"""Object and column comments (#464).

Port of TS ``packages/core/src/comments.test.ts``: the same input gives the same SQL.
"""

from __future__ import annotations

from typing import cast

import pytest

from chkit.cli.commands.drift_compare import SchemaObjectShape, compare_object_comments
from chkit.cli.commands.pull import _pull_definitions
from chkit.cli.commands.pull_render import render_schema_file
from chkit.cli.commands.pull_view_parser import parse_as_clause, parse_to_clause
from chkit.clickhouse.alter_column_statement import ColumnIntent, parse_modify_column_intent
from chkit.core.model import (
    ColumnDefinition,
    SchemaDefinition,
    TableDefinition,
    dictionary,
    materialized_view,
    table,
    view,
)
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql

# Each value, and the string literal ClickHouse must receive to store it as is.
EDGE_COMMENTS: list[tuple[str, str]] = [
    ('it\'s "q"', "'it''s \"q\"'"),
    ("a\\b C:\\new\\t", "'a\\\\b C:\\\\new\\\\t'"),
    ("trail\\", "'trail\\\\'"),
    ("l1\nl2", "'l1\nl2'"),
    ("héllo 世界 🚀", "'héllo 世界 🚀'"),
    ("x AS y", "'x AS y'"),
]


def _events(
    comment: str | None = None, columns: list[ColumnDefinition] | None = None
) -> TableDefinition:
    return table(
        database="app",
        name="events",
        engine="MergeTree()",
        columns=columns or [ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
        comment=comment,
    )


def _objects(comment: str | None = None) -> list[SchemaDefinition]:
    return [
        _events(comment),
        view(database="app", name="v", as_="SELECT id FROM app.events", comment=comment),
        materialized_view(
            database="app",
            name="mv",
            to={"database": "app", "name": "events"},
            as_="SELECT id FROM app.src",
            comment=comment,
        ),
        dictionary(
            database="app",
            name="d",
            attributes=[{"name": "id", "type": "UInt64"}],
            primary_key=["id"],
            source="NULL()",
            layout="HASHED()",
            lifetime="300",
            comment=comment,
        ),
    ]


def _sql_of(old: list[SchemaDefinition], new: list[SchemaDefinition]) -> list[str]:
    return [op.sql for op in plan_diff(old, new).operations]


@pytest.mark.parametrize(("comment", "literal"), EDGE_COMMENTS)
def test_create_escapes_the_comment_for_every_object_kind_and_columns(
    comment: str, literal: str
) -> None:
    column = ColumnDefinition(name="id", type="UInt64", comment=comment)
    table_def, view_def, mv_def, dict_def = _objects(comment)
    assert to_create_sql(_events(comment, [column])) == (
        f"CREATE TABLE IF NOT EXISTS app.events\n(\n  `id` UInt64 COMMENT {literal}\n) "
        f"ENGINE = MergeTree()\nPRIMARY KEY (`id`)\nORDER BY (`id`)\nCOMMENT {literal};"
    )
    assert to_create_sql(view_def) == (
        f"CREATE VIEW IF NOT EXISTS app.v COMMENT {literal} AS\nSELECT id FROM app.events;"
    )
    assert to_create_sql(mv_def) == (
        f"CREATE MATERIALIZED VIEW IF NOT EXISTS app.mv TO app.events COMMENT {literal} AS\n"
        "SELECT id FROM app.src;"
    )
    assert to_create_sql(dict_def).endswith(f"LIFETIME(300)\nCOMMENT {literal};")
    assert to_create_sql(table_def).endswith(f"COMMENT {literal};")


@pytest.mark.parametrize(("comment", "literal"), EDGE_COMMENTS)
def test_a_comment_change_alters_every_object_in_place(comment: str, literal: str) -> None:
    assert _sql_of(_objects("old"), _objects(comment)) == [
        f"ALTER TABLE app.d MODIFY COMMENT {literal};",
        f"ALTER TABLE app.mv MODIFY COMMENT {literal};",
        f"ALTER TABLE app.events MODIFY COMMENT {literal};",
        f"ALTER TABLE app.v MODIFY COMMENT {literal};",
    ]


def test_adding_and_removing_an_object_comment_is_modify_comment_at_safe_risk() -> None:
    added = plan_diff(_objects(), _objects("c"))
    assert [(op.type, op.key, op.risk) for op in added.operations] == [
        ("alter_table_modify_comment", "dictionary:app.d:comment", "safe"),
        ("alter_table_modify_comment", "materialized_view:app.mv:comment", "safe"),
        ("alter_table_modify_comment", "table:app.events:comment", "safe"),
        ("alter_table_modify_comment", "view:app.v:comment", "safe"),
    ]
    assert _sql_of(_objects("c"), _objects()) == [
        "ALTER TABLE app.d MODIFY COMMENT '';",
        "ALTER TABLE app.mv MODIFY COMMENT '';",
        "ALTER TABLE app.events MODIFY COMMENT '';",
        "ALTER TABLE app.v MODIFY COMMENT '';",
    ]


def test_an_empty_comment_is_no_comment() -> None:
    def column(comment: str | None) -> list[ColumnDefinition]:
        return [ColumnDefinition(name="id", type="UInt64", comment=comment)]

    with_empty = [_events("", column("")), *_objects("")[1:]]
    without = [_events(None, column(None)), *_objects()[1:]]
    assert _sql_of(without, with_empty) == []
    assert _sql_of(with_empty, without) == []


def test_a_change_that_recreates_the_object_carries_the_new_comment() -> None:
    old_view = _objects("old")[1]
    new_view = view(
        database="app", name="v", as_="SELECT id + 1 AS id FROM app.events", comment="new"
    )
    assert _sql_of([old_view], [new_view]) == [
        "DROP VIEW IF EXISTS app.v;",
        "CREATE VIEW IF NOT EXISTS app.v COMMENT 'new' AS\nSELECT id + 1 AS id FROM app.events;",
    ]


def test_a_dictionary_comment_change_does_not_replace_the_dictionary() -> None:
    assert _sql_of([_objects("old")[3]], [_objects("new")[3]]) == [
        "ALTER TABLE app.d MODIFY COMMENT 'new';"
    ]


def test_a_refresh_and_comment_change_are_two_alters() -> None:
    def mv(every: str, comment: str) -> SchemaDefinition:
        return materialized_view(
            database="app",
            name="rmv",
            to={"database": "app", "name": "events"},
            refresh={"every": every},
            as_="SELECT id FROM app.src",
            comment=comment,
        )

    assert _sql_of([mv("1 HOUR", "old")], [mv("2 HOUR", "new")]) == [
        "ALTER TABLE app.rmv MODIFY COMMENT 'new';",
        "ALTER TABLE app.rmv MODIFY REFRESH EVERY 2 HOUR;",
    ]


def _column_plan(old: ColumnDefinition, new: ColumnDefinition) -> list[tuple[str, str, str]]:
    plan = plan_diff([_events(None, [old])], [_events(None, [new])])
    return [(op.type, op.risk, op.sql) for op in plan.operations]


def test_adding_or_changing_only_a_column_comment_is_comment_column() -> None:
    assert _column_plan(
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="id", type="UInt64", comment="trail\\"),
    ) == [
        (
            "alter_table_modify_column",
            "safe",
            "ALTER TABLE app.events COMMENT COLUMN `id` 'trail\\\\';",
        )
    ]
    assert _column_plan(
        ColumnDefinition(name="id", type="UInt64", comment="old"),
        ColumnDefinition(name="id", type="UInt64", comment="it's"),
    ) == [
        ("alter_table_modify_column", "safe", "ALTER TABLE app.events COMMENT COLUMN `id` 'it''s';")
    ]


def test_removing_only_a_column_comment_is_remove_comment() -> None:
    assert _column_plan(
        ColumnDefinition(name="id", type="UInt64", comment="old"),
        ColumnDefinition(name="id", type="UInt64"),
    ) == [
        (
            "alter_table_modify_column",
            "safe",
            "ALTER TABLE app.events MODIFY COLUMN `id` REMOVE COMMENT;",
        )
    ]


def test_a_type_change_keeps_modify_column_with_the_new_comment() -> None:
    assert _column_plan(
        ColumnDefinition(name="id", type="UInt32", comment="old"),
        ColumnDefinition(name="id", type="UInt64", comment="new"),
    ) == [
        (
            "alter_table_modify_column",
            "caution",
            "ALTER TABLE app.events MODIFY COLUMN `id` UInt64 COMMENT 'new';",
        )
    ]


def test_a_type_change_that_removes_the_comment_runs_remove_comment_first() -> None:
    assert _column_plan(
        ColumnDefinition(name="id", type="UInt32", comment="old"),
        ColumnDefinition(name="id", type="UInt64"),
    ) == [
        (
            "alter_table_modify_column",
            "safe",
            "ALTER TABLE app.events MODIFY COLUMN `id` REMOVE COMMENT;",
        ),
        ("alter_table_modify_column", "caution", "ALTER TABLE app.events MODIFY COLUMN `id` UInt64;"),
    ]


# ---------- DDL wait, drift, pull (TS alter-column-statement, drift, plugin-pull tests) ----------


def test_the_ddl_wait_reads_the_comment_comment_column_sets() -> None:
    assert parse_modify_column_intent(
        "ALTER TABLE t COMMENT COLUMN `id` 'a\\\\b it''s';", "id"
    ) == ColumnIntent(comment="a\\b it's")
    assert parse_modify_column_intent(
        "ALTER TABLE t COMMENT COLUMN IF EXISTS id '';", "id"
    ) == ColumnIntent(comment="")
    assert parse_modify_column_intent("ALTER TABLE t COMMENT COLUMN other 'x';", "id") == (
        ColumnIntent()
    )


def test_drift_reports_a_changed_comment_on_any_object_kind_with_both_values() -> None:
    drift = compare_object_comments(
        [
            SchemaObjectShape(kind="table", database="app", name="events", comment="a\\b"),
            SchemaObjectShape(kind="view", database="app", name="v"),
            SchemaObjectShape(
                kind="materialized_view", database="app", name="mv", comment="same"
            ),
            SchemaObjectShape(kind="dictionary", database="app", name="d", comment="dict"),
            SchemaObjectShape(kind="table", database="app", name="missing", comment="x"),
        ],
        [
            SchemaObjectShape(kind="table", database="app", name="events", comment="a\\b"),
            SchemaObjectShape(kind="view", database="app", name="v", comment="server"),
            SchemaObjectShape(
                kind="materialized_view", database="app", name="mv", comment="same"
            ),
            SchemaObjectShape(kind="dictionary", database="app", name="d", comment=""),
        ],
    )
    assert [(d.code, d.object, d.expected, d.actual) for d in drift] == [
        ("comment_mismatch", "app.v", "", "server"),
        ("comment_mismatch", "app.d", "dict", ""),
    ]


def test_pull_skips_an_as_inside_the_comment_literal() -> None:
    assert (
        parse_as_clause(
            "CREATE VIEW db.v (`id` UInt64) COMMENT 'it\\'s a view AS x' AS SELECT id FROM db.events"
        )
        == "SELECT id FROM db.events"
    )
    assert (
        parse_as_clause(
            "CREATE MATERIALIZED VIEW db.mv TO db.totals (`id` UInt64) "
            "COMMENT 'sums AS totals' AS SELECT id, note FROM db.src"
        )
        == "SELECT id, note FROM db.src"
    )


def test_pull_ignores_a_to_inside_the_comment_of_an_inner_storage_view() -> None:
    assert (
        parse_to_clause(
            "CREATE MATERIALIZED VIEW db.mv (`id` UInt64) ENGINE = MergeTree ORDER BY id "
            "COMMENT 'maps x TO y' AS SELECT id FROM db.src",
            "db",
        )
        is None
    )


class _Rows:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows


class _PullClient:
    """system.tables / system.columns as ClickHouse reports them for one database."""

    def query(self, sql: str) -> _Rows:
        if "system.columns" in sql:
            return _Rows(
                [{"database": "db", "table": "t", "name": "id", "type": "UInt64", "position": 1}]
            )
        if "system.data_skipping_indices" in sql:
            return _Rows([])
        return _Rows(
            [
                {
                    "database": "db",
                    "name": "t",
                    "engine": "MergeTree",
                    "create_table_query": "CREATE TABLE db.t (`id` UInt64) ENGINE = MergeTree "
                    "ORDER BY id COMMENT 'line1\\nline2 back\\\\slash'",
                    "comment": "line1\nline2 back\\slash",
                },
                {
                    "database": "db",
                    "name": "inner_mv",
                    "engine": "MaterializedView",
                    "create_table_query": "CREATE MATERIALIZED VIEW db.inner_mv (`id` UInt64) "
                    "ENGINE = MergeTree ORDER BY id AS SELECT id FROM db.t",
                    "comment": "",
                },
            ]
        )


def test_pull_reads_the_decoded_comment_and_warns_about_an_inner_storage_view() -> None:
    definitions, warnings = _pull_definitions(_PullClient(), ["db"])
    assert [(d.kind, d.name, d.comment) for d in definitions] == [
        ("table", "t", "line1\nline2 back\\slash")
    ]
    assert warnings == [
        'Materialized view "db.inner_mv" stores its rows in an inner table (it has no TO '
        "table), which the schema DSL does not support. Pull skipped the view and its inner "
        "table."
    ]


def test_pull_renders_each_comment_so_python_reads_it_back_exactly() -> None:
    comment = "".join(c for c, _ in EDGE_COMMENTS)
    content = render_schema_file(
        [
            _events(comment, [ColumnDefinition(name="id", type="UInt64", comment=comment)]),
            view(database="app", name="v", as_="SELECT id FROM app.events", comment=comment),
        ]
    )
    namespace: dict[str, object] = {}
    exec(compile(content, "pulled.py", "exec"), namespace)
    definitions = cast(list[SchemaDefinition], namespace["definitions"])
    assert [d.comment for d in definitions] == [comment, comment]
    assert cast(TableDefinition, definitions[0]).columns[0].comment == comment
