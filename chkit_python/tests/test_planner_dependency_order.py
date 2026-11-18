"""Port of ``packages/core/src/planner-dependency-order.test.ts`` (#231)."""

from __future__ import annotations

import time
from typing import Any

import pytest

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import (
    DictionaryDefinition,
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
from chkit.core.planner import _column_default_reads, plan_diff


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


def test_plans_a_wide_table_whose_every_modify_closes_a_cycle_in_time_that_grows_with_its_width() -> None:
    # Each column reads the one before it and changes to read the one two
    # places ahead, so every MODIFY waits for a breaker. Four times the columns
    # take about four times as long; a quadratic repair would take sixteen.
    def name(i: int) -> str:
        return f"c{i:04d}"

    def plan(count: int) -> tuple[float, list[str]]:
        before = [_u(name(i), "1" if i == 0 else name(i - 1)) for i in range(count)]
        after = [_u(name(i), name(i + 2) if i + 2 < count else "1") for i in range(count)]
        best = float("inf")
        operations: list[MigrationOperation] = []
        for _ in range(2):
            start = time.perf_counter()
            operations = plan_diff([_t(before)], [_t(after)]).operations
            best = min(best, time.perf_counter() - start)
        return best, [op.key[len("table:app.t:column:"):] for op in operations[:3]]

    narrow, _ = plan(1200)
    wide, first = plan(4800)
    assert first == ["c4798", "c4797", "c4796"]
    assert wide < max(8 * narrow, 0.05)
    assert wide < 5


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
