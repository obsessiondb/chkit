"""Tests for `chkit.clickhouse.ddl_propagation`.

Uses a fake client that returns scripted responses on each ``query()`` call
and a monkey-patched ``time.sleep`` so the retry loop runs at zero cost.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from chkit.clickhouse import ddl_propagation
from chkit.clickhouse.ddl_propagation import (
    MAX_ATTEMPTS,
    wait_for_column,
    wait_for_ddl_propagation,
    wait_for_table,
    wait_for_table_absent,
    wait_for_view,
)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(ddl_propagation.time, "sleep", lambda _: None)
    return


class _FakeResult:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows


class _ScriptedClient:
    """Returns a sequence of canned results, one per query() call."""

    def __init__(self, responses: list[list[dict[str, Any]]]) -> None:
        self._responses = list(responses)
        self.queries: list[str] = []

    def query(self, sql: str) -> _FakeResult:
        self.queries.append(sql)
        if not self._responses:
            return _FakeResult([])
        return _FakeResult(self._responses.pop(0))


# ---------- wait_for_table ----------


def test_wait_for_table_returns_when_present() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_table(client, "db", "t")
    assert "db" in client.queries[0]
    assert "t" in client.queries[0]


def test_wait_for_table_retries_until_visible() -> None:
    # First two attempts return empty (not yet visible), third succeeds.
    client = _ScriptedClient([[], [], [{"x": 1}]])
    wait_for_table(client, "db", "t")
    assert len(client.queries) == 3


def test_wait_for_table_raises_after_max_attempts() -> None:
    client = _ScriptedClient([[] for _ in range(MAX_ATTEMPTS + 1)])
    with pytest.raises(RuntimeError, match="not yet visible"):
        wait_for_table(client, "db", "ghost")


def test_wait_for_table_escapes_single_quotes() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_table(client, "db'name", "t'name")
    assert "db''name" in client.queries[0]
    assert "t''name" in client.queries[0]


# ---------- wait_for_view ----------


def test_wait_for_view_requires_view_engine_filter() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_view(client, "db", "v")
    assert "engine LIKE '%View%'" in client.queries[0]


def test_wait_for_view_raises_when_never_visible() -> None:
    client = _ScriptedClient([[] for _ in range(MAX_ATTEMPTS + 1)])
    with pytest.raises(RuntimeError, match="not yet visible"):
        wait_for_view(client, "db", "v")


# ---------- wait_for_column ----------


def test_wait_for_column_uses_system_columns_query() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_column(client, "db", "t", "c")
    assert "system.columns" in client.queries[0]
    assert "name = 'c'" in client.queries[0]


# ---------- wait_for_table_absent ----------


def test_wait_for_table_absent_returns_when_already_gone() -> None:
    client = _ScriptedClient([[]])
    wait_for_table_absent(client, "db", "t")
    assert len(client.queries) == 1


def test_wait_for_table_absent_retries_until_gone() -> None:
    client = _ScriptedClient([[{"x": 1}], [{"x": 1}], []])
    wait_for_table_absent(client, "db", "t")
    assert len(client.queries) == 3


def test_wait_for_table_absent_raises_when_still_present() -> None:
    client = _ScriptedClient([[{"x": 1}] for _ in range(MAX_ATTEMPTS + 1)])
    with pytest.raises(RuntimeError, match="still present"):
        wait_for_table_absent(client, "db", "t")


# ---------- wait_for_ddl_propagation dispatcher ----------


def test_dispatch_create_table_calls_wait_for_table() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(client, "create_table", "table:db.events")
    assert "system.tables" in client.queries[0]
    assert "name = 'events'" in client.queries[0]


def test_dispatch_create_view_calls_wait_for_view() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(client, "create_view", "table:db.v")
    assert "engine LIKE '%View%'" in client.queries[0]


def test_dispatch_create_materialized_view_calls_wait_for_view() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(
        client, "create_materialized_view", "table:db.mv"
    )
    assert "engine LIKE '%View%'" in client.queries[0]


def test_dispatch_alter_add_column_calls_wait_for_column() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(
        client, "alter_table_add_column", "table:db.t:column:newcol"
    )
    assert "system.columns" in client.queries[0]
    assert "name = 'newcol'" in client.queries[0]


def test_dispatch_alter_add_column_without_column_segment_skips() -> None:
    client = _ScriptedClient([])
    wait_for_ddl_propagation(client, "alter_table_add_column", "table:db.t")
    assert client.queries == []


def test_dispatch_drop_table_calls_wait_for_table_absent() -> None:
    client = _ScriptedClient([[]])
    wait_for_ddl_propagation(client, "drop_table", "table:db.t")
    assert "system.tables" in client.queries[0]


def test_dispatch_unknown_operation_falls_back_to_wait_for_table() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(
        client, "alter_table_modify_setting", "table:db.t"
    )
    assert "system.tables" in client.queries[0]


def test_dispatch_database_level_op_returns_immediately() -> None:
    client = _ScriptedClient([])
    wait_for_ddl_propagation(client, "create_database", "database:foo")
    assert client.queries == []


def test_dispatch_malformed_key_returns_immediately() -> None:
    client = _ScriptedClient([])
    wait_for_ddl_propagation(client, "create_table", "weird-key")
    assert client.queries == []
