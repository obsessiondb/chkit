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
    SQLExpression,
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


# Column default expressions as ClickHouse stores them (#752). Port of the
# matching suite in drift.test.ts; the real formatter runs in
# test_drift_canonicalize_e2e.py.
_FORMATTED_DEFAULTS = {
    "id*2+1": "(id * 2) + 1",
    "(id * 2) + 1": "(id * 2) + 1",
    "ts + INTERVAL 1 DAY": "ts + toIntervalDay(1)",
    "ts + toIntervalDay(1)": "ts + toIntervalDay(1)",
}


@dataclass(frozen=True)
class _MapCanonicalizer:
    formatted: dict[str, str]

    def expression(self, fragment: str) -> str | None:
        return self.formatted.get(fragment)

    def query(self, fragment: str) -> str | None:
        return None


@dataclass(frozen=True)
class _SameCanonicalizer:
    def expression(self, fragment: str) -> str | None:
        return "same"

    def query(self, fragment: str) -> str | None:
        return None


_ID_TS: list[ColumnDefinition] = [
    ColumnDefinition(name="id", type="UInt64"),
    ColumnDefinition(name="ts", type="DateTime"),
]


def _compare_column(
    declared: ColumnDefinition,
    stored: ColumnDefinition,
    canonicalizer: _MapCanonicalizer | _SameCanonicalizer | None = None,
) -> list[str] | None:
    detail = compare_table_shape(
        table(
            database="app",
            name="events",
            engine="MergeTree()",
            columns=[*_ID_TS, declared],
            primary_key=["id"],
            order_by=["id"],
        ),
        IntrospectedTable(
            database="app",
            name="events",
            engine="MergeTree()",
            primary_key="(id)",
            order_by="(id)",
            columns=[*_ID_TS, stored],
            settings={},
            indexes=[],
            projections=[],
        ),
        canonicalizer,
    )
    return None if detail is None else detail.changed_columns


def test_column_expressions_read_clean_against_how_clickhouse_stores_them() -> None:
    canonicalizer = _MapCanonicalizer(_FORMATTED_DEFAULTS)
    pairs = [
        (
            ColumnDefinition(name="v", type="UInt64", default="fn: id*2+1 "),
            ColumnDefinition(name="v", type="UInt64", default="(id * 2) + 1"),
        ),
        (
            ColumnDefinition(
                name="v",
                type="DateTime",
                default_kind="MATERIALIZED",
                default=SQLExpression(expression="ts + INTERVAL 1 DAY"),
            ),
            ColumnDefinition(
                name="v", type="DateTime", default_kind="MATERIALIZED", default="ts + toIntervalDay(1)"
            ),
        ),
        (
            ColumnDefinition(name="v", type="UInt64", default_kind="ALIAS", default="fn:id*2+1"),
            ColumnDefinition(name="v", type="UInt64", default_kind="ALIAS", default="(id * 2) + 1"),
        ),
    ]
    for declared, stored in pairs:
        assert _compare_column(declared, stored) == ["v"]
        assert _compare_column(declared, stored, canonicalizer) is None


def test_different_column_expression_drifts_and_unformattable_one_compares_as_before() -> None:
    canonicalizer = _MapCanonicalizer(_FORMATTED_DEFAULTS)
    declared = ColumnDefinition(name="v", type="UInt64", default="fn:id*2+1")
    assert _compare_column(declared, declared.model_copy(update={"default": "id + 1"}), canonicalizer) == ["v"]
    spaced = ColumnDefinition(name="v", type="UInt64", default="fn:cityHash64(id,id)")
    stored = spaced.model_copy(update={"default": "cityHash64(id, id)"})
    assert _compare_column(spaced, stored, canonicalizer) is None
    other = spaced.model_copy(update={"default": "cityHash64(id, ts)"})
    assert _compare_column(spaced, other, canonicalizer) == ["v"]


def test_literal_and_synthetic_ephemeral_defaults_keep_their_own_comparison() -> None:
    anything = _SameCanonicalizer()
    literal = ColumnDefinition(name="v", type="UInt64", default=1)
    assert _compare_column(literal, literal.model_copy(update={"default": "2"}), anything) == ["v"]
    assert (
        _compare_column(
            literal.model_copy(update={"default": 2.0}),
            literal.model_copy(update={"default": "2."}),
            anything,
        )
        is None
    )
    ephemeral = ColumnDefinition(name="v", type="Int64", default_kind="EPHEMERAL")
    synthetic = ephemeral.model_copy(update={"default": "fn:defaultValueOfTypeName('Int64')"})
    assert _compare_column(synthetic, ephemeral, anything) is None


def test_collect_gathers_column_expressions_from_both_sides_not_literals() -> None:
    expected = table(
        database="app",
        name="events",
        engine="MergeTree()",
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="a", type="UInt64", default="fn: id*2+1 "),
            ColumnDefinition(name="b", type="String", default="x"),
            ColumnDefinition(
                name="c",
                type="Int64",
                default_kind="EPHEMERAL",
                default="fn:defaultValueOfTypeName('Int64')",
            ),
        ],
        primary_key=["id"],
        order_by=["id"],
    )
    actual = IntrospectedTable(
        database="app",
        name="events",
        engine="MergeTree()",
        primary_key="(id)",
        order_by="(id)",
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="a", type="UInt64", default="(id * 2) + 1"),
            ColumnDefinition(name="b", type="String", default="'x'"),
            ColumnDefinition(name="c", type="Int64", default_kind="EPHEMERAL"),
        ],
        settings={},
        indexes=[],
        projections=[],
    )
    expressions = collect_table_sql_fragments(expected, actual).expressions
    assert "id*2+1" in expressions
    assert "(id * 2) + 1" in expressions
    assert "'x'" not in expressions
    assert "defaultValueOfTypeName('Int64')" not in expressions
