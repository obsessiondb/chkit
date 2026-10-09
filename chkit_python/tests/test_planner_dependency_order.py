"""Port of ``packages/core/src/planner-dependency-order.test.ts`` (#231)."""

from __future__ import annotations

from typing import Any

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import (
    DictionaryDefinition,
    SchemaDefinition,
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
