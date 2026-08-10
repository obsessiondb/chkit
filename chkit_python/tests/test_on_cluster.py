"""Tests for ``chkit.core.on_cluster`` — parity with TS ``on-cluster.test.ts``.

The full TS test surface is ported case-by-case so behavioral drift shows up
immediately if the injector or the anchor tables are edited. Test names mirror
the TS ``describe/test`` labels for cross-referencing.
"""

from __future__ import annotations

import pytest

from chkit.core.model import (
    ChxUserClickHouseConfig,
    ChxUserConfig,
    ColumnRenameSuggestion,
    MigrationOperation,
    MigrationOperationType,
    MigrationPlan,
    _RiskSummary,
    resolve_config,
)
from chkit.core.on_cluster import apply_on_cluster_to_plan, on_cluster_clause


def _user_config(cluster: str | None) -> ChxUserConfig:
    ch = ChxUserClickHouseConfig(url="u", cluster=cluster)
    return ChxUserConfig.model_validate({"schema": "s", "clickhouse": ch})


def _op(op_type: MigrationOperationType, sql: str) -> MigrationOperation:
    return MigrationOperation(type=op_type, key="k", risk="safe", sql=sql)


def _plan_of(operations: list[MigrationOperation]) -> MigrationPlan:
    return MigrationPlan(
        operations=operations,
        risk_summary=_RiskSummary(),
        rename_suggestions=[],
    )


# ---------- on_cluster_clause ----------


def test_on_cluster_clause_is_empty_when_none() -> None:
    assert on_cluster_clause(None) == ""


def test_on_cluster_clause_is_empty_when_empty_string() -> None:
    # Falsy check mirrors TS: an unset cluster never engages the clause.
    assert on_cluster_clause("") == ""


def test_on_cluster_clause_renders_single_quoted() -> None:
    assert on_cluster_clause("my_cluster") == " ON CLUSTER 'my_cluster'"


def test_on_cluster_clause_supports_the_macro_form() -> None:
    assert on_cluster_clause("{cluster}") == " ON CLUSTER '{cluster}'"


# ---------- apply_on_cluster_to_plan ----------


def test_returns_plan_unchanged_when_cluster_is_none() -> None:
    plan = _plan_of([_op("drop_table", "DROP TABLE IF EXISTS db.t;")])
    assert apply_on_cluster_to_plan(plan, None) is plan


def test_injects_on_cluster_after_object_ref_for_every_statement_shape() -> None:
    plan = _plan_of(
        [
            _op(
                "create_table",
                "CREATE TABLE IF NOT EXISTS db.t\n(\n  `id` UInt64\n)"
                " ENGINE = MergeTree()\nORDER BY (`id`);",
            ),
            _op("create_view", "CREATE VIEW IF NOT EXISTS db.v AS\nSELECT 1;"),
            _op(
                "create_materialized_view",
                "CREATE MATERIALIZED VIEW IF NOT EXISTS db.mv TO db.t AS\nSELECT 1;",
            ),
            _op(
                "create_materialized_view",
                "CREATE MATERIALIZED VIEW IF NOT EXISTS db.mv\n"
                "REFRESH EVERY 1 HOUR TO db.t AS\nSELECT 1;",
            ),
            _op("create_database", "CREATE DATABASE IF NOT EXISTS db;"),
            _op(
                "alter_table_add_column",
                "ALTER TABLE db.t ADD COLUMN IF NOT EXISTS `c` String;",
            ),
            _op(
                "alter_table_rename_column",
                "ALTER TABLE db.t RENAME COLUMN IF EXISTS `a` TO `b`;",
            ),
            _op(
                "alter_table_rename_table",
                "RENAME TABLE IF EXISTS db.a TO db.b;",
            ),
            _op("drop_table", "DROP TABLE IF EXISTS db.t;"),
            _op("drop_materialized_view", "DROP TABLE IF EXISTS db.mv SYNC;"),
            _op("drop_view", "DROP VIEW IF EXISTS db.v;"),
        ]
    )

    sql = [op.sql for op in apply_on_cluster_to_plan(plan, "c").operations]

    assert sql == [
        "CREATE TABLE IF NOT EXISTS db.t ON CLUSTER 'c'\n(\n  `id` UInt64\n)"
        " ENGINE = MergeTree()\nORDER BY (`id`);",
        "CREATE VIEW IF NOT EXISTS db.v ON CLUSTER 'c' AS\nSELECT 1;",
        "CREATE MATERIALIZED VIEW IF NOT EXISTS db.mv ON CLUSTER 'c' TO db.t AS\nSELECT 1;",
        "CREATE MATERIALIZED VIEW IF NOT EXISTS db.mv ON CLUSTER 'c'\n"
        "REFRESH EVERY 1 HOUR TO db.t AS\nSELECT 1;",
        "CREATE DATABASE IF NOT EXISTS db ON CLUSTER 'c';",
        "ALTER TABLE db.t ON CLUSTER 'c' ADD COLUMN IF NOT EXISTS `c` String;",
        "ALTER TABLE db.t ON CLUSTER 'c' RENAME COLUMN IF EXISTS `a` TO `b`;",
        "RENAME TABLE IF EXISTS db.a TO db.b ON CLUSTER 'c';",
        "DROP TABLE IF EXISTS db.t ON CLUSTER 'c';",
        "DROP TABLE IF EXISTS db.mv ON CLUSTER 'c' SYNC;",
        "DROP VIEW IF EXISTS db.v ON CLUSTER 'c';",
    ]


def test_injects_into_rename_suggestion_confirmation_sql() -> None:
    plan = MigrationPlan(
        operations=[],
        risk_summary=_RiskSummary(),
        rename_suggestions=[
            ColumnRenameSuggestion(
                kind="column",
                database="db",
                table="t",
                from_="a",
                to="b",
                confidence="high",
                reason="x",
                drop_operation_key="d",
                add_operation_key="a",
                confirmation_sql="ALTER TABLE db.t RENAME COLUMN IF EXISTS `a` TO `b`;",
            )
        ],
    )

    stamped = apply_on_cluster_to_plan(plan, "c").rename_suggestions[0]
    assert (
        stamped.confirmation_sql
        == "ALTER TABLE db.t ON CLUSTER 'c' RENAME COLUMN IF EXISTS `a` TO `b`;"
    )
    # All non-SQL fields must survive the copy — regression guard for the port.
    assert stamped.kind == "column"
    assert stamped.from_ == "a"
    assert stamped.to == "b"
    assert stamped.drop_operation_key == "d"
    assert stamped.add_operation_key == "a"
    assert stamped.confidence == "high"


def test_leaves_statements_without_a_known_anchor_untouched() -> None:
    plan = _plan_of([_op("drop_table", "INSERT INTO db.t SELECT 1;")])
    assert (
        apply_on_cluster_to_plan(plan, "c").operations[0].sql
        == "INSERT INTO db.t SELECT 1;"
    )


def test_injects_on_cluster_for_dictionary_create_or_replace_drop_and_rename() -> None:
    # The injector inspects ``sql``, not ``type`` — the dictionary op types are
    # a separate port (Category B). Use ``create_table``/``drop_table`` here so
    # this covers the SQL-shape behavior without depending on Dictionary being
    # ported first.
    plan = _plan_of(
        [
            _op(
                "create_table",
                "CREATE DICTIONARY IF NOT EXISTS db.d\n(\n  `id` UInt64\n)\n"
                "PRIMARY KEY `id`\nSOURCE(NULL())\nLAYOUT(FLAT())\nLIFETIME(0);",
            ),
            _op(
                "create_table",
                "CREATE OR REPLACE DICTIONARY db.d\n(\n  `id` UInt64\n)\n"
                "PRIMARY KEY `id`\nSOURCE(NULL())\nLAYOUT(FLAT())\nLIFETIME(0);",
            ),
            _op("drop_table", "DROP DICTIONARY IF EXISTS db.d;"),
            _op(
                "alter_table_rename_table",
                "RENAME DICTIONARY IF EXISTS db.old TO db.new;",
            ),
        ]
    )

    sql = [op.sql for op in apply_on_cluster_to_plan(plan, "c").operations]

    assert sql == [
        "CREATE DICTIONARY IF NOT EXISTS db.d ON CLUSTER 'c'\n(\n  `id` UInt64\n)\n"
        "PRIMARY KEY `id`\nSOURCE(NULL())\nLAYOUT(FLAT())\nLIFETIME(0);",
        "CREATE OR REPLACE DICTIONARY db.d ON CLUSTER 'c'\n(\n  `id` UInt64\n)\n"
        "PRIMARY KEY `id`\nSOURCE(NULL())\nLAYOUT(FLAT())\nLIFETIME(0);",
        "DROP DICTIONARY IF EXISTS db.d ON CLUSTER 'c';",
        "RENAME DICTIONARY IF EXISTS db.old TO db.new ON CLUSTER 'c';",
    ]


def test_injects_into_speculative_after_name_anchors() -> None:
    # Not emitted by chkit yet; the anchors exist as a forward-compatible
    # safety net so injection already works if a future command produces them.
    plan = _plan_of(
        [
            _op(
                "create_table",
                "CREATE DICTIONARY IF NOT EXISTS db.d "
                "(id UInt64) PRIMARY KEY id SOURCE(NULL());",
            ),
            _op("create_table", "CREATE FUNCTION add_one AS (x) -> x + 1;"),
            _op("drop_table", "DROP DATABASE IF EXISTS db;"),
            _op("drop_table", "DROP DICTIONARY IF EXISTS db.d;"),
            _op("create_table", "ATTACH TABLE IF NOT EXISTS db.t;"),
            _op("drop_table", "DETACH TABLE IF EXISTS db.t;"),
            _op("drop_table", "TRUNCATE TABLE IF EXISTS db.t;"),
            _op("drop_table", "OPTIMIZE TABLE db.t FINAL;"),
        ]
    )

    sql = [op.sql for op in apply_on_cluster_to_plan(plan, "c").operations]

    assert sql == [
        "CREATE DICTIONARY IF NOT EXISTS db.d ON CLUSTER 'c' "
        "(id UInt64) PRIMARY KEY id SOURCE(NULL());",
        "CREATE FUNCTION add_one ON CLUSTER 'c' AS (x) -> x + 1;",
        "DROP DATABASE IF EXISTS db ON CLUSTER 'c';",
        "DROP DICTIONARY IF EXISTS db.d ON CLUSTER 'c';",
        "ATTACH TABLE IF NOT EXISTS db.t ON CLUSTER 'c';",
        "DETACH TABLE IF EXISTS db.t ON CLUSTER 'c';",
        "TRUNCATE TABLE IF EXISTS db.t ON CLUSTER 'c';",
        "OPTIMIZE TABLE db.t ON CLUSTER 'c' FINAL;",
    ]


def test_handles_both_guarded_and_unguarded_forms_of_the_same_statement() -> None:
    plan = _plan_of(
        [
            _op("drop_table", "DROP TABLE IF EXISTS db.t;"),
            _op("drop_table", "DROP TABLE db.t;"),
            _op("create_table", "CREATE TABLE db.t (`id` UInt64) ENGINE = Memory;"),
            _op("drop_table", "TRUNCATE TABLE db.t;"),
        ]
    )

    sql = [op.sql for op in apply_on_cluster_to_plan(plan, "c").operations]

    assert sql == [
        "DROP TABLE IF EXISTS db.t ON CLUSTER 'c';",
        "DROP TABLE db.t ON CLUSTER 'c';",
        "CREATE TABLE db.t ON CLUSTER 'c' (`id` UInt64) ENGINE = Memory;",
        "TRUNCATE TABLE db.t ON CLUSTER 'c';",
    ]


def test_is_idempotent_never_double_injects_when_on_cluster_present() -> None:
    plan = _plan_of(
        [
            _op(
                "create_table",
                "CREATE TABLE IF NOT EXISTS db.t ON CLUSTER 'x'\n"
                "(\n  `id` UInt64\n) ENGINE = MergeTree();",
            ),
            _op(
                "alter_table_rename_table",
                "RENAME TABLE db.a TO db.b ON CLUSTER 'x';",
            ),
        ]
    )

    sql = [op.sql for op in apply_on_cluster_to_plan(plan, "c").operations]

    assert sql == [
        "CREATE TABLE IF NOT EXISTS db.t ON CLUSTER 'x'\n"
        "(\n  `id` UInt64\n) ENGINE = MergeTree();",
        "RENAME TABLE db.a TO db.b ON CLUSTER 'x';",
    ]


def test_still_injects_when_user_content_contains_words_on_cluster() -> None:
    # Regression guard for the positional-idempotency fix: scanning the whole
    # statement for "on cluster" would have caused these to skip injection.
    plan = _plan_of(
        [
            _op(
                "create_table",
                "CREATE TABLE db.t\n(\n  `id` UInt64 "
                "COMMENT 'aggregated on cluster level'\n) "
                "ENGINE = MergeTree()\nORDER BY (`id`);",
            ),
            _op(
                "create_view",
                "CREATE VIEW IF NOT EXISTS db.v AS\nSELECT 'on cluster' AS label;",
            ),
        ]
    )

    sql = [op.sql for op in apply_on_cluster_to_plan(plan, "c").operations]

    assert sql == [
        "CREATE TABLE db.t ON CLUSTER 'c'\n(\n  `id` UInt64 "
        "COMMENT 'aggregated on cluster level'\n) "
        "ENGINE = MergeTree()\nORDER BY (`id`);",
        "CREATE VIEW IF NOT EXISTS db.v ON CLUSTER 'c' AS\nSELECT 'on cluster' AS label;",
    ]


def test_appends_on_cluster_at_end_for_speculative_trailing_anchors() -> None:
    plan = _plan_of(
        [
            _op("alter_table_rename_table", "RENAME DATABASE db.a TO db.b;"),
            _op("alter_table_rename_table", "RENAME DICTIONARY db.a TO db.b;"),
            _op("alter_table_rename_table", "EXCHANGE TABLES db.a AND db.b;"),
            _op("alter_table_rename_table", "EXCHANGE DICTIONARIES db.a AND db.b;"),
        ]
    )

    sql = [op.sql for op in apply_on_cluster_to_plan(plan, "c").operations]

    assert sql == [
        "RENAME DATABASE db.a TO db.b ON CLUSTER 'c';",
        "RENAME DICTIONARY db.a TO db.b ON CLUSTER 'c';",
        "EXCHANGE TABLES db.a AND db.b ON CLUSTER 'c';",
        "EXCHANGE DICTIONARIES db.a AND db.b ON CLUSTER 'c';",
    ]


# ---------- resolve_config cluster validation ----------


def test_resolve_config_passes_through_identifier_and_macro() -> None:
    resolved = resolve_config(_user_config("my_cluster")).clickhouse
    assert resolved is not None
    assert resolved.cluster == "my_cluster"

    macro = resolve_config(_user_config("{cluster}")).clickhouse
    assert macro is not None
    assert macro.cluster == "{cluster}"


def test_resolve_config_passes_through_names_with_dashes_and_dots() -> None:
    dash = resolve_config(_user_config("prod-eu-1")).clickhouse
    dot = resolve_config(_user_config("eu.west.main")).clickhouse
    assert dash is not None
    assert dash.cluster == "prod-eu-1"
    assert dot is not None
    assert dot.cluster == "eu.west.main"


def test_resolve_config_defaults_to_none_when_cluster_unset() -> None:
    resolved = resolve_config(_user_config(None)).clickhouse
    assert resolved is not None
    assert resolved.cluster is None


def test_resolve_config_rejects_injection_unsafe_cluster_name() -> None:
    with pytest.raises(ValueError, match=r"Invalid clickhouse\.cluster"):
        resolve_config(_user_config("x'; DROP"))


def test_resolve_config_rejects_multiline_cluster_name() -> None:
    # Regression guard for the ``re.fullmatch`` (vs ``re.match``) fix — a
    # start-only anchor would silently accept ``"prod\nDROP TABLE x"``.
    with pytest.raises(ValueError, match=r"Invalid clickhouse\.cluster"):
        resolve_config(_user_config("prod\nDROP TABLE x"))
