"""Drift comparer tests from TS ``drift.test.ts`` for #232 (SQL comments) and #234
(``SQLExpression`` defaults)."""

from __future__ import annotations

from typing import Any

import pytest

from chkit.cli.commands.drift_compare import TableDriftDetail, compare_table_shape
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.model import (
    ColumnDefinition,
    ProjectionDefinition,
    SkipIndexBloomFilter,
    TableDefinition,
    table,
)


def expected_table(name: str, columns: list[dict[str, Any]], **overrides: Any) -> TableDefinition:
    return table(**{
        "database": "app",
        "name": name,
        "engine": "MergeTree()",
        "columns": columns,
        "primary_key": [columns[0]["name"]],
        "order_by": [columns[0]["name"]],
        **overrides,
    })


def live(columns: list[dict[str, Any]], **overrides: Any) -> IntrospectedTable:
    return IntrospectedTable(**{
        "database": "app",
        "name": "t",
        "columns": [ColumnDefinition.model_validate(c) for c in columns],
        "settings": {},
        "indexes": [],
        "projections": [],
        "engine": "MergeTree",
        "primary_key": None,
        "order_by": "id",
        **overrides,
    })


def compare(expected: TableDefinition, actual: IntrospectedTable) -> TableDriftDetail | None:
    return compare_table_shape(expected, actual)


# ---------- #232 ----------


def test_literal_defaults_with_comment_markers_are_not_drift() -> None:
    expected = expected_table("notes", [
        {"name": "id", "type": "UInt64"},
        {"name": "note", "type": "String", "default": "a -- b"},
        {"name": "tag", "type": "String", "default": "# x"},
        {"name": "link", "type": "String", "default": "http://x"},
    ])
    assert compare(expected, live([
        {"name": "id", "type": "UInt64"},
        {"name": "note", "type": "String", "default": "'a -- b'"},
        {"name": "tag", "type": "String", "default": "'# x'"},
        {"name": "link", "type": "String", "default": "'http://x'"},
    ])) is None


def test_ignores_comments_in_defaults_ttl_partition_index_and_projection_sql() -> None:
    expected = expected_table(
        "events",
        [
            {"name": "id", "type": "UInt64"},
            {"name": "name", "type": "String"},
            {"name": "ts", "type": "DateTime", "default": "fn:now() /* server time */"},
        ],
        partition_by="toYYYYMM(ts) -- monthly",
        ttl="ts + toIntervalDay(30) // retention",
        indexes=[{"name": "idx_name", "expression": "lower(name) -- case-insensitive",
                  "type": "bloom_filter", "granularity": 1}],
        projections=[{"name": "p_recent", "query": "SELECT id, ts # newest first\nORDER BY ts"}],
    )
    assert compare(expected, live(
        [
            {"name": "id", "type": "UInt64"},
            {"name": "name", "type": "String"},
            {"name": "ts", "type": "DateTime", "default": "now()"},
        ],
        partition_by="toYYYYMM(ts)",
        ttl="ts + toIntervalDay(30)",
        indexes=[SkipIndexBloomFilter(name="idx_name", expression="lower(name)",
                                      type="bloom_filter", granularity=1)],
        projections=[ProjectionDefinition(name="p_recent", query="SELECT id, ts ORDER BY ts")],
    )) is None


@pytest.mark.parametrize("column", ["user--id", "# visits", "a//b"])
def test_compares_key_column_with_comment_marker_as_a_name(column: str) -> None:
    # chkit backticks key columns in the DDL, so `--`, `#` or `//` in a key
    # column's name is part of the name. ClickHouse reports the key backticked.
    expected = expected_table("visits", [{"name": column, "type": "UInt64"}], unique_key=[column])
    assert compare(expected, live(
        [{"name": column, "type": "UInt64"}], order_by=f"`{column}`", unique_key=f"`{column}`"
    )) is None


def test_compares_key_columns_after_one_whose_name_holds_a_comment_marker() -> None:
    columns = [
        {"name": "user--id", "type": "UInt64"},
        {"name": "ts", "type": "DateTime"},
        {"name": "received_at", "type": "DateTime"},
    ]
    expected = expected_table("visits", columns, order_by=["user--id", "ts"])

    def diff(order_by: str) -> TableDriftDetail | None:
        return compare(expected, live(columns, primary_key="`user--id`", order_by=order_by))

    assert diff("(`user--id`, ts)") is None
    detail = diff("(`user--id`, `received_at`)")
    assert detail is not None
    assert detail.reason_codes == ["order_by_mismatch"]


def test_compares_parenthesized_partition_past_quoted_name_holding_dashes() -> None:
    columns = [{"name": "user--id", "type": "UInt64"}, {"name": "ts", "type": "DateTime"}]
    expected = expected_table("visits", columns, partition_by="(toYYYYMM(ts), `user--id` % 4)")

    def diff(partition_by: str) -> TableDriftDetail | None:
        return compare(expected, live(columns, order_by="`user--id`", partition_by=partition_by))

    assert diff("(toYYYYMM(ts), `user--id` % 4)") is None
    detail = diff("(toYYYYMM(ts), `user--id` % 8)")
    assert detail is not None
    assert detail.reason_codes == ["partition_by_mismatch"]


# ---------- #234 ----------


def test_compares_sql_expression_and_fn_defaults_with_introspected_expression() -> None:
    # Snapshot columns hold the fn: string; a raw SQLExpression must compare
    # the same way.
    expected = expected_table("events", [
        {"name": "id", "type": "UInt64"},
        {"name": "updated_at", "type": "DateTime64(3)", "default": {"expression": "now64(3)"}},
        {"name": "created_at", "type": "DateTime64(3)", "default": "fn:now64(3)"},
        {"name": "seen_at", "type": "DateTime",
         "default": {"expression": "now() -- set on insert"}},
        {"name": "note", "type": "String", "default": "a -- b"},
    ])
    assert compare(expected, live([
        {"name": "id", "type": "UInt64"},
        {"name": "updated_at", "type": "DateTime64(3)", "default": "now64(3)"},
        {"name": "created_at", "type": "DateTime64(3)", "default": "now64(3)"},
        {"name": "seen_at", "type": "DateTime", "default": "now()"},
        {"name": "note", "type": "String", "default": "'a -- b'"},
    ])) is None


def test_reports_changed_column_when_sql_expression_differs_from_live() -> None:
    expected = expected_table("events", [
        {"name": "id", "type": "UInt64"},
        {"name": "updated_at", "type": "DateTime64(3)", "default": {"expression": "now64(3)"}},
    ])
    detail = compare(expected, live([
        {"name": "id", "type": "UInt64"},
        {"name": "updated_at", "type": "DateTime64(3)", "default": "now()"},
    ]))
    assert detail is not None
    assert detail.reason_codes == ["changed_column"]
    assert detail.changed_columns == ["updated_at"]


def test_compares_expression_defaults_token_by_token_with_stored_formatting() -> None:
    expected = expected_table("events", [
        {"name": "id", "type": "UInt64"},
        {"name": "label", "type": "String",
         "default": {"expression": "concat('id-',\n  toString(id))"}},
        {"name": "kind", "type": "String",
         "default": {"expression": "multiIf(\n  id = 1, 'first',\n  'other')"}},
        {"name": "next_id", "type": "UInt64", "default": {"expression": "id+1"}},
        {"name": "upper_now", "type": "DateTime", "default": {"expression": "NOW()"}},
        {"name": "id_text", "type": "String", "default": {"expression": "id::String"}},
        {"name": "later", "type": "DateTime", "default": {"expression": "now() + INTERVAL 1 DAY"}},
        {"name": "day", "type": "Date", "default_kind": "MATERIALIZED",
         "default": {"expression": "toDate(upper_now)"}},
    ])
    # system.columns.default_expression for these defaults on ClickHouse 26.3.
    detail = compare(expected, live([
        {"name": "id", "type": "UInt64"},
        {"name": "label", "type": "String", "default": "concat('id-', toString(id))"},
        {"name": "kind", "type": "String", "default": "multiIf(id = 1, 'first', 'other')"},
        {"name": "next_id", "type": "UInt64", "default": "id + 1"},
        {"name": "upper_now", "type": "DateTime", "default": "now()"},
        {"name": "id_text", "type": "String", "default": "CAST(id, 'String')"},
        {"name": "later", "type": "DateTime", "default": "now() + toIntervalDay(1)"},
        {"name": "day", "type": "Date", "default_kind": "MATERIALIZED", "default": "toDate(upper_now)"},
    ]))
    # Whitespace and line breaks match; ClickHouse's canonical spellings do not.
    assert detail is not None
    assert detail.changed_columns == ["id_text", "later", "upper_now"]


def test_ignores_every_kind_of_comment_in_an_expression_default() -> None:
    expected = expected_table("events", [
        {"name": "id", "type": "UInt64"},
        {"name": "hash", "type": "DateTime",
         "default": {"expression": "now() # it's the insert time"}},
        {"name": "bang", "type": "DateTime", "default": "fn:now() #! server clock"},
        {"name": "slashes", "type": "Date", "default": {"expression": "today() // server date"}},
        {"name": "nested", "type": "DateTime", "default": "fn:now() /* a /* nested */ comment */"},
    ])
    assert compare(expected, live([
        {"name": "id", "type": "UInt64"},
        {"name": "hash", "type": "DateTime", "default": "now()"},
        {"name": "bang", "type": "DateTime", "default": "now()"},
        {"name": "slashes", "type": "Date", "default": "today()"},
        {"name": "nested", "type": "DateTime", "default": "now()"},
    ])) is None
