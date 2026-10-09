"""Port of ``packages/core/src/planner-sql-comments.test.ts`` (#232)."""

from __future__ import annotations

import re
from typing import Any

import pytest

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import (
    MigrationPlan,
    TableDefinition,
    ViewDefinition,
    dictionary,
    materialized_view,
    table,
    view,
)
from chkit.core.planner import plan_diff
from chkit.core.sql_splitter import extract_executable_statements
from chkit.core.validate import validate_definitions

# The view SQL from issue #232: a `--` comment with an apostrophe between CTEs.
ISSUE_AS = "\n".join([
    "WITH people_by_email AS (SELECT person_id, company_id, arrayJoin(emails) AS email "
    "FROM brain.person_identity),",
    "-- The attendee's company: through their person record, else through the email domain.",
    "meeting_company AS (",
    "  SELECT email, company_id FROM people_by_email",
    ")",
    "SELECT email, company_id FROM meeting_company",
])

_DEFAULT_COLUMNS: list[dict[str, Any]] = [
    {"name": "id", "type": "UInt64"},
    {"name": "name", "type": "String"},
    {"name": "ts", "type": "DateTime"},
]


def events(**overrides: Any) -> TableDefinition:
    return table(**{
        "database": "app",
        "name": "events",
        "columns": _DEFAULT_COLUMNS,
        "engine": "MergeTree()",
        "primary_key": ["id"],
        "order_by": ["id"],
        **overrides,
    })


def app_view(name: str, as_: str) -> ViewDefinition:
    return view(database="app", name=name, as_=as_)


def legacy_normalize(sql: str) -> str:
    """The canonical text chkit stored before #232: whitespace collapsed, comments kept."""
    return re.sub(r"\s+", " ", sql).strip()


def render_migration_body(plan: MigrationPlan) -> str:
    """The migration file body codegen writes, without its header."""
    return "\n\n".join(
        f"-- operation: {op.type} key={op.key} risk={op.risk}\n{op.sql}" for op in plan.operations
    )


def sql_of(plan: MigrationPlan, type_: str) -> str | None:
    return next((op.sql for op in plan.operations if op.type == type_), None)


def operation_types(plan: MigrationPlan) -> list[str]:
    return [op.type for op in plan.operations]


# ---------- plan_diff with SQL comments in fragments ----------


def test_issue_repro_view_renders_as_one_complete_statement() -> None:
    plan = plan_diff([], [view(database="brain", name="meeting_company", as_=ISSUE_AS)])
    assert sql_of(plan, "create_view") == (
        "CREATE VIEW IF NOT EXISTS brain.meeting_company AS\nWITH people_by_email AS (SELECT "
        "person_id, company_id, arrayJoin(emails) AS email FROM brain.person_identity), "
        "meeting_company AS ( SELECT email, company_id FROM people_by_email ) SELECT email, "
        "company_id FROM meeting_company;"
    )
    assert len(extract_executable_statements(render_migration_body(plan))) == len(plan.operations)


def test_trailing_comment_no_longer_swallows_the_statement_terminator() -> None:
    plan = plan_diff(
        [], [app_view("a_first", "SELECT 1 AS x\n-- trailing note"), app_view("b_second", "SELECT 2 AS y")]
    )
    statements = extract_executable_statements(render_migration_body(plan))
    assert len(statements) == len(plan.operations)
    # The Python splitter keeps the leading marker line and drops the `;`.
    assert any(st.endswith("CREATE VIEW IF NOT EXISTS app.a_first AS\nSELECT 1 AS x") for st in statements)
    assert any(st.endswith("CREATE VIEW IF NOT EXISTS app.b_second AS\nSELECT 2 AS y") for st in statements)


def test_commented_partition_by_and_ttl_keep_create_table_complete() -> None:
    plan = plan_diff(
        [],
        [
            events(partition_by="toYYYYMM(ts) -- monthly", ttl="ts + toIntervalDay(30) // retention"),
            app_view("v", "SELECT 1 AS x"),
        ],
    )
    assert len(extract_executable_statements(render_migration_body(plan))) == len(plan.operations)
    create_table = sql_of(plan, "create_table") or ""
    assert "PARTITION BY toYYYYMM(ts)\n" in create_table
    assert create_table.endswith("\nTTL ts + toIntervalDay(30);")


def test_commented_ttl_change_renders_complete_modify_ttl() -> None:
    plan = plan_diff(
        [events(ttl="ts + toIntervalDay(30)")], [events(ttl="ts + toIntervalDay(60) -- retention")]
    )
    assert [(op.type, op.sql) for op in plan.operations] == [
        ("alter_table_modify_ttl", "ALTER TABLE app.events MODIFY TTL ts + toIntervalDay(60);"),
    ]


def test_comment_only_ttl_removes_the_ttl() -> None:
    plan = plan_diff(
        [events(ttl="ts + toIntervalDay(30)")], [events(ttl="-- ts + toIntervalDay(30)")]
    )
    assert [(op.type, op.sql) for op in plan.operations] == [
        ("alter_table_modify_ttl", "ALTER TABLE app.events REMOVE TTL;"),
    ]


def test_comment_only_ttl_or_partition_by_canonicalizes_to_no_clause() -> None:
    [canonical] = canonicalize_definitions([events(partition_by="/* none yet */", ttl="# later\n")])
    assert isinstance(canonical, TableDefinition)
    assert canonical.partition_by is None
    assert canonical.ttl is None
    create_table = sql_of(
        plan_diff([], [events(partition_by="/* none yet */", ttl="# later\n")]), "create_table"
    ) or ""
    assert "PARTITION BY" not in create_table
    assert "TTL" not in create_table


def test_commented_index_and_projection_sql_renders_complete_alters() -> None:
    plan = plan_diff(
        [events()],
        [
            events(
                indexes=[{"name": "idx_name", "expression": "lower(name) -- note",
                          "type": "bloom_filter", "granularity": 1}],
                projections=[{"name": "p_recent", "query": "SELECT id -- note\nORDER BY id"}],
            )
        ],
    )
    assert len(extract_executable_statements(render_migration_body(plan))) == len(plan.operations)
    assert sql_of(plan, "alter_table_add_index") == (
        "ALTER TABLE app.events ADD INDEX IF NOT EXISTS `idx_name` (lower(name)) "
        "TYPE bloom_filter GRANULARITY 1;"
    )
    assert sql_of(plan, "alter_table_add_projection") == (
        "ALTER TABLE app.events ADD PROJECTION IF NOT EXISTS `p_recent` (SELECT id ORDER BY id);"
    )


def test_commented_dictionary_source_layout_and_lifetime_render_complete() -> None:
    plan = plan_diff(
        [],
        [
            dictionary(
                database="app",
                name="names",
                attributes=[{"name": "id", "type": "UInt64"}, {"name": "name", "type": "String"}],
                primary_key=["id"],
                source="CLICKHOUSE(TABLE 'events' DB 'app') -- note",
                layout="HASHED() /* small */",
                lifetime="300 # seconds",
            ),
            app_view("v", "SELECT 1 AS x"),
        ],
    )
    assert len(extract_executable_statements(render_migration_body(plan))) == len(plan.operations)
    assert (
        "SOURCE(CLICKHOUSE(TABLE 'events' DB 'app'))\nLAYOUT(HASHED())\nLIFETIME(300);"
        in (sql_of(plan, "create_dictionary") or "")
    )


def test_commented_materialized_view_sql_renders_complete() -> None:
    plan = plan_diff(
        [],
        [
            materialized_view(
                database="app",
                name="mv",
                to={"database": "app", "name": "agg"},
                as_="SELECT id -- per id\nFROM app.events\nGROUP BY id -- trailing",
            ),
            app_view("v", "SELECT 1 AS x"),
        ],
    )
    assert len(extract_executable_statements(render_migration_body(plan))) == len(plan.operations)
    assert sql_of(plan, "create_materialized_view") == (
        "CREATE MATERIALIZED VIEW IF NOT EXISTS app.mv TO app.agg AS\n"
        "SELECT id FROM app.events GROUP BY id;"
    )


def test_editing_only_a_comment_plans_nothing() -> None:
    assert plan_diff(
        [app_view("v", "SELECT a\n-- old note\nFROM app.t")],
        [app_view("v", "SELECT a\n-- new note\nFROM app.t")],
    ).operations == []
    assert plan_diff(
        [events(ttl="ts + toIntervalDay(30) -- a")], [events(ttl="ts + toIntervalDay(30) -- b")]
    ).operations == []


# ---------- plan_diff against a snapshot written before #232 ----------
# plan_diff canonicalizes the old definitions with the current normalizer, as
# reading a stored snapshot.json does.


def test_view_cut_short_by_mid_query_dash_comment_is_recreated_in_full() -> None:
    source = "SELECT a\n-- note\nFROM app.t"
    plan = plan_diff([app_view("v", legacy_normalize(source))], [app_view("v", source)])
    assert operation_types(plan) == ["drop_view", "create_view"]
    assert sql_of(plan, "create_view") == "CREATE VIEW IF NOT EXISTS app.v AS\nSELECT a FROM app.t;"


def test_view_cut_short_by_mid_query_hash_comment_is_recreated_in_full() -> None:
    source = "SELECT a # note\nFROM app.t"
    plan = plan_diff([app_view("v", legacy_normalize(source))], [app_view("v", source)])
    assert operation_types(plan) == ["drop_view", "create_view"]


def test_materialized_view_cut_short_by_comment_is_recreated_in_full() -> None:
    def mv(as_: str) -> Any:
        return materialized_view(
            database="app", name="mv", to={"database": "app", "name": "agg"}, as_=as_
        )

    source = "SELECT id -- per id\nFROM app.events GROUP BY id"
    plan = plan_diff([mv(legacy_normalize(source))], [mv(source)])
    assert operation_types(plan) == ["drop_materialized_view", "create_materialized_view"]


@pytest.mark.parametrize("source", ["SELECT /* note */\n  a\nFROM app.t", "SELECT a FROM app.t\n-- note"])
def test_block_and_trailing_comments_plan_nothing(source: str) -> None:
    assert plan_diff([app_view("v", legacy_normalize(source))], [app_view("v", source)]).operations == []


def test_trailing_partition_by_comment_does_not_recreate_the_table() -> None:
    source = "toYYYYMM(ts)\n  -- monthly"
    assert plan_diff(
        [events(partition_by=legacy_normalize(source))], [events(partition_by=source)]
    ).operations == []


# ---------- column kind checks with SQL comments in fragments ----------
# #237's stored-column checks read projections, partition_by and skip index
# expressions without their comments, as canonicalization stores them.


def with_ephemeral(**overrides: Any) -> TableDefinition:
    return events(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "ts", "type": "DateTime"},
            {"name": "raw", "type": "String", "default_kind": "EPHEMERAL"},
        ],
        **overrides,
    )


def codes(definition: TableDefinition) -> list[str]:
    # to_create_sql validates the definition as written; plan_diff, generate
    # and snapshot rebuild validate its canonical form. Both must agree.
    raw = [issue.code for issue in validate_definitions([definition])]
    canonical = [issue.code for issue in validate_definitions(canonicalize_definitions([definition]))]
    assert canonical == raw
    return raw


@pytest.mark.parametrize("comment", ["-- raw", "# raw", "#! raw", "// raw", "/* a /* raw */ b */"])
def test_comment_naming_ephemeral_column_is_not_a_projection_read(comment: str) -> None:
    query = f"SELECT id, count() {comment}\nGROUP BY id"
    assert codes(with_ephemeral(projections=[{"name": "p", "query": query}])) == []


@pytest.mark.parametrize(
    "projection",
    [
        {"name": "p", "query": "SELECT id, count(raw) # raw's count\nGROUP BY id"},
        {"name": "p", "query": "SELECT id, count(`raw`) -- input\nGROUP BY id"},
        {"name": "p", "query": 'SELECT id, count("raw") // input\nGROUP BY id'},
        {"name": "p", "index": "raw /* input */", "type": "basic"},
    ],
)
def test_projection_read_next_to_a_comment_is_reported(projection: dict[str, Any]) -> None:
    assert codes(with_ephemeral(projections=[projection])) == ["column_ephemeral_in_projection"]


def test_projection_alias_next_to_a_comment_is_not_a_read() -> None:
    assert codes(with_ephemeral(
        projections=[{"name": "p", "query": "SELECT id AS raw -- alias\nORDER BY id"}]
    )) == []


def test_commented_partition_by_or_skip_index_naming_ephemeral_column_is_reported() -> None:
    assert codes(with_ephemeral(partition_by="(ts, raw) -- by input")) == ["column_kind_not_stored"]
    assert codes(with_ephemeral(indexes=[
        {"name": "idx_raw", "type": "minmax", "expression": '"raw" # bare', "granularity": 1}
    ])) == ["column_kind_not_stored"]
    assert codes(with_ephemeral(indexes=[
        {"name": "idx_raw", "type": "minmax", "expression": "length(raw) // derived", "granularity": 1}
    ])) == []
