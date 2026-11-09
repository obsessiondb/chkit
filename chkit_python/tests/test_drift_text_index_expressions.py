"""Text index expressions as ClickHouse stores them.

Port of the ``@chkit/cli drift: text index expressions as ClickHouse stores
them`` suite in ``packages/cli/src/test/drift.test.ts``. The real formatter runs
over ``test/fixtures/text-index-expressions.json`` in ``test_text_index_e2e.py``.
"""

from __future__ import annotations

from chkit.cli.commands.drift_compare import (
    MapSqlCanonicalizer,
    collect_table_sql_fragments,
    compare_table_shape,
)
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.model import ColumnDefinition, SkipIndexText, TableDefinition, table

# Stand-in for ClickHouse's formatter on the fragments under test.
_CANONICALIZER = MapSqlCanonicalizer(
    expressions={
        "if(NOT a AND b, s, '')": "if((NOT a) AND b, s, '')",
        "if((NOT a) AND b, s, '')": "if((NOT a) AND b, s, '')",
    },
    queries={},
)

_COLUMNS = [
    ColumnDefinition(name="id", type="UInt64"),
    ColumnDefinition(name="s", type="String"),
    ColumnDefinition(name="a", type="UInt8"),
    ColumnDefinition(name="b", type="UInt8"),
]


def _text_index(expression: str, tokenizer: str = "splitByNonAlpha") -> SkipIndexText:
    return SkipIndexText(name="idx", expression=expression, tokenizer=tokenizer)


def _expected(expression: str, tokenizer: str = "splitByNonAlpha") -> TableDefinition:
    return table(
        database="app",
        name="docs",
        engine="MergeTree()",
        columns=[*_COLUMNS],
        primary_key=["id"],
        order_by=["id"],
        indexes=[_text_index(expression, tokenizer)],
    )


def _actual(expression: str) -> IntrospectedTable:
    # What ClickHouse stores: ObsessionDB keeps the outer parentheses (#512).
    return IntrospectedTable(
        database="app",
        name="docs",
        engine="MergeTree()",
        primary_key="(id)",
        order_by="(id)",
        columns=[*_COLUMNS],
        settings={},
        indexes=[_text_index(expression).model_copy(update={"granularity": 100000000})],
        projections=[],
    )


def test_text_index_expression_reaches_the_canonicalizer_outer_parentheses_peeled() -> None:
    expressions = collect_table_sql_fragments(
        _expected("if(NOT a AND b, s, '')"), _actual("(if((NOT a) AND b, s, ''))")
    ).expressions
    assert "if(NOT a AND b, s, '')" in expressions
    assert "if((NOT a) AND b, s, '')" in expressions


def test_spaces_inside_a_string_literal_reach_the_canonicalizer_intact() -> None:
    expressions = collect_table_sql_fragments(
        _expected("concat(s,  '  ')"), _actual("concat(s, '  ')")
    ).expressions
    assert "concat(s, '  ')" in expressions


def test_not_a_and_b_reads_clean_against_the_parentheses_clickhouse_adds() -> None:
    live = _actual("(if((NOT a) AND b, s, ''))")
    detail = compare_table_shape(_expected("if(NOT a AND b, s, '')"), live)
    assert detail is not None
    assert detail.index_diffs == ["idx"]
    assert compare_table_shape(_expected("if(NOT a AND b, s, '')"), live, _CANONICALIZER) is None


def test_different_tokenizer_still_drifts_when_expressions_canonicalize_equal() -> None:
    detail = compare_table_shape(
        _expected("if(NOT a AND b, s, '')", "splitByString([' '])"),
        _actual("if((NOT a) AND b, s, '')"),
        _CANONICALIZER,
    )
    assert detail is not None
    assert detail.index_diffs == ["idx"]
