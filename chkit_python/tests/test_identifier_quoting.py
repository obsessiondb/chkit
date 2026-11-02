"""Identifier quoting in rendered SQL (TS ``identifier-quoting.test.ts``)."""

from __future__ import annotations

from typing import Any

from chkit.cli.commands.generate_plan_pipeline import (
    apply_explicit_dictionary_renames,
    apply_explicit_table_renames,
    build_explicit_column_rename_suggestions,
)
from chkit.cli.commands.generate_rename_mappings import (
    ColumnRenameMapping,
    DictionaryRenameMapping,
    TableRenameMapping,
)
from chkit.core.identifier import quote_identifier, render_identifier, render_qualified_name
from chkit.core.model import (
    MigrationOperation,
    MigrationPlan,
    TableConstraintDefinition,
    TableDefinition,
    _RiskSummary,
    materialized_view,
    table,
)
from chkit.core.on_cluster import apply_on_cluster_to_plan
from chkit.core.planner import plan_diff
from chkit.core.sql import (
    render_alter_add_column,
    render_alter_add_constraint,
    render_alter_drop_column,
    render_alter_drop_index,
    render_alter_drop_projection,
    render_alter_remove_codec,
    to_create_sql,
)


def _events_table(**overrides: Any) -> TableDefinition:
    args: dict[str, Any] = {
        "database": "app",
        "name": "events",
        "columns": [{"name": "id", "type": "UInt64"}],
        "engine": "MergeTree()",
        "primary_key": ["id"],
        "order_by": ["id"],
    }
    args.update(overrides)
    return table(**args)


def _plan(*operations: MigrationOperation) -> MigrationPlan:
    return MigrationPlan(
        operations=list(operations),
        risk_summary=_RiskSummary(safe=0, caution=0, danger=0),
        rename_suggestions=[],
    )


def test_helpers_match_ts() -> None:
    assert quote_identifier("a`b\\c") == "`a\\`b\\\\c`"
    assert render_identifier("events") == "events"
    assert render_identifier("my-db") == "`my-db`"
    assert render_identifier("select") == "select"
    assert render_qualified_name("my-db", "user-events") == "`my-db`.`user-events`"


def test_plain_names_render_exactly_as_before() -> None:
    assert to_create_sql(_events_table()) == (
        "CREATE TABLE IF NOT EXISTS app.events\n(\n  `id` UInt64\n) ENGINE = MergeTree()\n"
        "PRIMARY KEY (`id`)\nORDER BY (`id`);"
    )
    plan = plan_diff([_events_table()], [])
    assert [op.sql for op in plan.operations] == ["DROP TABLE IF EXISTS app.events;"]


def test_database_and_table_names_are_quoted_when_needed() -> None:
    assert to_create_sql(_events_table(name="a.b")).startswith(
        "CREATE TABLE IF NOT EXISTS app.`a.b`\n"
    )
    assert to_create_sql(_events_table(database="my-db")).startswith(
        "CREATE TABLE IF NOT EXISTS `my-db`.events\n"
    )
    assert to_create_sql(_events_table(name="weird`name")).startswith(
        "CREATE TABLE IF NOT EXISTS app.`weird\\`name`\n"
    )
    assert to_create_sql(_events_table(name="a\\b")).startswith(
        "CREATE TABLE IF NOT EXISTS app.`a\\\\b`\n"
    )
    assert render_alter_add_column(
        _events_table(name="a b"), {"name": "x", "type": "String"}
    ) == "ALTER TABLE app.`a b` ADD COLUMN IF NOT EXISTS `x` String;"


def test_planner_drop_and_create_database_quote_names() -> None:
    dropped = plan_diff([_events_table(name="a;b")], [])
    assert [op.sql for op in dropped.operations] == ["DROP TABLE IF EXISTS app.`a;b`;"]
    created = plan_diff([], [_events_table(database="my-db")])
    assert created.operations[0].sql == "CREATE DATABASE IF NOT EXISTS `my-db`;"


def test_materialized_view_to_target_is_quoted() -> None:
    mv = materialized_view(
        database="app",
        name="mv.events",
        to={"database": "app", "name": "events-agg"},
        as_="SELECT 1",
    )
    assert to_create_sql(mv) == (
        "CREATE MATERIALIZED VIEW IF NOT EXISTS app.`mv.events` TO app.`events-agg` AS\n"
        "SELECT 1;"
    )


def test_column_names_cannot_close_the_quoted_identifier() -> None:
    definition = _events_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "evil` UInt8, `x", "type": "String"},
        ]
    )
    assert "  `evil\\` UInt8, \\`x` String" in to_create_sql(definition)
    keyed = _events_table(
        columns=[{"name": "a`b", "type": "UInt64"}], primary_key=["a`b"], order_by=["a`b"]
    )
    assert "ORDER BY (`a\\`b`)" in to_create_sql(keyed)


def test_alter_statements_escape_object_names() -> None:
    definition = _events_table()
    assert render_alter_drop_column(definition, "c`d") == (
        "ALTER TABLE app.events DROP COLUMN IF EXISTS `c\\`d`;"
    )
    assert render_alter_remove_codec(definition, "c`d") == (
        "ALTER TABLE app.events MODIFY COLUMN `c\\`d` REMOVE CODEC;"
    )
    assert render_alter_drop_index(definition, "i`x") == (
        "ALTER TABLE app.events DROP INDEX IF EXISTS `i\\`x`;"
    )
    assert render_alter_drop_projection(definition, "p`x") == (
        "ALTER TABLE app.events DROP PROJECTION IF EXISTS `p\\`x`;"
    )
    constraint = TableConstraintDefinition(name="c`k", check="id > 0")
    assert render_alter_add_constraint(definition, constraint) == (
        "ALTER TABLE app.events ADD CONSTRAINT IF NOT EXISTS `c\\`k` CHECK id > 0;"
    )
    with_constraint = _events_table(constraints=[constraint])
    assert "CONSTRAINT `c\\`k` CHECK id > 0" in to_create_sql(with_constraint)


def test_rename_column_suggestion_escapes_both_names() -> None:
    old = _events_table(
        columns=[{"name": "id", "type": "UInt64"}, {"name": "old`name", "type": "String"}]
    )
    new = _events_table(
        columns=[{"name": "id", "type": "UInt64"}, {"name": "new`name", "type": "String"}]
    )
    plan = plan_diff([old], [new])
    assert [s.confirmation_sql for s in plan.rename_suggestions] == [
        "ALTER TABLE app.events RENAME COLUMN IF EXISTS `old\\`name` TO `new\\`name`;"
    ]


def test_explicit_renames_quote_names() -> None:
    table_plan = apply_explicit_table_renames(
        _plan(),
        [TableRenameMapping(
            old_database="my-db", old_name="old-t", new_database="my-db", new_name="new-t",
            source="cli",
        )],
    )
    assert [op.sql for op in table_plan.operations] == [
        "RENAME TABLE IF EXISTS `my-db`.`old-t` TO `my-db`.`new-t`;"
    ]
    dictionary_plan = apply_explicit_dictionary_renames(
        _plan(),
        [DictionaryRenameMapping(
            old_database="app", old_name="old-d", new_database="app", new_name="new-d",
            source="cli",
        )],
    )
    assert [op.sql for op in dictionary_plan.operations] == [
        "RENAME DICTIONARY IF EXISTS app.`old-d` TO app.`new-d`;"
    ]
    key = "table:my-db.user-events:column:"
    column_plan = _plan(
        MigrationOperation(type="alter_table_drop_column", key=f"{key}a`b", risk="danger", sql=""),
        MigrationOperation(type="alter_table_add_column", key=f"{key}c", risk="safe", sql=""),
    )
    suggestions = build_explicit_column_rename_suggestions(
        column_plan,
        [ColumnRenameMapping(
            database="my-db", table="user-events", from_="a`b", to="c", source="cli"
        )],
    )
    assert [s.confirmation_sql for s in suggestions] == [
        "ALTER TABLE `my-db`.`user-events` RENAME COLUMN IF EXISTS `a\\`b` TO `c`;"
    ]


def test_on_cluster_lands_after_quoted_object_references() -> None:
    plan = _plan(
        MigrationOperation(
            type="drop_table", key="k", risk="danger", sql="DROP TABLE IF EXISTS `my db`.`a b`;"
        ),
        MigrationOperation(
            type="alter_table_add_column",
            key="k",
            risk="safe",
            sql="ALTER TABLE app.`a\\` b` ADD COLUMN IF NOT EXISTS `x` String;",
        ),
    )
    assert [op.sql for op in apply_on_cluster_to_plan(plan, "c").operations] == [
        "DROP TABLE IF EXISTS `my db`.`a b` ON CLUSTER 'c';",
        "ALTER TABLE app.`a\\` b` ON CLUSTER 'c' ADD COLUMN IF NOT EXISTS `x` String;",
    ]
