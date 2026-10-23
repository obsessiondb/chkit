"""Async migrate through the real ObsessionDB workbench API (#246).

Port of ``packages/cli/test/workbench-api.e2e.test.ts``. The API runs a query
under its top-level ``queryId`` and on whichever replica it reaches, so this
checks what the stand-in workbench of the default suite cannot: that a
submission keeps chkit's id and that ``query_status`` sees it on every replica.

Opt-in like the cluster suites (outside ``testpaths``). Needs a
``chkit obsessiondb login`` session (``~/.config/chkit/credentials.json``) and
the service slug::

    CHKIT_E2E_OBSESSIONDB_SERVICE=<slug> .venv/bin/python -m pytest tests_workbench_api

Hard-fails (never skips) without them.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, TypeVar

from chkit.cli.commands.migrate_async_apply import (
    AsyncApplyInput,
    apply_async_statement,
    make_deterministic_query_id,
)
from chkit.cli.journal_store import MigrationRowState, OperationState
from chkit.clickhouse.client import QueryResult, QueryStatus
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.types import BackfillChunkState, BackfillProgress
from chkit_plugin_obsessiondb.credentials import load_credentials
from chkit_plugin_obsessiondb.remote_executor import RemoteClickHouseClient

T = TypeVar("T")

# About 20 s: one row per block, 1 s per row.
_SLOW_ROWS = 20
_READS = 6
_MIGRATION_CHECKSUM = "c1"


def test_submission_keeps_its_id_and_reads_running_on_every_replica() -> None:
    remote = _connect()
    query_id = f"chkit-e2e-py-{uuid.uuid4()}"
    bound = _iso(_read_server_now_ms(remote) - 2_000)
    outcome: list[str] = []
    worker = threading.Thread(
        target=_run_into(
            outcome,
            lambda: remote.submit(
                f"SELECT sum(sleepEachRow(1)) FROM numbers({_SLOW_ROWS}) "
                "SETTINGS max_block_size = 1",
                query_id=query_id,
            ),
        )
    )
    worker.start()
    try:
        _poll_until(
            lambda: remote.query_status(query_id, every_replica=True),
            lambda status: status.status == "running",
            timeout=10.0,
            interval=0.25,
        )
        statuses: list[str] = []
        local_reads_that_saw_it = 0
        for _ in range(_READS):
            statuses.append(remote.query_status(query_id, every_replica=True).status)
            # What query_status read before #246: the answering replica only.
            local = remote.query(
                "SELECT toString(count()) AS n FROM system.processes "
                f"WHERE query_id = '{query_id}'"
            )
            if local.rows and local.rows[0].get("n") == "1":
                local_reads_that_saw_it += 1
            time.sleep(0.5)
        print(
            "[workbench-api] single-replica system.processes reads saw the query "
            f"{local_reads_that_saw_it}/{_READS} times"
        )

        assert statuses == ["running"] * _READS
        worker.join(timeout=60)
        assert outcome == ["finished"]
        finished = _poll_until(
            lambda: remote.query_status(query_id, after_time=bound),
            lambda status: status.status == "finished",
            timeout=60.0,
        )
        assert finished.duration_ms is not None
        assert finished.duration_ms >= (_SLOW_ROWS - 1) * 1_000
    finally:
        worker.join(timeout=60)


def test_rerun_attaches_to_attempt_a_lost_run_left_running() -> None:
    remote = _connect()
    database = str(remote.query("SELECT currentDatabase() AS db").rows[0]["db"])
    name = f"chkit_e2e_py_workbench_api_{int(time.time())}_{uuid.uuid4().hex[:6]}_dst"
    table = f"`{database}`.`{name}`"
    operation_key = f"table:{database}.{name}"
    migration_name = f"20990101000000_{name}.sql"
    query_id = make_deterministic_query_id(migration_name, 0)
    outcome: list[str] = []
    # The attempt of a run that lost its connection while the statement ran.
    worker = threading.Thread(
        target=_run_into(
            outcome,
            lambda: remote.submit(
                f"INSERT INTO {table} SELECT number + sleepEachRow(1) "
                f"FROM numbers({_SLOW_ROWS}) SETTINGS max_block_size = 1",
                query_id=query_id,
            ),
        )
    )
    try:
        remote.execute(f"CREATE TABLE {table} (n UInt64) ENGINE = MergeTree ORDER BY n")
        _poll_until(
            lambda: _count(
                remote,
                f"SELECT toString(count()) AS n FROM system.tables "
                f"WHERE database = '{database}' AND name = '{name}'",
            ),
            lambda n: n == 1,
        )
        worker.start()
        _poll_until(
            lambda: remote.query_status(query_id, every_replica=True),
            lambda status: status.status == "running",
            timeout=10.0,
            interval=0.25,
        )

        recording = _RecordingRemote(remote)
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
                before_retry=f"TRUNCATE TABLE {table}",
                log=lines.append,
                poll_interval_seconds=1.0,
            )
        )

        assert result.kind == "completed"
        assert any("attaching to in-flight query" in line for line in lines)
        assert recording.executed == []
        assert recording.submitted == []
        assert journal.statuses() == ["completed"]
        worker.join(timeout=60)
        assert outcome == ["finished"]
        rows = _poll_until(
            lambda: _count(remote, f"SELECT toString(count()) AS n FROM {table}"),
            lambda n: n == _SLOW_ROWS,
        )
        assert rows == _SLOW_ROWS
    finally:
        # A DROP waits for the running INSERT's table lock, so let it end first.
        if worker.is_alive():
            worker.join(timeout=60)
        remote.execute(f"DROP TABLE IF EXISTS {table}")


def test_backfill_resume_finds_chunk_a_lost_run_left_running() -> None:
    # #289: backfill's resume reads every replica through the remote client too
    # (the SDK takes any executor), so a chunk that a lost run left running is
    # polled, not submitted again.
    remote = _connect()
    plan_id = f"py_workbench_bf_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    chunk_id = "c0"
    query_id = f"backfill-{plan_id}-{chunk_id}"
    chunk_sql = (
        f"SELECT sum(sleepEachRow(1)) FROM numbers({_SLOW_ROWS}) SETTINGS max_block_size = 1"
    )
    outcome: list[str] = []
    worker = threading.Thread(
        target=_run_into(outcome, lambda: _connect().submit(chunk_sql, query_id=query_id))
    )
    worker.start()
    try:
        _poll_until(
            lambda: remote.query_status(query_id, every_replica=True),
            lambda status: status.status == "running",
            timeout=10.0,
            interval=0.25,
        )
        recording = _RecordingRemote(remote)
        snapshots: list[BackfillChunkState] = []

        def on_progress(progress: BackfillProgress) -> None:
            state = progress.get(chunk_id)
            if state is not None:
                snapshots.append(state)

        result = execute_backfill(
            executor=recording,
            plan_id=plan_id,
            chunk_ids=[chunk_id],
            build_query=lambda _chunk_id: chunk_sql,
            concurrency=1,
            poll_interval_ms=500,
            resume_from={chunk_id: BackfillChunkState(status="pending")},
            on_progress=on_progress,
        )

        assert snapshots[0].status == "running"
        assert snapshots[0].query_id == query_id
        assert recording.submitted == []
        assert result.progress[chunk_id].status == "done"
        worker.join(timeout=60)
        assert outcome == ["finished"]
    finally:
        if worker.is_alive():
            worker.join(timeout=60)


class _RecordingRemote:
    """Delegates to the remote client and records before-retry SQL and submissions."""

    def __init__(self, inner: RemoteClickHouseClient) -> None:
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


def _connect() -> RemoteClickHouseClient:
    service = os.environ.get("CHKIT_E2E_OBSESSIONDB_SERVICE", "")
    assert service, "set CHKIT_E2E_OBSESSIONDB_SERVICE to the ObsessionDB service slug"
    credentials = load_credentials()
    assert credentials is not None, "run `chkit obsessiondb login` first"
    return RemoteClickHouseClient(credentials=credentials, service_slug=service)


def _run_into(outcome: list[str], run: Callable[[], Any]) -> Callable[[], None]:
    def target() -> None:
        try:
            run()
            outcome.append("finished")
        except Exception as error:
            outcome.append(str(error))

    return target


def _read_server_now_ms(remote: RemoteClickHouseClient) -> int:
    rows = remote.query(
        "SELECT toString(toUnixTimestamp64Milli(now64(3))) AS now_ms"
    ).rows
    return int(rows[0]["now_ms"])


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=UTC).isoformat().replace("+00:00", "Z")


def _count(remote: RemoteClickHouseClient, sql: str) -> int:
    return int(remote.query(sql).rows[0]["n"])


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
