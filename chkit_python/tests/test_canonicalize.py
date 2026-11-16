"""Tests for ``chkit.clickhouse.canonicalize`` (port of ``canonicalize.test.ts``)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from chkit.clickhouse.canonicalize import (
    FunctionRegistry,
    build_function_registry,
    canonicalize_sql_fragments,
    normalize_function_names,
)
from chkit.clickhouse.client import QueryResult

# A small system.functions stand-in: the case-insensitive entries the drift
# tests exercise, plus camelCase natives that must keep their written case.
TEST_REGISTRY_ROWS: list[dict[str, Any]] = [
    {"name": "floor", "case_insensitive": 1, "alias_to": ""},
    {"name": "ceil", "case_insensitive": 1, "alias_to": ""},
    {"name": "ceiling", "case_insensitive": 1, "alias_to": "ceil"},
    {"name": "lower", "case_insensitive": 1, "alias_to": ""},
    {"name": "lcase", "case_insensitive": 1, "alias_to": "lower"},
    {"name": "count", "case_insensitive": 1, "alias_to": ""},
    {"name": "substring", "case_insensitive": 1, "alias_to": ""},
    {"name": "cityHash64", "case_insensitive": 0, "alias_to": ""},
    {"name": "toUnixTimestamp", "case_insensitive": 0, "alias_to": ""},
    {"name": "concat", "case_insensitive": 0, "alias_to": ""},
]

TEST_REGISTRY: FunctionRegistry = build_function_registry(TEST_REGISTRY_ROWS)


@dataclass
class _FakeClient:
    """Records the SQL it was asked to run, answers the system.functions read
    from ``registry_rows`` (or raises for it when they are None), and replays a
    canned arrayMap result for the formatting query."""

    reply: list[str | None]
    sqls: list[str] = field(default_factory=list[str])
    registry_rows: list[dict[str, Any]] | None = field(
        default_factory=lambda: list(TEST_REGISTRY_ROWS)
    )

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> QueryResult:
        self.sqls.append(sql)
        if "system.functions" in sql:
            if self.registry_rows is None:
                raise RuntimeError("system.functions unreadable")
            return QueryResult(
                column_names=["name", "case_insensitive", "alias_to"], rows=self.registry_rows
            )
        return QueryResult(column_names=["formatted"], rows=[{"formatted": self.reply}])


def test_strips_select_wrapper_and_maps_each_fragment() -> None:
    client = _FakeClient(["SELECT cityHash64(a, b)", "SELECT (n * 2) + 1"])

    result = canonicalize_sql_fragments(client, ["cityHash64(a,b)", "n*2+1"], wrap=True)

    assert result["cityHash64(a,b)"] == "cityHash64(a, b)"
    assert result["n*2+1"] == "(n * 2) + 1"
    assert "formatQuerySingleLineOrNull('SELECT ' || fragment)" in client.sqls[-1]


def test_does_not_wrap_when_formatting_full_queries() -> None:
    client = _FakeClient(["SELECT a, count() GROUP BY a"])

    result = canonicalize_sql_fragments(client, ["SELECT a,count() GROUP BY a"], wrap=False)

    assert result["SELECT a,count() GROUP BY a"] == "SELECT a, count() GROUP BY a"
    assert "formatQuerySingleLineOrNull(fragment)" in client.sqls[-1]


def test_omits_fragments_clickhouse_could_not_format() -> None:
    client = _FakeClient(["SELECT cityHash64(a, b)", None])

    result = canonicalize_sql_fragments(client, ["cityHash64(a,b)", "((bad"], wrap=True)

    assert result["cityHash64(a,b)"] == "cityHash64(a, b)"
    assert "((bad" not in result


def test_escapes_quotes_and_backslashes_and_drops_blank_input() -> None:
    client = _FakeClient(["SELECT concat(a, 'x,y')"])

    result = canonicalize_sql_fragments(client, ["concat(a,'x,y')", "", "   "], wrap=True)

    # Single-quote doubled, blanks dropped — a valid single-element array literal.
    assert "['concat(a,''x,y'')']" in client.sqls[-1]
    assert result["concat(a,'x,y')"] == "concat(a, 'x,y')"


def test_escapes_backslashes() -> None:
    client = _FakeClient(["SELECT 'a\\\\b'"])

    canonicalize_sql_fragments(client, ["'a\\b'"], wrap=True)

    assert "['''a\\\\b''']" in client.sqls[-1]


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
        if "system.functions" in sql:
            return QueryResult(column_names=["name", "case_insensitive", "alias_to"], rows=[])
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


def test_resolves_case_insensitive_names_and_aliases_like_the_server() -> None:
    """The formatter echoes the written names while the stored query carries
    ClickHouse's canonical names; after registry normalization both agree (#729)."""
    written_query = (
        "SELECT FLOOR(toUnixTimestamp(ts) / 300) AS bucket, CEILING(x), LCASE(s) "
        "FROM drift_repro.events"
    )
    stored_query = (
        "SELECT floor(toUnixTimestamp(ts) / 300) AS bucket, ceil(x), lower(s) "
        "FROM drift_repro.events"
    )
    written = _FakeClient([written_query])
    stored = _FakeClient([stored_query])

    written_map = canonicalize_sql_fragments(written, [written_query], wrap=False)
    stored_map = canonicalize_sql_fragments(stored, [stored_query], wrap=False)

    assert written_map[written_query] == stored_map[stored_query]
    # Registered camelCase names keep their readable case in drift output.
    assert "toUnixTimestamp" in written_map[written_query]


def test_keeps_case_sensitive_function_names_distinct() -> None:
    """User-defined functions are case-sensitive: lowercasing them would hide
    a real change between rv731_f and RV731_F."""
    a = _FakeClient(["SELECT rv731_f(x)"])
    b = _FakeClient(["SELECT RV731_F(x)"])

    map_a = canonicalize_sql_fragments(a, ["SELECT rv731_f(x)"], wrap=False)
    map_b = canonicalize_sql_fragments(b, ["SELECT RV731_F(x)"], wrap=False)

    assert map_a["SELECT rv731_f(x)"] == "SELECT rv731_f(x)"
    assert map_b["SELECT RV731_F(x)"] == "SELECT RV731_F(x)"
    assert map_a["SELECT rv731_f(x)"] != map_b["SELECT RV731_F(x)"]


def test_still_formats_when_system_functions_cannot_be_read() -> None:
    client = _FakeClient(["SELECT FLOOR(x)"], registry_rows=None)

    result = canonicalize_sql_fragments(client, ["SELECT FLOOR(x)"], wrap=False)

    # No registry, no name normalization — names stay exactly as formatted.
    assert result["SELECT FLOOR(x)"] == "SELECT FLOOR(x)"


def test_reports_when_system_functions_cannot_be_read() -> None:
    client = _FakeClient(["SELECT FLOOR(x)"], registry_rows=None)
    seen: list[Exception] = []

    canonicalize_sql_fragments(
        client,
        ["SELECT FLOOR(x)"],
        wrap=False,
        on_registry_unavailable=seen.append,
    )

    assert len(seen) == 1
    assert isinstance(seen[0], Exception)


def test_normalize_function_names_leaves_literals_and_aliases_alone() -> None:
    assert (
        normalize_function_names(
            "SELECT FLOOR(x) AS FLOOR, 'LOWER(' -- UPPER(\nFROM `MAX(`", TEST_REGISTRY
        )
        == "SELECT floor(x) AS FLOOR, 'LOWER(' -- UPPER(\nFROM `MAX(`"
    )
    assert normalize_function_names("count ()", TEST_REGISTRY) == "count ()"
    assert normalize_function_names("LCASE(s)", TEST_REGISTRY) == "lower(s)"
    assert normalize_function_names("toUnixTimestamp(ts)", TEST_REGISTRY) == "toUnixTimestamp(ts)"


def test_normalize_function_names_leaves_dot_qualified_names_alone() -> None:
    # `analytics.FLOOR` names a parameterized view, not the built-in FLOOR:
    # rewriting it to `analytics.floor` would merge two different views.
    assert normalize_function_names("analytics.FLOOR(x = 1)", TEST_REGISTRY) == (
        "analytics.FLOOR(x = 1)"
    )
    assert normalize_function_names("analytics.floor(x = 1)", TEST_REGISTRY) == (
        "analytics.floor(x = 1)"
    )
    assert normalize_function_names("SELECT analytics.CEILING(x), FLOOR(y)", TEST_REGISTRY) == (
        "SELECT analytics.CEILING(x), floor(y)"
    )
