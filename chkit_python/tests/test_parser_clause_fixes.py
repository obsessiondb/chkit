"""Table-clause parsing past the column list + derived PK — port of TS 8296b8a (#198).

Direct ports of the #190/#194 tests in ``packages/clickhouse/src/index.test.ts``
and ``packages/cli/src/test/drift.test.ts``.
"""

from __future__ import annotations

from chkit.cli.commands.drift_compare import compare_table_shape
from chkit.clickhouse.create_table_parser import (
    ProjectionDefinitionShape,
    parse_engine_from_create_table_query,
    parse_order_by_from_create_table_query,
    parse_partition_by_from_create_table_query,
    parse_primary_key_from_create_table_query,
    parse_projections_from_create_table_query,
    parse_settings_from_create_table_query,
    parse_ttl_from_create_table_query,
)
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.model import ColumnDefinition, table


def test_ignores_clause_keywords_inside_a_projection_select_body() -> None:
    query = (
        "CREATE TABLE bi.price_history (`day` Date, `csin` String, "
        "`min_price` UInt32, `_version` UInt64 DEFAULT now64(), "
        "PROJECTION by_csin_day (SELECT csin, day, min_price ORDER BY csin, day)) "
        "ENGINE = ReplicatedReplacingMergeTree("
        "'/clickhouse/tables/{cluster}/bi/price_history_new', '{replica}', _version) "
        "PARTITION BY toYYYYMM(day) ORDER BY (day, csin) "
        "TTL day + toIntervalYear(5) "
        "SETTINGS index_granularity = 8192, "
        "deduplicate_merge_projection_mode = 'rebuild'"
    )

    assert parse_engine_from_create_table_query(query) == (
        "ReplicatedReplacingMergeTree("
        "'/clickhouse/tables/{cluster}/bi/price_history_new', '{replica}', _version)"
    )
    assert parse_order_by_from_create_table_query(query) == "(day, csin)"
    assert parse_primary_key_from_create_table_query(query) is None
    assert parse_partition_by_from_create_table_query(query) == "toYYYYMM(day)"
    assert parse_ttl_from_create_table_query(query) == "day + toIntervalYear(5)"
    assert parse_settings_from_create_table_query(query) == {
        "index_granularity": "8192",
        "deduplicate_merge_projection_mode": "'rebuild'",
    }
    assert parse_projections_from_create_table_query(query) == [
        ProjectionDefinitionShape(
            name="by_csin_day",
            query="SELECT csin, day, min_price ORDER BY csin, day",
        )
    ]


def test_reads_table_level_ttl_past_a_column_level_ttl() -> None:
    query = (
        "CREATE TABLE app.events (`id` UInt64, `ts` DateTime, "
        "`tmp` String TTL ts + toIntervalDay(1)) "
        "ENGINE = MergeTree ORDER BY id TTL ts + toIntervalYear(1) "
        "SETTINGS index_granularity = 8192"
    )

    assert parse_ttl_from_create_table_query(query) == "ts + toIntervalYear(1)"
    assert parse_order_by_from_create_table_query(query) == "id"
    assert parse_settings_from_create_table_query(query) == {
        "index_granularity": "8192"
    }


def _live_table(
    *, primary_key: str | None, order_by: str, columns: list[ColumnDefinition]
) -> IntrospectedTable:
    return IntrospectedTable(
        database="bi",
        name="price_history",
        columns=columns,
        settings={},
        indexes=[],
        projections=[],
        engine="MergeTree()",
        primary_key=primary_key,
        order_by=order_by,
    )


def test_treats_a_primary_key_derived_from_order_by_as_clean() -> None:
    expected = table(
        database="bi",
        name="price_history",
        engine="MergeTree()",
        columns=[
            {"name": "day", "type": "Date"},
            {"name": "csin", "type": "String"},
        ],
        primary_key=["day", "csin"],  # what `chkit pull` writes out (derived)
        order_by=["day", "csin"],
    )

    result = compare_table_shape(
        expected,
        _live_table(
            primary_key=None,  # live table has no PRIMARY KEY clause
            order_by="(day, csin)",
            columns=[
                ColumnDefinition(name="day", type="Date"),
                ColumnDefinition(name="csin", type="String"),
            ],
        ),
    )

    assert result is None


def test_still_reports_primary_key_mismatch_when_keys_genuinely_differ() -> None:
    expected = table(
        database="bi",
        name="price_history",
        engine="MergeTree()",
        columns=[
            {"name": "day", "type": "Date"},
            {"name": "csin", "type": "String"},
        ],
        primary_key=["day"],
        order_by=["day", "csin"],
    )

    result = compare_table_shape(
        expected,
        _live_table(
            primary_key="(csin)",
            order_by="(day, csin)",
            columns=[
                ColumnDefinition(name="day", type="Date"),
                ColumnDefinition(name="csin", type="String"),
            ],
        ),
    )

    assert result is not None
    assert "primary_key_mismatch" in result.reason_codes
