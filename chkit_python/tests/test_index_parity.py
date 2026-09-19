"""1:1 port of ``packages/core/src/index.test.ts``.

Grouped to mirror the original TypeScript ``describe`` blocks:

- @chkit/core smoke
- @chkit/core planner v1
- @chkit/core column codec
- @chkit/core refreshable materialized views
"""

from __future__ import annotations

from typing import Any

import pytest

from chkit.core.canonical import canonicalize_definitions
from chkit.core.codec import codec_raw
from chkit.core.model import (
    ChxValidationError,
    MaterializedViewDefinition,
    TableDefinition,
    collect_definitions_from_module,
    materialized_view,
    schema,
    table,
    view,
)
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.validate import validate_definitions

# =========================================================================
# @chkit/core smoke
# =========================================================================


def test_builds_table_and_view_definitions() -> None:
    users = table(
        database="app",
        name="users",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "email", "type": "String"},
        ],
        engine="MergeTree()",
        primaryKey=["id"],
        orderBy=["id"],
    )
    users_view = view(
        database="app",
        name="users_view",
        as_="SELECT id, email FROM app.users",
    )
    defs = schema(users, users_view)
    assert len(defs) == 2
    assert "CREATE TABLE IF NOT EXISTS app.users" in to_create_sql(defs[0])


def test_renders_unique_key_and_projections_in_create_table_sql() -> None:
    events = table(
        database="app",
        name="events",
        columns=[{"name": "id", "type": "UInt64"}],
        engine="MergeTree()",
        primaryKey=["id"],
        orderBy=["id"],
        uniqueKey=["id"],
        projections=[
            {"name": "p_recent", "query": "SELECT id ORDER BY id DESC LIMIT 10"}
        ],
    )
    sql = to_create_sql(events)
    assert "UNIQUE KEY (`id`)" in sql
    assert "PROJECTION `p_recent` (SELECT id ORDER BY id DESC LIMIT 10)" in sql


def test_normalizes_comma_delimited_key_clauses_in_create_table_sql() -> None:
    events = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "org_id", "type": "String"},
            {"name": "created_at", "type": "DateTime64(3)"},
        ],
        engine="MergeTree()",
        primaryKey=["id, org_id"],
        orderBy=["org_id, created_at, id"],
        uniqueKey=["id, org_id"],
    )
    sql = to_create_sql(events)
    assert "PRIMARY KEY (`id`, `org_id`)" in sql
    assert "ORDER BY (`org_id`, `created_at`, `id`)" in sql
    assert "UNIQUE KEY (`id`, `org_id`)" in sql


def test_collects_and_deduplicates_definitions_from_module_exports() -> None:
    users = table(
        database="app",
        name="users",
        columns=[{"name": "id", "type": "UInt64"}],
        engine="MergeTree()",
        primaryKey=["id"],
        orderBy=["id"],
    )
    defs = collect_definitions_from_module({"one": users, "two": [users]})
    assert len(defs) == 1


def test_canonicalizes_comma_delimited_key_clauses_to_separate_columns() -> None:
    defs = canonicalize_definitions(
        [
            table(
                database="app",
                name="events",
                columns=[
                    {"name": "id", "type": "UInt64"},
                    {"name": "org_id", "type": "String"},
                    {"name": "created_at", "type": "DateTime64(3)"},
                ],
                engine="MergeTree()",
                primaryKey=["id, org_id"],
                orderBy=["org_id, created_at, id"],
            )
        ]
    )
    events = defs[0]
    assert isinstance(events, TableDefinition)
    assert events.primary_key == ["id", "org_id"]
    assert events.order_by == ["org_id", "created_at", "id"]


# =========================================================================
# @chkit/core planner v1
# =========================================================================


def _simple_table(database: str, name: str) -> TableDefinition:
    return table(
        database=database,
        name=name,
        columns=[{"name": "id", "type": "UInt64"}],
        engine="MergeTree()",
        primaryKey=["id"],
        orderBy=["id"],
    )


def test_canonicalizes_deterministically_by_kind_database_name() -> None:
    defs = canonicalize_definitions(
        [
            view(database="z", name="v2", as_="SELECT 1"),
            _simple_table("z", "t2"),
            view(database="a", name="v1", as_="SELECT 1"),
            _simple_table("a", "t1"),
        ]
    )
    rendered = [f"{d.kind}:{d.database}.{d.name}" for d in defs]
    assert rendered == ["table:a.t1", "table:z.t2", "view:a.v1", "view:z.v2"]


def test_plans_create_drop_with_danger_safe_risks() -> None:
    old = [_simple_table("app", "old_users")]
    new = [_simple_table("app", "users")]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "drop_table",
        "create_database",
        "create_table",
    ]
    assert plan.risk_summary.model_dump() == {"safe": 2, "caution": 0, "danger": 1}


def test_plans_additive_table_changes_in_stable_order() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            settings={"index_granularity": 8192},
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
                {"name": "received_at", "type": "DateTime64(3)", "default": "fn:now64(3)"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            settings={"index_granularity": 4096},
            indexes=[
                {
                    "name": "idx_source",
                    "expression": "source",
                    "type": "set",
                    "maxRows": 0,
                    "granularity": 1,
                }
            ],
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "alter_table_add_column",
        "alter_table_add_column",
        "alter_table_add_index",
        "alter_table_modify_setting",
    ]
    assert plan.operations[0].risk == "safe"
    assert plan.operations[2].risk == "caution"
    assert plan.operations[3].risk == "caution"
    assert plan.risk_summary.model_dump() == {"safe": 2, "caution": 2, "danger": 0}


def test_plans_non_additive_table_changes_with_risk_classification() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
                {"name": "old_col", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            ttl="toDateTime(id)",
            settings={"index_granularity": 8192, "old_setting": 1},
            indexes=[
                {"name": "idx_source", "expression": "source", "type": "set", "maxRows": 0, "granularity": 1},
                {"name": "idx_old", "expression": "old_col", "type": "set", "maxRows": 0, "granularity": 1},
            ],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "LowCardinality(String)"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            settings={"index_granularity": 4096},
            indexes=[
                {"name": "idx_source", "expression": "lower(source)", "type": "set", "maxRows": 0, "granularity": 2},
            ],
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "alter_table_drop_column",
        "alter_table_modify_column",
        "alter_table_drop_index",
        "alter_table_drop_index",
        "alter_table_add_index",
        "alter_table_modify_setting",
        "alter_table_reset_setting",
        "alter_table_modify_ttl",
    ]
    assert plan.risk_summary.model_dump() == {"safe": 0, "caution": 7, "danger": 1}
    assert plan.rename_suggestions == []


def test_suggests_a_likely_column_rename_when_add_drop_definitions_match() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String", "nullable": True, "default": "unknown"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "origin", "type": "String", "nullable": True, "default": "unknown"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "alter_table_add_column",
        "alter_table_drop_column",
    ]
    assert len(plan.rename_suggestions) == 1
    s = plan.rename_suggestions[0]
    assert s.kind == "column"
    assert s.database == "app"
    assert s.table == "events"
    assert s.from_ == "source"
    assert s.to == "origin"
    assert s.confidence == "high"
    assert "non-name definition" in s.reason
    assert s.drop_operation_key == "table:app.events:column:source"
    assert s.add_operation_key == "table:app.events:column:origin"
    assert s.confirmation_sql == (
        "ALTER TABLE app.events RENAME COLUMN `source` TO `origin`;"
    )


def test_does_not_suggest_rename_when_new_column_definition_differs() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "origin", "type": "LowCardinality(String)"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    plan = plan_diff(old, new)
    assert plan.rename_suggestions == []


def test_ignores_renamed_from_metadata_for_same_name_column_equality_checks() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String", "renamedFrom": "legacy_source"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    plan = plan_diff(old, new)
    assert plan.operations == []
    assert plan.rename_suggestions == []


def test_recreates_table_when_structural_keys_change() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            uniqueKey=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            uniqueKey=["id", "id"],
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == ["drop_table", "create_table"]
    assert plan.risk_summary.model_dump() == {"safe": 1, "caution": 0, "danger": 1}


def test_plans_projection_add_replace_remove_operations() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            projections=[
                {"name": "p_old", "query": "SELECT id ORDER BY id LIMIT 1"},
                {"name": "p_change", "query": "SELECT id"},
            ],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            projections=[
                {"name": "p_new", "query": "SELECT id ORDER BY id DESC LIMIT 5"},
                {"name": "p_change", "query": "SELECT id ORDER BY id LIMIT 10"},
            ],
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "alter_table_drop_projection",
        "alter_table_add_projection",
        "alter_table_add_projection",
        "alter_table_drop_projection",
    ]
    assert plan.risk_summary.model_dump() == {"safe": 0, "caution": 4, "danger": 0}


def test_recreates_changed_view_definitions_with_caution_risk() -> None:
    old = [view(database="app", name="users_view", as_="SELECT id FROM app.users")]
    new = [
        view(
            database="app",
            name="users_view",
            as_="SELECT id, email FROM app.users",
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == ["drop_view", "create_view"]
    assert plan.operations[0].risk == "caution"
    assert plan.operations[1].risk == "caution"
    assert plan.risk_summary.model_dump() == {"safe": 0, "caution": 2, "danger": 0}


def test_recreates_changed_materialized_view_definitions_with_caution_risk() -> None:
    old = [
        materialized_view(
            database="app",
            name="mv_users",
            to={"database": "app", "name": "users_rollup"},
            as_="SELECT id FROM app.users",
        )
    ]
    new = [
        materialized_view(
            database="app",
            name="mv_users",
            to={"database": "app", "name": "users_rollup_v2"},
            as_="SELECT id, count() AS c FROM app.users GROUP BY id",
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "drop_materialized_view",
        "create_materialized_view",
    ]
    assert plan.operations[0].risk == "caution"
    assert plan.operations[1].risk == "caution"
    assert plan.risk_summary.model_dump() == {"safe": 0, "caution": 2, "danger": 0}


def test_validates_duplicate_columns_indexes_and_missing_key_columns() -> None:
    defs = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "id", "type": "UInt64"},
            ],
            engine="MergeTree()",
            primaryKey=["id", "missing_pk_col"],
            orderBy=["id", "missing_order_col"],
            indexes=[
                {"name": "idx_source", "expression": "id", "type": "set", "maxRows": 0, "granularity": 1},
                {"name": "idx_source", "expression": "id", "type": "set", "maxRows": 0, "granularity": 1},
            ],
        )
    ]
    issues = validate_definitions(defs)
    assert [i.code for i in issues] == [
        "duplicate_column_name",
        "duplicate_index_name",
        "primary_key_missing_column",
        "order_by_missing_column",
    ]


def test_validates_duplicate_projection_names() -> None:
    defs = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            projections=[
                {"name": "p_events", "query": "SELECT id"},
                {"name": "p_events", "query": "SELECT id ORDER BY id"},
            ],
        )
    ]
    issues = validate_definitions(defs)
    assert [i.code for i in issues] == ["duplicate_projection_name"]


def test_plan_diff_throws_typed_validation_error_for_invalid_schema() -> None:
    invalid = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree()",
            primaryKey=["missing"],
            orderBy=["id"],
        )
    ]
    with pytest.raises(ChxValidationError):
        plan_diff([], invalid)


def test_returns_empty_plan_for_equivalent_schemas() -> None:
    defs = [_simple_table("app", "users")]
    plan = plan_diff(defs, defs)
    assert len(plan.operations) == 0
    assert plan.risk_summary.model_dump() == {"safe": 0, "caution": 0, "danger": 0}
    assert plan.rename_suggestions == []


def test_plan_ordering_is_deterministic_regardless_of_input_definition_order() -> None:
    old = [_simple_table("app", "events")]
    new_a: list[Any] = [
        view(database="app", name="events_view", as_="SELECT id FROM app.events"),
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        ),
    ]
    new_b = list(reversed(new_a))
    plan_a = plan_diff(old, new_a)
    plan_b = plan_diff(old, new_b)
    assert [f"{op.type}:{op.key}" for op in plan_a.operations] == [
        f"{op.type}:{op.key}" for op in plan_b.operations
    ]
    assert plan_a.risk_summary.model_dump() == plan_b.risk_summary.model_dump()


def test_renders_structured_index_args_in_create_table() -> None:
    events = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "source", "type": "String"},
            {"name": "body", "type": "String"},
            {"name": "name", "type": "String"},
        ],
        engine="MergeTree()",
        primaryKey=["id"],
        orderBy=["id"],
        indexes=[
            {"name": "idx_source", "expression": "source", "type": "set", "maxRows": 0, "granularity": 1},
            {"name": "idx_id", "expression": "id", "type": "minmax", "granularity": 3},
            {
                "name": "idx_bloom",
                "expression": "source",
                "type": "bloom_filter",
                "falsePositiveRate": 0.01,
                "granularity": 1,
            },
            {
                "name": "idx_bloom_default",
                "expression": "source",
                "type": "bloom_filter",
                "granularity": 1,
            },
            {
                "name": "idx_body",
                "expression": "body",
                "type": "tokenbf_v1",
                "sizeBytes": 256,
                "hashFunctions": 2,
                "randomSeed": 0,
                "granularity": 1,
            },
            {
                "name": "idx_name",
                "expression": "name",
                "type": "ngrambf_v1",
                "ngramSize": 3,
                "sizeBytes": 256,
                "hashFunctions": 2,
                "randomSeed": 0,
                "granularity": 1,
            },
        ],
    )
    sql = to_create_sql(events)
    assert "TYPE set(0) GRANULARITY 1" in sql
    assert "TYPE minmax GRANULARITY 3" in sql
    assert "TYPE bloom_filter(0.01) GRANULARITY 1" in sql
    assert "`idx_bloom_default` (source) TYPE bloom_filter GRANULARITY 1" in sql
    assert "TYPE tokenbf_v1(256, 2, 0) GRANULARITY 1" in sql
    assert "TYPE ngrambf_v1(3, 256, 2, 0) GRANULARITY 1" in sql


def test_renders_structured_index_args_in_alter_add_index() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            indexes=[
                {"name": "idx_source", "expression": "source", "type": "set", "maxRows": 0, "granularity": 1},
            ],
        )
    ]
    plan = plan_diff(old, new)
    assert len(plan.operations) == 1
    assert "TYPE set(0) GRANULARITY 1" in plan.operations[0].sql


def test_detects_index_change_when_structured_args_differ() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            indexes=[
                {"name": "idx_source", "expression": "source", "type": "set", "maxRows": 0, "granularity": 1},
            ],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
            indexes=[
                {"name": "idx_source", "expression": "source", "type": "set", "maxRows": 100, "granularity": 1},
            ],
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "alter_table_drop_index",
        "alter_table_add_index",
    ]
    assert "TYPE set(100) GRANULARITY 1" in plan.operations[1].sql


def test_creates_tables_before_views_and_materialized_views() -> None:
    new = [
        materialized_view(
            database="app",
            name="mv_events",
            to={"database": "app", "name": "events_rollup"},
            as_="SELECT id FROM app.events",
        ),
        view(database="app", name="events_view", as_="SELECT id FROM app.events"),
        _simple_table("app", "events"),
        _simple_table("app", "events_rollup"),
    ]
    plan = plan_diff([], new)
    types = [op.type for op in plan.operations]
    create_types = [t for t in types if t.startswith("create_") and t != "create_database"]
    assert create_types == [
        "create_table",
        "create_table",
        "create_view",
        "create_materialized_view",
    ]


# =========================================================================
# @chkit/core column codec
# =========================================================================


def test_codec_renders_CODEC_clause_after_DEFAULT() -> None:
    events = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {
                "name": "ts",
                "type": "DateTime",
                "codec": {"kind": "ZSTD", "level": 3},
                "default": "fn:now()",
            },
        ],
        engine="MergeTree()",
        primaryKey=["id"],
        orderBy=["id"],
    )
    sql = to_create_sql(events)
    assert "`ts` DateTime DEFAULT now() CODEC(ZSTD(3))" in sql


def test_codec_renders_chain_with_preprocessor_plus_general() -> None:
    events = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {
                "name": "delta",
                "type": "Int64",
                "codec": [{"kind": "Delta", "size": 4}, {"kind": "ZSTD"}],
            },
        ],
        engine="MergeTree()",
        primaryKey=["id"],
        orderBy=["id"],
    )
    sql = to_create_sql(events)
    assert "`delta` Int64 CODEC(Delta(4), ZSTD)" in sql


def test_codec_renders_on_nullable_column() -> None:
    events = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {
                "name": "note",
                "type": "String",
                "nullable": True,
                "codec": {"kind": "ZSTD", "level": 3},
            },
        ],
        engine="MergeTree()",
        primaryKey=["id"],
        orderBy=["id"],
    )
    sql = to_create_sql(events)
    assert "`note` Nullable(String) CODEC(ZSTD(3))" in sql


def test_plan_add_codec_to_column_emits_modify_column_with_codec() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "String", "codec": {"kind": "ZSTD", "level": 3}},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == ["alter_table_modify_column"]
    assert "MODIFY COLUMN `payload` String CODEC(ZSTD(3))" in plan.operations[0].sql


def test_plan_change_codec_emits_single_modify_column() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "String", "codec": {"kind": "ZSTD", "level": 1}},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "String", "codec": {"kind": "ZSTD", "level": 6}},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == ["alter_table_modify_column"]
    sql = plan.operations[0].sql
    assert "MODIFY COLUMN `payload` String CODEC(ZSTD(6))" in sql
    assert "REMOVE CODEC" not in sql


def test_plan_remove_codec_emits_REMOVE_CODEC_when_other_fields_unchanged() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "String", "codec": {"kind": "ZSTD", "level": 3}},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "String"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    plan = plan_diff(old, new)
    assert len(plan.operations) == 1
    assert plan.operations[0].type == "alter_table_modify_column"
    assert plan.operations[0].sql == (
        "ALTER TABLE app.events MODIFY COLUMN `payload` REMOVE CODEC;"
    )


def test_plan_drop_codec_plus_other_change_emits_single_modify_no_separate_remove() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "String", "codec": {"kind": "ZSTD", "level": 3}},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "LowCardinality(String)"},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    plan = plan_diff(old, new)
    assert len(plan.operations) == 1
    assert plan.operations[0].type == "alter_table_modify_column"
    sql = plan.operations[0].sql
    assert "LowCardinality(String)" in sql
    assert "REMOVE CODEC" not in sql


def test_plan_equal_codec_across_canonicalization_yields_no_diff() -> None:
    old = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "String", "codec": {"kind": "ZSTD"}},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    new = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "String", "codec": {"kind": "ZSTD", "level": 1}},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    plan = plan_diff(old, new)
    assert plan.operations == []


def test_validates_chain_with_multiple_general_codecs() -> None:
    defs = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {
                    "name": "payload",
                    "type": "String",
                    "codec": [{"kind": "ZSTD", "level": 3}, {"kind": "LZ4"}],
                },
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    issues = validate_definitions(defs)
    assert "codec_chain_multiple_general" in {i.code for i in issues}


def test_validates_chain_ending_in_preprocessor() -> None:
    defs = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {
                    "name": "payload",
                    "type": "Int64",
                    "codec": [{"kind": "ZSTD"}, {"kind": "Delta", "size": 4}],
                },
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    issues = validate_definitions(defs)
    assert "codec_chain_must_end_with_general" in {i.code for i in issues}


def test_allows_standalone_preprocessor_codec() -> None:
    defs = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "delta", "type": "Int64", "codec": {"kind": "Delta", "size": 4}},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    codes = {i.code for i in validate_definitions(defs)}
    assert "codec_chain_must_end_with_general" not in codes
    assert "codec_chain_multiple_general" not in codes


def test_flags_empty_codec_chain() -> None:
    defs = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "payload", "type": "Int64", "codec": []},
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    issues = validate_definitions(defs)
    assert "codec_chain_empty" in {i.code for i in issues}


def test_raw_codec_atoms_satisfy_any_chain_position() -> None:
    defs = [
        table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {
                    "name": "exp",
                    "type": "Float32",
                    "codec": [{"kind": "Delta", "size": 4}, codec_raw("SomeNewCodec(42)")],
                },
            ],
            engine="MergeTree()",
            primaryKey=["id"],
            orderBy=["id"],
        )
    ]
    issues = validate_definitions(defs)
    assert not any(i.code.startswith("codec_chain_") for i in issues)


# =========================================================================
# @chkit/core refreshable materialized views
# =========================================================================


_BASE_MV: dict[str, Any] = {
    "database": "analytics",
    "name": "daily_mv",
    "to": {"database": "analytics", "name": "daily_rollup"},
    "as_": "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
}


def _mv(**overrides: Any) -> MaterializedViewDefinition:
    payload = {**_BASE_MV, **overrides}
    return materialized_view(**payload)


def test_renders_CREATE_with_REFRESH_EVERY_plus_TO() -> None:
    mv = _mv(refresh={"every": "1 HOUR"})
    sql = to_create_sql(mv)
    assert "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_mv" in sql
    assert "REFRESH EVERY 1 HOUR" in sql
    assert "TO analytics.daily_rollup" in sql
    assert "APPEND" not in sql
    assert "EMPTY" not in sql


def test_renders_CREATE_with_APPEND_OFFSET_RANDOMIZE_SETTINGS() -> None:
    mv = _mv(
        refresh={
            "every": "1 DAY",
            "offset": "2 HOUR",
            "randomize": "5 MINUTE",
            "settings": {"refresh_retries": 3},
            "append": True,
        }
    )
    sql = to_create_sql(mv)
    assert "REFRESH EVERY 1 DAY OFFSET 2 HOUR RANDOMIZE FOR 5 MINUTE" in sql
    assert "SETTINGS refresh_retries = 3" in sql
    assert "APPEND" in sql
    assert "TO analytics.daily_rollup" in sql


def test_renders_CREATE_with_DEPENDS_ON_and_EMPTY() -> None:
    mv = _mv(
        refresh={
            "every": "1 HOUR",
            "dependsOn": [{"database": "analytics", "name": "upstream_mv"}],
            "empty": True,
        }
    )
    sql = to_create_sql(mv)
    assert "REFRESH EVERY 1 HOUR DEPENDS ON analytics.upstream_mv" in sql
    assert " EMPTY AS" in sql


def test_diff_adding_refresh_to_existing_mv_triggers_drop_recreate() -> None:
    old = [_mv()]
    new = [_mv(refresh={"every": "1 HOUR"})]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "drop_materialized_view",
        "create_materialized_view",
    ]


def test_diff_removing_refresh_triggers_drop_recreate() -> None:
    old = [_mv(refresh={"every": "1 HOUR"})]
    new = [_mv()]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "drop_materialized_view",
        "create_materialized_view",
    ]


def test_diff_toggling_APPEND_triggers_drop_recreate() -> None:
    old = [_mv(refresh={"every": "1 HOUR", "append": True})]
    new = [_mv(refresh={"every": "1 HOUR"})]
    plan = plan_diff(old, new)
    assert [op.type for op in plan.operations] == [
        "drop_materialized_view",
        "create_materialized_view",
    ]


def test_diff_schedule_only_change_emits_modify_refresh() -> None:
    old = [_mv(refresh={"every": "1 HOUR"})]
    new = [_mv(refresh={"every": "30 MINUTE"})]
    plan = plan_diff(old, new)
    assert len(plan.operations) == 1
    op = plan.operations[0]
    assert op.type == "alter_materialized_view_modify_refresh"
    assert "ALTER TABLE analytics.daily_mv MODIFY REFRESH EVERY 30 MINUTE" in op.sql
    assert "APPEND" not in op.sql


def test_diff_schedule_only_change_on_APPEND_mv_preserves_APPEND_in_modify_refresh() -> None:
    old = [_mv(refresh={"every": "1 HOUR", "append": True})]
    new = [_mv(refresh={"every": "30 SECOND", "append": True})]
    plan = plan_diff(old, new)
    assert len(plan.operations) == 1
    op = plan.operations[0]
    assert op.type == "alter_materialized_view_modify_refresh"
    assert "MODIFY REFRESH EVERY 30 SECOND" in op.sql
    assert "APPEND" in op.sql


def test_diff_randomize_dependsOn_settings_changes_emit_modify_refresh() -> None:
    old = [_mv(refresh={"every": "1 HOUR"})]
    new = [
        _mv(
            refresh={
                "every": "1 HOUR",
                "randomize": "1 MINUTE",
                "dependsOn": [{"database": "analytics", "name": "upstream"}],
                "settings": {"refresh_retries": 5},
            }
        )
    ]
    plan = plan_diff(old, new)
    assert len(plan.operations) == 1
    op = plan.operations[0]
    assert op.type == "alter_materialized_view_modify_refresh"
    assert "RANDOMIZE FOR 1 MINUTE" in op.sql
    assert "DEPENDS ON analytics.upstream" in op.sql
    assert "SETTINGS refresh_retries = 5" in op.sql


def test_diff_equivalent_refresh_yields_no_ops() -> None:
    defs = [_mv(refresh={"every": "1 HOUR", "append": True})]
    plan = plan_diff(defs, defs)
    assert plan.operations == []


def test_MODIFY_REFRESH_ranks_with_other_alters() -> None:
    old = [
        table(
            database="analytics",
            name="daily_rollup",
            columns=[{"name": "day", "type": "Date"}],
            engine="MergeTree()",
            primaryKey=["day"],
            orderBy=["day"],
        ),
        _mv(refresh={"every": "1 HOUR"}),
    ]
    new = [
        table(
            database="analytics",
            name="daily_rollup",
            columns=[
                {"name": "day", "type": "Date"},
                {"name": "total", "type": "UInt64"},
            ],
            engine="MergeTree()",
            primaryKey=["day"],
            orderBy=["day"],
        ),
        _mv(refresh={"every": "30 MINUTE"}),
    ]
    plan = plan_diff(old, new)
    types = [op.type for op in plan.operations]
    first_alter = types.index("alter_table_add_column")
    first_refresh = types.index("alter_materialized_view_modify_refresh")
    assert first_alter >= 0
    assert first_refresh >= 0
    # No creates after the alters.
    create_indices = [i for i, t in enumerate(types) if t.startswith("create_")]
    if create_indices:
        last_create = max(create_indices)
        assert max(first_alter, first_refresh) < last_create + 1


def test_canonicalization_uppercases_intervals_and_sorts_dependsOn_settings() -> None:
    defs = canonicalize_definitions(
        [
            _mv(
                refresh={
                    "every": "1 hour",
                    "randomize": "30 seconds",
                    "dependsOn": [
                        {"database": "z", "name": "b"},
                        {"database": "a", "name": "a"},
                    ],
                    "settings": {
                        "refresh_retries": 3,
                        "refresh_retry_initial_backoff_ms": 100,
                    },
                }
            )
        ]
    )
    mv = defs[0]
    assert isinstance(mv, MaterializedViewDefinition)
    assert mv.refresh is not None
    assert mv.refresh.every == "1 HOUR"
    assert mv.refresh.randomize == "30 SECOND"
    assert mv.refresh.depends_on is not None
    assert [d.model_dump() for d in mv.refresh.depends_on] == [
        {"database": "a", "name": "a"},
        {"database": "z", "name": "b"},
    ]
    assert mv.refresh.settings is not None
    assert list(mv.refresh.settings.keys()) == [
        "refresh_retries",
        "refresh_retry_initial_backoff_ms",
    ]


def test_validates_refresh_requires_exactly_one_of_every_after() -> None:
    missing = validate_definitions([_mv(refresh={})])
    assert "refresh_requires_every_or_after" in {i.code for i in missing}

    both = validate_definitions(
        [_mv(refresh={"every": "1 HOUR", "after": "10 MINUTE"})]
    )
    assert "refresh_every_after_mutually_exclusive" in {i.code for i in both}


def test_validates_interval_format() -> None:
    issues = validate_definitions([_mv(refresh={"every": "soonish"})])
    assert "refresh_interval_format" in {i.code for i in issues}


def test_validates_DEPENDS_ON_is_only_allowed_with_REFRESH_EVERY() -> None:
    with_after = validate_definitions(
        [
            _mv(
                refresh={
                    "after": "10 MINUTE",
                    "dependsOn": [{"database": "analytics", "name": "upstream"}],
                }
            )
        ]
    )
    assert "refresh_depends_on_requires_every" in {i.code for i in with_after}

    with_every = validate_definitions(
        [
            _mv(
                refresh={
                    "every": "1 HOUR",
                    "dependsOn": [{"database": "analytics", "name": "upstream"}],
                }
            )
        ]
    )
    assert "refresh_depends_on_requires_every" not in {i.code for i in with_every}


def test_validates_non_APPEND_RMV_with_replicated_target() -> None:
    issues = validate_definitions(
        [
            table(
                database="analytics",
                name="daily_rollup",
                columns=[{"name": "day", "type": "Date"}],
                engine="SharedMergeTree",
                primaryKey=["day"],
                orderBy=["day"],
            ),
            _mv(refresh={"every": "1 HOUR"}),
        ]
    )
    assert "refresh_append_required_for_replicated_target" in {i.code for i in issues}


def test_no_issue_when_APPEND_RMV_targets_replicated_table() -> None:
    issues = validate_definitions(
        [
            table(
                database="analytics",
                name="daily_rollup",
                columns=[{"name": "day", "type": "Date"}],
                engine="SharedMergeTree",
                primaryKey=["day"],
                orderBy=["day"],
            ),
            _mv(refresh={"every": "1 HOUR", "append": True}),
        ]
    )
    assert "refresh_append_required_for_replicated_target" not in {
        i.code for i in issues
    }


def test_no_issue_when_target_table_is_external() -> None:
    issues = validate_definitions([_mv(refresh={"every": "1 HOUR"})])
    assert "refresh_append_required_for_replicated_target" not in {
        i.code for i in issues
    }
