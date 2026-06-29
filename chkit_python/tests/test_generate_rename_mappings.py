"""Tests for the generate rename-mappings module."""

from __future__ import annotations

import pytest

from chkit import ColumnDefinition, table, view
from chkit.cli.commands.generate_rename_mappings import (
    ColumnRenameMapping,
    SchemaRenameMappings,
    TableRenameMapping,
    assert_cli_table_mappings_resolvable,
    assert_no_conflicting_column_mappings,
    assert_no_conflicting_table_mappings,
    collect_schema_rename_mappings,
    merge_column_mappings,
    merge_table_mappings,
    parse_rename_column_mappings,
    parse_rename_table_mappings,
    remap_old_definitions_for_table_renames,
    resolve_active_table_mappings,
)
from chkit.core.model import SchemaDefinition, TableDefinition


def _basic_table(
    database: str,
    name: str,
    *,
    renamed_from: dict[str, object] | None = None,
) -> TableDefinition:
    return table(
        database=database,
        name=name,
        engine="MergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
        renamed_from=renamed_from,
    )


# ---------- parse_rename_table_mappings ----------


def test_parse_rename_table_single() -> None:
    [mapping] = parse_rename_table_mappings(["db.old=db.new"])
    assert mapping == TableRenameMapping(
        old_database="db",
        old_name="old",
        new_database="db",
        new_name="new",
        source="cli",
    )


def test_parse_rename_table_cross_database() -> None:
    [mapping] = parse_rename_table_mappings(["analytics.events=warehouse.events"])
    assert mapping.old_database == "analytics"
    assert mapping.new_database == "warehouse"


def test_parse_rename_table_strips_whitespace() -> None:
    [mapping] = parse_rename_table_mappings(["  db.old  =  db.new  "])
    assert mapping.old_database == "db"
    assert mapping.new_name == "new"


def test_parse_rename_table_rejects_missing_equals() -> None:
    with pytest.raises(ValueError, match="Expected format"):
        parse_rename_table_mappings(["db.old"])


def test_parse_rename_table_rejects_too_many_equals() -> None:
    with pytest.raises(ValueError, match="Expected format"):
        parse_rename_table_mappings(["db.old=db.new=db.even-newer"])


def test_parse_rename_table_rejects_missing_dot() -> None:
    with pytest.raises(ValueError, match=r"Expected format: database\.table"):
        parse_rename_table_mappings(["bare_table=db.new"])


def test_parse_rename_table_returns_empty_for_empty_input() -> None:
    assert parse_rename_table_mappings([]) == []


# ---------- parse_rename_column_mappings ----------


def test_parse_rename_column_single() -> None:
    [mapping] = parse_rename_column_mappings(["db.t.old=new"])
    assert mapping == ColumnRenameMapping(
        database="db", table="t", from_="old", to="new", source="cli"
    )


def test_parse_rename_column_strips_whitespace() -> None:
    [mapping] = parse_rename_column_mappings(["  db.t.old  =  new  "])
    assert mapping.from_ == "old"
    assert mapping.to == "new"


def test_parse_rename_column_rejects_missing_db_or_table() -> None:
    with pytest.raises(ValueError, match=r"db\.table\.old_column"):
        parse_rename_column_mappings(["t.old=new"])


def test_parse_rename_column_rejects_extra_dot_segment() -> None:
    with pytest.raises(ValueError, match=r"db\.table\.old_column"):
        parse_rename_column_mappings(["db.t.a.old=new"])


def test_parse_rename_column_rejects_missing_equals() -> None:
    with pytest.raises(ValueError, match="Expected format"):
        parse_rename_column_mappings(["db.t.old"])


# ---------- collect_schema_rename_mappings ----------


def test_collect_schema_picks_up_renamed_from_table() -> None:
    defs = [
        _basic_table("db", "events", renamed_from={"database": "db", "name": "old_events"}),
    ]
    result = collect_schema_rename_mappings(defs)
    assert isinstance(result, SchemaRenameMappings)
    assert result.table_mappings == [
        TableRenameMapping(
            old_database="db",
            old_name="old_events",
            new_database="db",
            new_name="events",
            source="schema",
        )
    ]


def test_collect_schema_defaults_renamed_from_db_to_current_db() -> None:
    defs = [
        _basic_table("db", "events", renamed_from={"name": "old_events"}),
    ]
    result = collect_schema_rename_mappings(defs)
    assert result.table_mappings[0].old_database == "db"


def test_collect_schema_picks_up_column_renamed_from() -> None:
    defs = [
        table(
            database="db",
            name="t",
            engine="MergeTree",
            columns=[
                ColumnDefinition(name="user_id", type="UInt64", renamed_from="uid"),
            ],
            primary_key=["user_id"],
            order_by=["user_id"],
        )
    ]
    result = collect_schema_rename_mappings(defs)
    assert result.column_mappings == [
        ColumnRenameMapping(
            database="db", table="t", from_="uid", to="user_id", source="schema"
        )
    ]


def test_collect_schema_skips_views() -> None:
    defs = [view(database="db", name="v", as_="SELECT 1")]
    result = collect_schema_rename_mappings(defs)
    assert result.table_mappings == []
    assert result.column_mappings == []


# ---------- merge_table_mappings ----------


def test_merge_cli_replaces_schema_on_same_old_key() -> None:
    schema = [
        TableRenameMapping("db", "old", "db", "new_schema", "schema"),
    ]
    cli = [
        TableRenameMapping("db", "old", "db", "new_cli", "cli"),
    ]
    merged = merge_table_mappings(schema, cli)
    assert merged == [TableRenameMapping("db", "old", "db", "new_cli", "cli")]


def test_merge_cli_replaces_schema_on_same_new_key() -> None:
    schema = [
        TableRenameMapping("db", "old_schema", "db", "new", "schema"),
    ]
    cli = [
        TableRenameMapping("db", "old_cli", "db", "new", "cli"),
    ]
    merged = merge_table_mappings(schema, cli)
    assert merged == [TableRenameMapping("db", "old_cli", "db", "new", "cli")]


def test_merge_keeps_non_conflicting_schema_mappings() -> None:
    schema = [TableRenameMapping("db", "a", "db", "b", "schema")]
    cli = [TableRenameMapping("db", "c", "db", "d", "cli")]
    merged = merge_table_mappings(schema, cli)
    assert merged == [
        TableRenameMapping("db", "a", "db", "b", "schema"),
        TableRenameMapping("db", "c", "db", "d", "cli"),
    ]


def test_merge_empty_inputs() -> None:
    assert merge_table_mappings([], []) == []


# ---------- merge_column_mappings ----------


def test_merge_column_cli_replaces_schema() -> None:
    schema = [ColumnRenameMapping("db", "t", "x", "y_schema", "schema")]
    cli = [ColumnRenameMapping("db", "t", "x", "y_cli", "cli")]
    merged = merge_column_mappings(schema, cli)
    assert merged == [ColumnRenameMapping("db", "t", "x", "y_cli", "cli")]


def test_merge_column_displaces_by_target_key() -> None:
    schema = [ColumnRenameMapping("db", "t", "old_schema", "new", "schema")]
    cli = [ColumnRenameMapping("db", "t", "old_cli", "new", "cli")]
    merged = merge_column_mappings(schema, cli)
    assert merged == [ColumnRenameMapping("db", "t", "old_cli", "new", "cli")]


# ---------- resolve_active_table_mappings ----------


def test_resolve_active_keeps_when_both_sides_exist() -> None:
    previous = [_basic_table("db", "old")]
    next_defs = [_basic_table("db", "new")]
    mappings = [TableRenameMapping("db", "old", "db", "new", "cli")]
    assert resolve_active_table_mappings(previous, next_defs, mappings) == mappings


def test_resolve_active_drops_when_old_missing() -> None:
    next_defs = [_basic_table("db", "new")]
    mappings = [TableRenameMapping("db", "ghost", "db", "new", "cli")]
    assert resolve_active_table_mappings([], next_defs, mappings) == []


def test_resolve_active_drops_when_new_missing() -> None:
    previous = [_basic_table("db", "old")]
    mappings = [TableRenameMapping("db", "old", "db", "ghost", "cli")]
    assert resolve_active_table_mappings(previous, [], mappings) == []


# ---------- assert_no_conflicting_table_mappings ----------


def test_no_conflict_when_unique_sources_and_targets() -> None:
    assert_no_conflicting_table_mappings(
        [TableRenameMapping("db", "a", "db", "b", "cli")]
    )


def test_conflict_on_duplicate_source() -> None:
    mappings = [
        TableRenameMapping("db", "a", "db", "b", "cli"),
        TableRenameMapping("db", "a", "db", "c", "cli"),
    ]
    with pytest.raises(ValueError, match="source mapping"):
        assert_no_conflicting_table_mappings(mappings)


def test_conflict_on_duplicate_target() -> None:
    mappings = [
        TableRenameMapping("db", "a", "db", "z", "cli"),
        TableRenameMapping("db", "b", "db", "z", "cli"),
    ]
    with pytest.raises(ValueError, match="target mapping"):
        assert_no_conflicting_table_mappings(mappings)


def test_conflict_on_chained_mapping() -> None:
    mappings = [
        TableRenameMapping("db", "a", "db", "b", "cli"),
        TableRenameMapping("db", "b", "db", "c", "cli"),
    ]
    with pytest.raises(ValueError, match="chained or cyclic"):
        assert_no_conflicting_table_mappings(mappings)


# ---------- assert_no_conflicting_column_mappings ----------


def test_column_conflict_on_same_source_different_target() -> None:
    mappings = [
        ColumnRenameMapping("db", "t", "x", "y", "cli"),
        ColumnRenameMapping("db", "t", "x", "z", "cli"),
    ]
    with pytest.raises(ValueError, match="source mapping"):
        assert_no_conflicting_column_mappings(mappings)


def test_column_conflict_on_same_target_different_source() -> None:
    mappings = [
        ColumnRenameMapping("db", "t", "a", "z", "cli"),
        ColumnRenameMapping("db", "t", "b", "z", "cli"),
    ]
    with pytest.raises(ValueError, match="target mapping"):
        assert_no_conflicting_column_mappings(mappings)


def test_column_no_conflict_on_unrelated_mappings() -> None:
    assert_no_conflicting_column_mappings(
        [
            ColumnRenameMapping("db", "t", "a", "b", "cli"),
            ColumnRenameMapping("db", "t", "c", "d", "cli"),
        ]
    )


# ---------- assert_cli_table_mappings_resolvable ----------


def test_resolvable_passes_when_both_sides_present() -> None:
    previous = [_basic_table("db", "old")]
    next_defs = [_basic_table("db", "new")]
    assert_cli_table_mappings_resolvable(
        [TableRenameMapping("db", "old", "db", "new", "cli")], previous, next_defs
    )


def test_resolvable_rejects_both_missing() -> None:
    with pytest.raises(ValueError, match="missing from previous snapshot and target"):
        assert_cli_table_mappings_resolvable(
            [TableRenameMapping("db", "ghost", "db", "ghost2", "cli")], [], []
        )


def test_resolvable_rejects_old_missing() -> None:
    next_defs = [_basic_table("db", "new")]
    with pytest.raises(ValueError, match="source table is missing"):
        assert_cli_table_mappings_resolvable(
            [TableRenameMapping("db", "ghost", "db", "new", "cli")], [], next_defs
        )


def test_resolvable_rejects_new_missing() -> None:
    previous = [_basic_table("db", "old")]
    with pytest.raises(ValueError, match="target table is missing"):
        assert_cli_table_mappings_resolvable(
            [TableRenameMapping("db", "old", "db", "ghost", "cli")], previous, []
        )


# ---------- remap_old_definitions_for_table_renames ----------


def test_remap_rewrites_database_and_name() -> None:
    previous = [_basic_table("db", "old")]
    mapping = TableRenameMapping("db", "old", "warehouse", "new", "cli")
    [remapped] = remap_old_definitions_for_table_renames(previous, [mapping])
    assert isinstance(remapped, TableDefinition)
    assert remapped.database == "warehouse"
    assert remapped.name == "new"


def test_remap_leaves_unrelated_tables_untouched() -> None:
    previous = [_basic_table("db", "a"), _basic_table("db", "b")]
    mapping = TableRenameMapping("db", "a", "db", "renamed", "cli")
    out = remap_old_definitions_for_table_renames(previous, [mapping])
    by_name = {d.name for d in out}
    assert by_name == {"renamed", "b"}


def test_remap_returns_copy_when_no_mappings() -> None:
    previous = [_basic_table("db", "a")]
    out = remap_old_definitions_for_table_renames(previous, [])
    # Same items, but a fresh list (avoids accidental mutation of caller's list).
    assert out == previous
    assert out is not previous


def test_remap_ignores_views() -> None:
    previous: list[SchemaDefinition] = [
        view(database="db", name="v", as_="SELECT 1"),
        _basic_table("db", "t"),
    ]
    mapping = TableRenameMapping("db", "v", "db", "v2", "cli")
    out = remap_old_definitions_for_table_renames(previous, [mapping])
    # View must not be remapped; only table mappings touch tables.
    assert any(d.name == "v" for d in out)
    assert any(d.name == "t" for d in out)
