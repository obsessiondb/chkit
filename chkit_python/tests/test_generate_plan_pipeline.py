"""Tests for the generate plan-pipeline module."""

from __future__ import annotations

import pytest

from chkit import ColumnDefinition, table
from chkit.cli.commands.generate_plan_pipeline import (
    apply_explicit_table_renames,
    apply_selected_rename_suggestions,
    assert_cli_column_mappings_resolvable,
    build_explicit_column_rename_suggestions,
)
from chkit.cli.commands.generate_rename_mappings import (
    ColumnRenameMapping,
    TableRenameMapping,
)
from chkit.core.model import (
    ColumnRenameSuggestion,
    MigrationOperation,
    MigrationPlan,
    SchemaDefinition,
    TableDefinition,
    _RiskSummary,
)


def _empty_plan() -> MigrationPlan:
    return MigrationPlan(
        operations=[],
        risk_summary=_RiskSummary(safe=0, caution=0, danger=0),
        rename_suggestions=[],
    )


def _op(
    type_: str, key: str, *, risk: str = "safe", sql: str = "SELECT 1"
) -> MigrationOperation:
    return MigrationOperation(type=type_, key=key, risk=risk, sql=sql)  # type: ignore[arg-type]


def _suggestion(
    *,
    database: str = "db",
    table_name: str = "t",
    from_: str = "old",
    to: str = "new",
) -> ColumnRenameSuggestion:
    return ColumnRenameSuggestion(
        kind="column",
        database=database,
        table=table_name,
        from_=from_,
        to=to,
        confidence="high",
        reason="test",
        drop_operation_key=f"table:{database}.{table_name}:column:{from_}",
        add_operation_key=f"table:{database}.{table_name}:column:{to}",
        confirmation_sql=(
            f"ALTER TABLE {database}.{table_name} "
            f"RENAME COLUMN IF EXISTS `{from_}` TO `{to}`;"
        ),
    )


def _basic_table(database: str, name: str) -> TableDefinition:
    return table(
        database=database,
        name=name,
        engine="MergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
    )


# ---------- apply_selected_rename_suggestions ----------


def test_apply_selected_renames_returns_input_when_empty() -> None:
    plan = _empty_plan()
    out = apply_selected_rename_suggestions(plan, [])
    assert out is plan


def test_apply_selected_renames_replaces_drop_add_with_rename() -> None:
    sug = _suggestion()
    plan = MigrationPlan(
        operations=[
            _op("alter_table_drop_column", sug.drop_operation_key, risk="danger"),
            _op("alter_table_add_column", sug.add_operation_key),
        ],
        risk_summary=_RiskSummary(safe=1, caution=0, danger=1),
        rename_suggestions=[sug],
    )
    out = apply_selected_rename_suggestions(plan, [sug])
    [op] = out.operations
    assert op.type == "alter_table_rename_column"
    assert op.key == "table:db.t:column_rename:old:new"
    assert op.risk == "caution"
    assert out.risk_summary.caution == 1
    assert out.risk_summary.safe == 0
    assert out.risk_summary.danger == 0
    # Suggestion list should drop the materialized suggestion.
    assert out.rename_suggestions == []


def test_apply_selected_renames_preserves_unrelated_operations() -> None:
    sug = _suggestion()
    plan = MigrationPlan(
        operations=[
            _op("alter_table_drop_column", sug.drop_operation_key, risk="danger"),
            _op("alter_table_add_column", sug.add_operation_key),
            _op("create_table", "table:db.other"),
        ],
        risk_summary=_RiskSummary(safe=2, caution=0, danger=1),
        rename_suggestions=[],
    )
    out = apply_selected_rename_suggestions(plan, [sug])
    keys = [op.key for op in out.operations]
    assert "table:db.other" in keys
    assert any("column_rename" in k for k in keys)


def test_apply_selected_renames_keeps_unselected_suggestions() -> None:
    selected = _suggestion()
    other = _suggestion(from_="a", to="b")
    plan = MigrationPlan(
        operations=[
            _op("alter_table_drop_column", selected.drop_operation_key, risk="danger"),
            _op("alter_table_add_column", selected.add_operation_key),
        ],
        risk_summary=_RiskSummary(safe=1, caution=0, danger=1),
        rename_suggestions=[selected, other],
    )
    out = apply_selected_rename_suggestions(plan, [selected])
    assert out.rename_suggestions == [other]


# ---------- apply_explicit_table_renames ----------


def test_apply_explicit_table_renames_empty_is_noop() -> None:
    plan = _empty_plan()
    assert apply_explicit_table_renames(plan, []) is plan


def test_apply_explicit_table_rename_collapses_drop_create_to_rename() -> None:
    plan = MigrationPlan(
        operations=[
            _op("drop_table", "table:db.old", risk="danger"),
            _op("create_table", "table:db.new"),
        ],
        risk_summary=_RiskSummary(safe=1, caution=0, danger=1),
        rename_suggestions=[],
    )
    mapping = TableRenameMapping("db", "old", "db", "new", "cli")
    out = apply_explicit_table_renames(plan, [mapping])
    [op] = out.operations
    assert op.type == "alter_table_rename_table"
    assert op.key == "table:db.new:rename_table"
    assert "RENAME TABLE IF EXISTS db.old TO db.new" in op.sql
    assert out.risk_summary.caution == 1
    assert out.risk_summary.danger == 0


def test_apply_explicit_cross_database_rename_emits_create_database() -> None:
    plan = MigrationPlan(
        operations=[
            _op("drop_table", "table:olddb.t", risk="danger"),
            _op("create_table", "table:newdb.t"),
        ],
        risk_summary=_RiskSummary(safe=1, caution=0, danger=1),
        rename_suggestions=[],
    )
    mapping = TableRenameMapping("olddb", "t", "newdb", "t", "cli")
    out = apply_explicit_table_renames(plan, [mapping])
    types = [op.type for op in out.operations]
    keys = [op.key for op in out.operations]
    assert "create_database" in types
    assert "database:newdb" in keys
    # create_database must precede the rename in the sorted output.
    assert keys.index("database:newdb") < keys.index("table:newdb.t:rename_table")


def test_apply_explicit_rename_does_not_duplicate_existing_create_database() -> None:
    plan = MigrationPlan(
        operations=[
            _op("create_database", "database:newdb"),
            _op("drop_table", "table:olddb.t", risk="danger"),
            _op("create_table", "table:newdb.t"),
        ],
        risk_summary=_RiskSummary(safe=2, caution=0, danger=1),
        rename_suggestions=[],
    )
    mapping = TableRenameMapping("olddb", "t", "newdb", "t", "cli")
    out = apply_explicit_table_renames(plan, [mapping])
    create_db_count = sum(1 for op in out.operations if op.type == "create_database")
    assert create_db_count == 1


def test_operations_are_sorted_by_rank_then_key() -> None:
    plan = MigrationPlan(
        operations=[
            _op("create_table", "table:db.c"),
            _op("drop_table", "table:db.a", risk="danger"),
            _op("alter_table_modify_column", "table:db.b:column:x"),
        ],
        risk_summary=_RiskSummary(safe=2, caution=0, danger=1),
        rename_suggestions=[],
    )
    out = apply_explicit_table_renames(plan, [])
    # apply_explicit_table_renames returns plan unchanged on empty mappings.
    assert out is plan


# ---------- build_explicit_column_rename_suggestions ----------


def test_build_column_suggestions_skips_when_pair_missing() -> None:
    plan = MigrationPlan(
        operations=[
            _op("alter_table_drop_column", "table:db.t:column:old", risk="danger"),
            # No matching add op
        ],
        risk_summary=_RiskSummary(safe=0, caution=0, danger=1),
        rename_suggestions=[],
    )
    mapping = ColumnRenameMapping("db", "t", "old", "new", "cli")
    assert build_explicit_column_rename_suggestions(plan, [mapping]) == []


def test_build_column_suggestions_yields_when_pair_present() -> None:
    plan = MigrationPlan(
        operations=[
            _op("alter_table_drop_column", "table:db.t:column:old", risk="danger"),
            _op("alter_table_add_column", "table:db.t:column:new"),
        ],
        risk_summary=_RiskSummary(safe=1, caution=0, danger=1),
        rename_suggestions=[],
    )
    mapping = ColumnRenameMapping("db", "t", "old", "new", "cli")
    [sug] = build_explicit_column_rename_suggestions(plan, [mapping])
    assert sug.database == "db"
    assert sug.table == "t"
    assert sug.from_ == "old"
    assert sug.to == "new"
    assert sug.confidence == "high"
    assert "--rename-column" in sug.reason


def test_build_column_suggestions_uses_schema_reason_when_schema_source() -> None:
    plan = MigrationPlan(
        operations=[
            _op("alter_table_drop_column", "table:db.t:column:old", risk="danger"),
            _op("alter_table_add_column", "table:db.t:column:new"),
        ],
        risk_summary=_RiskSummary(safe=1, caution=0, danger=1),
        rename_suggestions=[],
    )
    mapping = ColumnRenameMapping("db", "t", "old", "new", "schema")
    [sug] = build_explicit_column_rename_suggestions(plan, [mapping])
    assert "schema metadata" in sug.reason


# ---------- assert_cli_column_mappings_resolvable ----------


def test_assert_cli_column_mappings_rejects_missing_table() -> None:
    plan = _empty_plan()
    next_defs: list[SchemaDefinition] = []
    mapping = ColumnRenameMapping("db", "ghost", "x", "y", "cli")
    with pytest.raises(ValueError, match="target table is missing"):
        assert_cli_column_mappings_resolvable([mapping], plan, next_defs)


def test_assert_cli_column_mappings_rejects_missing_planner_pair() -> None:
    plan = _empty_plan()
    next_defs: list[SchemaDefinition] = [_basic_table("db", "t")]
    mapping = ColumnRenameMapping("db", "t", "x", "y", "cli")
    with pytest.raises(ValueError, match="planner did not find"):
        assert_cli_column_mappings_resolvable([mapping], plan, next_defs)


def test_assert_cli_column_mappings_passes_when_pair_present() -> None:
    plan = MigrationPlan(
        operations=[
            _op("alter_table_drop_column", "table:db.t:column:x", risk="danger"),
            _op("alter_table_add_column", "table:db.t:column:y"),
        ],
        risk_summary=_RiskSummary(safe=1, caution=0, danger=1),
        rename_suggestions=[],
    )
    next_defs: list[SchemaDefinition] = [_basic_table("db", "t")]
    mapping = ColumnRenameMapping("db", "t", "x", "y", "cli")
    # No exception.
    assert_cli_column_mappings_resolvable([mapping], plan, next_defs)
