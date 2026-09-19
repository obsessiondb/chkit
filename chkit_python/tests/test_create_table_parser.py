"""Tests for `chkit.clickhouse.create_table_parser`.

Test cases mirror the kind of `system.tables.create_table_query`
strings ClickHouse actually returns for a variety of engines and
clauses.
"""

from __future__ import annotations

from chkit.clickhouse.create_table_parser import (
    ProjectionDefinitionShape,
    parse_engine_from_create_table_query,
    parse_order_by_from_create_table_query,
    parse_partition_by_from_create_table_query,
    parse_primary_key_from_create_table_query,
    parse_projections_from_create_table_query,
    parse_settings_from_create_table_query,
    parse_ttl_from_create_table_query,
    parse_unique_key_from_create_table_query,
)

SIMPLE_DDL = (
    "CREATE TABLE default.events\n"
    "(\n"
    "  `id` UInt64,\n"
    "  `ts` DateTime\n"
    ")\n"
    "ENGINE = MergeTree\n"
    "PRIMARY KEY (id)\n"
    "ORDER BY (id, ts)\n"
    "PARTITION BY toYYYYMM(ts)\n"
    "TTL ts + INTERVAL 7 DAY\n"
    "SETTINGS index_granularity = 8192, allow_nullable_key = 1"
)

REPLICATED_DDL = (
    "CREATE TABLE shared.events\n"
    "(`id` UInt64)\n"
    "ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events', '{replica}')\n"
    "ORDER BY id\n"
    "SETTINGS index_granularity = 8192"
)

WITH_PROJECTIONS_DDL = (
    "CREATE TABLE default.events\n"
    "(\n"
    "  `id` UInt64,\n"
    "  `country` String,\n"
    "  PROJECTION by_country (SELECT * ORDER BY country),\n"
    "  PROJECTION `daily_count` (SELECT count() GROUP BY toDate(ts))\n"
    ")\n"
    "ENGINE = MergeTree\n"
    "ORDER BY id"
)

WITH_UNIQUE_KEY_DDL = (
    "CREATE TABLE default.events\n"
    "(`id` UInt64)\n"
    "ENGINE = SharedReplacingMergeTree\n"
    "UNIQUE KEY (id)\n"
    "ORDER BY id"
)


# ---------- parse_settings_from_create_table_query ----------


def test_settings_basic() -> None:
    out = parse_settings_from_create_table_query(SIMPLE_DDL)
    assert out == {"index_granularity": "8192", "allow_nullable_key": "1"}


def test_settings_returns_empty_when_absent() -> None:
    assert parse_settings_from_create_table_query("CREATE TABLE t (id UInt64) ENGINE = MergeTree ORDER BY id") == {}


def test_settings_returns_empty_for_none() -> None:
    assert parse_settings_from_create_table_query(None) == {}


def test_settings_handles_quoted_string_value() -> None:
    ddl = "CREATE TABLE t (id UInt64) ENGINE = MergeTree ORDER BY id SETTINGS storage_policy = 's3'"
    out = parse_settings_from_create_table_query(ddl)
    assert out == {"storage_policy": "'s3'"}


def test_settings_handles_function_in_value() -> None:
    ddl = "ENGINE = MergeTree ORDER BY id SETTINGS x = toUInt64(1, 2), y = 3"
    out = parse_settings_from_create_table_query(ddl)
    assert out == {"x": "toUInt64(1, 2)", "y": "3"}


def test_settings_drops_items_without_equals() -> None:
    ddl = "ORDER BY id SETTINGS valid = 1, totally_invalid_no_equals"
    out = parse_settings_from_create_table_query(ddl)
    assert out == {"valid": "1"}


# ---------- parse_ttl_from_create_table_query ----------


def test_ttl_basic() -> None:
    assert parse_ttl_from_create_table_query(SIMPLE_DDL) == "ts + INTERVAL 7 DAY"


def test_ttl_returns_none_when_absent() -> None:
    assert parse_ttl_from_create_table_query(REPLICATED_DDL) is None


def test_ttl_normalises_whitespace() -> None:
    ddl = "ENGINE = MergeTree ORDER BY id TTL    ts   +   INTERVAL    1    DAY SETTINGS x=1"
    assert parse_ttl_from_create_table_query(ddl) == "ts + INTERVAL 1 DAY"


def test_ttl_stops_before_settings() -> None:
    ddl = "ORDER BY id TTL ts SETTINGS index_granularity = 8192"
    assert parse_ttl_from_create_table_query(ddl) == "ts"


# ---------- parse_engine_from_create_table_query ----------


def test_engine_simple() -> None:
    assert parse_engine_from_create_table_query(SIMPLE_DDL) == "MergeTree"


def test_engine_with_args() -> None:
    out = parse_engine_from_create_table_query(REPLICATED_DDL)
    assert out is not None
    assert out.startswith("ReplicatedMergeTree(")


def test_engine_returns_none_when_absent() -> None:
    assert parse_engine_from_create_table_query("CREATE TABLE t (id UInt64) ORDER BY id") is None


# ---------- parse_primary_key_from_create_table_query ----------


def test_primary_key_basic() -> None:
    assert parse_primary_key_from_create_table_query(SIMPLE_DDL) == "(id)"


def test_primary_key_returns_none_when_absent() -> None:
    assert parse_primary_key_from_create_table_query(REPLICATED_DDL) is None


# ---------- parse_order_by_from_create_table_query ----------


def test_order_by_basic() -> None:
    assert parse_order_by_from_create_table_query(SIMPLE_DDL) == "(id, ts)"


def test_order_by_returns_none_when_absent() -> None:
    assert parse_order_by_from_create_table_query("ENGINE = Memory") is None


# ---------- parse_partition_by_from_create_table_query ----------


def test_partition_by_basic() -> None:
    assert parse_partition_by_from_create_table_query(SIMPLE_DDL) == "toYYYYMM(ts)"


def test_partition_by_returns_none_when_absent() -> None:
    assert parse_partition_by_from_create_table_query(REPLICATED_DDL) is None


# ---------- parse_unique_key_from_create_table_query ----------


def test_unique_key_basic() -> None:
    assert parse_unique_key_from_create_table_query(WITH_UNIQUE_KEY_DDL) == "(id)"


def test_unique_key_returns_none_when_absent() -> None:
    assert parse_unique_key_from_create_table_query(SIMPLE_DDL) is None


# ---------- parse_projections_from_create_table_query ----------


def test_projections_extracts_both_quoted_and_bare_names() -> None:
    projections = parse_projections_from_create_table_query(WITH_PROJECTIONS_DDL)
    names = [p.name for p in projections]
    assert "by_country" in names
    assert "daily_count" in names


def test_projection_query_normalises_whitespace() -> None:
    projections = parse_projections_from_create_table_query(WITH_PROJECTIONS_DDL)
    by_country = next(p for p in projections if p.name == "by_country")
    assert by_country.query == "SELECT * ORDER BY country"


def test_projections_returns_empty_when_no_projection_clauses() -> None:
    assert parse_projections_from_create_table_query(SIMPLE_DDL) == []


def test_projections_returns_empty_for_none() -> None:
    assert parse_projections_from_create_table_query(None) == []


def test_projection_with_nested_parens() -> None:
    ddl = (
        "CREATE TABLE default.events\n"
        "(\n"
        "  `id` UInt64,\n"
        "  PROJECTION nested (SELECT count() WHERE id IN (1, 2, 3))\n"
        ")\n"
        "ENGINE = MergeTree\n"
        "ORDER BY id"
    )
    projections = parse_projections_from_create_table_query(ddl)
    assert len(projections) == 1
    assert projections[0].name == "nested"
    assert "WHERE id IN (1, 2, 3)" in projections[0].query


# ---------- Integration: all clauses on one DDL ----------


def test_round_trip_all_clauses() -> None:
    """Verify every parser independently extracts its clause from a full DDL."""
    assert parse_engine_from_create_table_query(SIMPLE_DDL) == "MergeTree"
    assert parse_primary_key_from_create_table_query(SIMPLE_DDL) == "(id)"
    assert parse_order_by_from_create_table_query(SIMPLE_DDL) == "(id, ts)"
    assert parse_partition_by_from_create_table_query(SIMPLE_DDL) == "toYYYYMM(ts)"
    assert parse_ttl_from_create_table_query(SIMPLE_DDL) == "ts + INTERVAL 7 DAY"
    assert parse_settings_from_create_table_query(SIMPLE_DDL) == {
        "index_granularity": "8192",
        "allow_nullable_key": "1",
    }


def test_projection_dataclass_is_frozen() -> None:
    proj = ProjectionDefinitionShape(name="x", query="SELECT 1")
    try:
        proj.name = "y"  # type: ignore[misc]
    except (AttributeError, TypeError):
        return
    raise AssertionError("ProjectionDefinitionShape should be frozen")
