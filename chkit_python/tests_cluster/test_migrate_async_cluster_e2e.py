"""Async migrate against the 2-shard x 2-replica cluster (#246).

Port of the async case in ``packages/cli/test/cluster-2shard.e2e.test.ts``. An
async statement runs on the node that received it; a re-run whose requests
reach another node must still see the attempt and attach to it, instead of
running the statement's before-retry SQL and resubmitting.

Opt-in like the TS cluster tests (outside ``testpaths``). Start the cluster
with ``bun run cluster:2shard:up``, then run::

    .venv/bin/python -m pytest tests_cluster

Hard-fails (never skips) when the cluster is unreachable.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any, TypeVar

from chkit.cli.commands.migrate_async_apply import (
    AsyncApplyInput,
    apply_async_statement,
    make_deterministic_query_id,
)
from chkit.cli.journal_store import MigrationRowState, OperationState
from chkit.clickhouse.client import ClickHouseClient, QueryResult, QueryStatus
from chkit.core.model import ChxResolvedClickHouseConfig

T = TypeVar("T")

_NODES = os.environ.get(
    "CHKIT_CLUSTER_2S_NODES",
    "http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136",
).split(",")
_CLUSTER = os.environ.get("CHKIT_CLUSTER_2S", "test_cluster_2s")
_USER = os.environ.get("CLICKHOUSE_USER", "default")
_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "clusterpass")
_DATABASE = os.environ.get("CLICKHOUSE_DB", "default")
_MIGRATION_CHECKSUM = "c1"
# Rows the attempt inserts.
_ATTEMPT_ROWS = 20


def test_rerun_through_another_replica_attaches_to_running_attempt() -> None:
    # _NODES[0] and _NODES[1] are the two replicas of shard 1.
    submitter = _connect(_NODES[0], cluster=None)
    other_replica = _connect(_NODES[1], cluster=_CLUSTER)
    name = f"py_twoshard_async_{int(time.time())}_{uuid.uuid4().hex[:6]}_dst"
    table = f"{_DATABASE}.`{name}`"
    migration_name = f"20990101000000_{name}.sql"
    query_id = make_deterministic_query_id(migration_name, 0)
    operation_key = f"table:{_DATABASE}.{name}"
    attempt_outcome: list[str] = []

    def run_attempt() -> None:
        # The attempt a run that lost its connection left behind: about 6 s.
        # Its own client, since a client runs one query at a time.
        with _connect(_NODES[0], cluster=None) as lost_run:
            lost_run.submit(
                f"INSERT INTO {table} SELECT number + sleepEachRow(0.3) "
                f"FROM numbers({_ATTEMPT_ROWS}) SETTINGS max_block_size = 1",
                query_id=query_id,
            )
        attempt_outcome.append("finished")

    worker = threading.Thread(target=run_attempt)
    try:
        submitter.execute(
            f"CREATE TABLE {table} ON CLUSTER '{_CLUSTER}' (n UInt64) "
            "ENGINE = ReplicatedMergeTree ORDER BY n"
        )
        tables_sql = (
            f"SELECT count() FROM system.tables WHERE database = '{_DATABASE}' "
            f"AND name = '{name}'"
        )
        for url in _NODES:
            with _connect(url, cluster=None) as node:
                _poll_until(lambda node=node: _count(node, tables_sql), lambda n: n == 1)
        worker.start()
        processes_sql = f"SELECT count() FROM system.processes WHERE query_id = '{query_id}'"
        _poll_until(lambda: _count(submitter, processes_sql), lambda n: n == 1, interval=0.1)
        # The other replica's own system.processes does not show the attempt.
        assert _count(other_replica, processes_sql) == 0

        recording = _RecordingClient(other_replica)
        started = OperationState.model_validate(
            {
                "operationIndex": 0,
                "operationKey": operation_key,
                "operationType": "load_table_data",
                "queryId": query_id,
                "status": "started",
                "startedAt": "2026-10-02 00:00:00.000",
                "finishedAt": None,
                "lastError": "",
            }
        )
        journal = _MemoryJournal(
            MigrationRowState.model_validate(
                {
                    "name": migration_name,
                    "appliedAt": "1970-01-01 00:00:00.000",
                    "checksum": _MIGRATION_CHECKSUM,
                    "chkitVersion": "",
                    "migrationCompleted": False,
                    "operations": [started],
                }
            )
        )
        lines: list[str] = []
        result = apply_async_statement(
            AsyncApplyInput(
                client=recording,  # type: ignore[arg-type]
                journal_store=journal,  # type: ignore[arg-type]
                # Never submitted: chkit attaches to the running attempt.
                sql="SELECT 1",
                migration_name=migration_name,
                migration_checksum=_MIGRATION_CHECKSUM,
                statement_index=0,
                operation_type="load_table_data",
                operation_key=operation_key,
                before_retry=f"TRUNCATE TABLE {table} ON CLUSTER '{_CLUSTER}'",
                log=lines.append,
                poll_interval_seconds=0.25,
            )
        )

        assert result.kind == "completed"
        assert any("attaching to in-flight query" in line for line in lines)
        assert recording.executed == []
        assert recording.submitted == []
        assert journal.statuses() == ["completed"]
        worker.join(timeout=60)
        assert attempt_outcome == ["finished"]
        assert _count(submitter, f"SELECT count() FROM {table}") == _ATTEMPT_ROWS
    finally:
        if worker.is_alive():
            worker.join(timeout=60)
        submitter.execute(f"DROP TABLE IF EXISTS {table} ON CLUSTER '{_CLUSTER}' SYNC")
        submitter.close()
        other_replica.close()


class _RecordingClient:
    """Delegates to a native client and records before-retry SQL and submissions."""

    def __init__(self, inner: ClickHouseClient) -> None:
        self._inner = inner
        self.executed: list[str] = []
        self.submitted: list[str] = []

    def query(self, statement: str) -> QueryResult:
        return self._inner.query(statement)

    def execute(self, statement: str) -> None:
        self.executed.append(statement)
        self._inner.execute(statement)

    def submit(self, statement: str, query_id: str | None = None) -> str:
        self.submitted.append(statement)
        return self._inner.submit(statement, query_id=query_id)

    def query_status(
        self, query_id: str, *, after_time: str | None = None, every_replica: bool = False
    ) -> QueryStatus:
        return self._inner.query_status(
            query_id, after_time=after_time, every_replica=every_replica
        )


class _MemoryJournal:
    def __init__(self, initial: MigrationRowState | None) -> None:
        self.state = initial
        self.writes: list[MigrationRowState] = []

    def read_migration_state(self, _name: str) -> MigrationRowState | None:
        return self.state

    def write_migration_state(self, state: MigrationRowState) -> None:
        self.writes.append(state)
        self.state = state

    def statuses(self) -> list[str]:
        return [w.operations[0].status for w in self.writes]


def _connect(url: str, *, cluster: str | None) -> ClickHouseClient:
    return ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=url,
            username=_USER,
            password=_PASSWORD,
            database=_DATABASE,
            secure=False,
            cluster=cluster,
        )
    )


def _count(client: ClickHouseClient, sql: str) -> int:
    return int(client.query(sql).rows[0]["count()"])


def _poll_until(
    read: Callable[[], T],
    done: Callable[[T], bool],
    *,
    timeout: float = 30.0,
    interval: float = 0.5,
) -> T:
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        last = read()
        if done(last):
            return last  # type: ignore[no-any-return]
        time.sleep(interval)
    msg = f"condition not met within {timeout}s (last value: {last!r})"
    raise AssertionError(msg)
