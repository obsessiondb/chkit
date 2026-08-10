"""Comprehensive SQL-rendering parity tests for ``to_create_sql``.

Ports the cases in TS ``packages/core/src/sql-validation.e2e.test.ts`` —
which validates each rendered statement against a live ClickHouse via
``EXPLAIN AST`` — into structural assertions that don't need a live DB.

For each TS test case we:
- Build the same input definition.
- Render via Python ``to_create_sql`` / ``render_alter_*``.
- Assert that the rendered SQL contains the expected clauses (type literal,
  engine, primary key, etc.) in the right shape.

This is regression-protection (not e2e validation): if the renderer ever
diverges from the TS golden shape, the test fails before any drift hits a
real ClickHouse.
"""

from __future__ import annotations

from typing import Any

import pytest

from chkit import (
    ColumnDefinition,
    MaterializedViewRefresh,
    SkipIndexBloomFilter,
    SkipIndexMinmax,
    SkipIndexNgramBF,
    SkipIndexSet,
    SkipIndexTokenBF,
    TableDefinition,
    TableRef,
    materialized_view,
    table,
    view,
)
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


def _base_table(**overrides: Any) -> TableDefinition:
    """Mirror of the TS ``baseTable`` helper from sql-validation.e2e.test.ts."""
    base: dict[str, Any] = {
        "database": "default",
        "name": "test_table",
        "columns": [ColumnDefinition(name="id", type="UInt64")],
        "engine": "MergeTree()",
        "primary_key": ["id"],
        "order_by": ["id"],
    }
    base.update(overrides)
    return table(**base)


# ---------- primitive column types ----------


@pytest.mark.parametrize(
    "type_text",
    [
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
    ],
)
def test_primitive_column_type_renders_verbatim(type_text: str) -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="value", type=type_text),
        ]
    )
    sql = to_create_sql(t)
    assert f"`value` {type_text}" in sql


# ---------- parameterized column types ----------


@pytest.mark.parametrize(
    "type_text",
    [
        "DateTime64(3)",
        "DateTime64(3, 'UTC')",
        "FixedString(10)",
        "Decimal(18, 4)",
        "Decimal32(2)",
        "Decimal64(4)",
        "Decimal128(6)",
    ],
)
def test_parameterized_column_type_renders_verbatim(type_text: str) -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="value", type=type_text),
        ]
    )
    sql = to_create_sql(t)
    assert f"`value` {type_text}" in sql


# ---------- complex / nested types ----------


@pytest.mark.parametrize(
    "type_text",
    [
        "LowCardinality(String)",
        "LowCardinality(Nullable(String))",
        "Array(String)",
        "Array(UInt32)",
        "Array(Array(String))",
        "Map(String, UInt64)",
        "Tuple(String, UInt32)",
        "Tuple(String, Array(UInt32))",
        "Array(Tuple(String, Array(UInt32)))",
    ],
)
def test_complex_column_type_renders_verbatim(type_text: str) -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="value", type=type_text),
        ]
    )
    sql = to_create_sql(t)
    assert f"`value` {type_text}" in sql


def test_nullable_wraps_base_type_around_user_type() -> None:
    """``nullable=True`` should wrap the type in ``Nullable(...)``."""
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="email", type="String", nullable=True),
        ]
    )
    sql = to_create_sql(t)
    assert "`email` Nullable(String)" in sql


# ---------- column defaults ----------


def test_default_string_literal_is_quoted() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="status", type="String", default="active"),
        ]
    )
    sql = to_create_sql(t)
    assert "`status` String DEFAULT 'active'" in sql


def test_default_numeric_unquoted() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="count", type="UInt32", default=0),
        ]
    )
    sql = to_create_sql(t)
    assert "`count` UInt32 DEFAULT 0" in sql


def test_default_boolean_lowercase() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="flag", type="Bool", default=False),
        ]
    )
    sql = to_create_sql(t)
    assert "`flag` Bool DEFAULT false" in sql


def test_default_fn_prefix_stripped() -> None:
    """``fn:now()`` should emit ``DEFAULT now()`` (no quotes, no fn: prefix)."""
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="created_at", type="DateTime", default="fn:now()"),
        ]
    )
    sql = to_create_sql(t)
    assert "`created_at` DateTime DEFAULT now()" in sql
    assert "fn:" not in sql


def test_default_fn_nested_call() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(
                name="created_date", type="Date", default="fn:toDate(now())"
            ),
        ]
    )
    sql = to_create_sql(t)
    assert "DEFAULT toDate(now())" in sql


# ---------- column codecs ----------


def _col(spec: dict[str, Any]) -> ColumnDefinition:
    """Build a ColumnDefinition from a TS-style dict (so we can use the
    discriminated-union codec literals without mypy complaining)."""
    return ColumnDefinition.model_validate(spec)


def test_codec_zstd_with_level() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            _col({"name": "payload", "type": "String", "codec": {"kind": "ZSTD", "level": 3}}),
        ]
    )
    sql = to_create_sql(t)
    assert "CODEC(ZSTD(3))" in sql


def test_codec_lz4hc_with_level() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            _col({"name": "payload", "type": "String", "codec": {"kind": "LZ4HC", "level": 9}}),
        ]
    )
    sql = to_create_sql(t)
    assert "CODEC(LZ4HC(9))" in sql


def test_codec_none() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            _col({"name": "payload", "type": "String", "codec": {"kind": "NONE"}}),
        ]
    )
    sql = to_create_sql(t)
    assert "CODEC(NONE)" in sql


def test_codec_chain_delta_zstd() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            _col(
                {
                    "name": "payload",
                    "type": "Int64",
                    "codec": [
                        {"kind": "Delta", "size": 4},
                        {"kind": "ZSTD", "level": 3},
                    ],
                }
            ),
        ]
    )
    sql = to_create_sql(t)
    assert "CODEC(Delta(4), ZSTD(3))" in sql


def test_codec_t64() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            _col({"name": "payload", "type": "Int64", "codec": {"kind": "T64"}}),
        ]
    )
    sql = to_create_sql(t)
    assert "CODEC(T64)" in sql


def test_codec_with_default_combined() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            _col(
                {
                    "name": "ts",
                    "type": "DateTime",
                    "default": "fn:now()",
                    "codec": {"kind": "ZSTD", "level": 3},
                }
            ),
        ]
    )
    sql = to_create_sql(t)
    assert "DEFAULT now()" in sql
    assert "CODEC(ZSTD(3))" in sql
    # DEFAULT must come before CODEC.
    assert sql.index("DEFAULT now()") < sql.index("CODEC(ZSTD(3))")


def test_codec_on_nullable_column() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            _col(
                {
                    "name": "note",
                    "type": "String",
                    "nullable": True,
                    "codec": {"kind": "ZSTD", "level": 3},
                }
            ),
        ]
    )
    sql = to_create_sql(t)
    assert "`note` Nullable(String)" in sql
    assert "CODEC(ZSTD(3))" in sql


# ---------- column comments + nullable ----------


def test_column_with_comment() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="name", type="String", comment="User name"),
        ]
    )
    sql = to_create_sql(t)
    assert "`name` String COMMENT 'User name'" in sql


def test_column_comment_with_escaped_quote() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="name", type="String", comment="User's full name"),
        ]
    )
    sql = to_create_sql(t)
    # Single-quote is doubled (TS + CH convention).
    assert "COMMENT 'User''s full name'" in sql


def test_nullable_with_default_and_comment() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(
                name="nickname",
                type="String",
                nullable=True,
                default="anon",
                comment="Display name",
            ),
        ]
    )
    sql = to_create_sql(t)
    assert "`nickname` Nullable(String)" in sql
    assert "DEFAULT 'anon'" in sql
    assert "COMMENT 'Display name'" in sql


# ---------- engine family ----------


@pytest.mark.parametrize(
    ("engine", "extra_columns"),
    [
        ("MergeTree()", []),
        (
            "ReplacingMergeTree(version)",
            [ColumnDefinition(name="version", type="UInt64")],
        ),
        (
            "SummingMergeTree(amount)",
            [ColumnDefinition(name="amount", type="Float64")],
        ),
        ("AggregatingMergeTree()", []),
        (
            "CollapsingMergeTree(sign)",
            [ColumnDefinition(name="sign", type="Int8")],
        ),
        (
            "VersionedCollapsingMergeTree(sign, version)",
            [
                ColumnDefinition(name="sign", type="Int8"),
                ColumnDefinition(name="version", type="UInt64"),
            ],
        ),
    ],
)
def test_engine_family_renders_verbatim(
    engine: str, extra_columns: list[ColumnDefinition]
) -> None:
    columns = [ColumnDefinition(name="id", type="UInt64"), *extra_columns]
    t = _base_table(engine=engine, columns=columns)
    sql = to_create_sql(t)
    assert f"ENGINE = {engine}" in sql


# ---------- PARTITION BY ----------


@pytest.mark.parametrize(
    "expr",
    [
        "toYYYYMM(created_at)",
        "toDate(created_at)",
        "tuple(region, toYYYYMM(created_at))",
    ],
)
def test_partition_by_renders_verbatim(expr: str) -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="created_at", type="DateTime"),
            ColumnDefinition(name="region", type="String"),
        ],
        partition_by=expr,
    )
    sql = to_create_sql(t)
    assert f"PARTITION BY {expr}" in sql


def test_partition_by_absent_emits_nothing() -> None:
    t = _base_table()
    sql = to_create_sql(t)
    assert "PARTITION BY" not in sql


# ---------- ORDER BY / PRIMARY KEY ----------


def test_multi_column_order_by_and_primary_key() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="tenant_id", type="UInt64"),
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="created_at", type="DateTime"),
        ],
        primary_key=["tenant_id", "id"],
        order_by=["tenant_id", "id", "created_at"],
    )
    sql = to_create_sql(t)
    assert "PRIMARY KEY (`tenant_id`, `id`)" in sql
    assert "ORDER BY (`tenant_id`, `id`, `created_at`)" in sql


# ---------- TTL ----------


def test_ttl_simple() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="created_at", type="DateTime"),
        ],
        ttl="created_at + INTERVAL 30 DAY",
    )
    sql = to_create_sql(t)
    assert "TTL created_at + INTERVAL 30 DAY" in sql


def test_ttl_with_delete_clause() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="created_at", type="DateTime"),
        ],
        ttl="created_at + INTERVAL 90 DAY DELETE",
    )
    sql = to_create_sql(t)
    assert "TTL created_at + INTERVAL 90 DAY DELETE" in sql


# ---------- SETTINGS ----------


def test_settings_numeric() -> None:
    t = _base_table(settings={"index_granularity": 8192})
    sql = to_create_sql(t)
    assert "SETTINGS index_granularity = 8192" in sql


def test_settings_multiple_preserve_insertion_order() -> None:
    t = _base_table(
        settings={"index_granularity": 8192, "min_bytes_for_wide_part": 0}
    )
    sql = to_create_sql(t)
    assert (
        "SETTINGS index_granularity = 8192, min_bytes_for_wide_part = 0" in sql
    )


# ---------- skip indexes ----------


def test_index_minmax() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="created_at", type="DateTime"),
        ],
        indexes=[
            SkipIndexMinmax(name="idx_ts", expression="created_at", granularity=3)
        ],
    )
    sql = to_create_sql(t)
    assert "INDEX `idx_ts` (created_at) TYPE minmax GRANULARITY 3" in sql


def test_index_set_with_max_rows() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="status", type="String"),
        ],
        indexes=[
            SkipIndexSet(
                name="idx_status",
                expression="status",
                max_rows=100,
                granularity=2,
            )
        ],
    )
    sql = to_create_sql(t)
    assert "INDEX `idx_status` (status) TYPE set(100) GRANULARITY 2" in sql


def test_index_set_unbounded() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="status", type="String"),
        ],
        indexes=[
            SkipIndexSet(
                name="idx_status_all",
                expression="status",
                max_rows=0,
                granularity=2,
            )
        ],
    )
    sql = to_create_sql(t)
    assert "TYPE set(0)" in sql


def test_index_bloom_filter() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="email", type="String"),
        ],
        indexes=[
            SkipIndexBloomFilter(
                name="idx_email", expression="email", granularity=1
            )
        ],
    )
    sql = to_create_sql(t)
    assert "INDEX `idx_email` (email) TYPE bloom_filter GRANULARITY 1" in sql


def test_index_bloom_filter_with_false_positive_rate() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="email", type="String"),
        ],
        indexes=[
            SkipIndexBloomFilter(
                name="idx_email2",
                expression="email",
                false_positive_rate=0.01,
                granularity=1,
            )
        ],
    )
    sql = to_create_sql(t)
    assert "TYPE bloom_filter(0.01)" in sql


def test_index_tokenbf_v1() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="body", type="String"),
        ],
        indexes=[
            SkipIndexTokenBF(
                name="idx_body",
                expression="body",
                size_bytes=10240,
                hash_functions=3,
                random_seed=0,
                granularity=1,
            )
        ],
    )
    sql = to_create_sql(t)
    assert (
        "INDEX `idx_body` (body) TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 1"
        in sql
    )


def test_index_ngrambf_v1() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="name", type="String"),
        ],
        indexes=[
            SkipIndexNgramBF(
                name="idx_name",
                expression="name",
                ngram_size=3,
                size_bytes=256,
                hash_functions=2,
                random_seed=0,
                granularity=1,
            )
        ],
    )
    sql = to_create_sql(t)
    assert "TYPE ngrambf_v1(3, 256, 2, 0)" in sql


def test_index_expression_argument() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="name", type="String"),
        ],
        indexes=[
            SkipIndexBloomFilter(
                name="idx_lower", expression="lower(name)", granularity=1
            )
        ],
    )
    sql = to_create_sql(t)
    assert "INDEX `idx_lower` (lower(name)) TYPE bloom_filter GRANULARITY 1" in sql


# ---------- projections ----------


def test_projection_simple() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="status", type="String"),
        ],
        projections=[
            {"name": "proj_status", "query": "SELECT status, count() GROUP BY status"},
        ],
    )
    sql = to_create_sql(t)
    assert (
        "PROJECTION `proj_status` (SELECT status, count() GROUP BY status)" in sql
    )


def test_projection_with_order_by() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="created_at", type="DateTime"),
        ],
        projections=[{"name": "proj_ts", "query": "SELECT * ORDER BY created_at"}],
    )
    sql = to_create_sql(t)
    assert "PROJECTION `proj_ts` (SELECT * ORDER BY created_at)" in sql


# ---------- table comment ----------


def test_table_comment_renders() -> None:
    t = _base_table(comment="Main events table")
    sql = to_create_sql(t)
    assert "COMMENT 'Main events table'" in sql


def test_table_comment_escapes_single_quote() -> None:
    t = _base_table(comment="User's activity log")
    sql = to_create_sql(t)
    assert "COMMENT 'User''s activity log'" in sql


# ---------- kitchen sink ----------


def test_kitchen_sink_table_renders_all_clauses() -> None:
    t = table(
        database="default",
        name="kitchen_sink",
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="tenant_id", type="UInt32"),
            ColumnDefinition(name="name", type="String", comment="Full name"),
            ColumnDefinition(name="email", type="String", nullable=True),
            ColumnDefinition(name="status", type="Enum8('active' = 1, 'inactive' = 2)"),
            ColumnDefinition(name="score", type="Float64", default=0),
            ColumnDefinition(name="tags", type="Array(String)"),
            ColumnDefinition(name="metadata", type="Map(String, String)"),
            ColumnDefinition(name="created_at", type="DateTime", default="fn:now()"),
            ColumnDefinition(name="updated_at", type="Nullable(DateTime)"),
            ColumnDefinition(name="amount", type="Decimal(18, 4)"),
            ColumnDefinition(
                name="flags", type="UInt8", default=0, comment="Bitmask flags"
            ),
        ],
        engine="MergeTree()",
        primary_key=["tenant_id", "id"],
        order_by=["tenant_id", "id", "created_at"],
        partition_by="toYYYYMM(created_at)",
        ttl="created_at + INTERVAL 365 DAY",
        settings={"index_granularity": 8192},
        indexes=[
            SkipIndexBloomFilter(
                name="idx_email", expression="email", granularity=1
            ),
            SkipIndexMinmax(
                name="idx_ts", expression="created_at", granularity=3
            ),
        ],
        projections=[
            {"name": "proj_status", "query": "SELECT status, count() GROUP BY status"}
        ],
        comment="All-in-one test table",
    )
    sql = to_create_sql(t)
    expected_pieces = [
        "CREATE TABLE IF NOT EXISTS default.kitchen_sink",
        "`id` UInt64",
        "`name` String COMMENT 'Full name'",
        "`email` Nullable(String)",
        "`status` Enum8('active' = 1, 'inactive' = 2)",
        "`score` Float64 DEFAULT 0",
        "`tags` Array(String)",
        "`metadata` Map(String, String)",
        "`created_at` DateTime DEFAULT now()",
        "`updated_at` Nullable(DateTime)",
        "`amount` Decimal(18, 4)",
        "`flags` UInt8 DEFAULT 0 COMMENT 'Bitmask flags'",
        "INDEX `idx_email` (email) TYPE bloom_filter GRANULARITY 1",
        "INDEX `idx_ts` (created_at) TYPE minmax GRANULARITY 3",
        "PROJECTION `proj_status` (SELECT status, count() GROUP BY status)",
        "ENGINE = MergeTree()",
        "PARTITION BY toYYYYMM(created_at)",
        "PRIMARY KEY (`tenant_id`, `id`)",
        "ORDER BY (`tenant_id`, `id`, `created_at`)",
        "TTL created_at + INTERVAL 365 DAY",
        "SETTINGS index_granularity = 8192",
        "COMMENT 'All-in-one test table'",
    ]
    for piece in expected_pieces:
        assert piece in sql, f"Missing piece in kitchen-sink SQL: {piece}"


# ---------- 25-column table ----------


def test_many_columns_renders_each_column() -> None:
    columns = [ColumnDefinition(name="id", type="UInt64")]
    for i in range(25):
        columns.append(
            ColumnDefinition(name=f"col_{i}", type="String" if i % 2 == 0 else "UInt32")
        )
    t = _base_table(columns=columns)
    sql = to_create_sql(t)
    for i in range(25):
        expected_type = "String" if i % 2 == 0 else "UInt32"
        assert f"`col_{i}` {expected_type}" in sql


# ---------- reserved-word column names ----------


@pytest.mark.parametrize(
    ("name", "type_text"),
    [
        ("select", "String"),
        ("from", "String"),
        ("table", "UInt32"),
        ("index", "UInt32"),
    ],
)
def test_reserved_word_column_names_get_backticked(name: str, type_text: str) -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name=name, type=type_text),
        ]
    )
    sql = to_create_sql(t)
    assert f"`{name}` {type_text}" in sql


def test_deeply_nested_type() -> None:
    t = _base_table(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(
                name="nested", type="Array(Tuple(String, Array(UInt32)))"
            ),
        ]
    )
    sql = to_create_sql(t)
    assert "`nested` Array(Tuple(String, Array(UInt32)))" in sql


# ---------- CREATE VIEW ----------


def test_view_simple() -> None:
    v = view(database="default", name="test_view", as_="SELECT 1 AS x")
    sql = to_create_sql(v)
    assert "CREATE VIEW IF NOT EXISTS default.test_view AS" in sql
    assert "SELECT 1 AS x" in sql


def test_view_with_comment_still_valid() -> None:
    v = view(
        database="default",
        name="test_view_comment",
        as_="SELECT 1 AS x",
        comment="A test view",
    )
    sql = to_create_sql(v)
    # Comment is not rendered for plain views (matches TS).
    assert "CREATE VIEW IF NOT EXISTS default.test_view_comment AS" in sql


# ---------- CREATE MATERIALIZED VIEW ----------


def test_materialized_view_to_target() -> None:
    mv = materialized_view(
        database="default",
        name="test_mv",
        to=TableRef(database="default", name="target_table"),
        as_="SELECT id, count() AS cnt FROM default.source GROUP BY id",
    )
    sql = to_create_sql(mv)
    assert "CREATE MATERIALIZED VIEW IF NOT EXISTS default.test_mv" in sql
    assert "TO default.target_table" in sql
    assert "SELECT id, count() AS cnt FROM default.source GROUP BY id" in sql


def test_refreshable_mv_every() -> None:
    mv = materialized_view(
        database="default",
        name="test_rmv",
        to=TableRef(database="default", name="rmv_target"),
        refresh=MaterializedViewRefresh(every="1 HOUR"),
        as_="SELECT id, count() AS cnt FROM default.source GROUP BY id",
    )
    sql = to_create_sql(mv)
    assert "REFRESH EVERY 1 HOUR" in sql
    assert "TO default.rmv_target" in sql


def test_refreshable_mv_append_offset_randomize_settings() -> None:
    mv = materialized_view(
        database="default",
        name="test_rmv_append",
        to=TableRef(database="default", name="rmv_append_target"),
        refresh=MaterializedViewRefresh(
            every="1 DAY",
            offset="2 HOUR",
            randomize="5 MINUTE",
            settings={"refresh_retries": 3},
            append=True,
        ),
        as_="SELECT toDate(created_at) AS day, count() AS c FROM default.events GROUP BY day",
    )
    sql = to_create_sql(mv)
    # Clause order must match TS: REFRESH EVERY → OFFSET → RANDOMIZE FOR → SETTINGS → APPEND
    assert "REFRESH EVERY 1 DAY" in sql
    assert "OFFSET 2 HOUR" in sql
    assert "RANDOMIZE FOR 5 MINUTE" in sql
    assert "SETTINGS refresh_retries = 3" in sql
    assert "APPEND" in sql
    assert sql.index("REFRESH EVERY 1 DAY") < sql.index("OFFSET 2 HOUR")
    assert sql.index("OFFSET 2 HOUR") < sql.index("RANDOMIZE FOR 5 MINUTE")
    assert sql.index("RANDOMIZE FOR 5 MINUTE") < sql.index("SETTINGS refresh_retries")
    assert sql.index("SETTINGS refresh_retries") < sql.index("APPEND")


def test_refreshable_mv_after_only() -> None:
    mv = materialized_view(
        database="default",
        name="test_rmv_after",
        to=TableRef(database="default", name="rmv_after_target"),
        refresh=MaterializedViewRefresh(after="10 MINUTE"),
        as_="SELECT id FROM default.source",
    )
    sql = to_create_sql(mv)
    assert "REFRESH AFTER 10 MINUTE" in sql
    assert "REFRESH EVERY" not in sql


def test_refreshable_mv_depends_on() -> None:
    mv = materialized_view(
        database="default",
        name="test_rmv_deps",
        to=TableRef(database="default", name="rmv_deps_target"),
        refresh=MaterializedViewRefresh(
            every="1 HOUR",
            depends_on=[TableRef(database="default", name="upstream_mv")],
        ),
        as_="SELECT id FROM default.source",
    )
    sql = to_create_sql(mv)
    assert "DEPENDS ON default.upstream_mv" in sql


def test_refreshable_mv_empty_clause() -> None:
    mv = materialized_view(
        database="default",
        name="test_rmv_empty",
        to=TableRef(database="default", name="rmv_empty_target"),
        refresh=MaterializedViewRefresh(every="1 HOUR", empty=True),
        as_="SELECT id FROM default.source",
    )
    sql = to_create_sql(mv)
    assert " EMPTY AS" in sql


# ---------- ALTER MODIFY REFRESH ----------


def test_alter_modify_refresh_every() -> None:
    mv = materialized_view(
        database="default",
        name="test_rmv",
        to=TableRef(database="default", name="rmv_target"),
        refresh=MaterializedViewRefresh(every="30 MINUTE"),
        as_="SELECT 1",
    )
    sql = render_alter_modify_refresh(mv)
    assert (
        sql == "ALTER TABLE default.test_rmv MODIFY REFRESH EVERY 30 MINUTE;"
    )


def test_alter_modify_refresh_append_preserved() -> None:
    mv = materialized_view(
        database="default",
        name="test_rmv",
        to=TableRef(database="default", name="rmv_target"),
        refresh=MaterializedViewRefresh(every="30 SECOND", append=True),
        as_="SELECT 1",
    )
    sql = render_alter_modify_refresh(mv)
    assert "MODIFY REFRESH EVERY 30 SECOND APPEND" in sql


def test_alter_modify_refresh_after_with_randomize_and_settings() -> None:
    mv = materialized_view(
        database="default",
        name="test_rmv",
        to=TableRef(database="default", name="rmv_target"),
        refresh=MaterializedViewRefresh(
            after="5 MINUTE",
            randomize="30 SECOND",
            settings={"refresh_retries": 3},
        ),
        as_="SELECT 1",
    )
    sql = render_alter_modify_refresh(mv)
    assert "MODIFY REFRESH AFTER 5 MINUTE" in sql
    assert "RANDOMIZE FOR 30 SECOND" in sql
    assert "SETTINGS refresh_retries = 3" in sql


def test_alter_modify_refresh_raises_when_refresh_missing() -> None:
    mv = materialized_view(
        database="default",
        name="test_mv",
        to=TableRef(database="default", name="target"),
        as_="SELECT 1",
    )
    with pytest.raises(ValueError, match="refresh is not set"):
        render_alter_modify_refresh(mv)


# ---------- ALTER ADD COLUMN ----------


@pytest.mark.parametrize(
    ("col", "expected_clause"),
    [
        (
            ColumnDefinition(name="name", type="String"),
            "`name` String",
        ),
        (
            ColumnDefinition(name="email", type="String", nullable=True),
            "`email` Nullable(String)",
        ),
        (
            ColumnDefinition(name="score", type="Float64", default=0),
            "`score` Float64 DEFAULT 0",
        ),
        (
            ColumnDefinition(name="ts", type="DateTime", default="fn:now()"),
            "`ts` DateTime DEFAULT now()",
        ),
        (
            ColumnDefinition(name="notes", type="String", comment="User notes"),
            "`notes` String COMMENT 'User notes'",
        ),
        (
            ColumnDefinition(name="tags", type="Array(String)"),
            "`tags` Array(String)",
        ),
    ],
)
def test_alter_add_column_variants(
    col: ColumnDefinition, expected_clause: str
) -> None:
    t = _base_table()
    sql = render_alter_add_column(t, col)
    assert f"ALTER TABLE default.test_table ADD COLUMN IF NOT EXISTS {expected_clause}" in sql


# ---------- ALTER MODIFY COLUMN ----------


def test_alter_modify_column_with_codec() -> None:
    t = _base_table()
    sql = render_alter_modify_column(
        t,
        _col({"name": "value", "type": "String", "codec": {"kind": "ZSTD", "level": 6}}),
    )
    assert "MODIFY COLUMN `value` String CODEC(ZSTD(6))" in sql


def test_alter_modify_column_remove_codec() -> None:
    t = _base_table()
    sql = render_alter_remove_codec(t, "payload")
    assert sql == "ALTER TABLE default.test_table MODIFY COLUMN `payload` REMOVE CODEC;"


# ---------- ALTER DROP COLUMN / INDEX / PROJECTION ----------


def test_alter_drop_column() -> None:
    t = _base_table()
    sql = render_alter_drop_column(t, "x")
    assert sql == "ALTER TABLE default.test_table DROP COLUMN IF EXISTS `x`;"


def test_alter_add_index() -> None:
    t = _base_table()
    sql = render_alter_add_index(
        t,
        SkipIndexMinmax(name="idx_ts", expression="ts", granularity=4),
    )
    assert (
        "ADD INDEX IF NOT EXISTS `idx_ts` (ts) TYPE minmax GRANULARITY 4" in sql
    )


def test_alter_drop_index() -> None:
    t = _base_table()
    sql = render_alter_drop_index(t, "ix1")
    assert sql == "ALTER TABLE default.test_table DROP INDEX IF EXISTS `ix1`;"


def test_alter_add_projection() -> None:
    t = _base_table()
    sql = render_alter_add_projection(
        t,
        {"name": "p1", "query": "SELECT id ORDER BY id"},
    )
    assert (
        "ADD PROJECTION IF NOT EXISTS `p1` (SELECT id ORDER BY id)" in sql
    )


def test_alter_drop_projection() -> None:
    t = _base_table()
    sql = render_alter_drop_projection(t, "p1")
    assert sql == "ALTER TABLE default.test_table DROP PROJECTION IF EXISTS `p1`;"


# ---------- ALTER MODIFY / RESET SETTING + MODIFY TTL ----------


def test_alter_modify_setting_renders_value_verbatim() -> None:
    t = _base_table()
    sql = render_alter_modify_setting(t, "index_granularity", 4096)
    assert sql == (
        "ALTER TABLE default.test_table MODIFY SETTING index_granularity = 4096;"
    )


def test_alter_reset_setting() -> None:
    t = _base_table()
    sql = render_alter_reset_setting(t, "index_granularity")
    assert sql == "ALTER TABLE default.test_table RESET SETTING index_granularity;"


def test_alter_modify_ttl_with_value() -> None:
    t = _base_table()
    sql = render_alter_modify_ttl(t, "ts + INTERVAL 30 DAY")
    assert sql == "ALTER TABLE default.test_table MODIFY TTL ts + INTERVAL 30 DAY;"


def test_alter_modify_ttl_none_emits_remove() -> None:
    t = _base_table()
    sql = render_alter_modify_ttl(t, None)
    assert sql == "ALTER TABLE default.test_table REMOVE TTL;"
