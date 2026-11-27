"""Port of ``packages/core/src/planner-dependency-order.test.ts`` (#231)."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from collections.abc import Callable
from typing import Any

import pytest

from chkit.core.canonical import canonicalize_definitions
from chkit.core.column_cycle_repair import _cycle_repair_work
from chkit.core.column_order import order_column_statements
from chkit.core.column_reads import _column_default_reads, column_rename_key
from chkit.core.model import (
    ColumnRenameSuggestion,
    DictionaryDefinition,
    MaterializedViewDefinition,
    MigrationOperation,
    SchemaDefinition,
    SQLExpression,
    TableDefinition,
    ViewDefinition,
    dictionary,
    materialized_view,
    table,
    view,
)
from chkit.core.object_dependencies import build_dependency_graph, order_by_dependencies
from chkit.core.planner import plan_diff


def app_table(name: str, columns: list[dict[str, Any]] | None = None) -> TableDefinition:
    return table(
        database="app",
        name=name,
        columns=list(columns or [{"name": "id", "type": "UInt64"}]),
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )


def app_view(name: str, as_: str) -> ViewDefinition:
    return view(database="app", name=name, as_=as_)


def app_dictionary(name: str, source: str) -> DictionaryDefinition:
    return dictionary(
        database="app",
        name=name,
        attributes=[{"name": "id", "type": "UInt64"}, {"name": "name", "type": "String"}],
        primary_key=["id"],
        source=source,
        layout="FLAT()",
        lifetime="0",
    )


def object_ops(old: list[SchemaDefinition], new: list[SchemaDefinition]) -> list[str]:
    return [
        f"{op.type} {op.key}"
        for op in plan_diff(old, new).operations
        if op.type != "create_database"
    ]


def edges_of(definitions: list[SchemaDefinition], key: str) -> list[str]:
    return sorted(build_dependency_graph(canonicalize_definitions(definitions)).get(key, set()))


def quote(name: str) -> str:
    """Backtick-quote a name the way TS's renderQualifiedName does (#230)."""
    escaped = name.replace("\\", "\\\\").replace("`", "\\`")
    return f"`{escaped}`"


# ---------- materialized view query dependency order ----------


def query_mv(as_: str, name: str = "mv", target: str = "out") -> MaterializedViewDefinition:
    return materialized_view(database="app", name=name, to={"database": "app", "name": target}, as_=as_)


def plan_types(old: list[SchemaDefinition], next_: list[SchemaDefinition]) -> list[str]:
    return [op.type for op in plan_diff(old, next_).operations]


_ID = {"name": "id", "type": "UInt64"}


_OLD_QUERY = "SELECT id FROM app.src"
_NEW_QUERY = "SELECT id FROM app.src WHERE id > 0"


@pytest.mark.parametrize(
    ("name", "drop", "op"),
    [
        ("src", False, "alter_table_add_column"),
        ("src", True, "alter_table_drop_column"),
        ("out", False, "alter_table_add_column"),
    ],
    ids=["add-source-column", "drop-source-column", "add-target-column"],
)
def test_mv_query_recreates_view_when_migration_changes_a_column(name: str, drop: bool, op: str) -> None:
    plain = app_table(name)
    extra = app_table(name, [_ID, {"name": "tag", "type": "String"}])
    other = app_table("out" if name == "src" else "src")
    assert plan_types(
        [extra if drop else plain, other, query_mv(_OLD_QUERY)],
        [plain if drop else extra, other, query_mv(_NEW_QUERY)],
    ) == ["drop_materialized_view", op, "create_materialized_view"]


def test_mv_query_changes_in_place_and_keeps_unrelated_column_statements_in_order() -> None:
    src = app_table("src")
    out = app_table("out")
    old = app_table("src:column:x", [_ID, {"name": "legacy", "type": "String"}])
    next_ = app_table("src:column:x", [_ID, {"name": "fresh", "type": "UInt64"}])
    assert plan_types(
        [src, out, old, query_mv(_OLD_QUERY)],
        [src, out, next_, query_mv(_NEW_QUERY)],
    ) == ["alter_materialized_view_modify_query", "alter_table_add_column", "alter_table_drop_column"]


def test_mv_query_recreates_view_when_migration_changes_source_column_type() -> None:
    def tagged(type_: str) -> TableDefinition:
        return app_table("src", [_ID, {"name": "tag", "type": type_}])

    plan = plan_diff(
        [tagged("String"), app_table("out"), query_mv(_OLD_QUERY)],
        [tagged("UInt64"), app_table("out"), query_mv(_NEW_QUERY)],
    )
    assert [op.type for op in plan.operations] == [
        "drop_materialized_view",
        "alter_table_modify_column",
        "create_materialized_view",
    ]


def test_mv_query_recreates_view_reading_recreated_view_through_unchanged_view() -> None:
    shared = [
        app_table("src"),
        app_table("out"),
        app_table("up_out"),
        app_view("up_view", "SELECT id FROM app.a_up"),
    ]
    joined = "SELECT s.id AS id FROM app.src AS s INNER JOIN app.up_view AS u ON s.id = u.id"
    plan = plan_diff(
        [
            app_table("base"),
            *shared,
            query_mv("SELECT id FROM app.base", "a_up", "up_out"),
            query_mv(_OLD_QUERY, "z_down"),
        ],
        [
            app_table("base", [_ID, {"name": "spare", "type": "UInt64"}]),
            *shared,
            query_mv("SELECT id FROM app.base WHERE id > 0", "a_up", "up_out"),
            query_mv(joined, "z_down"),
        ],
    )
    assert [op.type for op in plan.operations] == [
        "drop_materialized_view",
        "drop_materialized_view",
        "alter_table_add_column",
        "create_materialized_view",
        "create_materialized_view",
    ]


def test_mv_query_recreates_view_and_preserves_order_when_nested_column_becomes_scalar() -> None:
    old = app_table("src", [_ID, {"name": "k.x", "type": "Array(UInt32)"}])
    next_ = app_table(
        "src",
        [
            _ID,
            {"name": "k", "type": "UInt64", "default": SQLExpression(expression="n")},
            {"name": "n", "type": "UInt64"},
        ],
    )
    out = app_table("out")
    plan = plan_diff([old, out, query_mv(_OLD_QUERY)], [next_, out, query_mv(_NEW_QUERY)])
    assert [(op.type, op.key) for op in plan.operations] == [
        ("drop_materialized_view", "materialized_view:app.mv"),
        ("alter_table_drop_column", "table:app.src:column:k.x"),
        ("alter_table_add_column", "table:app.src:column:n"),
        ("alter_table_add_column", "table:app.src:column:k"),
        ("create_materialized_view", "materialized_view:app.mv"),
    ]


def test_mv_query_recreates_view_when_either_query_reads_renamed_table() -> None:
    src = app_table("src")
    out = app_table("out")
    lookup = app_table("renamed_lookup")
    previous_table_aliases = {"app.lookup": "table:app.renamed_lookup"}
    for before, after in (
        (query_mv("SELECT id FROM app.src WHERE id IN app.lookup"), query_mv(_NEW_QUERY)),
        (query_mv(_OLD_QUERY), query_mv("SELECT id FROM app.src WHERE id IN app.renamed_lookup")),
    ):
        plan = plan_diff(
            [src, out, lookup, before],
            [src, out, lookup, after],
            previous_table_aliases=previous_table_aliases,
        )
        assert [op.type for op in plan.operations] == ["drop_materialized_view", "create_materialized_view"]


def test_mv_query_recreates_view_reading_upstream_mv_whose_query_changes() -> None:
    src = app_table("src")
    up_out = app_table("up_out", [_ID, {"name": "extra", "type": "UInt64"}])
    out = app_table("out")
    assert plan_types(
        [
            src, up_out, out,
            query_mv("SELECT id FROM app.src", "z_up", "up_out"),
            query_mv("SELECT id FROM app.z_up", "a_down"),
        ],
        [
            src, up_out, out,
            query_mv("SELECT id, id AS extra FROM app.src", "z_up", "up_out"),
            query_mv("SELECT extra AS id FROM app.z_up", "a_down"),
        ],
    ) == ["drop_materialized_view", "alter_materialized_view_modify_query", "create_materialized_view"]


def test_mv_query_recreates_view_when_either_query_uses_unqualified_object_name() -> None:
    src = app_table("src")
    out = app_table("out")
    for query in (
        "SELECT id FROM src WHERE id > 0",
        "SELECT id FROM app.src WHERE id IN allowed",
        "SELECT id FROM app.src WHERE dictHas('allowed', id)",
        "SELECT id FROM app.src WHERE dictHas(allowed, id)",
    ):
        for before, after in ((_OLD_QUERY, query), (query, _OLD_QUERY)):
            assert plan_types(
                [src, out, query_mv(before)], [src, out, query_mv(after)]
            ) == ["drop_materialized_view", "create_materialized_view"]
    assert plan_types(
        [src, out, query_mv("SELECT id FROM app.src")],
        [src, out, query_mv("WITH events AS (SELECT id FROM app.src) SELECT id FROM events")],
    ) == ["alter_materialized_view_modify_query"]


def test_mv_query_drops_changed_view_before_object_its_old_query_reads() -> None:
    src = app_table("src")
    out = app_table("out")
    assert plan_types(
        [
            src, out, app_table("allowed"),
            query_mv("SELECT id FROM app.src WHERE id IN (SELECT id FROM app.allowed)"),
        ],
        [src, out, query_mv("SELECT id FROM app.src")],
    ) == ["drop_materialized_view", "drop_table", "create_materialized_view"]

    old_up = query_mv("SELECT id FROM app.src", "z_up", "up_out")
    new_up = query_mv("SELECT id FROM src WHERE id > 0", "z_up", "up_out")
    old_down = query_mv("SELECT id FROM app.z_up", "a_down")
    new_down = query_mv("SELECT id FROM app.src", "a_down")
    up_out = app_table("up_out")
    cascade = plan_diff([src, out, up_out, old_up, old_down], [src, out, up_out, new_up, new_down])
    assert [(op.type, op.key) for op in cascade.operations] == [
        ("drop_materialized_view", "materialized_view:app.a_down"),
        ("drop_materialized_view", "materialized_view:app.z_up"),
        ("create_materialized_view", "materialized_view:app.a_down"),
        ("create_materialized_view", "materialized_view:app.z_up"),
    ]


# ---------- plan_diff dependency order ----------


def test_issue_repro_changed_view_recreated_before_changed_view_reading_it() -> None:
    person = table(
        database="brain",
        name="person_identity",
        columns=[{"name": "person_id", "type": "UInt64"}],
        engine="MergeTree()",
        primary_key=["person_id"],
        order_by=["person_id"],
    )

    def lemlist(as_: str) -> ViewDefinition:
        return view(database="brain", name="lemlist_activities", as_=as_)

    def funnel(as_: str) -> ViewDefinition:
        return view(database="brain", name="funnel_signals", as_=as_)

    ops = object_ops(
        [person, lemlist("SELECT 1 AS person_id"), funnel("SELECT 0 AS x")],
        [
            person,
            lemlist("SELECT 2 AS person_id"),
            funnel(
                "WITH people AS (SELECT * FROM brain.person_identity) SELECT * FROM people "
                "JOIN brain.lemlist_activities USING (person_id)"
            ),
        ],
    )
    assert ops == [
        "drop_view view:brain.funnel_signals",
        "drop_view view:brain.lemlist_activities",
        "create_view view:brain.lemlist_activities",
        "create_view view:brain.funnel_signals",
    ]


def test_three_level_chain_whose_names_sort_backwards_is_created_bottom_up() -> None:
    ops = object_ops(
        [],
        [
            app_view("a_top", "SELECT * FROM app.b_mid"),
            app_view("b_mid", "SELECT * FROM app.c_base"),
            app_view("c_base", "SELECT 1 AS id"),
        ],
    )
    assert ops == [
        "create_view view:app.c_base",
        "create_view view:app.b_mid",
        "create_view view:app.a_top",
    ]


def test_rollup_cascade_with_digit_led_names_is_created_in_order() -> None:
    ops = object_ops(
        [],
        [
            app_table("events"),
            app_view("1m_rollup", "SELECT id FROM app.events"),
            app_view("1h_rollup", "SELECT id FROM app.1m_rollup"),
            app_view("1d_rollup", "SELECT id FROM app.1h_rollup"),
        ],
    )
    assert ops == [
        "create_table table:app.events",
        "create_view view:app.1m_rollup",
        "create_view view:app.1h_rollup",
        "create_view view:app.1d_rollup",
    ]


def test_diamond_places_shared_base_first_and_keeps_key_order_for_siblings() -> None:
    ops = object_ops(
        [],
        [
            app_view("a", "SELECT * FROM app.b JOIN app.c USING (id)"),
            app_view("b", "SELECT * FROM app.d"),
            app_view("c", "SELECT * FROM app.d"),
            app_view("d", "SELECT 1 AS id"),
        ],
    )
    assert ops == [
        "create_view view:app.d",
        "create_view view:app.b",
        "create_view view:app.c",
        "create_view view:app.a",
    ]


def test_dependency_cycle_keeps_members_in_key_order_and_dependents_after() -> None:
    defs: list[SchemaDefinition] = [
        app_view("a_reader", "SELECT * FROM app.m"),
        app_view("m", "SELECT * FROM app.n"),
        app_view("n", "SELECT * FROM app.m"),
    ]
    expected = ["create_view view:app.m", "create_view view:app.n", "create_view view:app.a_reader"]
    assert object_ops([], defs) == expected
    assert object_ops([], list(reversed(defs))) == expected


def test_view_calling_dict_get_is_created_after_the_dictionary() -> None:
    ops = object_ops(
        [],
        [
            app_table("users"),
            app_dictionary("users_dict", "CLICKHOUSE(TABLE 'users' DB 'app')"),
            app_view("a_named", "SELECT id, dictGet('app.users_dict', 'name', id) AS n FROM app.users"),
        ],
    )
    assert ops == [
        "create_table table:app.users",
        "create_dictionary dictionary:app.users_dict",
        "create_view view:app.a_named",
    ]


def test_view_reading_materialized_view_is_created_after_it() -> None:
    ops = object_ops(
        [],
        [
            app_table("events"),
            app_table("users"),
            materialized_view(
                database="app",
                name="mv",
                to={"database": "app", "name": "events"},
                as_="SELECT id FROM app.users",
            ),
            app_view("a_reads_mv", "SELECT * FROM app.mv"),
        ],
    )
    assert ops == [
        "create_table table:app.events",
        "create_table table:app.users",
        "create_materialized_view materialized_view:app.mv",
        "create_view view:app.a_reads_mv",
    ]


def test_table_whose_default_calls_dict_get_is_created_after_the_dictionary() -> None:
    for default in ["fn:dictGet('app.users_dict', 'name', id)",
                    {"expression": "dictGet('app.users_dict', 'name', id)"}]:
        ops = object_ops(
            [],
            [
                app_table("users"),
                app_dictionary("users_dict", "CLICKHOUSE(TABLE 'users' DB 'app')"),
                app_table("events", [
                    {"name": "id", "type": "UInt64"},
                    {"name": "name", "type": "String", "default": default},
                ]),
            ],
        )
        assert ops == [
            "create_table table:app.users",
            "create_dictionary dictionary:app.users_dict",
            "create_table table:app.events",
        ]


def test_dictionary_named_by_bare_or_quoted_identifier_is_created_first() -> None:
    ops = object_ops(
        [],
        [
            app_table("users"),
            app_dictionary("users_dict", "CLICKHOUSE(TABLE 'users' DB 'app')"),
            app_view("a_named", "SELECT id, dictGet(users_dict, 'name', id) AS n FROM app.users"),
            app_view("a_rows", "SELECT * FROM dictionary(`users_dict`)"),
            app_table("a_events", [
                {"name": "id", "type": "UInt64"},
                {"name": "known", "type": "UInt8", "default": "fn:dictHas(users_dict, id)"},
            ]),
        ],
    )
    assert ops == [
        "create_table table:app.users",
        "create_dictionary dictionary:app.users_dict",
        "create_table table:app.a_events",
        "create_view view:app.a_named",
        "create_view view:app.a_rows",
    ]


def test_materialized_alias_and_ephemeral_dict_get_expressions_are_ordered_like_default() -> None:
    src = app_table("src")
    d = app_dictionary("d", "CLICKHOUSE(TABLE 'src' DB 'app')")
    readers: list[SchemaDefinition] = [
        app_table(f"a_{kind.lower()}", [
            {"name": "id", "type": "UInt64"},
            {"name": "name", "type": "String", "default_kind": kind,
             "default": "fn:dictGet('app.d', 'name', id)"},
        ])
        for kind in ("MATERIALIZED", "ALIAS", "EPHEMERAL")
    ]
    assert object_ops([], [src, d, *readers]) == [
        "create_table table:app.src",
        "create_dictionary dictionary:app.d",
        "create_table table:app.a_alias",
        "create_table table:app.a_ephemeral",
        "create_table table:app.a_materialized",
    ]
    assert object_ops([src, d, *readers], []) == [
        "drop_table table:app.a_alias",
        "drop_table table:app.a_ephemeral",
        "drop_table table:app.a_materialized",
        "drop_dictionary dictionary:app.d",
        "drop_table table:app.src",
    ]


def test_names_inside_literals_heredocs_and_comments_are_not_references() -> None:
    ops = object_ops(
        [],
        [
            app_view(
                "a",
                "SELECT 'app.b' AS s, $$FROM app.b$$ AS h, 1 AS one /* FROM app.b */ -- JOIN app.b",
            ),
            app_view("a2", "SELECT 1 AS one // JOIN app.b"),
            app_view("b", "SELECT 1 AS id"),
        ],
    )
    assert ops == ["create_view view:app.a", "create_view view:app.a2", "create_view view:app.b"]


def test_quoted_identifiers_and_comments_around_the_dot_still_form_a_reference() -> None:
    expected = ["create_view view:app.b", "create_view view:app.a"]
    assert object_ops(
        [], [app_view("a", "SELECT * FROM `app`.`b`"), app_view("b", "SELECT 1 AS id")]
    ) == expected
    assert object_ops(
        [], [app_view("a", "SELECT * FROM app /* x */ . /* y */ b"), app_view("b", "SELECT 1 AS id")]
    ) == expected


def test_unqualified_target_resolves_against_view_database_cte_names_excluded() -> None:
    assert object_ops(
        [], [app_view("a", "SELECT * FROM b"), app_view("b", "SELECT 1 AS id")]
    ) == ["create_view view:app.b", "create_view view:app.a"]
    assert object_ops(
        [],
        [
            app_view("a", "WITH b AS (SELECT 1 AS id) SELECT id FROM b"),
            app_view("b", "SELECT 1 AS id"),
        ],
    ) == ["create_view view:app.a", "create_view view:app.b"]
    assert object_ops(
        [],
        [app_view("a", "SELECT * FROM b"), view(database="other", name="b", as_="SELECT 1 AS id")],
    ) == ["create_view view:app.a", "create_view view:other.b"]


def test_cte_inside_subquery_does_not_hide_same_named_view_outside_it() -> None:
    ops = object_ops(
        [],
        [
            app_view(
                "a_report",
                "SELECT x.id FROM (WITH b AS (SELECT 1 AS id) SELECT id FROM b) AS x "
                "JOIN b USING (id)",
            ),
            app_view("b", "SELECT 1 AS id"),
        ],
    )
    assert ops == ["create_view view:app.b", "create_view view:app.a_report"]


def test_cte_with_column_list_or_materialized_does_not_form_false_cycle() -> None:
    def plan(cte: str) -> list[str]:
        return object_ops(
            [],
            [
                app_view("a_outer", "SELECT x FROM m_inner"),
                app_view("m_inner", f"WITH {cte} SELECT x FROM a_outer"),
            ],
        )

    expected = ["create_view view:app.m_inner", "create_view view:app.a_outer"]
    assert plan("a_outer(x) AS (SELECT 1 AS x)") == expected
    assert plan("a_outer AS MATERIALIZED (SELECT 1 AS x)") == expected


def test_array_join_arguments_and_from_inside_function_calls_are_not_references() -> None:
    ops = object_ops(
        [],
        [
            app_view("a", "SELECT id, tag, EXTRACT(DAY FROM b) AS d FROM app.t ARRAY JOIN tags AS tag"),
            app_view("b", "SELECT 1 AS id"),
            app_view("tags", "SELECT 1 AS id"),
        ],
    )
    assert ops == ["create_view view:app.a", "create_view view:app.b", "create_view view:app.tags"]


def test_is_distinct_from_operands_are_not_table_references() -> None:
    ops = object_ops(
        [],
        [
            app_view("a", "SELECT x IS DISTINCT FROM b AS d1, x IS NOT DISTINCT FROM b AS d2 FROM app.t"),
            app_view("b", "SELECT 1 AS id"),
        ],
    )
    assert ops == ["create_view view:app.a", "create_view view:app.b"]


def test_drops_run_dependents_first() -> None:
    ops = object_ops(
        [app_view("a_base", "SELECT 1 AS id"), app_view("z_top", "SELECT * FROM app.a_base")], []
    )
    assert ops == ["drop_view view:app.z_top", "drop_view view:app.a_base"]


def test_table_reading_dictionary_dropped_before_it_and_dictionary_before_source() -> None:
    ops = object_ops(
        [
            app_table("src"),
            app_dictionary("d", "CLICKHOUSE(TABLE 'src' DB 'app')"),
            app_table("t2", [
                {"name": "id", "type": "UInt64"},
                {"name": "name", "type": "String", "default": "fn:dictGet('app.d', 'name', id)"},
            ]),
        ],
        [],
    )
    assert ops == [
        "drop_table table:app.t2",
        "drop_dictionary dictionary:app.d",
        "drop_table table:app.src",
    ]


def test_plan_without_dependencies_keeps_rank_key_order() -> None:
    defs: list[SchemaDefinition] = [
        app_view("v2", "SELECT 1 AS id"),
        app_table("t2"),
        app_dictionary("d1", "MYSQL(host 'db' db 'x' table 'y')"),
        app_view("v1", "SELECT 2 AS id"),
        app_table("t1"),
    ]
    assert [op.key for op in plan_diff([], defs).operations] == [
        "database:app",
        "table:app.t1",
        "table:app.t2",
        "view:app.v1",
        "view:app.v2",
        "dictionary:app.d1",
    ]
    assert [op.key for op in plan_diff(defs, []).operations] == [
        "dictionary:app.d1",
        "table:app.t1",
        "table:app.t2",
        "view:app.v1",
        "view:app.v2",
    ]


def test_reordering_keeps_column_remove_right_before_its_modify_column() -> None:
    # Removing a column's expression is its own operation, with the MODIFY
    # COLUMN's key, and must run first: ClickHouse would cast the retained 'abc'
    # to Int64 and fail.
    def events(columns: list[dict[str, Any]]) -> TableDefinition:
        return app_table("events", [{"name": "id", "type": "UInt64"}, *columns])

    plan = plan_diff(
        [
            events([{"name": "a_old", "type": "String"},
                    {"name": "code", "type": "String", "default": "abc"}]),
            app_view("a_top", "SELECT * FROM app.z_base"),
            app_view("z_base", "SELECT 1 AS id"),
        ],
        [
            events([{"name": "code", "type": "Int64"}, {"name": "note", "type": "String"}]),
            app_view("a_top", "SELECT id FROM app.z_base"),
            app_view("z_base", "SELECT 2 AS id"),
        ],
    )
    assert [f"{op.type} {op.key}" for op in plan.operations] == [
        "drop_view view:app.a_top",
        "drop_view view:app.z_base",
        "alter_table_drop_column table:app.events:column:a_old",
        "alter_table_modify_column table:app.events:column:code",
        "alter_table_modify_column table:app.events:column:code",
        "alter_table_add_column table:app.events:column:note",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]
    assert [
        op.sql for op in plan.operations if op.key == "table:app.events:column:code"
    ] == [
        "ALTER TABLE app.events MODIFY COLUMN `code` REMOVE DEFAULT;",
        "ALTER TABLE app.events MODIFY COLUMN `code` Int64;",
    ]


# ---------- build_dependency_graph ----------


def test_graph_resolves_only_to_definitions_in_the_set_and_never_to_itself() -> None:
    assert edges_of(
        [
            app_view("v", "SELECT * FROM app.v JOIN app.missing USING (id) JOIN app.t USING (id)"),
            app_table("t"),
        ],
        "view:app.v",
    ) == ["table:app.t"]


def test_materialized_views_depend_on_to_target_and_depends_on_views() -> None:
    defs: list[SchemaDefinition] = [
        app_table("target"),
        materialized_view(
            database="app",
            name="base",
            to={"database": "app", "name": "target"},
            refresh={"every": "1 HOUR"},
            as_="SELECT 1 AS id",
        ),
        materialized_view(
            database="app",
            name="dep",
            to={"database": "app", "name": "target"},
            refresh={"every": "1 HOUR", "dependsOn": [{"database": "app", "name": "base"}]},
            as_="SELECT 1 AS id",
        ),
    ]
    assert edges_of(defs, "materialized_view:app.dep") == [
        "materialized_view:app.base",
        "table:app.target",
    ]


def test_clickhouse_dictionary_source_is_a_reference_in_table_and_query_form() -> None:
    defs: list[SchemaDefinition] = [
        app_table("src"),
        app_table("qsrc"),
        app_dictionary("by_table", "clickhouse(table 'src' user 'default')"),
        app_dictionary("by_query", "CLICKHOUSE(QUERY 'SELECT id, name FROM app.qsrc')"),
        app_dictionary("external", "MYSQL(host 'db' table 'src')"),
    ]
    assert edges_of(defs, "dictionary:app.by_table") == ["table:app.src"]
    assert edges_of(defs, "dictionary:app.by_query") == ["table:app.qsrc"]
    assert edges_of(defs, "dictionary:app.external") == []


def test_dict_get_family_join_get_and_dictionary_name_arguments_are_references() -> None:
    defs: list[SchemaDefinition] = [
        app_dictionary("d", "MYSQL(host 'x')"),
        app_table("j"),
        app_view(
            "v",
            "SELECT dictGetOrDefault('app.d', 'name', id, '') AS a, joinGet('app.j', 'v', id) AS b "
            "FROM dictionary('d')",
        ),
    ]
    assert edges_of(defs, "view:app.v") == ["dictionary:app.d", "table:app.j"]


def test_bare_or_quoted_identifier_name_argument_is_a_reference_in_object_database() -> None:
    defs: list[SchemaDefinition] = [
        app_table("app"),
        app_dictionary("d", "MYSQL(host 'x')"),
        app_table("j"),
        app_view("v1", "SELECT dictGet(d, 'name', id) AS a, joinGet(`j`, 'v', id) AS b FROM app.t"),
        app_view("v2", "SELECT * FROM dictionary(d)"),
        app_view("v3", "SELECT dictGet(app.d, 'name', id) AS a"),
        app_view(
            "v4",
            "SELECT dictGet(concat('a', 'pp.d'), 'name', id) AS a, dictGet(d.x, 'name', id) AS b",
        ),
    ]
    assert edges_of(defs, "view:app.v1") == ["dictionary:app.d", "table:app.j"]
    assert edges_of(defs, "view:app.v2") == ["dictionary:app.d"]
    # `app.d` is one qualified name, not the name `app` in the view's database.
    assert edges_of(defs, "view:app.v3") == ["dictionary:app.d"]
    # A function call or another database's object is not a name in app.
    assert edges_of(defs, "view:app.v4") == []


def _cte_edges(as_: str) -> list[str]:
    targets: list[SchemaDefinition] = [
        app_view("b", "SELECT 1 AS id"),
        app_view("r", "SELECT 1 AS n"),
        app_view("x", "SELECT 1 AS id"),
    ]
    return edges_of([*targets, app_view("v", as_)], "view:app.v")


def test_cte_hides_same_named_object_after_its_body_in_scope_only() -> None:
    assert _cte_edges("WITH b AS (SELECT 1 AS id) SELECT * FROM (SELECT id FROM b)") == []
    assert _cte_edges("WITH b AS (SELECT 1 AS id) SELECT id FROM b UNION ALL SELECT id FROM b") == []
    assert _cte_edges("WITH x AS (SELECT 1 AS id), b AS (SELECT id FROM x) SELECT id FROM b") == []
    # Without RECURSIVE, a CTE body that names its own CTE reads the real object.
    assert _cte_edges("WITH b AS (SELECT id + 1 AS id FROM b) SELECT id FROM b") == ["view:app.b"]
    assert _cte_edges(
        "WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r"
    ) == []
    assert _cte_edges(
        "SELECT id FROM (WITH b AS (SELECT 1 AS id) SELECT id FROM b) JOIN b USING (id)"
    ) == ["view:app.b"]


def test_cte_with_column_list_or_materialized_hides_same_named_object() -> None:
    assert _cte_edges("WITH b(id) AS (SELECT 1) SELECT id FROM b") == []
    assert _cte_edges("WITH b AS MATERIALIZED (SELECT 1 AS id) SELECT id FROM b") == []
    assert _cte_edges("WITH b (id) AS MATERIALIZED (SELECT 1) SELECT * FROM (SELECT id FROM b)") == []
    assert _cte_edges("WITH x AS (SELECT 1 AS i), b(id) AS (SELECT i FROM x) SELECT id FROM b") == []
    assert _cte_edges(
        "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r"
    ) == []
    # As in the plain form, a non-recursive CTE body that names its own CTE reads the real object.
    assert _cte_edges("WITH b(id) AS (SELECT id FROM b) SELECT id FROM b") == ["view:app.b"]
    assert _cte_edges("WITH b AS MATERIALIZED (SELECT id FROM b) SELECT id FROM b") == ["view:app.b"]
    # `name(args) AS alias` in a WITH list is an expression alias, not a CTE.
    assert _cte_edges("WITH lower(x) AS b SELECT b FROM b") == ["view:app.b"]


def test_window_names_declare_nothing() -> None:
    w = app_table("w")
    assert edges_of(
        [w, app_view("v", "SELECT id, count() OVER w AS c FROM w WINDOW w AS (ORDER BY id)")],
        "view:app.v",
    ) == ["table:app.w"]
    # The WITH list ends at its SELECT, so `, w AS (` in the WINDOW clause is not a CTE.
    assert edges_of(
        [
            w,
            app_view(
                "v",
                "WITH c AS (SELECT 1 AS id) SELECT id FROM c WINDOW x AS (ORDER BY id), "
                "w AS (ORDER BY id) UNION ALL SELECT id FROM w",
            ),
        ],
        "view:app.v",
    ) == ["table:app.w"]
    assert edges_of(
        [
            w,
            app_view(
                "v",
                "SELECT id FROM app.t GROUP BY id WITH TOTALS WINDOW x AS (ORDER BY id), "
                "w AS (ORDER BY id) UNION ALL SELECT id FROM w",
            ),
        ],
        "view:app.v",
    ) == ["table:app.w"]


def test_quoted_names_resolve_to_raw_definition_names() -> None:
    names = ["events v1", "we`ird", "back\\slash", "1m_rollup", "select"]
    reader = view(
        database="my-db",
        name="reader",
        as_="SELECT * FROM "
        + " CROSS JOIN ".join(f"{quote('my-db')}.{quote(name)}" for name in names),
    )
    defs: list[SchemaDefinition] = [
        *(view(database="my-db", name=name, as_="SELECT 1 AS id") for name in names),
        reader,
    ]
    assert edges_of(defs, "view:my-db.reader") == sorted(f"view:my-db.{name}" for name in names)


def test_column_path_references_the_table_only() -> None:
    defs: list[SchemaDefinition] = [
        app_table("t"),
        view(database="t", name="id", as_="SELECT 1 AS id"),
        app_view("v", "SELECT app.t.id FROM app.t"),
    ]
    assert edges_of(defs, "view:app.v") == ["table:app.t"]


def test_table_functions_and_qualified_targets_are_not_unqualified_references() -> None:
    assert edges_of(
        [app_view("numbers", "SELECT 1 AS n"), app_view("v", "SELECT number FROM numbers(10)")],
        "view:app.v",
    ) == []
    assert edges_of(
        [app_table("app"), app_table("t"), app_view("v", "SELECT id FROM app.t")], "view:app.v"
    ) == ["table:app.t"]


# ---------- order_by_dependencies ----------


def test_order_returns_input_order_without_edges() -> None:
    assert order_by_dependencies(["c", "a", "b"], lambda x: x, lambda _: []) == ["c", "a", "b"]


def test_order_moves_an_item_behind_its_prerequisites_only() -> None:
    prerequisites = {"a": ["c"]}
    assert order_by_dependencies(
        ["a", "b", "c", "d"], lambda x: x, lambda k: prerequisites.get(k, [])
    ) == ["b", "c", "a", "d"]


def test_order_ignores_prerequisites_not_in_the_list() -> None:
    assert order_by_dependencies(["a", "b"], lambda x: x, lambda _: ["zzz"]) == ["a", "b"]


def test_order_keeps_a_50000_item_cycle_in_input_order_without_recursion_error() -> None:
    # Item i needs i+1 and the last item needs 0: the search walks all 50,000 before it returns.
    n = 50_000
    items = list(range(n))
    assert order_by_dependencies(items, str, lambda key: [str((int(key) + 1) % n)]) == items


# ---------- ADD COLUMN order by the columns an expression reads (#681) ----------


def _added_columns(columns: list[dict[str, Any]]) -> list[str]:
    def orders(extra: list[dict[str, Any]]) -> TableDefinition:
        return table(
            database="app",
            name="orders",
            columns=[{"name": "id", "type": "UInt64"}, *extra],
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
        )

    return [op.sql for op in plan_diff([orders([])], [orders(columns)]).operations]


def test_adds_a_column_before_the_default_that_reads_it() -> None:
    assert _added_columns([
        {"name": "price", "type": "UInt64"},
        {"name": "Total", "type": "UInt64", "default": SQLExpression(expression="price + 1")},
    ]) == [
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `price` UInt64;",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `Total` UInt64 DEFAULT price + 1;",
    ]


def test_orders_materialized_and_alias_reads_and_keeps_key_order_otherwise() -> None:
    assert _added_columns([
        {"name": "a_alias", "type": "UInt64", "default_kind": "ALIAS",
         "default": SQLExpression(expression="z_base * 2")},
        {"name": "b_plain", "type": "UInt64"},
        {"name": "c_mat", "type": "UInt64", "default_kind": "MATERIALIZED",
         "default": SQLExpression(expression="`a_alias` + id")},
        {"name": "z_base", "type": "UInt64"},
    ]) == [
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `b_plain` UInt64;",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `z_base` UInt64;",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a_alias` UInt64 ALIAS z_base * 2;",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `c_mat` UInt64 MATERIALIZED `a_alias` + id;",
    ]


def test_keeps_key_order_for_a_cycle_and_for_names_inside_string_literals() -> None:
    assert _added_columns([
        {"name": "a", "type": "UInt64", "default": SQLExpression(expression="b + 1")},
        {"name": "b", "type": "UInt64", "default": SQLExpression(expression="a + 1")},
        {"name": "c", "type": "String",
         "default": SQLExpression(expression="concat('d', toString(id))")},
        {"name": "d", "type": "String"},
    ]) == [
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT b + 1;",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `b` UInt64 DEFAULT a + 1;",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `c` String DEFAULT concat('d', toString(id));",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `d` String;",
    ]


# ---------- column statements of a table ordered by reads and removals (#745) ----------


def _t(columns: list[dict[str, Any]], name: str = "t", **extra: Any) -> TableDefinition:
    return table(
        database="app",
        name=name,
        columns=[{"name": "id", "type": "UInt64"}, *columns],
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
        **extra,
    )


def _sqls(previous: list[SchemaDefinition], next_: list[SchemaDefinition]) -> list[str]:
    return [op.sql for op in plan_diff(previous, next_).operations]


def _expr(sql: str) -> SQLExpression:
    return SQLExpression(expression=sql)


def test_runs_a_modify_column_after_the_add_column_its_new_default_reads() -> None:
    assert _sqls(
        [_t([{"name": "Total", "type": "UInt64"}])],
        [_t([
            {"name": "Total", "type": "UInt64", "default": _expr("price + 1")},
            {"name": "price", "type": "UInt64"},
        ])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `price` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `Total` UInt64 DEFAULT price + 1;",
    ]


def test_drops_a_column_only_after_the_modify_of_the_column_whose_old_default_reads_it() -> None:
    # Sorting only the ADDs and MODIFYs left DROP `c` in its slot, before the
    # MODIFY of `b`, so `c` was dropped while `b` still read it.
    assert _sqls(
        [_t([
            {"name": "b", "type": "UInt64", "default": _expr("c")},
            {"name": "c", "type": "UInt64"},
        ])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("z")},
            {"name": "b", "type": "UInt64", "default": _expr("z")},
            {"name": "z", "type": "UInt64"},
        ])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT z;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT z;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `c`;",
    ]


def test_drops_a_column_after_the_modify_that_stops_reading_it_although_its_name_sorts_first() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "UInt64"},
            {"name": "b", "type": "UInt64", "default_kind": "MATERIALIZED", "default": _expr("a * 2")},
        ])],
        [_t([
            {"name": "b", "type": "UInt64", "default_kind": "MATERIALIZED", "default": _expr("id * 2")},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 MATERIALIZED id * 2;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `a`;",
    ]


def test_drops_a_dotted_column_after_the_modify_of_the_column_whose_old_expression_reads_it_unquoted() -> None:
    assert _sqls(
        [_t([
            {"name": "n.x", "type": "Array(UInt64)"},
            {"name": "z", "type": "UInt64", "default_kind": "MATERIALIZED", "default": _expr("arraySum(n.x)")},
        ])],
        [_t([{"name": "z", "type": "UInt64", "default_kind": "MATERIALIZED", "default": _expr("id")}])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `z` UInt64 MATERIALIZED id;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `n.x`;",
    ]


def test_drops_a_column_after_the_dropped_column_whose_expression_reads_it() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "UInt64"},
            {"name": "b", "type": "UInt64", "default_kind": "ALIAS", "default": _expr("a + 1")},
        ])],
        [_t([])],
    ) == [
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `b`;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `a`;",
    ]


def test_drops_a_3000_column_alias_chain_from_the_last_column_to_the_first() -> None:
    n = 3000
    columns: list[dict[str, Any]] = [{"name": "c0", "type": "UInt64"}] + [
        {"name": f"c{i}", "type": "UInt64", "default_kind": "ALIAS", "default": _expr(f"c{i - 1} + 1")}
        for i in range(1, n)
    ]
    assert _sqls([_t(columns)], [_t([])]) == [
        f"ALTER TABLE app.t DROP COLUMN IF EXISTS `c{i}`;" for i in reversed(range(n))
    ]


def test_a_function_call_named_like_a_column_is_not_a_read() -> None:
    assert _sqls(
        [_t([{"name": "length", "type": "UInt64"}])],
        [_t([{"name": "a", "type": "UInt64", "default": _expr("length ('abc')")}])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT length ('abc');",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `length`;",
    ]


# Reading the lambda parameter `c` as the column `c` ran MODIFY `a` last, so
# MODIFY `b` DEFAULT a met the old `a DEFAULT b`: Cyclic alias detected (#768).
def test_a_lambda_parameter_named_like_a_column_is_not_a_read() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("b")},
            {"name": "b", "type": "UInt64", "default": _expr("id")},
        ])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("arraySum(arrayMap(c -> c, [1]))")},
            {"name": "b", "type": "UInt64", "default": _expr("a")},
            {"name": "c", "type": "UInt64", "default": _expr("id")},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT arraySum(arrayMap(c -> c, [1]));",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT a;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c` UInt64 DEFAULT id;",
    ]


# ALTER's check for cyclic defaults counts a lambda parameter named like a
# column as a read of it, so MODIFY `a` DEFAULT b first met the old `b`
# DEFAULT that declares `a`: Cyclic alias detected (#799).
@pytest.mark.parametrize(
    "expression",
    [
        "arraySum(arrayMap(a -> 1, [1]))",
        "arraySum(arrayMap((x, a) -> x, [1], [2]))",
        "arraySum(arrayMap(lambda(tuple(a), 1), [1]))",
    ],
)
def test_an_old_lambda_parameter_named_like_a_column_holds_back_the_modify_that_reads_back(
    expression: str,
) -> None:
    assert _sqls(
        [_t([{"name": "a", "type": "UInt64"}, {"name": "b", "type": "UInt64", "default": _expr(expression)}])],
        [_t([{"name": "a", "type": "UInt64", "default": _expr("b")}, {"name": "b", "type": "UInt64"}])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` REMOVE DEFAULT;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;",
    ]


def test_a_new_lambda_parameter_named_like_a_column_waits_for_the_release_of_its_old_read_back() -> None:
    assert _sqls(
        [_t([{"name": "a", "type": "UInt64"}, {"name": "b", "type": "UInt64", "default": _expr("a")}])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("arraySum(arrayMap(b -> 1, [1]))")},
            {"name": "b", "type": "UInt64"},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` REMOVE DEFAULT;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT arraySum(arrayMap(b -> 1, [1]));",
    ]


def test_a_lambda_parameter_use_reads_the_dotted_column_it_names() -> None:
    assert _sqls(
        [_t([
            {"name": "w.z", "type": "UInt64"},
            {"name": "b", "type": "UInt64", "default": _expr("arraySum(arrayMap(w -> w.z, [tuple(1)::Tuple(z UInt64)]))")},
        ])],
        [_t([{"name": "w.z", "type": "UInt64", "default": _expr("b")}, {"name": "b", "type": "UInt64"}])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` REMOVE DEFAULT;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `w.z` UInt64 DEFAULT b;",
    ]


# ALTER's cycle check reads `w.a` as the column `w.a` or `w`, never `a`, so
# the new `b` no longer reads `a` and its MODIFY releases the cycle (#799).
def test_a_lambda_parameter_use_does_not_read_the_column_named_by_its_last_part() -> None:
    assert _sqls(
        [_t([{"name": "a", "type": "UInt64"}, {"name": "b", "type": "UInt64", "default": _expr("a")}])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("b")},
            {"name": "b", "type": "UInt64", "default": _expr("arraySum(arrayMap(w -> w.a, [tuple(1)::Tuple(a UInt64)]))")},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT arraySum(arrayMap(w -> w.a, [tuple(1)::Tuple(a UInt64)]));",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;",
    ]


def test_a_cast_type_named_like_a_column_is_not_a_read() -> None:
    assert _sqls(
        [_t([
            {"name": "A", "type": "UInt64", "default": _expr("CAST(id AS UInt64)")},
            {"name": "UInt64", "type": "UInt64", "default": _expr("A")},
        ])],
        [_t([])],
    ) == [
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `UInt64`;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `A`;",
    ]


def test_an_alias_inside_a_cast_argument_does_not_hide_the_reads_after_it() -> None:
    assert _sqls(
        [_t([])],
        [_t([
            {"name": "a", "type": "Array(UInt64)",
             "default": _expr("CAST([id AS q, z], 'Array(UInt64)')")},
            {"name": "z", "type": "UInt64"},
        ])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` Array(UInt64) DEFAULT "
        "CAST([id AS q, z], 'Array(UInt64)');",
    ]


def test_a_dotted_run_followed_by_a_paren_is_a_function_call_not_a_read() -> None:
    assert _sqls(
        [_t([])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("n.x(1)")},
            {"name": "n", "type": "UInt64"},
        ])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT n.x(1);",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `n` UInt64;",
    ]


def test_a_dotted_run_reads_only_its_longest_leading_column_not_a_later_part() -> None:
    # `n.a` reads the element `a` of the tuple `n`, not the column `a`; reading
    # `a` too made a cycle with `a DEFAULT z + 1` that kept the key order.
    assert _sqls(
        [_t([{"name": "n", "type": "Tuple(a UInt64)"}])],
        [_t([
            {"name": "n", "type": "Tuple(a UInt64)"},
            {"name": "a", "type": "UInt64", "default": _expr("z + 1")},
            {"name": "z", "type": "UInt64", "default": _expr("n.a")},
        ])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64 DEFAULT n.a;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT z + 1;",
    ]


def test_a_dotted_run_ends_at_a_tuple_element_by_position() -> None:
    # `t.1.a.b` is a path into the tuple `t`; reading its suffix as the column
    # `a.b` made a cycle with `a.b DEFAULT z + 1` that kept the key order.
    assert _sqls(
        [_t([{"name": "t", "type": "Tuple(u Tuple(a Tuple(b UInt64)))"}])],
        [_t([
            {"name": "t", "type": "Tuple(u Tuple(a Tuple(b UInt64)))"},
            {"name": "a.b", "type": "UInt64", "default": _expr("z + 1")},
            {"name": "z", "type": "UInt64", "default": _expr("t.1.a.b")},
        ])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64 DEFAULT t.1.a.b;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a.b` UInt64 DEFAULT z + 1;",
    ]


def test_keeps_key_order_for_a_cycle_of_dropped_columns() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("b")},
            {"name": "b", "type": "UInt64", "default": _expr("a")},
        ])],
        [_t([])],
    ) == [
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `a`;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `b`;",
    ]


def test_keeps_the_other_statements_other_tables_and_same_column_statements_in_place() -> None:
    previous: list[SchemaDefinition] = [
        _t(
            [
                {"name": "b", "type": "UInt64", "default": _expr("c"), "comment": "old",
                 "codec": "ZSTD(1)"},
                {"name": "c", "type": "UInt64"},
                {"name": "x", "type": "String"},
            ],
            indexes=[{"name": "idx_c", "expression": "c", "type": "minmax", "granularity": 1}],
        ),
        _t([{"name": "x", "type": "UInt64"}], "u"),
    ]
    next_: list[SchemaDefinition] = [
        _t(
            [
                {"name": "b", "type": "UInt64", "default": _expr("z")},
                {"name": "x", "type": "String"},
                {"name": "z", "type": "UInt64"},
            ],
            indexes=[{"name": "idx_z", "expression": "z", "type": "minmax", "granularity": 1}],
            settings={"ttl_only_drop_parts": 1},
        ),
        _t(
            [{"name": "w", "type": "UInt64", "default": _expr("x")}, {"name": "x", "type": "UInt64"}],
            "u",
        ),
    ]
    assert _sqls(previous, next_) == [
        "ALTER TABLE app.t DROP INDEX IF EXISTS `idx_c`;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `b` REMOVE COMMENT;",
        "ALTER TABLE app.t MODIFY COLUMN `b` REMOVE CODEC;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT z;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `c`;",
        "ALTER TABLE app.t ADD INDEX IF NOT EXISTS `idx_z` (z) TYPE minmax GRANULARITY 1;",
        "ALTER TABLE app.t MODIFY SETTING ttl_only_drop_parts = 1;",
        "ALTER TABLE app.u ADD COLUMN IF NOT EXISTS `w` UInt64 DEFAULT x;",
    ]


# ---------- the column reads skip keywords and alias names (#805) ----------
# Each expected read below is what ClickHouse 26.3 reads: a DROP COLUMN of a
# column it reads is refused.


_KEYWORD_COLUMNS = [
    "and", "as", "c", "else", "end", "from", "id", "interval", "is", "like", "nan", "not", "null",
    "NULL", "s", "then", "true", "ts", "when", "x",
]  # fmt: skip


def _keyword_reads_of(expression: str, extra: tuple[str, ...] = ()) -> list[str]:
    columns: list[dict[str, object]] = [
        {"name": name, "type": "UInt64"} for name in (*_KEYWORD_COLUMNS, *extra)
    ]
    columns.append({"name": "v", "type": "UInt64", "default": _expr(expression)})
    definition = table(
        database="app",
        name="t",
        columns=list(columns),
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )
    reads = _column_default_reads([definition]).get("table:app.t:column:v", set())
    return sorted(key[len("table:app.t:column:"):] for key in reads)


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("case when x = 1 then 2 else 3 end", ["x"]),
        ("case x when 1 then 2 end", ["when", "x"]),
        ("CASE x WHEN 1 THEN 2 END + 0", ["x"]),
        ("if(x is null, 1, 2)", ["x"]),
        ("if(x is not null, 1, 2)", ["x"]),
        ("not x", ["x"]),
        ("toUInt64(not (x = 1))", ["x"]),
        ("x not in (1, 2)", ["x"]),
        ("ifNull(null, 1) + ifNull(NULL, 1)", []),
        ("if(true, 1, 2) + toUInt64(isNaN(nan))", []),
        ("length(substring(toString(s) from 1 for 2))", ["s"]),
        ("toUInt64(extract(day from ts))", ["ts"]),
        ("length(trim(both ' ' from toString(s)))", ["s"]),
        ("x and 1", ["x"]),
        ("x between 1 and 2", ["x"]),
        ("toUInt64(x as c)", ["x"]),
        ("toUInt64(x AS `c`)", ["x"]),
        ("(x + 1 as c) * 2", ["x"]),
    ],
)
def test_reads_skip_keywords(expression: str, expected: list[str]) -> None:
    assert _keyword_reads_of(expression) == expected


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("end + 1", ["end"]),
        ("toUInt64(when)", ["when"]),
        ("is + 1", ["is"]),
        ("x and and", ["and", "x"]),
        ("toUInt64(as)", ["as"]),
        ("case when end = 1 then 2 end", ["end"]),
        ("case when x = 1 then end else 3 end", ["end", "x"]),
        ("case when x = 1 then then else else end", ["else", "then", "x"]),
        ("case when x = 1 then 2 else 3 end + end", ["end", "x"]),
        ("toUInt64(substring(toString(s) from from))", ["from", "s"]),
        ("ifNull(`null`, 1)", ["null"]),
        ("toUInt64(`true`)", ["true"]),
        ("toUInt64(`not`)", ["not"]),
        ("toUInt64(c as c)", ["c"]),
        ("(x + 1 as c) * c", ["c", "x"]),
        # A column named like a prefix keyword may be that keyword: the name after it is still read.
        ("toUInt64(toDateTime(0) + interval end day)", ["end", "interval"]),
        ("arraySum(arrayMap(interval -> toUInt64(toDateTime(0) + interval end day), [1]))", ["end"]),
        ("length(extract(interval end day > interval 0 day ? 'a' : 'b', '.'))", ["end", "interval"]),
        ("arraySum(arrayMap(and -> 1 and end, [1]))", ["end"]),
        ("arraySum(arrayMap(both -> both not like end, ['x']))", ["end", "like"]),
        ("toUInt8(t.x and end)", ["and", "end", "x"]),
        # Unclear positions keep the read: after a lambda parameter, and before a single `=`.
        ("arraySum(arrayMap(i -> i is null, [x]))", ["is", "x"]),
        ("toUInt8(null = 1)", ["null"]),
        # An alias named `case` (`s AS case`) is no CASE keyword.
        ("length(concat(toString(s) AS case, substring(case from then)))", ["from", "s", "then"]),
        ("length(extract(interval from day > interval 0 day ? 'a' : 'b', '.'))", ["from", "interval"]),
    ],
)
def test_reads_keep_keyword_named_columns_where_an_operand_is_expected(
    expression: str, expected: list[str]
) -> None:
    assert _keyword_reads_of(expression) == expected


# With a column named `case`, a bare `case` keeps its read: ClickHouse reads
# the column wherever CASE does not parse (`INTERVAL case DAY`, `case when`
# with the alias `when`), and chkit does not tell the two apart.
@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("case", ["case"]),
        ("case + 1", ["case"]),
        ("case when case = 1 then 2 end", ["case", "when"]),
        ("case global in (1, 2)", ["case"]),
        ("case regexp 'x'", ["case"]),
        ("toUInt64(toDateTime(0) + interval case day)", ["case", "interval"]),
        ("length(substring(case c, 1))", ["c", "case"]),
        ("length(substring(case when, 1))", ["case", "when"]),
        ("toUInt64(toDateTime(0) + interval case when day)", ["case", "interval", "when"]),
        ("case when x = 1 then 2 else 3 end", ["case", "when", "x"]),
        ("length(substring(case when from then))", ["case", "from", "then", "when"]),
    ],
)
def test_reads_keep_a_column_named_case(expression: str, expected: list[str]) -> None:
    assert _keyword_reads_of(expression, ("case",)) == expected


def test_drops_a_column_after_the_dropped_column_that_reads_it_when_a_case_names_that_column() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("case when id = 1 then 2 else 3 end")},
            {"name": "end", "type": "UInt64", "default": _expr("a + 1")},
        ])],
        [_t([])],
    ) == [
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `end`;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `a`;",
    ]


@pytest.mark.parametrize(
    ("column", "before", "after"),
    [
        ("case", "case TO DISK 'default'", "ts TO DISK 'default'"),
        ("case", "case DELETE", "ts DELETE"),
        ("null", "ts GROUP BY id SET null = max(x)", "ts GROUP BY id SET x = max(x)"),
    ],
)
def test_a_ttl_that_reads_a_keyword_named_column_changes_before_it_is_dropped(
    column: str, before: str, after: str
) -> None:
    columns: list[dict[str, Any]] = [
        {"name": "ts", "type": "DateTime"},
        {"name": "x", "type": "UInt64"},
    ]
    assert _sqls(
        [_t([*columns, {"name": column, "type": "DateTime"}], ttl=before)],
        [_t(columns, ttl=after)],
    ) == [
        f"ALTER TABLE app.t MODIFY TTL {after};",
        f"ALTER TABLE app.t DROP COLUMN IF EXISTS `{column}`;",
    ]


def test_a_ttl_that_reads_a_column_after_a_column_named_interval_changes_before_that_column_is_dropped() -> None:
    columns: list[dict[str, Any]] = [
        {"name": "ts", "type": "DateTime"},
        {"name": "interval", "type": "UInt64"},
    ]
    assert _sqls(
        [_t([*columns, {"name": "end", "type": "UInt64"}], ttl="ts + interval end day")],
        [_t(columns, ttl="ts + interval 1 day")],
    ) == [
        "ALTER TABLE app.t MODIFY TTL ts + interval 1 day;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `end`;",
    ]


# ---------- MODIFY read releases and table TTL changes (#769) ----------


def test_removes_the_old_default_that_reads_a_column_before_that_column_reads_it_back() -> None:
    assert _sqls(
        [_t([{"name": "a", "type": "UInt64"}, {"name": "z", "type": "UInt64", "default": _expr("a")}])],
        [_t([{"name": "a", "type": "UInt64", "default": _expr("z")}, {"name": "z", "type": "UInt64"}])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `z` REMOVE DEFAULT;",
        "ALTER TABLE app.t MODIFY COLUMN `z` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT z;",
    ]


def test_releases_a_read_that_closes_a_longer_cycle_through_an_unchanged_column() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "UInt64"},
            {"name": "b", "type": "UInt64", "default": _expr("c")},
            {"name": "c", "type": "UInt64", "default": _expr("a")},
        ])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("b")},
            {"name": "b", "type": "UInt64", "default": _expr("c")},
            {"name": "c", "type": "UInt64", "default": _expr("id")},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;",
    ]


def test_releases_a_read_that_closes_a_cycle_through_an_added_column() -> None:
    # `b` -> `a` -> `c` -> `b` once `a` is added, which runs first.
    assert _sqls(
        [_t([{"name": "b", "type": "UInt64"}, {"name": "c", "type": "UInt64", "default": _expr("b")}])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("c")},
            {"name": "b", "type": "UInt64", "default": _expr("a")},
            {"name": "c", "type": "UInt64"},
        ])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT c;",
        "ALTER TABLE app.t MODIFY COLUMN `c` REMOVE DEFAULT;",
        "ALTER TABLE app.t MODIFY COLUMN `c` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT a;",
    ]


def test_keeps_key_order_when_the_read_back_only_appears_after_the_release() -> None:
    # `y` reads `a` only in the new schema, so `a` -> `x` -> `y` -> `a` never
    # exists at once: the key order works and stays.
    assert _sqls(
        [_t([
            {"name": "a", "type": "UInt64"},
            {"name": "x", "type": "UInt64", "default": _expr("y")},
            {"name": "y", "type": "UInt64"},
        ])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("x")},
            {"name": "x", "type": "UInt64", "default": _expr("id")},
            {"name": "y", "type": "UInt64", "default": _expr("a")},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT x;",
        "ALTER TABLE app.t MODIFY COLUMN `x` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `y` UInt64 DEFAULT a;",
    ]


def test_changes_the_table_ttl_between_the_add_it_reads_and_the_drop_it_releases() -> None:
    assert _sqls(
        [_t([{"name": "x", "type": "DateTime"}], ttl="x + INTERVAL 1 DAY")],
        [_t([{"name": "y", "type": "DateTime"}], ttl="y + INTERVAL 1 DAY")],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `y` DateTime;",
        "ALTER TABLE app.t MODIFY TTL y + INTERVAL 1 DAY;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;",
    ]


def test_removes_the_table_ttl_before_the_drop_of_the_column_it_reads() -> None:
    assert _sqls([_t([{"name": "x", "type": "DateTime"}], ttl="x + INTERVAL 1 DAY")], [_t([])]) == [
        "ALTER TABLE app.t REMOVE TTL;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;",
    ]


def test_a_drop_held_back_by_the_ttl_takes_a_later_slot_and_other_statements_stay() -> None:
    # The statements fill the column statement slots: the DROP moves to the
    # TTL statement's slot, after the setting change.
    assert _sqls(
        [_t(
            [{"name": "b", "type": "UInt64"}, {"name": "x", "type": "DateTime"}],
            ttl="x + INTERVAL 1 DAY",
        )],
        [_t(
            [{"name": "b", "type": "String"}, {"name": "y", "type": "DateTime"}],
            ttl="y + INTERVAL 1 DAY",
            settings={"ttl_only_drop_parts": 1},
        )],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` String;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `y` DateTime;",
        "ALTER TABLE app.t MODIFY TTL y + INTERVAL 1 DAY;",
        "ALTER TABLE app.t MODIFY SETTING ttl_only_drop_parts = 1;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;",
    ]


def test_a_cast_type_in_the_ttl_is_not_a_read_of_a_column_with_that_name() -> None:
    # The TTL is read like a column expression: the CAST type is no column, so
    # the DROP of a column named `DateTime` does not wait for the TTL change.
    assert _sqls(
        [_t(
            [{"name": "DateTime", "type": "UInt64"}, {"name": "ts", "type": "UInt64"}],
            ttl="CAST(ts AS DateTime) + INTERVAL 1 DAY",
        )],
        [_t(
            [{"name": "a", "type": "UInt64"}, {"name": "ts", "type": "UInt64"}],
            ttl="CAST(ts AS DateTime) + INTERVAL 2 DAY",
        )],
    ) == [
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `DateTime`;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64;",
        "ALTER TABLE app.t MODIFY TTL CAST(ts AS DateTime) + INTERVAL 2 DAY;",
    ]


def test_a_ttl_change_that_reads_no_changed_column_keeps_its_slot() -> None:
    assert _sqls(
        [_t(
            [{"name": "ts", "type": "DateTime"}, {"name": "x", "type": "UInt64"}],
            ttl="ts + INTERVAL 1 DAY",
        )],
        [_t(
            [{"name": "a", "type": "UInt64"}, {"name": "ts", "type": "DateTime"}],
            ttl="ts + INTERVAL 2 DAY",
        )],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;",
        "ALTER TABLE app.t MODIFY TTL ts + INTERVAL 2 DAY;",
    ]


# ---------- a breaker runs before the MODIFY that closes a temporary cycle (#775) ----------


def _u(name: str, expression: str | None = None, **extra: Any) -> dict[str, Any]:
    column: dict[str, Any] = {"name": name, "type": "UInt64", **extra}
    if expression is not None:
        column["default"] = _expr(expression)
    return column


def test_runs_the_first_breaker_in_key_order_before_the_modify_that_would_close_the_cycle() -> None:
    # `a DEFAULT b` closes `a` -> `b` -> `c` -> `a`; either `b` or `c` breaks it.
    assert _sqls(
        [_t([_u("a"), _u("b", "c"), _u("c", "a")])],
        [_t([_u("a", "b"), _u("b", "id"), _u("c", "id")])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;",
        "ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;",
    ]


def test_removes_the_breaking_default_before_the_second_of_two_modifies_that_close_a_cycle() -> None:
    # `a DEFAULT b` and `b DEFAULT c` close `a` -> `b` -> `c` -> `a` together,
    # so whichever runs second waits for `c` to drop its read of `a`.
    assert _sqls(
        [_t([_u("a"), _u("b"), _u("c", "a")])],
        [_t([_u("a", "b"), _u("b", "c"), _u("c")])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;",
        "ALTER TABLE app.t MODIFY COLUMN `c` REMOVE DEFAULT;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT c;",
        "ALTER TABLE app.t MODIFY COLUMN `c` UInt64;",
    ]


def test_moves_another_breaker_before_a_breaker_that_would_close_a_cycle_itself() -> None:
    # `b` breaks `a` -> `d` -> `b` -> `a` but closes `b` -> `d` -> `b` itself,
    # so `d` runs before `b`, and `b` before `a`.
    assert _sqls(
        [_t([_u("a", "1"), _u("b", "a"), _u("c"), _u("d", "b + c")])],
        [_t([_u("a", "c + d"), _u("b", "c + d"), _u("c"), _u("d", "1")])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `d` UInt64 DEFAULT 1;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT c + d;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT c + d;",
    ]


def test_the_breaker_is_the_remove_default_not_the_comment_removal_of_the_same_column() -> None:
    # The REMOVE DEFAULT breaks the cycle; the REMOVE COMMENT after it does not.
    assert _sqls(
        [_t([_u("a"), _u("b", "c", comment="x"), _u("c", "a")])],
        [_t([_u("a", "b"), _u("b"), _u("c", "id")])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` REMOVE DEFAULT;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;",
        "ALTER TABLE app.t MODIFY COLUMN `b` REMOVE COMMENT;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;",
    ]


def test_keeps_key_order_when_no_statement_closes_a_cycle() -> None:
    # `c` reads `a` only until it changes, and `a` reads `b` only after it:
    # the key order never holds the cycle, so nothing moves.
    assert _sqls(
        [_t([_u("a"), _u("b"), _u("c", "a")])],
        [_t([_u("a", "b"), _u("b", "id"), _u("c", "id")])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;",
    ]


def test_repairs_a_wide_table_whose_every_modify_closes_a_cycle_with_work_that_grows() -> None:
    # Each column reads the one before it and changes to read the one two
    # places ahead, so every MODIFY waits for a breaker. Four times the columns
    # take about four times the work; a quadratic repair would take sixteen.
    def name(i: int) -> str:
        return f"c{i:04d}"

    def plan(count: int) -> tuple[int, list[str]]:
        before = [_u(name(i), "1" if i == 0 else name(i - 1)) for i in range(count)]
        after = [_u(name(i), name(i + 2) if i + 2 < count else "1") for i in range(count)]
        operations = plan_diff([_t(before)], [_t(after)]).operations
        return _cycle_repair_work.units, [
            op.key[len("table:app.t:column:"):] for op in operations[:3]
        ]

    narrow, _ = plan(1200)
    wide, first = plan(4800)
    assert first == ["c4798", "c4797", "c4796"]
    assert narrow > 0
    assert wide <= 5 * narrow


@pytest.mark.parametrize(
    "expression",
    [
        "now() + INTERVAL '1 day' > toDateTime(id) AND day",
        "toUInt64(now() + INTERVAL CASE WHEN day THEN 1 ELSE 2 END HOUR)",
    ],
)
def test_adds_the_column_read_after_an_interval_first(expression: str) -> None:
    # Each expression reads `day` after an INTERVAL. The reads keep it, so the
    # ADD of `day` runs first.
    assert _sqls([_t([])], [_t([_u("a", expression), {"name": "day", "type": "UInt8"}])]) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `day` UInt8;",
        f"ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT {expression};",
    ]


def test_adds_a_column_named_interval_before_the_expression_that_reads_it() -> None:
    # `interval.x` reads the column `interval`, so its ADD runs first.
    assert _sqls(
        [_t([])],
        [_t([_u("a", "tuple(interval.x day).1"), {"name": "interval", "type": "Tuple(x UInt64)"}])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `interval` Tuple(x UInt64);",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT tuple(interval.x day).1;",
    ]


def test_keeps_the_sorted_order_of_a_table_whose_expression_has_an_interval() -> None:
    # The reads take each INTERVAL unit for a column (`day`, `month`, `hour`),
    # so these tables seem to close a cycle `a` -> `month` -> `z` -> `a`. A
    # table with INTERVAL keeps its sorted order: `month` still runs after the
    # ALIAS that calls `length(month)` on the old String, and `a` changes to
    # String before the ALIAS `length(a)` is added.
    assert _sqls(
        [_t([
            _u("a", "toUInt64(toDateTime(id) + INTERVAL 1 day)"),
            _u("day", "length(month)", default_kind="ALIAS"),
            {"name": "month", "type": "String", "default": _expr("toString(z)")},
            _u("z", "a"),
        ])],
        [_t([
            _u("a", "toUInt64(toDateTime(id) + INTERVAL 1 month)"),
            _u("day", "a", default_kind="ALIAS"),
            _u("month", "id"),
            _u("z", "id"),
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT toUInt64(toDateTime(id) + INTERVAL 1 month);",
        "ALTER TABLE app.t MODIFY COLUMN `day` UInt64 ALIAS a;",
        "ALTER TABLE app.t MODIFY COLUMN `month` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `z` UInt64 DEFAULT id;",
    ]
    interval_case = (
        "toString(toDateTime(id) + INTERVAL CASE WHEN id > 0 THEN 1 ELSE 2 END hour)"
    )
    assert _sqls(
        [_t([
            _u("a"),
            {"name": "hour", "type": "String", "default": _expr("toString(z)")},
            _u("z", "length(toString(a))"),
        ])],
        [_t([
            {"name": "a", "type": "String", "default": _expr(interval_case)},
            _u("guard", "length(a)", default_kind="ALIAS"),
            _u("hour", "id"),
            _u("z", "id"),
        ])],
    ) == [
        f"ALTER TABLE app.t MODIFY COLUMN `a` String DEFAULT {interval_case};",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `guard` UInt64 ALIAS length(a);",
        "ALTER TABLE app.t MODIFY COLUMN `hour` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `z` UInt64 DEFAULT id;",
    ]


_CYCLE_BEFORE = [_u("a"), _u("b", "c"), _u("c", "a")]
_CYCLE_AFTER = [_u("a", "b"), _u("b", "id"), _u("c", "id")]


def test_keeps_the_sorted_order_of_a_table_whose_expression_has_a_case_and_repairs_the_other() -> None:
    # `when` inside the CASE is read as a column, so `u` keeps its sorted
    # order, while `t` is still repaired.
    case_columns = [_u("when", "zz"), _u("zz", "case when id > 0 then 1 else 0 end")]
    assert _sqls(
        [_t(_CYCLE_BEFORE, "t"), _t([*_CYCLE_BEFORE, *case_columns], "u")],
        [_t(_CYCLE_AFTER, "t"), _t(_CYCLE_AFTER, "u")],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;",
        "ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;",
        "ALTER TABLE app.u MODIFY COLUMN `a` UInt64 DEFAULT b;",
        "ALTER TABLE app.u MODIFY COLUMN `b` UInt64 DEFAULT id;",
        "ALTER TABLE app.u MODIFY COLUMN `c` UInt64 DEFAULT id;",
        "ALTER TABLE app.u DROP COLUMN IF EXISTS `when`;",
        "ALTER TABLE app.u DROP COLUMN IF EXISTS `zz`;",
    ]


@pytest.mark.parametrize(
    ("expression", "order"),
    [("identity(id AS v)", ["a", "b", "c"]), ("CAST(id AS UInt64)", ["b", "a", "c"])],
)
def test_an_alias_keeps_the_sorted_order_and_a_cast_does_not(expression: str, order: list[str]) -> None:
    # An alias makes the reads uncertain; the AS of a CAST does not.
    operations = plan_diff(
        [_t(_CYCLE_BEFORE)], [_t([_u("a", "b"), _u("b", "id"), _u("c", expression)])]
    ).operations
    assert [op.key[len("table:app.t:column:"):] for op in operations] == order


def test_keeps_the_sorted_order_of_a_table_whose_cycle_no_statement_breaks() -> None:
    # `p` and `q` read each other in the new schema, so their ADDs form a
    # cycle among the prerequisites. ADD `p` replays, then ADD `q` closes
    # `p` -> `q` -> `p`, which no statement breaks: the group is replayed back,
    # `u` keeps its sorted order, and `t` is still repaired.
    assert _sqls(
        [_t(_CYCLE_BEFORE, "t"), _t([], "u")],
        [_t(_CYCLE_AFTER, "t"), _t([_u("p", "q"), _u("q", "p")], "u")],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;",
        "ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;",
        "ALTER TABLE app.u ADD COLUMN IF NOT EXISTS `p` UInt64 DEFAULT q;",
        "ALTER TABLE app.u ADD COLUMN IF NOT EXISTS `q` UInt64 DEFAULT p;",
    ]


def _order_of(previous: list[SchemaDefinition], next_: list[SchemaDefinition]) -> list[str]:
    """The column order of a plan, as ``table.column`` without the database."""
    order = []
    for op in plan_diff(previous, next_).operations:
        at = op.key.rindex(":column:")
        order.append(f"{op.key[len('table:app.'):at]}.{op.key[at + len(':column:'):]}")
    return order


def _text(name: str, expression: str) -> dict[str, Any]:
    return {"name": name, "type": "String", "default": _expr(expression)}


@pytest.mark.parametrize(
    ("expression", "name", "changed"),
    [
        ("toString(date '2024-01-01')", "date", _text("date", "toString(id)")),
        (
            "toString(arrayMap(`as` -> tuple(id as month).1, [id])[1])",
            "month",
            _text("month", "toString(id)"),
        ),
        (
            "CAST(arrayMap(lambda(tuple(month), month), [id])[1] AS String)",
            "month",
            _text("month", "toString(id)"),
        ),
    ],
)
def test_a_table_with_an_uncertain_expression_keeps_its_sorted_order(
    expression: str, name: str, changed: dict[str, Any]
) -> None:
    # `a` gets a new DEFAULT; the ALIAS `b` calls `length(a)`. Each expression
    # for `a` reads `month` or `date` only seemingly, so these tables keep their
    # sorted order. No column changes its type, so none is ordered by one (#814).
    assert _order_of(
        [_t([{"name": "a", "type": "String"}, _text(name, "toString(z)"), _u("z", "length(toString(a))")])],
        [_t([_text("a", expression), _u("b", "length(a)", default_kind="ALIAS"), changed, _u("z", "id")])],
    ) == ["t.a", "t.b", f"t.{name}", "t.z"]


_Columns = list[tuple[str, str | None]]
_OVERLAPPING_CYCLES: dict[str, tuple[_Columns, _Columns, list[str]]] = {
    "cycles through m": (
        [("a", None), ("b", "m"), ("c", "b"), ("e", "m"), ("f", "e"), ("m", "a")],
        [("a", "f + c"), ("b", "z"), ("c", "id"), ("e", "id"), ("f", "id"), ("m", "a"), ("z", "id")],
        ["t.c", "t.e", "t.f", "t.z", "t.b", "t.a"],
    ),
    "cycles through y": (
        [("a", None), ("b", None), ("c", "y"), ("y", "a"), ("z", "b")],
        [("a", "z"), ("b", "y + c"), ("c", "zz"), ("y", "id"), ("z", "id"), ("zz", None)],
        ["t.a", "t.y", "t.z", "t.zz", "t.c", "t.b"],
    ),
}


@pytest.mark.parametrize("label", list(_OVERLAPPING_CYCLES))
def test_with_two_overlapping_cycles_every_breaker_counts(label: str) -> None:
    # Two reads of `a` close cycles that share columns; each cycle's breakers
    # count, so the first breaker in key order runs first in both ports.
    before, after, order = _OVERLAPPING_CYCLES[label]
    assert _order_of(
        [_t([_u(name, expression) for name, expression in before])],
        [_t([_u(name, expression) for name, expression in after])],
    ) == order


def test_overlapping_cycles_plan_the_same_under_every_hash_seed() -> None:
    # The orders the TS tests assert, in fresh interpreters with other seeds.
    script = (
        "import json, sys\n"
        "from chkit.core.model import table\n"
        "from chkit.core.planner import plan_diff\n"
        "def t(columns):\n"
        "    return table(database='app', name='t', columns=[{'name': 'id', 'type': 'UInt64'}] + [\n"
        "        {'name': n, 'type': 'UInt64', **({} if e is None else {'default': {'expression': e}})}\n"
        "        for n, e in columns], engine='MergeTree()', primary_key=['id'], order_by=['id'])\n"
        "cases = json.loads(sys.argv[1])\n"
        "print(json.dumps([[op.key.rsplit(':', 1)[1] for op in plan_diff([t(b)], [t(a)]).operations]\n"
        "    for b, a in cases]))\n"
    )
    cases = [[before, after] for before, after, _ in _OVERLAPPING_CYCLES.values()]
    expected = [[column.split(".")[1] for column in order] for _, _, order in _OVERLAPPING_CYCLES.values()]
    for seed in ("0", "1", "2", "3", "4"):
        result = subprocess.run(
            [sys.executable, "-c", script, json.dumps(cases)],
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "PYTHONHASHSEED": seed},
        )
        assert json.loads(result.stdout) == expected, seed


def test_a_table_whose_name_has_column_is_a_table_of_its_own() -> None:
    # A table named like another table's column keys (`t:column_archive`,
    # `t:column:other`) is still a table of its own.
    archive = "t:column_archive"
    assert _order_of(
        [_t([_u("a"), _text("month", "toString(z)"), _u("z", "length(toString(a))")], archive)],
        [_t([
            _text("a", "toString(toDateTime(id) + INTERVAL 1 month)"),
            _u("b", "length(a)", default_kind="ALIAS"),
            _u("month", "id"),
            _u("z", "id"),
        ], archive)],
    ) == [f"{archive}.a", f"{archive}.b", f"{archive}.month", f"{archive}.z"]
    assert _order_of(
        [_t(_CYCLE_BEFORE, "t"), _t([], archive)],
        [_t(_CYCLE_AFTER, "t"), _t([_u("p", "q"), _u("q", "p")], archive)],
    ) == ["t.b", "t.a", "t.c", f"{archive}.p", f"{archive}.q"]
    other = "t:column:other"
    interval = [_u("k", "toUInt64(toDateTime(id) + INTERVAL 1 DAY)")]
    assert _order_of(
        [_t(_CYCLE_BEFORE, other), _t(interval, "t")],
        [_t(_CYCLE_AFTER, other), _t(interval, "t")],
    ) == [f"{other}.b", f"{other}.a", f"{other}.c"]


def test_does_no_repair_work_on_the_acyclic_groups_fixture() -> None:
    # Old and new reads that form no cycle are not replayed at all: every `a`
    # and `z` goes through the `b` chain.
    def name(prefix: str, i: int) -> str:
        return f"{prefix}{i:05d}"

    n = 2000
    greatest = "greatest(" + ", ".join(name("z", j) for j in range(n)) + ")"
    before = [_u(name(prefix, i)) for prefix in "abz" for i in range(n)]
    after = (
        [_u(name("a", i), greatest if i == 0 else name("a", i - 1)) for i in range(n)]
        + [_u(name("b", i), "id" if i == 0 else name("b", i - 1)) for i in range(n)]
        + [_u(name("z", i), name("b", n - 1)) for i in range(n)]
    )
    plan_diff([_t(before)], [_t(after)])
    assert _cycle_repair_work.units == 0


def test_a_bare_null_is_no_read_of_a_column_named_null() -> None:
    # A bare NULL is a literal even when a column is named `null`, so these
    # tables close no cycle: the ALIAS `b` runs after `a` changes. Only a
    # quoted `null` reads the column. In the first plan `a` changes its type
    # and the old DEFAULT of `z` reads it, so `z` changes first (#814). Read as
    # a column, `null`, whose type changes too, would have to change before
    # `a`: that reorders the type changes, so the plan would keep its sorted
    # order. In the second plan no column changes its type, so none is
    # ordered by one.
    assert _order_of(
        [_t([_u("a"), _text("null", "toString(z)"), _u("z", "length(toString(a))")])],
        [_t([
            _text("a", "ifNull(null, '')"),
            _u("b", "match(a, 'x')", type="UInt8", default_kind="ALIAS"),
            _u("null", "id"),
            _u("z", "id"),
        ])],
    ) == ["t.z", "t.a", "t.b", "t.null"]
    assert _order_of(
        [_t([
            {"name": "a", "type": "String"},
            _u("b", "length(`null`)", default_kind="ALIAS"),
            _text("null", "toString(z)"),
            _u("z", "length(toString(a))"),
        ])],
        [_t([
            _text("a", "toString(ifNull(null, 1))"),
            _u("b", "length(a)", default_kind="ALIAS"),
            _text("null", "toString(id)"),
            _u("z", "id"),
        ])],
    ) == ["t.a", "t.b", "t.null", "t.z"]
    assert _order_of(
        [_t([_u("a"), _u("b", "c"), _u("c", "`null`"), _u("null", "a")])],
        [_t([_u("a", "b"), _u("b", "id"), _u("c", "id"), _u("null", "a")])],
    ) == ["t.b", "t.a", "t.c"]


def test_a_key_that_also_names_an_unchanged_column_of_another_table_keeps_the_repair() -> None:
    # Table `t:column:other` with column `a` and table `t` with column
    # `other:column:a` give the same key; the unchanged `t` leaves the other
    # table's repair alone.
    other = "t:column:other"
    assert _order_of(
        [_t(_CYCLE_BEFORE, other), _t([_u("other:column:a")], "t")],
        [_t(_CYCLE_AFTER, other), _t([_u("other:column:a")], "t")],
    ) == [f"{other}.b", f"{other}.a", f"{other}.c"]


_REPAIRED = ["t.b", "t.a", "t.c"]
_SORTED = ["t.a", "t.b", "t.c"]


@pytest.mark.parametrize(
    ("extra", "order"),
    [
        (_text("extra", "hex(x'CAFE')"), _REPAIRED),
        (_text("extra", "bin(b'0101')"), _REPAIRED),
        (_u("extra", "0xFF + 0b11"), _REPAIRED),
        (_u("extra", "CAST(id AS Nullable(UInt64))"), _REPAIRED),
        (_u("extra", "CAST(id AS Enum8('a' = 1, 'b' = -2))"), _REPAIRED),
        (_u("extra", "id::Tuple(a UInt64, b Array(String))"), _REPAIRED),
        (_u("extra", "CAST(id AS DateTime64(3, 'UTC'))"), _REPAIRED),
        (_u("extra", "CAST(id AS id ? a : b)"), _SORTED),
        (_u("extra", "id::UInt64([a], {b:UInt64}, a -> b)"), _SORTED),
        (_u("extra", "toString((SELECT (1)))"), _SORTED),
    ],
)
def test_literals_and_casts_the_parser_accepts_keep_the_repair(
    extra: dict[str, Any], order: list[str]
) -> None:
    # Literals and casts the parser accepts leave the table's repair alone;
    # a cast it cannot parse, or a subquery, keeps the sorted order.
    assert _order_of([_t([*_CYCLE_BEFORE, extra])], [_t([*_CYCLE_AFTER, extra])]) == order


def _unbreakable_tables(tables: int) -> tuple[list[SchemaDefinition], list[SchemaDefinition]]:
    names = [f"t{i}" for i in range(tables)]
    before: list[SchemaDefinition] = [
        _t([_u("a"), _u("null", "z"), _u("z", "a")], name) for name in names
    ]
    after: list[SchemaDefinition] = [
        _t([_u("a"), _u("null", "z"), _u("p", "q"), _u("q", "p"), _u("z", "a")], name)
        for name in names
    ]
    return before, after


def _never_closed_tables(tables: int) -> tuple[list[SchemaDefinition], list[SchemaDefinition]]:
    m = 300

    def pad(prefix: str, i: int) -> str:
        return f"{prefix}{i:04d}"

    greatest = "greatest(" + ", ".join(pad("a", i) for i in range(m)) + ")"
    c = [_u(pad("c", i), pad("c", i + 1) if i + 1 < m else "h") for i in range(m)]
    names = [f"t{k}" for k in range(tables // 256)]
    before: list[SchemaDefinition] = [
        _t(
            [_u(pad("a", i)) for i in range(m)]
            + [_u(pad("b", i), pad("b", i + 1) if i + 1 < m else "z") for i in range(m)]
            + [*c, _u("h", greatest), _u("z")],
            name,
        )
        for name in names
    ]
    after: list[SchemaDefinition] = [
        _t(
            [_u(pad("a", i), pad("b", 0)) for i in range(m)]
            + [_u(pad("b", i), "1") for i in range(m)]
            + [*c, _u("h", greatest), _u("z", pad("c", 0))],
            name,
        )
        for name in names
    ]
    return before, after


def _shared_chain(size: int) -> tuple[list[SchemaDefinition], list[SchemaDefinition]]:
    n = size // 4

    def pad(prefix: str, i: int) -> str:
        return f"{prefix}{i:04d}"

    before: list[dict[str, Any]] = []
    after: list[dict[str, Any]] = []
    for i in range(n):
        before += [_u(pad("a", i)), _u(pad("b", i), pad("z", i)), _u(pad("z", i), pad("a", i))]
        after += [_u(pad("a", i), pad("b", i)), _u(pad("b", i), pad("p", 0)), _u(pad("z", i), "id")]
    for j in range(n):
        reads = " + ".join(pad("b", i) for i in range(n)) if j == 0 else pad("p", j - 1)
        before.append(_u(pad("p", j), reads))
        after.append(_u(pad("p", j), pad("p", j + 1) if j + 1 < n else "id"))
    return [_t(before)], [_t(after)]


def _many_reads(size: int) -> tuple[list[SchemaDefinition], list[SchemaDefinition]]:
    extras = [_u(f"p{i:03d}") for i in range(30)]
    tail = "".join(f" + {column['name']}" for column in extras)
    before: list[dict[str, Any]] = list(extras)
    after: list[dict[str, Any]] = list(extras)
    for i in range(size // 32):
        before += [_u(f"a{i:03d}"), _u(f"b{i:03d}", f"c{i:03d}{tail}"), _u(f"c{i:03d}", f"a{i:03d}{tail}")]
        after += [_u(f"a{i:03d}", f"b{i:03d}{tail}"), _u(f"b{i:03d}", f"id{tail}"), _u(f"c{i:03d}", f"id{tail}")]
    return [_t(before)], [_t(after)]


@pytest.mark.parametrize(
    "schemas", [_unbreakable_tables, _never_closed_tables, _shared_chain, _many_reads]
)
def test_plans_with_work_that_grows_with_the_size(
    schemas: Callable[[int], tuple[list[SchemaDefinition], list[SchemaDefinition]]],
) -> None:
    # Each table is replayed on its own with its own budget, so many tables,
    # tables whose cycles no statement breaks, a prerequisite chain every
    # breaker check walks, and breakers that read many other columns cost work
    # that grows with the plan: four times the size takes at most about four
    # times the work.
    def work(size: int) -> int:
        previous, next_ = schemas(size)
        plan_diff(previous, next_)
        return _cycle_repair_work.units

    narrow = work(512)
    wide = work(2048)
    assert narrow > 0
    assert wide <= 5 * narrow


def test_repairs_cycles_whose_breakers_read_many_other_columns() -> None:
    # A table with breakers that read many other columns still has enough
    # work to repair all its cycles.
    previous, next_ = _many_reads(640)
    assert _order_of(previous, next_)[:2] == ["t.b000", "t.a000"]


def test_repairs_cycles_whose_breakers_wait_for_one_long_chain_of_statements() -> None:
    # Every breaker ``b_i`` waits for the 128 changes of the ``p`` chain, which
    # do not wait for ``a_i``. The search from ``a_i``'s end stops at once, so
    # the checks do not walk the chain again for each cycle (#829).
    previous, next_ = _shared_chain(512)
    order = _order_of(previous, next_)
    assert order[0] == "t.p0127"
    for i in range(128):
        assert order.index(f"t.b{i:04d}") < order.index(f"t.a{i:04d}")
    assert _cycle_repair_work.units == 6011


@pytest.mark.parametrize(
    ("before", "after", "order"),
    [
        (
            [_u("a"), _u("b", "c + z"), _u("c", "d"), _u("d", "c"), _u("z", "a")],
            [_u("a", "b"), _u("b", "id"), _u("c", "d"), _u("d", "c"), _u("z", "id")],
            ["t.a", "t.b", "t.z"],
        ),
        (
            [_u("a"), _u("b", "z"), _u("c", "a"), _u("z", "b + c")],
            [_u("a", "z"), _u("b", "p"), _u("c", "id"), _u("p", "id"), _u("z", "id")],
            ["t.a", "t.c", "t.p", "t.b", "t.z"],
        ),
    ],
    ids=["unchanged columns", "changed columns"],
)
def test_keeps_the_sorted_order_when_the_old_defaults_read_each_other_in_a_cycle(
    before: list[dict[str, Any]], after: list[dict[str, Any]], order: list[str]
) -> None:
    # An old schema whose defaults read each other in a cycle (ClickHouse
    # refuses one) cannot be replayed, so the table keeps its sorted order: a
    # cycle among unchanged single reads (``c``, ``d``) and one the walk meets
    # again (``b``, ``z``).
    assert _order_of([_t(before)], [_t(after)]) == order


@pytest.mark.parametrize(
    ("expression", "name"),
    [
        ("toString(date_add(day, if(true, 1, 0), toDateTime(id)))", "day"),
        ("toString(not - toInt64(id))", "not"),
    ],
)
def test_a_bare_special_word_is_no_read_of_a_column_with_that_name(expression: str, name: str) -> None:
    # The unit of `date_add`, `dateDiff` and the like, a bare NOT and a bare
    # SELECT are not reads even when a column has that name, so these tables
    # keep their sorted order: the ALIAS `b` runs after `a` changes. `a` keeps
    # its type, so no type change orders `z` (#814).
    assert _order_of(
        [_t([{"name": "a", "type": "String"}, _u(name, "z"), _u("z", "length(toString(a))")])],
        [_t([
            _text("a", expression),
            _u("b", "match(a, 'x')", type="UInt8", default_kind="ALIAS"),
            _u(name, "id"),
            _u("z", "id"),
        ])],
    ) == ["t.a", "t.b", f"t.{name}", "t.z"]


def test_a_datediff_unit_is_no_read_of_a_column_with_that_name() -> None:
    # `a` keeps its type, so no type change orders `c` (#814).
    assert _order_of(
        [_t([_u("a"), _u("b"), _text("c", "a"), _text("hour", "c")])],
        [_t([
            _u("a", "dateDiff(hour, toDateTime(0), toDateTime(id))"),
            _u("b", "a + 1"),
            _text("c", "'x'"),
            _text("hour", "'y'"),
        ])],
    ) == ["t.a", "t.b", "t.c", "t.hour"]


def test_a_bare_select_keeps_the_sorted_order_even_with_a_column_of_that_name() -> None:
    extra = [_u("SELECT"), _u("extra", "toUInt64((SELECT + 1))")]
    assert _order_of(
        [_t([*_CYCLE_BEFORE, *extra])], [_t([*_CYCLE_AFTER, *extra])]
    ) == ["t.a", "t.b", "t.c"]


@pytest.mark.parametrize(
    "expression", ["CAST(tuple(id) AS Tuple(`a-b` UInt64))", "tuple(id)::Tuple(`a-b` UInt64)"]
)
def test_an_unchanged_quoted_tuple_field_keeps_the_repair(expression: str) -> None:
    # A quoted Tuple element name is part of the type, in both casts.
    extra = {"name": "extra", "type": "Tuple(`a-b` UInt64)", "default": _expr(expression)}
    assert _order_of(
        [_t([*_CYCLE_BEFORE, extra])], [_t([*_CYCLE_AFTER, extra])]
    ) == ["t.b", "t.a", "t.c"]


def test_a_deeply_nested_cast_in_an_unchanged_table_plans_nothing() -> None:
    # A deeply nested cast is not parsed, and an unchanged table is not looked at.
    nested = "CAST(id AS " + "Array(" * 1050 + "UInt64" + ")" * 1050 + ")"
    deep = {"name": "deep", "type": "String", "default": _expr(nested)}
    assert plan_diff([_t([_u("a"), deep])], [_t([_u("a"), deep])]).operations == []


def test_a_shared_key_does_not_link_two_tables_so_the_other_table_is_still_repaired() -> None:
    # Column `x:column:a` of `t` and column `a` of `t:column:x` share a key,
    # but their statements are keyed by column (#801), so no prerequisite links
    # the two tables. `t:column:x` keeps its sorted order because of its
    # INTERVAL; `t` is still repaired: `MODIFY y` runs before the MODIFY of
    # `x:column:a` that would close the cycle through `y` and `z`.
    interval = _u("k", "toUInt64(toDateTime(id) + INTERVAL 1 day)")
    previous = [
        _t([_u("x:column:a"), _u("y", "z"), _u("z", "`x:column:a`")], "t"),
        _t([_u("b", "1"), interval], "t:column:x"),
    ]
    next_ = [
        _t([_u("x:column:a", "y"), _u("y", "id"), _u("z", "id")], "t"),
        _t([_u("a"), _u("b", "id"), interval], "t:column:x"),
    ]
    assert [op.sql for op in plan_diff(previous, next_).operations] == [
        "ALTER TABLE app.`t:column:x` ADD COLUMN IF NOT EXISTS `a` UInt64;",
        "ALTER TABLE app.`t:column:x` MODIFY COLUMN `b` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `y` UInt64 DEFAULT id;",
        "ALTER TABLE app.t MODIFY COLUMN `x:column:a` UInt64 DEFAULT y;",
        "ALTER TABLE app.t MODIFY COLUMN `z` UInt64 DEFAULT id;",
    ]


_FALLBACK = ["t.a", "t.b", "t.c"]
_REPAIRED = ["t.b", "t.a", "t.c"]


@pytest.mark.parametrize(
    ("extra", "order"),
    [
        pytest.param([_u("APPLY"), _u("extra", "toUInt64(APPLY)")], _REPAIRED, id="a bare APPLY"),
        pytest.param([_u("join"), _u("extra", "toUInt64(join)")], _REPAIRED, id="a bare JOIN"),
        pytest.param([_u("placing"), _u("extra", "toUInt64(placing)")], _REPAIRED, id="a bare PLACING"),
        pytest.param(
            [_u("left"), _u("RIGHT"), _u("extra", "left + RIGHT")], _REPAIRED, id="bare left and RIGHT"
        ),
        pytest.param(
            [_u("format"), _u("union"), _u("extra", "plus(format, -union)")],
            _REPAIRED,
            id="bare format and union",
        ),
        pytest.param(
            [_u("offset"), _u("step"), _u("Final"), _u("extra", "offset * step = Final")],
            _REPAIRED,
            id="bare offset, step and Final",
        ),
        pytest.param(
            [_u("settings"), _u("sample"), _u("extra", "CAST(settings AS UInt64) + sample::UInt64")],
            _REPAIRED,
            id="bare settings and sample",
        ),
        pytest.param(
            [_u("extra", "toUInt64(left(toString(id), 1)) + toUInt64(RIGHT(toString(id), 1))")],
            _REPAIRED,
            id="calls to left and RIGHT",
        ),
        pytest.param(
            [_u("extra", "length(format('{}-{}', toString(id), 'x'))")], _REPAIRED, id="a call to format"
        ),
        pytest.param(
            [_u("left"), _u("extra", "toUInt64(left(toString(left), 1))")],
            _REPAIRED,
            id="a call to left with a left column",
        ),
        pytest.param([_u("offset"), _u("extra", "id offset")], _FALLBACK, id="a query word after an operand"),
        pytest.param([_u("values"), _u("extra", "(values - (1))")], _FALLBACK, id="a bare values"),
        pytest.param([_u("extra", "toUInt64((values(id)))")], _FALLBACK, id="a call to values"),
        pytest.param([_u("APPLY"), _u("extra", "toUInt64(`APPLY`)")], _REPAIRED, id="a quoted APPLY"),
        pytest.param(
            [_u("extra", "length(eXTrAcT('abc', 'a'))")], _FALLBACK, id="eXTrAcT with string arguments"
        ),
        pytest.param(
            [_u("extra", "toUInt64(dateDiff('day', toDateTime(id), toDateTime(id)))")],
            _FALLBACK,
            id="dateDiff with a string unit",
        ),
        pytest.param(
            [_u("extra", "abs(plus(1, DATEDIFF('day', toDateTime(id), toDateTime(id))))")],
            _FALLBACK,
            id="a nested DATEDIFF",
        ),
        pytest.param(
            [_u("extra", "toUInt64(date_part('day', toDateTime(id)))")], _FALLBACK, id="date_part"
        ),
        pytest.param(
            [_u("extract"), _u("extra", "toUInt64(`extract`)")], _REPAIRED, id="a quoted extract column"
        ),
        pytest.param([_u("extra", "LENGTH(toString(id))")], _REPAIRED, id="a mixed-case LENGTH"),
        pytest.param(
            [_u("extra", "toUInt64(position('abc', 'b'))")], _REPAIRED, id="a call to position"
        ),
    ],
)
def test_query_words_and_unit_calls_keep_the_sorted_order(
    extra: list[dict[str, Any]], order: list[str]
) -> None:
    # A call to a function whose arguments can be units or keywords (in any
    # case, with any arguments) keeps the sorted order. A bare query or join
    # word reads its column and a call to one is a function, as ClickHouse 26.3
    # parses them, so both keep the repair; such a word after an operand does
    # not, nor does `values` (a VALUES subquery from 26.4). A quoted name is a column read, and other calls, in any case, keep
    # the repair.
    assert _order_of(
        [_t([*_CYCLE_BEFORE, *extra])], [_t([*_CYCLE_AFTER, *extra])]
    ) == order


@pytest.mark.parametrize(
    ("name", "order"),
    [
        ("true", _FALLBACK),
        ("FALSE", _FALLBACK),
        ("Inf", _FALLBACK),
        ("nan", _FALLBACK),
        ("infinity", _FALLBACK),
        ("not", _FALLBACK),
        ("NoT", _FALLBACK),
        ("null", _REPAIRED),
        ("all", _REPAIRED),
        ("ALL", _REPAIRED),
        ("select", _REPAIRED),
    ],
)
def test_a_quoted_literal_word_keeps_the_sorted_order(name: str, order: list[str]) -> None:
    # ALTER's cycle check reads a quoted `true`, `false`, `inf`, `nan` or
    # `infinity` as a literal, and ClickHouse stores a quoted `not` before an
    # operand as NOT, so an expression with one keeps the sorted order. A
    # quoted `null`, and a quoted name of any other keyword, reads its column:
    # on ClickHouse 26.3, of the 388 one-word `system.keywords`, only `not`,
    # `true` and `false` escaped ALTER's cycle check in eleven positions.
    extra = [_u(name), _u("extra", f"toUInt64(`{name}`)")]
    assert _order_of(
        [_t([*_CYCLE_BEFORE, *extra])], [_t([*_CYCLE_AFTER, *extra])]
    ) == order


def test_a_quoted_true_is_no_read_of_a_column_with_that_name() -> None:
    # `toUInt64(`true`)` reads no column, so `a` does not read the column
    # `true`: the table keeps its sorted order, where `b DEFAULT a + 1` runs
    # after `a` changes. `a` keeps its type, so no type change orders `c` (#814).
    assert _order_of(
        [_t([_u("a"), _u("b"), _text("c", "a"), _text("true", "c")])],
        [_t([_u("a", "toUInt64(`true`)"), _u("b", "a + 1"), _text("c", "'x'"), _text("true", "'y'")])],
    ) == ["t.a", "t.b", "t.c", "t.true"]


def test_a_quoted_all_is_a_read_of_the_column_with_that_name() -> None:
    # ALTER's cycle check reads a quoted `all` as the column (ClickHouse 26.3
    # rejects main's order with code 174), so the table is repaired.
    assert _order_of(
        [_t([_u("a"), _u("aa"), _u("ab", "a"), _u("all", "ab")])],
        [_t([_u("a", "`all` + 1"), _u("aa", "a + 1"), _u("ab", "5"), _u("all", "5")])],
    ) == ["t.aa", "t.ab", "t.a", "t.all"]


def test_a_bare_left_on_the_cycle_is_a_read_of_its_column() -> None:
    # ClickHouse 26.3 reads a bare `left` as the column: main's order fails
    # with code 174 when `a DEFAULT left + 1` closes a -> left -> c -> a.
    # Either `c` or `left` breaks it, so the first in key order, `c`, runs
    # first.
    assert _order_of(
        [_t([_u("a"), _u("c", "a"), _u("left", "c")])],
        [_t([_u("a", "left + 1"), _u("c", "id"), _u("left", "id")])],
    ) == ["t.c", "t.a", "t.left"]


def test_a_quoted_not_is_no_read_of_a_column_with_that_name() -> None:
    # ClickHouse stores `` `not` + 1 `` as `NOT 1`, so `a` does not read the
    # column `not` and the table keeps its sorted order. `a` keeps its type, so
    # no type change orders `c` (#814).
    assert _order_of(
        [_t([_u("a"), _u("b"), _text("c", "a"), _u("not", "length(c)")])],
        [_t([_u("a", "`not` + 1"), _u("b", "a + 1"), _text("c", "'x'"), _u("not", "5")])],
    ) == ["t.a", "t.b", "t.c", "t.not"]


def test_charges_the_reads_a_modify_keeps() -> None:
    # Every read the replay looks at uses work, also the reads a change keeps.
    def work(width: int) -> int:
        p = [f"p{i:05d}" for i in range(width)]
        total = " + ".join(p)
        columns = [_u(name) for name in p]
        assert _order_of(
            [_t([_u("a", total), _u("b", "a"), *columns])],
            [_t([_u("a", f"{total} + b"), _u("b", "id"), *columns])],
        ) == ["t.b", "t.a"]
        return _cycle_repair_work.units

    narrow = work(1)
    assert work(4096) > narrow + 4096


def test_charges_the_reads_a_replayed_modify_removes() -> None:
    w = [_u(f"w{i:03d}") for i in range(256)]
    total = " + ".join(column["name"] for column in w)
    plan_diff([_t([_u("b", f"z + {total}"), _u("z"), *w])], [_t([_u("b", "1"), _u("z", "b"), *w])])
    assert _cycle_repair_work.units > 256


_Schema = list[list[Any]]


def _nine_cycles(chain: int) -> tuple[_Schema, _Schema]:
    k = range(9)
    links = [[f"kc{i:03d}", f"kc{i + 1:03d}" if i + 1 < chain else "kz"] for i in range(chain)]
    total = " + ".join(f"ka{i:03d}" for i in k)
    return (
        [["a", "toUInt64(false)"], ["b", "c"], ["c", "a"], ["d", "b"], ["null", "a"], ["false", "b"],
         *[[f"ka{i:03d}", None] for i in k], *[[f"kb{i:03d}", "kc000"] for i in k], ["j", None],
         *links, ["kz", f"{total} + id + j"]],
        [["a", "b"], ["b", "ifNull(null, 0) + d"], ["c", "id"], ["d", "id"], ["null", "a"], ["false", "b"],
         *[[f"ka{i:03d}", f"kb{i:03d}"] for i in k], *[[f"kb{i:03d}", "id"] for i in k], ["j", None],
         *links, ["kz", "id"]],
    )


def _chain_and_fan_in() -> tuple[_Schema, _Schema]:
    p = [[f"p{i:03d}", f"p{i + 1:03d}" if i + 1 < 315 else None] for i in range(315)]
    y = [f"y_b{i:03d}" for i in range(20)]
    return (
        [["m", "x"], ["null", "toUInt64(true)"], ["true", "x"], ["x", "z"], ["z", "`null`"], ["q", None],
         ["p", "p000"], *p, *[[name, "y_c"] for name in y], ["y_c", "y_a"], ["y_a", None]],
        [["m", "id"], ["null", "x"], ["true", "x"], ["x", "ifNull(null, p + q + m)"], ["z", "id"],
         ["q", None], ["p", "p000"], *p, *[[name, "id"] for name in y], ["y_c", "id"],
         ["y_a", " + ".join(y)]],
    )


def _fan_in(m: int) -> tuple[_Schema, _Schema]:
    # ``m`` cycles ``a_i`` -> ``b_i`` -> ``c000`` -> ... -> ``c029`` -> ``z`` -> ``a_i``.
    k = range(m)
    links = [[f"c{i:03d}", f"c{i + 1:03d}" if i + 1 < 30 else "z"] for i in range(30)]
    total = " + ".join(f"a{i:03d}" for i in k)
    return (
        [*[[f"a{i:03d}", None] for i in k], *[[f"b{i:03d}", "c000"] for i in k], *links,
         ["z", f"{total} + id"]],
        [*[[f"a{i:03d}", f"b{i:03d}"] for i in k], *[[f"b{i:03d}", "id"] for i in k], *links,
         ["z", "id"]],
    )


# The work and the plan near the edge of the work budget, the same as in the
# TS tests (planner-dependency-order.test.ts). Nine cycles through one long
# chain of unchanged defaults are repaired whatever its length: the walks skip
# the chain (#829). Cycles through one chain whose end reads every cycle's
# column still cost the cycles squared: 50 are repaired, 60 run out of work and
# keep the sorted order.
_BUDGET_EDGE: dict[str, tuple[tuple[_Schema, _Schema], int, str, str]] = {
    "nine cycles through 449 links": (
        _nine_cycles(449), 1291, "c", "7fc14481e96d7b6347bd4aabe0c280403a5d8ed4e4da69854070032d1b5dc098"
    ),
    "nine cycles through 85 links": (
        _nine_cycles(85), 563, "c", "7fc14481e96d7b6347bd4aabe0c280403a5d8ed4e4da69854070032d1b5dc098"
    ),
    "nine cycles through 86 links": (
        _nine_cycles(86), 565, "c", "7fc14481e96d7b6347bd4aabe0c280403a5d8ed4e4da69854070032d1b5dc098"
    ),
    "30 cycles through 30 links": (
        _fan_in(30), 1807, "b000", "c9b8ec508f9b1e19693d8da1e7138fd8055abfd4a2ce8d638c8e7093d593879e"
    ),
    "50 cycles through 30 links": (
        _fan_in(50), 3967, "b000", "734d0b6c25b51d293c74327216b4fea5a1c11fe13660488ec1f084c3bbfde145"
    ),
    "60 cycles through 30 links": (
        _fan_in(60), 4648, "a000", "ee8a4528f50e4af7107b205dbfc26ae7b2dd7bd945d8654f3f2074c9603f2cad"
    ),
    "a chain and a fan-in": (
        _chain_and_fan_in(), 1808, "m", "f0ea844653d573b9fd93c11b98a1cf6f6e2f31d10c03d08aa9ee0572f4d8fd36"
    ),
}


@pytest.mark.parametrize("label", list(_BUDGET_EDGE))
def test_plans_the_budget_edge_with_the_same_work_and_sql_as_ts_under_every_hash_seed(label: str) -> None:
    script = (
        "import hashlib, json, sys\n"
        "from chkit.core.model import table\n"
        "from chkit.core.column_cycle_repair import _cycle_repair_work\n"
        "from chkit.core.planner import plan_diff\n"
        "def t(columns):\n"
        "    return table(database='app', name='t', columns=[{'name': 'id', 'type': 'UInt64'}] + [\n"
        "        {'name': n, 'type': 'UInt64', **({} if e is None else {'default': {'expression': e}})}\n"
        "        for n, e in columns], engine='MergeTree()', primary_key=['id'], order_by=['id'])\n"
        "before, after = json.loads(sys.stdin.read())\n"
        "sql = [op.sql for op in plan_diff([t(before)], [t(after)]).operations]\n"
        "print(json.dumps([_cycle_repair_work.units, sql[0],\n"
        "    hashlib.sha256('\\n'.join(sql).encode()).hexdigest()]))\n"
    )
    columns, units, first, digest = _BUDGET_EDGE[label]
    for seed in ("0", "1", "2", "5", "37"):
        result = subprocess.run(
            [sys.executable, "-c", script],
            input=json.dumps(columns),
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "PYTHONHASHSEED": seed},
        )
        found_units, found_first, found_digest = json.loads(result.stdout)
        assert found_units == units, seed
        assert found_first.startswith(f"ALTER TABLE app.t MODIFY COLUMN `{first}` "), seed
        assert found_digest == digest, seed
    # And in this interpreter.
    before, after = columns
    sql = [
        op.sql
        for op in plan_diff(
            [_t([_u(name, expression) for name, expression in before])],
            [_t([_u(name, expression) for name, expression in after])],
        ).operations
    ]
    assert _cycle_repair_work.units == units
    assert hashlib.sha256("\n".join(sql).encode()).hexdigest() == digest


# ---------- the column reads skip lambda parameters and CAST types (#768) ----------


_READ_COLUMNS = ["a", "arr", "c", "id", "n.x", "threshold", "UInt64", "x", "y"]


def _reads_of(expression: str) -> list[str]:
    columns: list[dict[str, object]] = [{"name": name, "type": "UInt64"} for name in _READ_COLUMNS]
    columns.append({"name": "v", "type": "UInt64", "default": _expr(expression)})
    definition = table(
        database="app",
        name="t",
        columns=list(columns),
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )
    reads = _column_default_reads([definition]).get("table:app.t:column:v", set())
    return sorted(key[len("table:app.t:column:"):] for key in reads)


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("arrayMap(c -> c, [1])", []),
        ("arrayMap((x, y) -> x + y, arr, arr)", ["arr"]),
        ("arrayMap((`x`, y) -> `x` * y, arr, arr)", ["arr"]),
        ("arrayMap(a -> a.x, arr)", ["arr"]),
        ("arrayMap(a -> a.x.y + c, arr)", ["arr", "c"]),
        ("arrayFilter(x -> x > threshold, arr)", ["arr", "threshold"]),
        ("arrayMap(x -> arrayMap(y -> x + y + c, arr), [arr])", ["arr", "c"]),
        ("arrayMap(x -> arrayMap(x -> x, [x]), [1])", []),
        ("arrayMap(x -> x, [1]) + x", ["x"]),
        ("arrayMap(x -> x, x)", ["x"]),
        ("arrayMap(x -> (x, y), arr)", ["arr", "y"]),
        ("arrayMap(x -> c.x, arr)", ["arr", "c"]),
        ("arrayMap(n -> n.x, arr)", ["arr"]),
        ("arrayMap(`n` -> `n`.`x`, arr)", ["arr"]),
        ("arrayMap(y -> y + n.x, arr)", ["arr", "n.x"]),
        ("arrayMap(n -> n.x, arr) + n.x", ["arr", "n.x"]),
    ],
)
def test_reads_skip_lambda_parameters(expression: str, expected: list[str]) -> None:
    assert _reads_of(expression) == expected


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("CAST(id AS UInt64)", ["id"]),
        ("cast(id AS Nullable(UInt64))", ["id"]),
        ("CAST(id AS Array(Tuple(a UInt64, x String)))", ["id"]),
        ("CAST(id AS DateTime64(3, 'UTC'))", ["id"]),
        ("CAST(CAST(a AS UInt8) AS UInt64)", ["a"]),
        ("CAST(a AS UInt64) + UInt64", ["UInt64", "a"]),
        ("id::UInt64", ["id"]),
        ("id::Nullable(UInt64) + x", ["id", "x"]),
        ("id::Array(Tuple(a UInt64)) + c", ["c", "id"]),
        ("CAST([id AS q, c], 'Array(UInt64)')", ["c", "id"]),
        ("CAST([id AS q, c] AS Array(UInt64))", ["c", "id"]),
        ("CAST((id AS q, c) AS Tuple(UInt64, UInt64))", ["c", "id"]),
        ("[id, c]::Array(UInt64)", ["c", "id"]),
    ],
)
def test_reads_skip_cast_types(expression: str, expected: list[str]) -> None:
    assert _reads_of(expression) == expected


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("-> x", ["x"]),
        ("(x, y -> x", ["x"]),
        ("() -> x", ["x"]),
        ("CAST(a AS", ["a"]),
        ("a::", ["a"]),
    ],
)
def test_reads_of_incomplete_expressions(expression: str, expected: list[str]) -> None:
    assert _reads_of(expression) == expected


def test_adds_a_dotted_column_before_the_default_that_reads_it_without_backquotes() -> None:
    assert _added_columns([
        {"name": "a", "type": "UInt64", "default": SQLExpression(expression="arraySum(n.x)")},
        {"name": "n.x", "type": "Array(UInt64)"},
    ]) == [
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `n.x` Array(UInt64);",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT arraySum(n.x);",
    ]


def test_a_dotted_run_reads_its_longest_leading_column_not_a_shorter_prefix() -> None:
    assert _added_columns([
        {"name": "a", "type": "UInt64",
         "default": SQLExpression(expression="length(n.x) + `n`.`x`[1]")},
        {"name": "b", "type": "UInt64", "default": SQLExpression(expression="a + 1")},
        {"name": "n", "type": "Tuple(y Array(UInt64))",
         "default": SQLExpression(expression="tuple([b])")},
        {"name": "n.x", "type": "Array(UInt64)"},
    ]) == [
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `n.x` Array(UInt64);",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT length(n.x) + `n`.`x`[1];",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `b` UInt64 DEFAULT a + 1;",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `n` Tuple(y Array(UInt64)) DEFAULT tuple([b]);",
    ]


def test_a_qualifier_that_is_no_column_is_dropped_and_a_column_prefix_is_read() -> None:
    assert _added_columns([
        {"name": "a", "type": "UInt64",
         "default": SQLExpression(expression="app.orders.price + orders.qty + t.first")},
        {"name": "price", "type": "UInt64"},
        {"name": "qty", "type": "UInt64"},
        {"name": "t", "type": "Tuple(first UInt64)"},
    ]) == [
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `price` UInt64;",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `qty` UInt64;",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `t` Tuple(first UInt64);",
        "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT app.orders.price + orders.qty + t.first;",
    ]


# ---------- a column type change ordered against the expressions that read it (#814) ----------


def test_changes_the_type_after_the_modify_whose_new_default_stops_reading_the_column() -> None:
    assert _sqls(
        [_t([{"name": "a", "type": "String"}, {"name": "b", "type": "UInt64", "default": _expr("length(a)")}])],
        [_t([{"name": "a", "type": "UInt64"}, {"name": "b", "type": "UInt64", "default": _expr("0")}])],
    ) == ["ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT 0;", "ALTER TABLE app.t MODIFY COLUMN `a` UInt64;"]


def test_changes_the_type_after_the_drop_of_a_column_whose_alias_reads_it() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "String"},
            {"name": "b", "type": "UInt64", "defaultKind": "ALIAS", "default": _expr("length(a)")},
        ])],
        [_t([{"name": "a", "type": "UInt64"}])],
    ) == ["ALTER TABLE app.t DROP COLUMN IF EXISTS `b`;", "ALTER TABLE app.t MODIFY COLUMN `a` UInt64;"]


def test_runs_the_modify_and_the_add_whose_new_default_starts_reading_the_column_after_its_type_change() -> None:
    assert _sqls(
        [_t([{"name": "b", "type": "UInt64", "default": _expr("0")}, {"name": "z", "type": "String"}])],
        [_t([
            {"name": "b", "type": "UInt64", "default": _expr("z + 1")},
            {"name": "c", "type": "UInt64", "defaultKind": "MATERIALIZED", "default": _expr("z * 2")},
            {"name": "z", "type": "UInt64"},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `z` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT z + 1;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c` UInt64 MATERIALIZED z * 2;",
    ]


# No order of the two MODIFYs applies when both DEFAULTs need their own type of `a`.
def test_keeps_key_order_when_the_old_and_the_new_default_both_read_the_column() -> None:
    assert _sqls(
        [_t([{"name": "a", "type": "String"}, {"name": "b", "type": "UInt64", "default": _expr("length(a)")}])],
        [_t([{"name": "a", "type": "UInt64"}, {"name": "b", "type": "UInt64", "default": _expr("a + 1")}])],
    ) == ["ALTER TABLE app.t MODIFY COLUMN `a` UInt64;", "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT a + 1;"]


# Moving MODIFY `a` behind `b` must not move it behind `z`, whose new
# DEFAULT needs the new type and which ran after it before.
def test_a_statement_whose_old_and_new_default_both_read_the_column_keeps_its_side_of_the_type_change() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "String"},
            {"name": "b", "type": "UInt64", "default": _expr("length(a)")},
            {"name": "z", "type": "UInt64", "default": _expr("length(toString(a))")},
        ])],
        [_t([
            {"name": "a", "type": "UInt64"},
            {"name": "b", "type": "UInt64", "default": _expr("0")},
            {"name": "z", "type": "UInt64", "default": _expr("a + 1")},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT 0;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `z` UInt64 DEFAULT a + 1;",
    ]


# `b` would wait for `a`, `z` for `b`, and `a` already waits for `z`: the
# edge the sort already satisfies goes in, the other is left out.
def test_keeps_the_sorted_order_when_two_type_change_edges_conflict() -> None:
    assert _sqls(
        [_t([{"name": "a", "type": "UInt64", "default": _expr("toUInt64(b)")}, {"name": "b", "type": "UInt8"}])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("z")},
            {"name": "b", "type": "UInt16"},
            {"name": "z", "type": "UInt64", "default": _expr("toUInt64(b)")},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt16;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64 DEFAULT toUInt64(b);",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT z;",
    ]


# Holding `a` and `b` behind `x` would run `c DEFAULT a` while the old
# `a DEFAULT b` and `b DEFAULT c` stand, so the sorted order stays.
def test_keeps_the_sorted_order_when_the_type_change_edges_would_close_a_cycle_of_expressions() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("b")},
            {"name": "b", "type": "UInt64", "default": _expr("c")},
            {"name": "c", "type": "UInt64", "default": _expr("0")},
            {"name": "x", "type": "UInt32"},
        ])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("x")},
            {"name": "b", "type": "UInt64", "default": _expr("x")},
            {"name": "c", "type": "UInt64", "default": _expr("a")},
            {"name": "x", "type": "UInt64"},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT x;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT x;",
        "ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT a;",
        "ALTER TABLE app.t MODIFY COLUMN `x` UInt64;",
    ]


# The TTL edges would run `b` first, and the unchanged `c` would then add
# two DateTimes: type changes keep their order, so the sorted order stays.
def test_keeps_the_sorted_order_when_it_would_reorder_two_type_changes() -> None:
    assert _sqls(
        [_t(
            [
                {"name": "a", "type": "DateTime"},
                {"name": "b", "type": "UInt32"},
                {"name": "c", "type": "String", "default": _expr("toString(a + b)")},
            ],
            ttl="toDateTime(toUInt32(a))",
        )],
        [_t(
            [
                {"name": "a", "type": "UInt32"},
                {"name": "b", "type": "DateTime"},
                {"name": "c", "type": "String", "default": _expr("toString(a + b)")},
            ],
            ttl="toDateTime(toUInt32(b))",
        )],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt32;",
        "ALTER TABLE app.t MODIFY COLUMN `b` DateTime;",
        "ALTER TABLE app.t MODIFY TTL toDateTime(toUInt32(b));",
    ]


# The unchanged `c DEFAULT if(id = 0, a, b)` sees the types of `a` and `b`
# in the order their changes run, so that order stays.
def test_type_changes_keep_their_order_among_themselves() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "Int64"},
            {"name": "b", "type": "UInt32"},
            {"name": "c", "type": "UInt64", "default": _expr("if(id = 0, a, b)")},
            {"name": "d", "type": "UInt64", "default": _expr("toUInt64(a)")},
        ])],
        [_t([
            {"name": "a", "type": "UInt32"},
            {"name": "b", "type": "UInt64"},
            {"name": "c", "type": "UInt64", "default": _expr("if(id = 0, a, b)")},
            {"name": "d", "type": "UInt64", "default": _expr("0")},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `d` UInt64 DEFAULT 0;",
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt32;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64;",
    ]


# Each ADD COLUMN appends its column, so moving `a` behind the type change
# and past the ADD of `b` would change the table's column order.
def test_keeps_the_sorted_order_when_it_would_change_the_order_of_the_add_columns() -> None:
    assert _sqls(
        [_t([{"name": "z", "type": "UInt32"}])],
        [_t([
            {"name": "z", "type": "UInt64"},
            {"name": "a", "type": "UInt64", "default": _expr("toUInt64(z)")},
            {"name": "b", "type": "String"},
        ])],
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT toUInt64(z);",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `b` String;",
        "ALTER TABLE app.t MODIFY COLUMN `z` UInt64;",
    ]


# Moving ADD `n` and ADD `k` behind the type change would run ADD `k`
# while `k.x` exists, which ClickHouse skips: ADDs and DROPs keep their order.
def test_keeps_the_sorted_order_when_it_would_move_an_add_past_a_drop() -> None:
    assert _sqls(
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("length(`k.x`)")},
            {"name": "k.x", "type": "Array(UInt32)"},
            {"name": "z", "type": "UInt32"},
        ])],
        [_t([
            {"name": "a", "type": "UInt64", "default": _expr("z")},
            {"name": "k", "type": "UInt64", "default": _expr("n")},
            {"name": "n", "type": "UInt64"},
            {"name": "z", "type": "UInt64"},
        ])],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT z;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `k.x`;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `n` UInt64;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `k` UInt64 DEFAULT n;",
        "ALTER TABLE app.t MODIFY COLUMN `z` UInt64;",
    ]


def test_changes_the_type_after_the_table_ttl_stops_reading_the_column() -> None:
    assert _sqls(
        [_t([{"name": "a", "type": "String"}], ttl="toDateTime(id) + toIntervalDay(length(a))")],
        [_t([{"name": "a", "type": "UInt64"}], ttl="toDateTime(id) + INTERVAL 1 DAY")],
    ) == ["ALTER TABLE app.t MODIFY TTL toDateTime(id) + INTERVAL 1 DAY;", "ALTER TABLE app.t MODIFY COLUMN `a` UInt64;"]


# Moving MODIFY `a` behind the TTL change would move it past the ADD INDEX
# that sits between them, so the sorted order stays.
def test_keeps_the_sorted_order_when_a_statement_would_move_past_another_alter() -> None:
    assert _sqls(
        [_t([{"name": "a", "type": "String"}], ttl="toDateTime(id) + toIntervalDay(length(a))")],
        [_t(
            [{"name": "a", "type": "UInt64"}],
            ttl="toDateTime(id) + INTERVAL 1 DAY",
            indexes=[{"name": "idx", "expression": "a", "type": "minmax", "granularity": 1}],
        )],
    ) == [
        "ALTER TABLE app.t MODIFY COLUMN `a` UInt64;",
        "ALTER TABLE app.t ADD INDEX IF NOT EXISTS `idx` (a) TYPE minmax GRANULARITY 1;",
        "ALTER TABLE app.t MODIFY TTL toDateTime(id) + INTERVAL 1 DAY;",
    ]


def test_a_table_with_a_column_rename_keeps_its_type_change_order() -> None:
    previous: list[SchemaDefinition] = [_t([
        {"name": "a", "type": "String"},
        {"name": "b", "type": "UInt64", "default": _expr("length(a)")},
        {"name": "old", "type": "UInt64"},
    ])]
    next_: list[SchemaDefinition] = [_t([
        {"name": "a", "type": "UInt64"},
        {"name": "b", "type": "UInt64", "default": _expr("0")},
        {"name": "new", "type": "UInt64"},
    ])]
    rename = ColumnRenameSuggestion.model_validate({
        "database": "app", "table": "t", "from": "old", "to": "new", "reason": "test",
        "dropOperationKey": "table:app.t:column:old", "addOperationKey": "table:app.t:column:new",
        "confirmationSQL": "RENAME",
    })
    operations = [
        MigrationOperation(type="alter_table_modify_column", key="table:app.t:column:a", risk="caution", sql="MODIFY a"),
        MigrationOperation(type="alter_table_modify_column", key="table:app.t:column:b", risk="caution", sql="MODIFY b"),
        MigrationOperation(type="alter_table_rename_column", key=column_rename_key(rename), risk="caution", sql="RENAME"),
    ]

    def order(renames: list[ColumnRenameSuggestion]) -> list[str]:
        return [
            op.sql
            for op in order_column_statements(operations, previous=previous, next_=next_, renames=renames)
        ]

    assert order([rename]) == ["MODIFY a", "MODIFY b", "RENAME"]
    assert order([]) == ["MODIFY b", "MODIFY a", "RENAME"]
