"""Tests for ``chkit.clickhouse.canonicalize`` (port of ``canonicalize.test.ts``)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from chkit.clickhouse.canonicalize import canonicalize_sql_fragments
from chkit.clickhouse.client import QueryResult


@dataclass
class _FakeClient:
    """Records the SQL it was asked to run and replays a canned arrayMap result."""

    reply: list[str | None]
    sqls: list[str] = field(default_factory=list[str])

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> QueryResult:
        self.sqls.append(sql)
        return QueryResult(column_names=["formatted"], rows=[{"formatted": self.reply}])


def test_strips_select_wrapper_and_maps_each_fragment() -> None:
    client = _FakeClient(["SELECT cityHash64(a, b)", "SELECT (n * 2) + 1"])

    result = canonicalize_sql_fragments(client, ["cityHash64(a,b)", "n*2+1"], wrap=True)

    assert result["cityHash64(a,b)"] == "cityHash64(a, b)"
    assert result["n*2+1"] == "(n * 2) + 1"
    assert "formatQuerySingleLineOrNull('SELECT ' || fragment)" in client.sqls[0]


def test_does_not_wrap_when_formatting_full_queries() -> None:
    client = _FakeClient(["SELECT a, count() GROUP BY a"])

    result = canonicalize_sql_fragments(client, ["SELECT a,count() GROUP BY a"], wrap=False)

    assert result["SELECT a,count() GROUP BY a"] == "SELECT a, count() GROUP BY a"
    assert "formatQuerySingleLineOrNull(fragment)" in client.sqls[0]


def test_omits_fragments_clickhouse_could_not_format() -> None:
    client = _FakeClient(["SELECT cityHash64(a, b)", None])

    result = canonicalize_sql_fragments(client, ["cityHash64(a,b)", "((bad"], wrap=True)

    assert result["cityHash64(a,b)"] == "cityHash64(a, b)"
    assert "((bad" not in result


def test_escapes_quotes_and_backslashes_and_drops_blank_input() -> None:
    client = _FakeClient(["SELECT concat(a, 'x,y')"])

    result = canonicalize_sql_fragments(client, ["concat(a,'x,y')", "", "   "], wrap=True)

    # Single-quote doubled, blanks dropped — a valid single-element array literal.
    assert "['concat(a,''x,y'')']" in client.sqls[0]
    assert result["concat(a,'x,y')"] == "concat(a, 'x,y')"


def test_escapes_backslashes() -> None:
    client = _FakeClient(["SELECT 'a\\\\b'"])

    canonicalize_sql_fragments(client, ["'a\\b'"], wrap=True)

    assert "['''a\\\\b''']" in client.sqls[0]


def test_returns_empty_map_without_querying_when_nothing_to_format() -> None:
    client = _FakeClient([])

    result = canonicalize_sql_fragments(client, ["", "  "], wrap=True)

    assert result == {}
    assert client.sqls == []


@dataclass
class _EchoClient:
    sqls: list[str] = field(default_factory=list[str])

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> QueryResult:
        self.sqls.append(sql)
        literal_count = len(re.findall("'", sql)) // 2
        return QueryResult(
            column_names=["formatted"], rows=[{"formatted": ["SELECT ok"] * literal_count}]
        )


def test_splits_large_input_into_bounded_queries_and_merges_results() -> None:
    # Guards against overflowing ClickHouse's max_query_size (256 KiB) on a
    # large schema, which would throw and drop the run to string comparison.
    client = _EchoClient()
    fragments = [f"expr_{i}_{'x' * 30}" for i in range(8000)]

    result = canonicalize_sql_fragments(client, fragments, wrap=True)

    assert len(client.sqls) > 1
    assert all(len(sql) < 200_000 for sql in client.sqls)
    assert len(result) == len(fragments)
    assert result[fragments[0]] == "ok"
    assert result[fragments[-1]] == "ok"
