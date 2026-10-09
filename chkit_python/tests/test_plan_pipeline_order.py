"""Port of ``packages/cli/src/test/commands/generate/plan-pipeline-order.test.ts`` (#231).

The rename pipeline keeps the planner's (dependency-aware) order of drops and
creates.
"""

from __future__ import annotations

from typing import Any

from chkit import table
from chkit.cli.commands.generate_plan_pipeline import (
    apply_explicit_dictionary_renames,
    apply_explicit_table_renames,
    apply_selected_rename_suggestions,
    build_explicit_column_rename_suggestions,
)
from chkit.cli.commands.generate_rename_mappings import (
    ColumnRenameMapping,
    DictionaryRenameMapping,
    TableRenameMapping,
)
from chkit.core.model import MigrationOperation, MigrationPlan, TableDefinition, _RiskSummary
from chkit.core.planner import plan_diff


def _op(type_: str, key: str) -> MigrationOperation:
    return MigrationOperation.model_validate(
        {"type": type_, "key": key, "risk": "safe", "sql": f"-- {type_} {key}"}
    )


# What plan_diff emits for a plan with dependencies: drops dependents-first and
# creates dependencies-first (neither in key order); alters in key order.
PLAN = MigrationPlan(
    operations=[
        _op("drop_view", "view:app.z_top"),
        _op("drop_view", "view:app.a_base"),
        _op("drop_dictionary", "dictionary:app.d_old"),
        _op("drop_table", "table:app.users"),
        _op("alter_table_drop_column", "table:app.t:column:a"),
        _op("alter_table_add_column", "table:app.t:column:b"),
        _op("create_database", "database:app"),
        _op("create_table", "table:app.customers"),
        _op("create_dictionary", "dictionary:app.d"),
        _op("create_view", "view:app.z_base"),
        _op("create_view", "view:app.a_top"),
    ],
    risk_summary=_RiskSummary(safe=11, caution=0, danger=0),
    rename_suggestions=[],
)


def summary(plan: MigrationPlan) -> list[str]:
    return [f"{op.type} {op.key}" for op in plan.operations]


def test_table_rename() -> None:
    plan = apply_explicit_table_renames(
        PLAN, [TableRenameMapping("app", "users", "app", "customers", "cli")]
    )
    assert summary(plan) == [
        "drop_view view:app.z_top",
        "drop_view view:app.a_base",
        "drop_dictionary dictionary:app.d_old",
        "create_database database:app",
        "alter_table_rename_table table:app.customers:rename_table",
        "alter_table_drop_column table:app.t:column:a",
        "alter_table_add_column table:app.t:column:b",
        "create_dictionary dictionary:app.d",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]


def test_table_rename_into_another_database_adds_create_database_in_key_order() -> None:
    plan = apply_explicit_table_renames(
        PLAN, [TableRenameMapping("app", "users", "archive", "customers", "cli")]
    )
    assert summary(plan) == [
        "drop_view view:app.z_top",
        "drop_view view:app.a_base",
        "drop_dictionary dictionary:app.d_old",
        "create_database database:app",
        "create_database database:archive",
        "alter_table_rename_table table:archive.customers:rename_table",
        "alter_table_drop_column table:app.t:column:a",
        "alter_table_add_column table:app.t:column:b",
        "create_table table:app.customers",
        "create_dictionary dictionary:app.d",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]


def test_dictionary_rename() -> None:
    plan = apply_explicit_dictionary_renames(
        PLAN, [DictionaryRenameMapping("app", "d_old", "app", "d", "cli")]
    )
    assert summary(plan) == [
        "drop_view view:app.z_top",
        "drop_view view:app.a_base",
        "drop_table table:app.users",
        "create_database database:app",
        "rename_dictionary dictionary:app.d:rename_dictionary",
        "alter_table_drop_column table:app.t:column:a",
        "alter_table_add_column table:app.t:column:b",
        "create_table table:app.customers",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]


def test_column_rename() -> None:
    plan = apply_selected_rename_suggestions(
        PLAN,
        build_explicit_column_rename_suggestions(
            PLAN, [ColumnRenameMapping("app", "t", "a", "b", "cli")]
        ),
    )
    assert summary(plan) == [
        "drop_view view:app.z_top",
        "drop_view view:app.a_base",
        "drop_dictionary dictionary:app.d_old",
        "drop_table table:app.users",
        "create_database database:app",
        "alter_table_rename_column table:app.t:column_rename:a:b",
        "create_table table:app.customers",
        "create_dictionary dictionary:app.d",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]


def test_column_rename_keeps_remove_default_right_before_its_modify_column() -> None:
    # plan_diff removes a column's expression in its own operation, with the
    # MODIFY COLUMN's key, and it must still run first once a rename merges the
    # alters: ClickHouse would cast the retained 'abc' to Int64 and fail.
    def t(columns: list[dict[str, Any]]) -> TableDefinition:
        return table(
            database="app",
            name="t",
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
            columns=[{"name": "id", "type": "UInt64"}, *columns],
        )

    planned = plan_diff(
        [t([{"name": "a", "type": "String"}, {"name": "code", "type": "String", "default": "abc"}])],
        [t([{"name": "b", "type": "String"}, {"name": "code", "type": "Int64"}])],
    )
    plan = apply_selected_rename_suggestions(
        planned,
        build_explicit_column_rename_suggestions(
            planned, [ColumnRenameMapping("app", "t", "a", "b", "cli")]
        ),
    )
    # TS sorts keys with localeCompare, which puts `column_rename:` before
    # `column:`; Python sorts by codepoint (DRIFT.md, plan-pipeline sort), so
    # the rename comes last here. The pinned invariant is the same: REMOVE
    # DEFAULT runs right before its MODIFY COLUMN.
    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.t MODIFY COLUMN `code` REMOVE DEFAULT;",
        "ALTER TABLE app.t MODIFY COLUMN `code` Int64;",
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;",
    ]
