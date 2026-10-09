"""Drift SQL canonicalization (#195).

Port of the ``@chkit/cli drift SQL canonicalization (#195)`` suite in
``packages/cli/src/test/drift.test.ts``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from chkit.cli.commands.drift_compare import (
    collect_table_sql_fragments,
    compare_table_shape,
)
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.model import (
    ColumnDefinition,
    ProjectionDefinition,
    SkipIndexMinmax,
    TableDefinition,
    table,
)


def _fake_clickhouse_format(fragment: str) -> str:
    # Stand-in for ClickHouse's formatter: collapse whitespace and space after
    # commas, so `cityHash64(a,b)` and `cityHash64(a, b)` share a canonical form.
    return re.sub(r"\s*,\s*", ", ", re.sub(r"\s+", " ", fragment)).strip()


@dataclass(frozen=True)
class _FakeCanonicalizer:
    def expression(self, fragment: str) -> str | None:
        return _fake_clickhouse_format(fragment)

    def query(self, fragment: str) -> str | None:
        return _fake_clickhouse_format(fragment)


@dataclass(frozen=True)
class _CommentAwareCanonicalizer:
    # Like ClickHouse, an unquoted `user--a` parses as `user` plus a comment, so
    # two different names would canonicalize to the same thing.
    def expression(self, fragment: str) -> str | None:
        return fragment if fragment.startswith("`") else re.sub(r"--.*$", "", fragment).strip()

    def query(self, fragment: str) -> str | None:
        return fragment


_AB: list[ColumnDefinition] = [
    ColumnDefinition(name="a", type="String"),
    ColumnDefinition(name="b", type="String"),
]


def _with_skip_index(expression: str) -> TableDefinition:
    return table(
        database="app",
        name="events",
        engine="MergeTree()",
        columns=[*_AB],
        primary_key=["a"],
        order_by=["a"],
        indexes=[SkipIndexMinmax(name="i", expression=expression, granularity=1)],
    )


def _actual_with_index(expression: str) -> IntrospectedTable:
    return IntrospectedTable(
        database="app",
        name="events",
        engine="MergeTree()",
        primary_key="(a)",
        order_by="(a)",
        columns=[*_AB],
        settings={},
        indexes=[SkipIndexMinmax(name="i", expression=expression, granularity=1)],
        projections=[],
    )


def test_skip_index_expression_differing_only_in_comma_spacing_reads_clean() -> None:
    expected = _with_skip_index("cityHash64(a,b)")
    # What ClickHouse actually stores for `cityHash64(a,b)`.
    actual = _actual_with_index("cityHash64(a, b)")

    # Without the canonicalizer the spacing reads as drift...
    detail = compare_table_shape(expected, actual)
    assert detail is not None
    assert "index_mismatch" in detail.reason_codes
    # ...with it, the two are recognized as equal.
    assert compare_table_shape(expected, actual, _FakeCanonicalizer()) is None


def test_genuinely_different_index_expression_still_drifts_under_canonicalization() -> None:
    expected = _with_skip_index("cityHash64(a,b)")
    actual = _actual_with_index("sipHash64(a, b)")

    detail = compare_table_shape(expected, actual, _FakeCanonicalizer())
    assert detail is not None
    assert "index_mismatch" in detail.reason_codes


def test_collect_gathers_index_ttl_clause_elements_and_projection_queries() -> None:
    columns = [*_AB, ColumnDefinition(name="ts", type="DateTime")]
    expected = table(
        database="app",
        name="events",
        engine="MergeTree()",
        columns=[*columns],
        primary_key=["a"],
        order_by=["a", "b"],
        partition_by="toYYYYMM(ts)",
        ttl="ts + toIntervalDay(30)",
        indexes=[SkipIndexMinmax(name="i", expression="cityHash64(a,b)", granularity=1)],
        projections=[
            ProjectionDefinition(name="p_sel", query="SELECT a, count() GROUP BY a"),
            ProjectionDefinition(name="p_idx", index="b", type="basic"),
        ],
    )
    actual = IntrospectedTable(
        database="app",
        name="events",
        engine="MergeTree()",
        primary_key=None,
        order_by="(a, b)",
        columns=columns,
        settings={},
        indexes=[SkipIndexMinmax(name="i", expression="cityHash64(a, b)", granularity=1)],
        partition_by="toYYYYMM(ts)",
        ttl="ts + toIntervalDay(30)",
        projections=[
            ProjectionDefinition(name="p_sel", query="SELECT a, count() GROUP BY a"),
            ProjectionDefinition(name="p_idx", index="b", type="basic"),
        ],
    )

    fragments = collect_table_sql_fragments(expected, actual)
    # Index expressions and clause elements are collected as expressions...
    for fragment in ("cityHash64(a,b)", "cityHash64(a, b)", "toYYYYMM(ts)", "a", "b"):
        assert fragment in fragments.expressions
    # ...SELECT projections as queries, and the index-only projection is not.
    assert "SELECT a, count() GROUP BY a" in fragments.queries
    assert "b" not in fragments.queries


def test_key_columns_reach_the_canonicalizer_still_quoted() -> None:
    columns = [
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="user--a", type="String"),
        ColumnDefinition(name="user--b", type="String"),
    ]
    expected = table(
        database="app",
        name="events",
        engine="MergeTree()",
        columns=[*columns],
        primary_key=["id"],
        order_by=["id", "user--a"],
    )

    def actual(order_by: str) -> IntrospectedTable:
        return IntrospectedTable(
            database="app",
            name="events",
            engine="MergeTree",
            primary_key="(id)",
            order_by=order_by,
            columns=columns,
            settings={},
            indexes=[],
            projections=[],
        )

    assert "`user--a`" in collect_table_sql_fragments(expected, actual("(id, `user--a`)")).expressions
    assert compare_table_shape(expected, actual("(id, `user--a`)"), _CommentAwareCanonicalizer()) is None
    detail = compare_table_shape(expected, actual("(id, `user--b`)"), _CommentAwareCanonicalizer())
    assert detail is not None
    assert detail.reason_codes == ["order_by_mismatch"]
