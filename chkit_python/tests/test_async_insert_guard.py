"""Port of ``packages/clickhouse/src/async-insert-guard.test.ts``."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from chkit.clickhouse.async_insert_guard import (
    assert_no_fire_and_forget_async_inserts,
    fire_and_forget_inserts_sql,
)

EVENTS = [("app", "events")]


@dataclass
class _Rows:
    rows: list[dict[str, Any]]


@dataclass
class _QueryLogClient:
    """``rows`` is what the query_log read returns; ``replicas`` what the fan-out probe counts."""

    rows: list[dict[str, Any]] | Exception
    replicas: int = 1
    queries: list[str] = field(default_factory=list[str])

    def query(self, sql: str) -> _Rows:
        self.queries.append(sql)
        if "system.one" in sql:
            return _Rows([{"replicas": self.replicas}])
        if isinstance(self.rows, Exception):
            raise self.rows
        return _Rows(self.rows)


def test_passes_when_no_fire_and_forget_insert_reached_the_tables() -> None:
    client = _QueryLogClient([])
    assert_no_fire_and_forget_async_inserts(client, EVENTS)
    assert "FROM system.query_log WHERE" in client.queries[-1]


def test_passes_on_rows_without_inserts() -> None:
    assert_no_fire_and_forget_async_inserts(
        _QueryLogClient([{"table": "app.events", "inserts": "0"}]), EVENTS
    )


def test_refuses_naming_the_tables_and_counts() -> None:
    client = _QueryLogClient(
        [{"table": "app.events", "inserts": "12"}, {"table": "app.other", "inserts": 1}]
    )
    with pytest.raises(RuntimeError) as info:
        assert_no_fire_and_forget_async_inserts(client, EVENTS)
    assert str(info.value) == (
        "Fire-and-forget async inserts (async_insert = 1, wait_for_async_insert = 0) ran in the "
        "last 10 minutes: 12 into app.events, 1 into app.other. ClickHouse drops the buffered "
        "rows of such an insert when its table is exchanged or renamed (TABLE_UUID_MISMATCH at "
        "flush), and the writer is never told. Switch these writers to wait_for_async_insert = 1 "
        "(an insert in flight at the swap then fails with a retryable error) or pause them, wait "
        "10 minutes, and run chkit migrate --apply again."
    )


def test_reads_query_log_on_every_replica() -> None:
    client = _QueryLogClient([], replicas=2)
    assert_no_fire_and_forget_async_inserts(client, EVENTS)
    assert "FROM clusterAllReplicas('default', system.query_log) WHERE" in client.queries[-1]


def test_probes_the_configured_cluster() -> None:
    client = _QueryLogClient([], replicas=2)
    assert_no_fire_and_forget_async_inserts(client, EVENTS, cluster="c2")
    assert "FROM clusterAllReplicas('c2', system.query_log) WHERE" in client.queries[-1]


def test_warns_and_goes_on_when_query_log_cannot_be_read() -> None:
    lines: list[str] = []
    client = _QueryLogClient(RuntimeError("Not enough privileges\nstack trace"))
    assert_no_fire_and_forget_async_inserts(
        client, [("app", "events"), ("app", "events__cutover_1")], log=lines.append
    )
    assert lines == [
        "  warning: could not read system.query_log to check for fire-and-forget async inserts "
        "into app.events, app.events__cutover_1 (Not enough privileges). Make sure no writer "
        "uses async_insert = 1 with wait_for_async_insert = 0 on these tables."
    ]


def test_sql_counts_only_async_queue_inserts_with_the_effective_wait_setting() -> None:
    sql = fire_and_forget_inserts_sql("system.query_log", ["app.events", "app.events__cutover_1"])
    assert sql == (
        "SELECT arrayJoin(arrayIntersect(tables, ['app.events', 'app.events__cutover_1'])) AS "
        "table, count() AS inserts FROM system.query_log "
        "WHERE event_date >= yesterday() AND event_time >= now() - INTERVAL 10 MINUTE "
        "AND type = 'QueryFinish' AND query_kind = 'Insert' "
        "AND ProfileEvents['AsyncInsertQuery'] > 0 "
        "AND hasAny(tables, ['app.events', 'app.events__cutover_1']) "
        "AND if(mapContains(Settings, 'wait_for_async_insert'), Settings['wait_for_async_insert'], "
        "(SELECT default FROM system.settings WHERE name = 'wait_for_async_insert')) "
        "IN ('0', 'false') "
        "GROUP BY table ORDER BY table"
    )
