"""1:1 port of ``packages/core/src/sql-validation.e2e.test.ts``.

Validates every SQL statement emitted by chkit is syntactically valid
ClickHouse SQL via ``EXPLAIN AST`` against a live instance. No DDL executes.

Connection defaults to ``http://localhost:8123`` user=``default`` password=``""``
(a fresh Docker run). Override with ``CLICKHOUSE_URL`` / ``CLICKHOUSE_PASSWORD``
env vars. See ``conftest.py``.
"""

from __future__ import annotations

from typing import Any

import pytest

from chkit.core.model import TableDefinition, materialized_view, table, view
from chkit.core.planner import plan_diff
from chkit.core.sql import (
    render_alter_add_column,
    render_alter_add_index,
    render_alter_add_projection,
    render_alter_drop_column,
    render_alter_drop_index,
    render_alter_drop_projection,
    render_alter_modify_column,
    render_alter_modify_refresh,
    render_alter_modify_setting,
    render_alter_modify_ttl,
    render_alter_remove_codec,
    render_alter_reset_setting,
    to_create_sql,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _base_table(**overrides: Any) -> TableDefinition:
    base = {
        "database": "default",
        "name": "test_table",
        "columns": [{"name": "id", "type": "UInt64"}],
        "engine": "MergeTree()",
        "primaryKey": ["id"],
        "orderBy": ["id"],
    }
    base.update(overrides)
    return table(**base)


# =========================================================================
# CREATE TABLE — Primitive column types
# =========================================================================


_PRIMITIVE_TYPES = [
    "String",
    "UInt8",
    "UInt16",
    "UInt32",
    "UInt64",
    "UInt128",
    "UInt256",
    "Int8",
    "Int16",
    "Int32",
    "Int64",
    "Int128",
    "Int256",
    "Float32",
    "Float64",
    "Bool",
    "Date",
    "DateTime",
    "DateTime64",
    "Date32",
]


@pytest.mark.parametrize("type_", _PRIMITIVE_TYPES)
def test_create_table_primitive_column_type(assert_valid_sql, type_: str) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "value", "type": type_},
        ]
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — Parameterized types
# =========================================================================


_PARAMETERIZED_TYPES = [
    "DateTime64(3)",
    "DateTime64(3, 'UTC')",
    "FixedString(10)",
    "Decimal(18, 4)",
    "Decimal32(2)",
    "Decimal64(4)",
    "Decimal128(6)",
]


@pytest.mark.parametrize("type_", _PARAMETERIZED_TYPES)
def test_create_table_parameterized_type(assert_valid_sql, type_: str) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "value", "type": type_},
        ]
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — Complex/nested types
# =========================================================================


_COMPLEX_TYPES = [
    "Nullable(String)",
    "LowCardinality(String)",
    "LowCardinality(Nullable(String))",
    "Array(String)",
    "Array(UInt32)",
    "Array(Array(String))",
    "Map(String, UInt64)",
    "Tuple(String, UInt32)",
    "Tuple(String, Array(UInt32))",
    "Array(Tuple(String, Array(UInt32)))",
    "Enum8('a' = 1, 'b' = 2)",
    "Enum16('active' = 1, 'inactive' = 2, 'deleted' = 3)",
    "SimpleAggregateFunction(sum, UInt64)",
    "SimpleAggregateFunction(max, DateTime)",
]


@pytest.mark.parametrize("type_", _COMPLEX_TYPES)
def test_create_table_complex_type(assert_valid_sql, type_: str) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "value", "type": type_},
        ]
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — Column defaults
# =========================================================================


_DEFAULT_CASES = [
    ("string literal", {"name": "status", "type": "String", "default": "active"}),
    ("numeric", {"name": "count", "type": "UInt32", "default": 0}),
    ("boolean", {"name": "flag", "type": "Bool", "default": False}),
    ("fn now()", {"name": "created_at", "type": "DateTime", "default": "fn:now()"}),
    (
        "fn toDate now()",
        {"name": "created_date", "type": "Date", "default": "fn:toDate(now())"},
    ),
]


@pytest.mark.parametrize(("label", "col"), _DEFAULT_CASES)
def test_create_table_column_default(
    assert_valid_sql, label: str, col: dict[str, Any]
) -> None:
    def_ = _base_table(columns=[{"name": "id", "type": "UInt64"}, col])
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — Column CODEC
# =========================================================================


_CODEC_CASES = [
    ("ZSTD(3)", {"name": "payload", "type": "String", "codec": {"kind": "ZSTD", "level": 3}}),
    ("LZ4HC(9)", {"name": "payload", "type": "String", "codec": {"kind": "LZ4HC", "level": 9}}),
    ("NONE", {"name": "payload", "type": "String", "codec": {"kind": "NONE"}}),
    (
        "Delta + ZSTD",
        {
            "name": "payload",
            "type": "Int64",
            "codec": [{"kind": "Delta", "size": 4}, {"kind": "ZSTD", "level": 3}],
        },
    ),
    ("T64", {"name": "payload", "type": "Int64", "codec": {"kind": "T64"}}),
]


@pytest.mark.parametrize(("label", "col"), _CODEC_CASES)
def test_create_table_column_codec(
    assert_valid_sql, label: str, col: dict[str, Any]
) -> None:
    def_ = _base_table(columns=[{"name": "id", "type": "UInt64"}, col])
    assert_valid_sql(to_create_sql(def_))


def test_create_table_codec_plus_default_combined(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {
                "name": "ts",
                "type": "DateTime",
                "codec": {"kind": "ZSTD", "level": 3},
                "default": "fn:now()",
            },
        ]
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_table_codec_on_nullable_column(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {
                "name": "note",
                "type": "String",
                "nullable": True,
                "codec": {"kind": "ZSTD", "level": 3},
            },
        ]
    )
    assert_valid_sql(to_create_sql(def_))


def test_alter_modify_column_with_codec(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(
        render_alter_modify_column(
            def_,
            {  # type: ignore[arg-type]
                "name": "value",
                "type": "String",
                "codec": {"kind": "ZSTD", "level": 6},
            },
        )
    )


def test_alter_modify_column_remove_codec(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(render_alter_remove_codec(def_, "payload"))


# =========================================================================
# CREATE TABLE — Comments & nullable
# =========================================================================


def test_create_table_column_with_comment(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "name", "type": "String", "comment": "User name"},
        ]
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_table_column_with_escaped_quote_in_comment(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "name", "type": "String", "comment": "User's full name"},
        ]
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_table_nullable_column(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "email", "type": "String", "nullable": True},
        ]
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_table_nullable_column_with_default_and_comment(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {
                "name": "nickname",
                "type": "String",
                "nullable": True,
                "default": "anon",
                "comment": "Display name",
            },
        ]
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — Engine family
# =========================================================================


_ENGINE_CASES: list[tuple[str, dict[str, Any]]] = [
    ("MergeTree()", {}),
    (
        "ReplacingMergeTree(version)",
        {
            "columns": [
                {"name": "id", "type": "UInt64"},
                {"name": "version", "type": "UInt64"},
            ]
        },
    ),
    (
        "SummingMergeTree(amount)",
        {
            "columns": [
                {"name": "id", "type": "UInt64"},
                {"name": "amount", "type": "Float64"},
            ]
        },
    ),
    ("AggregatingMergeTree()", {}),
    (
        "CollapsingMergeTree(sign)",
        {
            "columns": [
                {"name": "id", "type": "UInt64"},
                {"name": "sign", "type": "Int8"},
            ]
        },
    ),
    (
        "VersionedCollapsingMergeTree(sign, version)",
        {
            "columns": [
                {"name": "id", "type": "UInt64"},
                {"name": "sign", "type": "Int8"},
                {"name": "version", "type": "UInt64"},
            ]
        },
    ),
]


@pytest.mark.parametrize(("engine", "extra"), _ENGINE_CASES)
def test_create_table_engine_family(
    assert_valid_sql, engine: str, extra: dict[str, Any]
) -> None:
    def_ = _base_table(engine=engine, **extra)
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — PARTITION BY
# =========================================================================


_PARTITION_CASES = [
    ("toYYYYMM", "toYYYYMM(created_at)"),
    ("toDate", "toDate(created_at)"),
    ("tuple", "tuple(region, toYYYYMM(created_at))"),
]


@pytest.mark.parametrize(("label", "expr"), _PARTITION_CASES)
def test_create_table_partition_by(assert_valid_sql, label: str, expr: str) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "created_at", "type": "DateTime"},
            {"name": "region", "type": "String"},
        ],
        partitionBy=expr,
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — ORDER BY / PRIMARY KEY
# =========================================================================


def test_create_table_multi_column_order_by(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "tenant_id", "type": "UInt64"},
            {"name": "id", "type": "UInt64"},
            {"name": "created_at", "type": "DateTime"},
        ],
        primaryKey=["tenant_id", "id"],
        orderBy=["tenant_id", "id", "created_at"],
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_table_expression_in_order_by(assert_valid_sql) -> None:
    # Bypasses chkit validation since to_create_sql would reject an expression
    # in orderBy. We still want ClickHouse to confirm the syntax.
    sql = (
        "CREATE TABLE IF NOT EXISTS default.test_expr_order\n"
        "(\n"
        "  `id` UInt64,\n"
        "  `created_at` DateTime\n"
        ") ENGINE = MergeTree()\n"
        "PRIMARY KEY (`id`)\n"
        "ORDER BY (`id`, toDate(`created_at`))"
    )
    assert_valid_sql(sql)


# =========================================================================
# CREATE TABLE — TTL
# =========================================================================


def test_create_table_simple_ttl(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "created_at", "type": "DateTime"},
        ],
        ttl="created_at + INTERVAL 30 DAY",
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_table_ttl_with_delete(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "created_at", "type": "DateTime"},
        ],
        ttl="created_at + INTERVAL 90 DAY DELETE",
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — SETTINGS
# =========================================================================


def test_create_table_numeric_setting(assert_valid_sql) -> None:
    def_ = _base_table(settings={"index_granularity": 8192})
    assert_valid_sql(to_create_sql(def_))


def test_create_table_multiple_settings(assert_valid_sql) -> None:
    def_ = _base_table(
        settings={"index_granularity": 8192, "min_bytes_for_wide_part": 0}
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — Skip indexes
# =========================================================================


_INDEX_CASES: list[tuple[str, dict[str, Any]]] = [
    (
        "minmax",
        {"name": "idx_ts", "expression": "created_at", "type": "minmax", "granularity": 3},
    ),
    (
        "set",
        {
            "name": "idx_status",
            "expression": "status",
            "type": "set",
            "maxRows": 100,
            "granularity": 2,
        },
    ),
    (
        "set unbounded",
        {
            "name": "idx_status_all",
            "expression": "status",
            "type": "set",
            "maxRows": 0,
            "granularity": 2,
        },
    ),
    (
        "bloom_filter",
        {
            "name": "idx_email",
            "expression": "email",
            "type": "bloom_filter",
            "granularity": 1,
        },
    ),
    (
        "bloom_filter falsePositiveRate",
        {
            "name": "idx_email2",
            "expression": "email",
            "type": "bloom_filter",
            "falsePositiveRate": 0.01,
            "granularity": 1,
        },
    ),
    (
        "tokenbf_v1",
        {
            "name": "idx_body",
            "expression": "body",
            "type": "tokenbf_v1",
            "sizeBytes": 10240,
            "hashFunctions": 3,
            "randomSeed": 0,
            "granularity": 1,
        },
    ),
    (
        "ngrambf_v1",
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
    ),
    (
        "expression index",
        {
            "name": "idx_lower",
            "expression": "lower(name)",
            "type": "bloom_filter",
            "granularity": 1,
        },
    ),
]


@pytest.mark.parametrize(("label", "idx"), _INDEX_CASES)
def test_create_table_skip_index(
    assert_valid_sql, label: str, idx: dict[str, Any]
) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "created_at", "type": "DateTime"},
            {"name": "status", "type": "String"},
            {"name": "email", "type": "String"},
            {"name": "body", "type": "String"},
            {"name": "name", "type": "String"},
        ],
        indexes=[idx],
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — Projections
# =========================================================================


def test_create_table_simple_projection(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "status", "type": "String"},
        ],
        projections=[
            {"name": "proj_status", "query": "SELECT status, count() GROUP BY status"}
        ],
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_table_projection_with_order_by(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "created_at", "type": "DateTime"},
        ],
        projections=[{"name": "proj_ts", "query": "SELECT * ORDER BY created_at"}],
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE TABLE — Table comment / kitchen sink
# =========================================================================


def test_create_table_table_comment(assert_valid_sql) -> None:
    def_ = _base_table(comment="Main events table")
    assert_valid_sql(to_create_sql(def_))


def test_create_table_table_comment_with_escaped_quote(assert_valid_sql) -> None:
    def_ = _base_table(comment="User's activity log")
    assert_valid_sql(to_create_sql(def_))


def test_create_table_kitchen_sink(assert_valid_sql) -> None:
    def_ = table(
        database="default",
        name="kitchen_sink",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "tenant_id", "type": "UInt32"},
            {"name": "name", "type": "String", "comment": "Full name"},
            {"name": "email", "type": "String", "nullable": True},
            {"name": "status", "type": "Enum8('active' = 1, 'inactive' = 2)"},
            {"name": "score", "type": "Float64", "default": 0},
            {"name": "tags", "type": "Array(String)"},
            {"name": "metadata", "type": "Map(String, String)"},
            {"name": "created_at", "type": "DateTime", "default": "fn:now()"},
            {"name": "updated_at", "type": "Nullable(DateTime)"},
            {"name": "amount", "type": "Decimal(18, 4)"},
            {"name": "flags", "type": "UInt8", "default": 0, "comment": "Bitmask flags"},
        ],
        engine="MergeTree()",
        primaryKey=["tenant_id", "id"],
        orderBy=["tenant_id", "id", "created_at"],
        partitionBy="toYYYYMM(created_at)",
        ttl="created_at + INTERVAL 365 DAY",
        settings={"index_granularity": 8192},
        indexes=[
            {"name": "idx_email", "expression": "email", "type": "bloom_filter", "granularity": 1},
            {"name": "idx_ts", "expression": "created_at", "type": "minmax", "granularity": 3},
        ],
        projections=[
            {"name": "proj_status", "query": "SELECT status, count() GROUP BY status"}
        ],
        comment="All-in-one test table",
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_table_many_columns(assert_valid_sql) -> None:
    columns: list[dict[str, Any]] = [{"name": "id", "type": "UInt64"}]
    for i in range(25):
        columns.append(
            {"name": f"col_{i}", "type": "String" if i % 2 == 0 else "UInt32"}
        )
    def_ = _base_table(columns=columns)
    assert_valid_sql(to_create_sql(def_))


def test_create_table_reserved_word_column_names(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "select", "type": "String"},
            {"name": "from", "type": "String"},
            {"name": "table", "type": "UInt32"},
            {"name": "index", "type": "UInt32"},
        ]
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_table_deeply_nested_type(assert_valid_sql) -> None:
    def_ = _base_table(
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "nested", "type": "Array(Tuple(String, Array(UInt32)))"},
        ]
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE VIEW
# =========================================================================


def test_create_view_simple(assert_valid_sql) -> None:
    def_ = view(database="default", name="test_view", as_="SELECT 1 AS x")
    assert_valid_sql(to_create_sql(def_))


def test_create_view_with_comment(assert_valid_sql) -> None:
    def_ = view(
        database="default",
        name="test_view_comment",
        as_="SELECT 1 AS x",
        comment="A test view",
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# CREATE MATERIALIZED VIEW
# =========================================================================


def test_create_mv_with_target_table(assert_valid_sql) -> None:
    def_ = materialized_view(
        database="default",
        name="test_mv",
        to={"database": "default", "name": "target_table"},
        as_="SELECT id, count() AS cnt FROM default.source GROUP BY id",
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_mv_with_aggregation_select(assert_valid_sql) -> None:
    def_ = materialized_view(
        database="default",
        name="test_mv_agg",
        to={"database": "default", "name": "agg_target"},
        as_=(
            "SELECT toDate(created_at) AS day, sum(amount) AS total "
            "FROM default.events GROUP BY day"
        ),
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_refreshable_mv_refresh_every(assert_valid_sql) -> None:
    def_ = materialized_view(
        database="default",
        name="test_rmv",
        to={"database": "default", "name": "rmv_target"},
        refresh={"every": "1 HOUR"},
        as_="SELECT id, count() AS cnt FROM default.source GROUP BY id",
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_refreshable_mv_append_offset_randomize_settings(
    assert_valid_sql, ch_server_version: tuple[int, ...]
) -> None:
    if ch_server_version < (25, 0):
        pytest.xfail(
            f"Refreshable MV APPEND requires a ClickHouse build with the feature "
            f"(seen v{'.'.join(map(str, ch_server_version))})"
        )
    def_ = materialized_view(
        database="default",
        name="test_rmv_append",
        to={"database": "default", "name": "rmv_append_target"},
        refresh={
            "every": "1 DAY",
            "offset": "2 HOUR",
            "randomize": "5 MINUTE",
            "settings": {"refresh_retries": 3},
            "append": True,
        },
        as_=(
            "SELECT toDate(created_at) AS day, count() AS c "
            "FROM default.events GROUP BY day"
        ),
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_refreshable_mv_refresh_after(assert_valid_sql) -> None:
    def_ = materialized_view(
        database="default",
        name="test_rmv_after",
        to={"database": "default", "name": "rmv_after_target"},
        refresh={"after": "10 MINUTE"},
        as_="SELECT id FROM default.source",
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_refreshable_mv_with_depends_on(assert_valid_sql) -> None:
    def_ = materialized_view(
        database="default",
        name="test_rmv_deps",
        to={"database": "default", "name": "rmv_deps_target"},
        refresh={
            "every": "1 HOUR",
            "dependsOn": [{"database": "default", "name": "upstream_mv"}],
        },
        as_="SELECT id FROM default.source",
    )
    assert_valid_sql(to_create_sql(def_))


def test_create_refreshable_mv_empty_clause(assert_valid_sql) -> None:
    def_ = materialized_view(
        database="default",
        name="test_rmv_empty",
        to={"database": "default", "name": "rmv_empty_target"},
        refresh={"every": "1 HOUR", "empty": True},
        as_="SELECT id FROM default.source",
    )
    assert_valid_sql(to_create_sql(def_))


# =========================================================================
# ALTER TABLE — MODIFY REFRESH
# =========================================================================


def test_alter_modify_refresh_every(assert_valid_sql) -> None:
    def_ = materialized_view(
        database="default",
        name="test_rmv",
        to={"database": "default", "name": "rmv_target"},
        refresh={"every": "30 MINUTE"},
        as_="SELECT 1",
    )
    assert_valid_sql(render_alter_modify_refresh(def_))


def test_alter_modify_refresh_with_append_preserved(
    assert_valid_sql, ch_server_version: tuple[int, ...]
) -> None:
    if ch_server_version < (25, 0):
        pytest.xfail(
            f"MODIFY REFRESH ... APPEND requires a ClickHouse build with the "
            f"feature (seen v{'.'.join(map(str, ch_server_version))})"
        )
    def_ = materialized_view(
        database="default",
        name="test_rmv",
        to={"database": "default", "name": "rmv_target"},
        refresh={"every": "30 SECOND", "append": True},
        as_="SELECT 1",
    )
    assert_valid_sql(render_alter_modify_refresh(def_))


def test_alter_modify_refresh_after_randomize_settings(assert_valid_sql) -> None:
    def_ = materialized_view(
        database="default",
        name="test_rmv",
        to={"database": "default", "name": "rmv_target"},
        refresh={
            "after": "5 MINUTE",
            "randomize": "30 SECOND",
            "settings": {"refresh_retries": 3},
        },
        as_="SELECT 1",
    )
    assert_valid_sql(render_alter_modify_refresh(def_))


# =========================================================================
# ALTER TABLE — ADD COLUMN
# =========================================================================


_ADD_COLUMN_CASES = [
    ("simple string", {"name": "name", "type": "String"}),
    ("nullable", {"name": "email", "type": "String", "nullable": True}),
    ("with default", {"name": "score", "type": "Float64", "default": 0}),
    ("with fn default", {"name": "ts", "type": "DateTime", "default": "fn:now()"}),
    ("with comment", {"name": "notes", "type": "String", "comment": "User notes"}),
    ("complex type", {"name": "tags", "type": "Array(String)"}),
]


@pytest.mark.parametrize(("label", "col"), _ADD_COLUMN_CASES)
def test_alter_add_column(
    assert_valid_sql, label: str, col: dict[str, Any]
) -> None:
    def_ = _base_table()
    assert_valid_sql(render_alter_add_column(def_, col))  # type: ignore[arg-type]


# =========================================================================
# ALTER TABLE — MODIFY COLUMN
# =========================================================================


def test_alter_modify_column_type_change(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(
        render_alter_modify_column(def_, {"name": "id", "type": "UInt128"})  # type: ignore[arg-type]
    )


def test_alter_modify_column_nullable_change(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(
        render_alter_modify_column(
            def_, {"name": "value", "type": "String", "nullable": True}  # type: ignore[arg-type]
        )
    )


def test_alter_modify_column_default_change(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(
        render_alter_modify_column(
            def_, {"name": "value", "type": "String", "default": "unknown"}  # type: ignore[arg-type]
        )
    )


# =========================================================================
# ALTER TABLE — DROP COLUMN
# =========================================================================


def test_alter_drop_column(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(render_alter_drop_column(def_, "old_column"))


# =========================================================================
# ALTER TABLE — ADD INDEX
# =========================================================================


_ALTER_ADD_INDEX_CASES: list[tuple[str, dict[str, Any]]] = [
    (
        "minmax",
        {"name": "idx_ts", "expression": "created_at", "type": "minmax", "granularity": 3},
    ),
    (
        "set",
        {
            "name": "idx_status",
            "expression": "status",
            "type": "set",
            "maxRows": 100,
            "granularity": 2,
        },
    ),
    (
        "bloom_filter",
        {
            "name": "idx_email",
            "expression": "email",
            "type": "bloom_filter",
            "granularity": 1,
        },
    ),
    (
        "bloom_filter tuned",
        {
            "name": "idx_email_tuned",
            "expression": "email",
            "type": "bloom_filter",
            "falsePositiveRate": 0.01,
            "granularity": 1,
        },
    ),
    (
        "tokenbf_v1",
        {
            "name": "idx_body",
            "expression": "body",
            "type": "tokenbf_v1",
            "sizeBytes": 10240,
            "hashFunctions": 3,
            "randomSeed": 0,
            "granularity": 1,
        },
    ),
    (
        "ngrambf_v1",
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
    ),
]


@pytest.mark.parametrize(("label", "idx"), _ALTER_ADD_INDEX_CASES)
def test_alter_add_index(
    assert_valid_sql, label: str, idx: dict[str, Any]
) -> None:
    def_ = _base_table()
    assert_valid_sql(render_alter_add_index(def_, idx))  # type: ignore[arg-type]


# =========================================================================
# ALTER TABLE — DROP INDEX
# =========================================================================


def test_alter_drop_index(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(render_alter_drop_index(def_, "idx_old"))


# =========================================================================
# ALTER TABLE — ADD/DROP PROJECTION
# =========================================================================


def test_alter_add_projection(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(
        render_alter_add_projection(
            def_,
            {  # type: ignore[arg-type]
                "name": "proj_status",
                "query": "SELECT status, count() GROUP BY status",
            },
        )
    )


def test_alter_drop_projection(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(render_alter_drop_projection(def_, "proj_old"))


# =========================================================================
# ALTER TABLE — MODIFY SETTING / RESET SETTING
# =========================================================================


def test_alter_modify_setting(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(render_alter_modify_setting(def_, "index_granularity", 4096))


def test_alter_reset_setting(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(render_alter_reset_setting(def_, "index_granularity"))


# =========================================================================
# ALTER TABLE — MODIFY TTL / REMOVE TTL
# =========================================================================


def test_alter_modify_ttl(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(
        render_alter_modify_ttl(def_, "created_at + INTERVAL 30 DAY")
    )


def test_alter_remove_ttl(assert_valid_sql) -> None:
    def_ = _base_table()
    assert_valid_sql(render_alter_modify_ttl(def_, None))


# =========================================================================
# planDiff — migration plans
# =========================================================================


def test_plan_new_table_creation_sql_valid(assert_valid_sql) -> None:
    plan = plan_diff([], [_base_table(name="new_events")])
    assert len(plan.operations) > 0
    for op in plan.operations:
        assert_valid_sql(op.sql)


def test_plan_table_drop_sql_valid(assert_valid_sql) -> None:
    plan = plan_diff([_base_table(name="old_events")], [])
    assert len(plan.operations) > 0
    for op in plan.operations:
        assert_valid_sql(op.sql)


def test_plan_additive_changes_sql_valid(assert_valid_sql) -> None:
    old = _base_table(name="events")
    new = _base_table(
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "name", "type": "String"},
            {"name": "created_at", "type": "DateTime"},
        ],
        indexes=[
            {"name": "idx_ts", "expression": "created_at", "type": "minmax", "granularity": 3},
        ],
        settings={"index_granularity": 4096},
    )
    plan = plan_diff([old], [new])
    assert len(plan.operations) > 0
    for op in plan.operations:
        assert_valid_sql(op.sql)


def test_plan_destructive_changes_sql_valid(assert_valid_sql) -> None:
    old = _base_table(
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "obsolete", "type": "String"},
            {"name": "created_at", "type": "DateTime"},
        ],
        indexes=[
            {"name": "idx_ts", "expression": "created_at", "type": "minmax", "granularity": 3},
        ],
    )
    new = _base_table(name="events", columns=[{"name": "id", "type": "UInt64"}])
    plan = plan_diff([old], [new])
    assert len(plan.operations) > 0
    for op in plan.operations:
        assert_valid_sql(op.sql)


def test_plan_structural_recreate_sql_valid(assert_valid_sql) -> None:
    old = _base_table(name="events", engine="MergeTree()")
    new = _base_table(name="events", engine="ReplacingMergeTree()")
    plan = plan_diff([old], [new])
    assert len(plan.operations) == 2
    for op in plan.operations:
        assert_valid_sql(op.sql)


def test_plan_view_modification_sql_valid(assert_valid_sql) -> None:
    old_v = view(database="default", name="events_view", as_="SELECT 1 AS x")
    new_v = view(
        database="default", name="events_view", as_="SELECT 1 AS x, 2 AS y"
    )
    plan = plan_diff([old_v], [new_v])
    assert len(plan.operations) == 2
    for op in plan.operations:
        assert_valid_sql(op.sql)


def test_plan_materialized_view_modification_sql_valid(assert_valid_sql) -> None:
    old_mv = materialized_view(
        database="default",
        name="events_mv",
        to={"database": "default", "name": "events_target"},
        as_="SELECT id FROM default.source",
    )
    new_mv = materialized_view(
        database="default",
        name="events_mv",
        to={"database": "default", "name": "events_target"},
        as_="SELECT id, name FROM default.source",
    )
    plan = plan_diff([old_mv], [new_mv])
    assert len(plan.operations) == 2
    for op in plan.operations:
        assert_valid_sql(op.sql)


def test_plan_create_database_sql_valid(assert_valid_sql) -> None:
    new = table(
        database="analytics",
        name="events",
        columns=[{"name": "id", "type": "UInt64"}],
        engine="MergeTree()",
        primaryKey=["id"],
        orderBy=["id"],
    )
    plan = plan_diff([], [new])
    db_ops = [op for op in plan.operations if op.type == "create_database"]
    assert len(db_ops) == 1
    for op in plan.operations:
        assert_valid_sql(op.sql)


def test_plan_multiple_operations_sql_valid(assert_valid_sql) -> None:
    old = [_base_table(name="users"), _base_table(name="events")]
    new = [
        _base_table(
            name="users",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "email", "type": "String"},
            ],
        ),
        _base_table(
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "created_at", "type": "DateTime"},
            ],
        ),
        _base_table(name="sessions"),
    ]
    plan = plan_diff(old, new)
    assert len(plan.operations) > 0
    for op in plan.operations:
        assert_valid_sql(op.sql)
