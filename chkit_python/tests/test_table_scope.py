"""Tests for `chkit.cli.table_scope`."""

from __future__ import annotations

import pytest

from chkit import ColumnDefinition, table, view
from chkit.cli.table_scope import (
    TableScope,
    TableScopeFilterResult,
    build_scoped_snapshot_definitions,
    database_key_from_operation_key,
    filter_plan_by_table_scope,
    parse_table_selector,
    resolve_table_scope,
    table_key_from_operation_key,
    table_keys_from_definitions,
)
from chkit.core.model import (
    ColumnRenameSuggestion,
    MigrationOperation,
    MigrationPlan,
    SchemaDefinition,
    TableDefinition,
    _RiskSummary,
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


# ---------- table_keys_from_definitions ----------


def test_keys_from_definitions_sorts_and_dedupes() -> None:
    defs: list[SchemaDefinition] = [
        _basic_table("z", "x"),
        _basic_table("a", "x"),
        _basic_table("a", "x"),  # duplicate
        view(database="z", name="v", as_="SELECT 1"),  # not a table
    ]
    assert table_keys_from_definitions(defs) == ["a.x", "z.x"]


def test_keys_from_definitions_empty() -> None:
    assert table_keys_from_definitions([]) == []


# ---------- parse_table_selector ----------


def test_parse_exact() -> None:
    parsed = parse_table_selector("events")
    assert parsed.mode == "exact"
    assert parsed.value == "events"
    assert parsed.database is None


def test_parse_prefix() -> None:
    parsed = parse_table_selector("events_*")
    assert parsed.mode == "prefix"
    assert parsed.value == "events_"
    assert parsed.database is None


def test_parse_qualified_exact() -> None:
    parsed = parse_table_selector("analytics.events")
    assert parsed.mode == "exact"
    assert parsed.database == "analytics"
    assert parsed.value == "events"


def test_parse_qualified_prefix() -> None:
    parsed = parse_table_selector("analytics.events_*")
    assert parsed.mode == "prefix"
    assert parsed.database == "analytics"
    assert parsed.value == "events_"


def test_parse_strips_whitespace() -> None:
    parsed = parse_table_selector("  analytics.events  ")
    assert parsed.database == "analytics"
    assert parsed.value == "events"


def test_parse_rejects_empty() -> None:
    with pytest.raises(ValueError, match="Expected <table>"):
        parse_table_selector("")


def test_parse_rejects_blank() -> None:
    with pytest.raises(ValueError, match="Expected <table>"):
        parse_table_selector("   ")


def test_parse_rejects_bare_wildcard() -> None:
    with pytest.raises(ValueError, match='A bare "\\*" is not supported'):
        parse_table_selector("*")


def test_parse_rejects_qualified_bare_wildcard() -> None:
    with pytest.raises(ValueError, match='A bare "\\*" is not supported'):
        parse_table_selector("db.*")


def test_parse_rejects_multiple_wildcards() -> None:
    with pytest.raises(ValueError, match="trailing suffix"):
        parse_table_selector("**")


def test_parse_rejects_mid_string_wildcard() -> None:
    with pytest.raises(ValueError, match="trailing suffix"):
        parse_table_selector("ev*ents")


def test_parse_rejects_empty_database() -> None:
    with pytest.raises(ValueError, match="Database qualifier"):
        parse_table_selector(".events")


def test_parse_rejects_wildcard_in_database() -> None:
    with pytest.raises(ValueError, match="Database qualifier"):
        parse_table_selector("an*.events")


# ---------- resolve_table_scope ----------


def test_resolve_returns_disabled_for_no_selector() -> None:
    scope = resolve_table_scope(None, ["db.a", "db.b"])
    assert scope == TableScope(enabled=False, matched_tables=(), match_count=0)


def test_resolve_returns_disabled_for_empty_selector() -> None:
    scope = resolve_table_scope("", ["db.a"])
    assert scope.enabled is False


def test_resolve_exact_match() -> None:
    scope = resolve_table_scope("a", ["db.a", "db.b", "x.a"])
    assert set(scope.matched_tables) == {"db.a", "x.a"}
    assert scope.enabled is True
    assert scope.selector == "a"


def test_resolve_qualified_exact() -> None:
    scope = resolve_table_scope("db.a", ["db.a", "x.a", "db.b"])
    assert list(scope.matched_tables) == ["db.a"]


def test_resolve_prefix_match() -> None:
    scope = resolve_table_scope("events_*", [
        "db.events_a",
        "db.events_b",
        "db.users",
        "x.events_a",
    ])
    assert set(scope.matched_tables) == {
        "db.events_a",
        "db.events_b",
        "x.events_a",
    }


def test_resolve_qualified_prefix() -> None:
    scope = resolve_table_scope("db.events_*", [
        "db.events_a",
        "x.events_a",
        "db.users",
    ])
    assert list(scope.matched_tables) == ["db.events_a"]


def test_resolve_empty_when_no_match() -> None:
    scope = resolve_table_scope("ghost", ["db.real"])
    assert scope.matched_tables == ()
    assert scope.match_count == 0
    assert scope.enabled is True


def test_resolve_skips_keys_with_invalid_dot_position() -> None:
    scope = resolve_table_scope("a", ["a", ".a", "db."])
    # All inputs malformed → no match.
    assert scope.matched_tables == ()


def test_resolve_sorts_and_dedupes_input() -> None:
    scope = resolve_table_scope("events_*", [
        "db.events_a",
        "db.events_a",  # duplicate
        "db.events_b",
    ])
    assert list(scope.matched_tables) == ["db.events_a", "db.events_b"]


# ---------- table_key_from_operation_key / database_key_from_operation_key ----------


def test_table_key_extracts_db_dot_table_prefix() -> None:
    assert table_key_from_operation_key("table:db.t:column:x") == "db.t"


def test_table_key_returns_whole_target_when_no_suffix() -> None:
    assert table_key_from_operation_key("table:db.t") == "db.t"


def test_table_key_returns_none_for_non_table_op() -> None:
    assert table_key_from_operation_key("database:foo") is None


def test_database_key_extracts() -> None:
    assert database_key_from_operation_key("database:foo") == "foo"


def test_database_key_returns_none_for_non_db_op() -> None:
    assert database_key_from_operation_key("table:db.t") is None


# ---------- filter_plan_by_table_scope ----------


def test_filter_empty_matched_tables_clears_plan() -> None:
    plan = MigrationPlan(
        operations=[_op("create_table", "table:db.t")],
        risk_summary=_RiskSummary(safe=1, caution=0, danger=0),
        rename_suggestions=[],
    )
    result = filter_plan_by_table_scope(plan, set())
    assert result.plan.operations == []
    assert result.omitted_operation_count == 1


def test_filter_keeps_matched_operations() -> None:
    plan = MigrationPlan(
        operations=[
            _op("create_table", "table:db.kept"),
            _op("create_table", "table:db.dropped"),
        ],
        risk_summary=_RiskSummary(safe=2, caution=0, danger=0),
        rename_suggestions=[],
    )
    result = filter_plan_by_table_scope(plan, {"db.kept"})
    assert [op.key for op in result.plan.operations] == ["table:db.kept"]
    assert result.omitted_operation_count == 1


def test_filter_keeps_database_op_when_database_referenced() -> None:
    plan = MigrationPlan(
        operations=[
            _op("create_database", "database:db"),
            _op("create_table", "table:db.kept"),
        ],
        risk_summary=_RiskSummary(safe=2, caution=0, danger=0),
        rename_suggestions=[],
    )
    result = filter_plan_by_table_scope(plan, {"db.kept"})
    types = [op.type for op in result.plan.operations]
    assert "create_database" in types


def test_filter_drops_unknown_op_kind() -> None:
    plan = MigrationPlan(
        operations=[
            _op("create_table", "weird:nothing"),
            _op("create_table", "table:db.kept"),
        ],
        risk_summary=_RiskSummary(safe=2, caution=0, danger=0),
        rename_suggestions=[],
    )
    result = filter_plan_by_table_scope(plan, {"db.kept"})
    assert [op.key for op in result.plan.operations] == ["table:db.kept"]


def test_filter_expands_via_rename_mappings() -> None:
    plan = MigrationPlan(
        operations=[
            _op("alter_table_rename_table", "table:db.new:rename_table"),
            _op("create_table", "table:db.old"),
        ],
        risk_summary=_RiskSummary(safe=2, caution=0, danger=0),
        rename_suggestions=[],
    )

    class M:
        def __init__(self, ob: str, on: str, nb: str, nn: str) -> None:
            self.old_database = ob
            self.old_name = on
            self.new_database = nb
            self.new_name = nn

    result = filter_plan_by_table_scope(
        plan, {"db.old"}, rename_mappings=[M("db", "old", "db", "new")]
    )
    keys = {op.key for op in result.plan.operations}
    assert "table:db.new:rename_table" in keys
    assert "table:db.old" in keys


def test_filter_keeps_rename_suggestions_for_selected_table() -> None:
    suggestion = ColumnRenameSuggestion(
        kind="column",
        database="db",
        table="t",
        from_="old",
        to="new",
        confidence="high",
        reason="r",
        drop_operation_key="table:db.t:column:old",
        add_operation_key="table:db.t:column:new",
        confirmation_sql="ALTER TABLE db.t RENAME COLUMN IF EXISTS `old` TO `new`;",
    )
    plan = MigrationPlan(
        operations=[],
        risk_summary=_RiskSummary(safe=0, caution=0, danger=0),
        rename_suggestions=[suggestion],
    )
    result = filter_plan_by_table_scope(plan, {"db.t"})
    assert result.plan.rename_suggestions == [suggestion]


def test_filter_drops_rename_suggestions_for_unselected_table() -> None:
    suggestion = ColumnRenameSuggestion(
        kind="column",
        database="db",
        table="t",
        from_="old",
        to="new",
        confidence="high",
        reason="r",
        drop_operation_key="table:db.t:column:old",
        add_operation_key="table:db.t:column:new",
        confirmation_sql="ALTER TABLE db.t RENAME COLUMN IF EXISTS `old` TO `new`;",
    )
    plan = MigrationPlan(
        operations=[],
        risk_summary=_RiskSummary(safe=0, caution=0, danger=0),
        rename_suggestions=[suggestion],
    )
    result = filter_plan_by_table_scope(plan, {"db.other"})
    assert result.plan.rename_suggestions == []


def test_filter_recomputes_risk_summary() -> None:
    plan = MigrationPlan(
        operations=[
            _op("drop_table", "table:db.x", risk="danger"),
            _op("create_table", "table:db.y"),
        ],
        risk_summary=_RiskSummary(safe=1, caution=0, danger=1),
        rename_suggestions=[],
    )
    result = filter_plan_by_table_scope(plan, {"db.x"})
    assert result.plan.risk_summary.danger == 1
    assert result.plan.risk_summary.safe == 0


def test_filter_returns_filter_result_dataclass() -> None:
    plan = _empty_plan()
    out = filter_plan_by_table_scope(plan, {"db.a"})
    assert isinstance(out, TableScopeFilterResult)


# ---------- build_scoped_snapshot_definitions ----------


def test_build_scoped_returns_previous_when_no_match() -> None:
    previous: list[SchemaDefinition] = [_basic_table("db", "t")]
    out = build_scoped_snapshot_definitions(
        previous_definitions=previous,
        next_definitions=[],
        matched_tables=set(),
    )
    assert out == previous


def test_build_scoped_removes_dropped_selected_table() -> None:
    previous: list[SchemaDefinition] = [_basic_table("db", "old"), _basic_table("db", "other")]
    out = build_scoped_snapshot_definitions(
        previous_definitions=previous,
        next_definitions=[_basic_table("db", "other")],
        matched_tables={"db.old"},
    )
    names = {d.name for d in out}
    assert "old" not in names
    assert "other" in names


def test_build_scoped_replaces_changed_selected_table() -> None:
    previous_t = _basic_table("db", "t")
    updated_t = table(
        database="db",
        name="t",
        engine="MergeTree",
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="extra", type="String"),
        ],
        primary_key=["id"],
        order_by=["id"],
    )
    out = build_scoped_snapshot_definitions(
        previous_definitions=[previous_t],
        next_definitions=[updated_t],
        matched_tables={"db.t"},
    )
    [result] = out
    assert isinstance(result, TableDefinition)
    assert len(result.columns) == 2


def test_build_scoped_leaves_unselected_tables_from_previous_untouched() -> None:
    previous_t = _basic_table("db", "stable")
    updated_t = table(
        database="db",
        name="stable",
        engine="MergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64"), ColumnDefinition(name="extra", type="String")],
        primary_key=["id"],
        order_by=["id"],
    )
    out = build_scoped_snapshot_definitions(
        previous_definitions=[previous_t],
        next_definitions=[updated_t],
        matched_tables={"db.other"},
    )
    # No "stable" mapping selected → previous_t stays.
    [result] = out
    assert isinstance(result, TableDefinition)
    assert len(result.columns) == 1


def test_build_scoped_passes_through_views() -> None:
    v = view(database="db", name="v", as_="SELECT 1")
    out = build_scoped_snapshot_definitions(
        previous_definitions=[v],
        next_definitions=[],
        matched_tables={"db.anything"},
    )
    assert out == [v]
