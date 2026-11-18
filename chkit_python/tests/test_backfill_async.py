"""Tests for the async backfill execution loop.

1:1 port of ``packages/plugin-backfill/src/async-backfill.test.ts``.

Covers ``execute_backfill`` (completion, failures, concurrency ordering,
progress callbacks, intermediate metrics, resume, poll-error handling,
replay of failed chunks, unknown outcomes) and ``sync_progress``
(server-side reconciliation via ``system.processes`` / ``system.query_log``).
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from clickhouse_connect.driver.httpclient import HttpClient  # type: ignore[import-untyped]
from urllib3.exceptions import ProtocolError

from chkit.clickhouse.client import (
    SEND_ADMISSION,
    ClickHouseClient,
    QueryStatus,
    SendNotAdmittedError,
    install_send_hook,
)
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.async_backfill import (
    CHECKPOINT_VERSION,
    BackfillInterruptedError,
    BackfillResult,
    execute_backfill,
    sync_progress,
)
from chkit_plugin_backfill.types import BackfillChunkState, BackfillProgress

PLAN_ID = "test-plan"

CHUNK_IDS = ["c1", "c2"]
CHUNK_WINDOWS = {
    "c1": ("2024-01-01", "2024-01-02"),
    "c2": ("2024-01-02", "2024-01-03"),
}

_IDS_IN = re.compile(r"query_id IN \(([^)]*)\)")
_QUOTED = re.compile(r"'([^']*)'")


class _Result:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows


def _ids_in(statement: str) -> list[str] | None:
    exact = _IDS_IN.search(statement)
    return _QUOTED.findall(exact.group(1)) if exact else None


class MockExecutor:
    """A scripted server: each query id walks through its list of statuses. A
    ``running`` status is in system.processes, and a read of it there moves the
    id to its next status; a ``finished`` or ``failed`` one is a
    QueryFinish or ExceptionWhileProcessing row in system.query_log. A key
    ending in ``-*`` scripts every id with that prefix (a replay's random id)."""

    def __init__(self, statuses: dict[str, list[QueryStatus]] | None = None) -> None:
        self._statuses = statuses if statuses is not None else {}
        self._cursors: dict[str, int] = {}
        self._lock = threading.Lock()

    def _script(self, query_id: str) -> list[QueryStatus] | None:
        if query_id in self._statuses:
            return self._statuses[query_id]
        for key, script in self._statuses.items():
            if key.endswith("-*") and query_id.startswith(key[:-1]):
                return script
        return None

    def _current(self, query_id: str) -> QueryStatus:
        script = self._script(query_id) or [QueryStatus(status="unknown")]
        return script[min(self._cursors.get(query_id, 0), len(script) - 1)]

    def submit(self, statement: str, query_id: str | None = None) -> str:
        return query_id if query_id is not None else str(uuid.uuid4())

    transport_admission = True

    def submit_once(self, statement: str, query_id: str) -> str:
        """Sends once, asking the admission as the request enters the
        transport, as ``ClickHouseClient.submit_once`` does."""
        admission = SEND_ADMISSION.get()
        if admission is not None:
            if not admission.admit():
                msg = "The request was not sent: its caller stopped"
                raise SendNotAdmittedError(msg)
            admission.handed_off()
        return self.submit(statement, query_id)

    def query(self, statement: str) -> _Result:
        # Rows in a result, as the client returns them (the replica probe
        # reads ``.rows``).
        return _Result(self._rows(statement))

    def _rows(self, statement: str) -> list[dict[str, object]]:
        # A replay reads the server time for its query_log bound.
        if "now64" in statement:
            return [{"now_ms": str(int(time.time() * 1000))}]
        # One replica, which answers the strict probe.
        if "system.one" in statement:
            return [{"replicas": 1}]
        ids = _ids_in(statement)
        if ids is None:
            ids = [key for key in self._statuses if not key.endswith("-*")]
        with self._lock:
            if "system.processes" in statement:
                rows: list[dict[str, object]] = []
                for i in ids:
                    status = self._current(i)
                    if status.status != "running":
                        continue
                    self._cursors[i] = self._cursors.get(i, 0) + 1
                    rows.append(
                        {
                            "query_id": i,
                            "read_rows": str(status.read_rows or 0),
                            "read_bytes": str(status.read_bytes or 0),
                            "written_rows": str(status.written_rows or 0),
                            "written_bytes": str(status.written_bytes or 0),
                            "elapsed": (status.elapsed_ms or 0) / 1000,
                        }
                    )
                return rows
            if "system.query_log" in statement:
                return [
                    _scripted_log_row(i, status)
                    for i in ids
                    if (status := self._current(i)).status in {"finished", "failed"}
                ]
        return []


def _scripted_log_row(query_id: str, status: QueryStatus) -> dict[str, object]:
    finished = status.status == "finished"
    return {
        "query_id": query_id,
        "type": "QueryFinish" if finished else "ExceptionWhileProcessing",
        "written_rows": str(status.written_rows or 0) if finished else "0",
        "written_bytes": str(status.written_bytes or 0) if finished else "0",
        "query_duration_ms": str(status.duration_ms or 0),
        "exception": "" if finished else (status.error or ""),
    }


class SubmitRecordingExecutor(MockExecutor):
    """Records the order of submitted query IDs (thread-safe)."""

    def __init__(self, statuses: dict[str, list[QueryStatus]]) -> None:
        super().__init__(statuses)
        self.submit_order: list[str] = []
        self._submit_lock = threading.Lock()

    def submit(self, statement: str, query_id: str | None = None) -> str:
        submitted = super().submit(statement, query_id)
        with self._submit_lock:
            self.submit_order.append(submitted)
        return submitted


def test_completes_all_chunks() -> None:
    statuses = {
        f"backfill-{PLAN_ID}-c1": [
            QueryStatus(status="running"),
            QueryStatus(status="finished", written_rows=100, written_bytes=500, duration_ms=200),
        ],
        f"backfill-{PLAN_ID}-c2": [
            QueryStatus(status="finished", written_rows=50, written_bytes=250, duration_ms=100),
        ],
    }

    def build_query(chunk_id: str) -> str:
        window_from, window_to = CHUNK_WINDOWS[chunk_id]
        return f"INSERT INTO t SELECT * FROM s WHERE d >= '{window_from}' AND d < '{window_to}'"

    result = execute_backfill(
        executor=MockExecutor(statuses),
        plan_id=PLAN_ID,
        chunk_ids=CHUNK_IDS,
        build_query=build_query,
        concurrency=2,
        poll_interval_ms=1,
    )

    assert result.total == 2
    assert result.completed == 2
    assert result.failed == 0
    assert result.progress["c1"].status == "done"
    assert result.progress["c2"].status == "done"
    assert result.progress["c1"].written_rows == 100


def test_reports_failed_chunks() -> None:
    statuses = {
        f"backfill-{PLAN_ID}-c1": [
            QueryStatus(status="failed", error="OOM", duration_ms=50),
        ],
        f"backfill-{PLAN_ID}-c2": [
            QueryStatus(status="finished", written_rows=10, written_bytes=40, duration_ms=30),
        ],
    }

    result = execute_backfill(
        executor=MockExecutor(statuses),
        plan_id=PLAN_ID,
        chunk_ids=CHUNK_IDS,
        build_query=lambda _chunk_id: "SELECT 1",
        concurrency=2,
        poll_interval_ms=1,
    )

    assert result.completed == 1
    assert result.failed == 1
    assert result.progress["c1"].status == "failed"
    assert result.progress["c1"].error == "OOM"
    assert result.progress["c2"].status == "done"


def test_respects_concurrency_limit() -> None:
    statuses = {
        f"backfill-{PLAN_ID}-c1": [
            QueryStatus(status="running"),
            QueryStatus(status="finished", written_rows=1, written_bytes=1, duration_ms=1),
        ],
        f"backfill-{PLAN_ID}-c2": [
            QueryStatus(status="finished", written_rows=1, written_bytes=1, duration_ms=1),
        ],
    }

    executor = SubmitRecordingExecutor(statuses)

    result = execute_backfill(
        executor=executor,
        plan_id=PLAN_ID,
        chunk_ids=CHUNK_IDS,
        build_query=lambda _chunk_id: "SELECT 1",
        concurrency=1,
        poll_interval_ms=1,
    )

    assert result.total == 2
    assert result.completed == 2
    assert executor.submit_order[0] == f"backfill-{PLAN_ID}-c1"
    assert executor.submit_order[1] == f"backfill-{PLAN_ID}-c2"


def test_calls_on_progress_on_state_changes() -> None:
    statuses = {
        f"backfill-{PLAN_ID}-c1": [
            QueryStatus(status="finished", written_rows=1, written_bytes=1, duration_ms=1),
        ],
    }

    progress_snapshots: list[BackfillProgress] = []

    execute_backfill(
        executor=MockExecutor(statuses),
        plan_id=PLAN_ID,
        chunk_ids=["c1"],
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        on_progress=lambda p: progress_snapshots.append(dict(p)),
    )

    assert len(progress_snapshots) >= 1
    last_snapshot = progress_snapshots[-1]
    assert last_snapshot["c1"].status == "done"


def test_reports_intermediate_metrics_while_running() -> None:
    statuses = {
        f"backfill-{PLAN_ID}-c1": [
            QueryStatus(
                status="running",
                read_rows=100,
                read_bytes=400,
                written_rows=0,
                written_bytes=0,
                elapsed_ms=1000,
            ),
            QueryStatus(
                status="running",
                read_rows=500,
                read_bytes=2000,
                written_rows=50,
                written_bytes=200,
                elapsed_ms=3000,
            ),
            QueryStatus(status="finished", written_rows=200, written_bytes=800, duration_ms=5000),
        ],
    }

    progress_snapshots: list[BackfillProgress] = []

    execute_backfill(
        executor=MockExecutor(statuses),
        plan_id=PLAN_ID,
        chunk_ids=["c1"],
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        on_progress=lambda p: progress_snapshots.append(dict(p)),
    )

    # Should have at least 3 progress calls: submitted, running (with metrics), done
    assert len(progress_snapshots) >= 3

    # Find the running snapshots with metrics
    running_snapshots = [p for p in progress_snapshots if p["c1"].status == "running"]
    assert len(running_snapshots) == 2
    assert running_snapshots[0]["c1"].read_rows == 100
    assert running_snapshots[0]["c1"].elapsed_ms == 1000
    assert running_snapshots[1]["c1"].read_rows == 500
    assert running_snapshots[1]["c1"].written_rows == 50
    assert running_snapshots[1]["c1"].elapsed_ms == 3000

    # Final snapshot should be done
    last_snapshot = progress_snapshots[-1]
    assert last_snapshot["c1"].status == "done"
    assert last_snapshot["c1"].written_rows == 200


def test_resumes_from_saved_progress() -> None:
    query_id = f"backfill-{PLAN_ID}-c2"
    statuses = {
        query_id: [
            QueryStatus(status="finished", written_rows=50, written_bytes=250, duration_ms=100),
        ],
    }

    resume_from: BackfillProgress = {
        "c1": BackfillChunkState(
            status="done", query_id=f"backfill-{PLAN_ID}-c1", written_rows=100
        ),
        "c2": BackfillChunkState(
            status="submitted", query_id=query_id, submitted_at="2024-01-01T00:00:00Z"
        ),
    }

    result = execute_backfill(
        executor=MockExecutor(statuses),
        plan_id=PLAN_ID,
        chunk_ids=CHUNK_IDS,
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        resume_from=resume_from,
    )

    assert result.completed == 2
    assert result.failed == 0
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].written_rows == 100


def test_handles_transient_poll_errors_gracefully() -> None:
    class TransientErrorExecutor(MockExecutor):
        def __init__(self) -> None:
            super().__init__(
                {
                    f"backfill-{PLAN_ID}-c1": [
                        QueryStatus(
                            status="finished", written_rows=10, written_bytes=40, duration_ms=30
                        )
                    ]
                }
            )
            self.log_reads = 0

        def _rows(self, statement: str) -> list[dict[str, object]]:
            if "system.query_log" in statement:
                with self._lock:
                    self.log_reads += 1
                    count = self.log_reads
                if count <= 2:
                    msg = "ECONNRESET"
                    raise ConnectionError(msg)
            return super()._rows(statement)

    result = execute_backfill(
        executor=TransientErrorExecutor(),
        plan_id=PLAN_ID,
        chunk_ids=["c1"],
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        max_poll_errors=5,
    )

    assert result.completed == 1
    assert result.failed == 0
    assert result.progress["c1"].status == "done"


def _unknown_error(query_id: str, reason: str) -> str:
    return (
        f"Backfill plan {PLAN_ID}: the outcome of the last attempt is unknown for "
        f"chunk c1 (query_id {query_id}): {reason}. A chunk whose outcome is unknown "
        "is not submitted again, as it may have written its rows. Re-run the resume "
        "once system.query_log records the outcome, or pass --accept-unknown to "
        "replay it under a new query id, which can write its rows twice."
    )


# #765: losing contact is no evidence that the chunk failed, and a failed
# chunk is what --replay-failed runs again. No chunk starts after it.
def test_a_polling_outage_stops_the_run_after_the_chunk_in_flight() -> None:
    class AlwaysErrorExecutor(SubmitRecordingExecutor):
        def _rows(self, statement: str) -> list[dict[str, object]]:
            if "system.processes" in statement:
                msg = "ETIMEDOUT"
                raise ConnectionError(msg)
            return []

    executor = AlwaysErrorExecutor({})
    saved: list[BackfillProgress] = []

    with pytest.raises(RuntimeError) as raised:
        execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1", "c2", "c3"],
            build_query=lambda _chunk_id: "SELECT 1",
            concurrency=1,
            poll_interval_ms=1,
            max_poll_errors=3,
            on_progress=saved.append,
        )

    assert str(raised.value) == _unknown_error(
        f"backfill-{PLAN_ID}-c1",
        "lost contact with the server after 3 consecutive poll errors (ETIMEDOUT)",
    )
    assert executor.submit_order == [f"backfill-{PLAN_ID}-c1"]
    assert saved[-1] == {
        "c1": BackfillChunkState(
            status="submitted", query_id=f"backfill-{PLAN_ID}-c1", single_send=True
        ),
        "c2": BackfillChunkState(status="pending"),
        "c3": BackfillChunkState(status="pending"),
    }


def test_replay_failed_replays_a_chunk_the_server_shows_failed_under_a_new_id() -> None:
    query_id = f"backfill-{PLAN_ID}-c1"
    statuses = {
        query_id: [QueryStatus(status="failed", error="OOM", duration_ms=5)],
        f"{query_id}-*": [
            QueryStatus(status="finished", written_rows=42, written_bytes=200, duration_ms=80),
        ],
        f"backfill-{PLAN_ID}-c2": [
            QueryStatus(status="finished", written_rows=10, written_bytes=50, duration_ms=20),
        ],
    }

    resume_from: BackfillProgress = {
        "c1": BackfillChunkState(
            status="failed", query_id=query_id, error="OOM", single_send=True
        ),
        "c2": BackfillChunkState(
            status="done", query_id=f"backfill-{PLAN_ID}-c2", written_rows=10
        ),
    }

    result = execute_backfill(
        executor=MockExecutor(statuses),
        plan_id=PLAN_ID,
        chunk_ids=CHUNK_IDS,
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        resume_from=resume_from,
        checkpoint_version=CHECKPOINT_VERSION,
        replay_failed=True,
    )

    assert result.completed == 2
    assert result.failed == 0
    assert result.progress["c1"].status == "done"
    assert (result.progress["c1"].query_id or "").startswith(f"{query_id}-")
    assert result.progress["c1"].written_rows == 42


def test_a_first_attempt_records_its_query_id_before_its_submit() -> None:
    saved: list[BackfillProgress] = []

    class CheckingExecutor(MockExecutor):
        def submit(self, statement: str, query_id: str | None = None) -> str:
            # A run that stops while the INSERT runs must not leave a chunk
            # that looks never submitted: a resume would submit it again.
            assert saved[-1]["c1"] == BackfillChunkState(
                status="pending", query_id=f"backfill-{PLAN_ID}-c1", single_send=True
            )
            return super().submit(statement, query_id)

    result = execute_backfill(
        executor=CheckingExecutor(
            {
                f"backfill-{PLAN_ID}-c1": [
                    QueryStatus(status="finished", written_rows=1, written_bytes=1, duration_ms=1)
                ]
            }
        ),
        plan_id=PLAN_ID,
        chunk_ids=["c1"],
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        on_progress=saved.append,
    )

    assert result.progress["c1"].status == "done"


SYNC_CHUNK_IDS = ["c1", "c2", "c3"]


def test_sync_discovers_submitted_but_untracked_queries_from_server() -> None:
    class ServerStateExecutor(MockExecutor):
        def _rows(self, statement: str) -> list[dict[str, object]]:
            if "system.processes" in statement:
                return [{"query_id": f"backfill-{PLAN_ID}-c2"}]
            if "system.query_log" in statement:
                return [
                    {
                        "query_id": f"backfill-{PLAN_ID}-c1",
                        "type": "QueryFinish",
                        "written_rows": "500",
                        "written_bytes": "2000",
                        "query_duration_ms": "150",
                        "exception": "",
                    }
                ]
            return []

    progress: BackfillProgress = {
        "c1": BackfillChunkState(status="pending"),
        "c2": BackfillChunkState(status="pending"),
        "c3": BackfillChunkState(status="pending"),
    }

    synced = sync_progress(ServerStateExecutor(), PLAN_ID, SYNC_CHUNK_IDS, progress)

    # c1 was found completed in query_log
    assert synced["c1"].status == "done"
    assert synced["c1"].written_rows == 500
    # c2 was found running in system.processes
    assert synced["c2"].status == "running"
    assert synced["c2"].query_id == f"backfill-{PLAN_ID}-c2"
    # c3 had no server state — stays pending
    assert synced["c3"].status == "pending"


def test_sync_does_not_downgrade_done_chunks() -> None:
    progress: BackfillProgress = {
        "c1": BackfillChunkState(
            status="done", query_id=f"backfill-{PLAN_ID}-c1", written_rows=100
        ),
    }

    synced = sync_progress(MockExecutor(), PLAN_ID, ["c1"], progress)
    assert synced["c1"].status == "done"
    assert synced["c1"].written_rows == 100


def test_sync_updates_failed_server_state_for_locally_submitted_chunk() -> None:
    class FailedServerStateExecutor(MockExecutor):
        def _rows(self, statement: str) -> list[dict[str, object]]:
            if "system.one" in statement:
                return [{"replicas": 1}]
            if "system.processes" in statement:
                return []
            if "system.query_log" in statement:
                return [
                    {
                        "query_id": f"backfill-{PLAN_ID}-c1",
                        "type": "ExceptionWhileProcessing",
                        "written_rows": "0",
                        "written_bytes": "0",
                        "query_duration_ms": "10",
                        "exception": "Memory limit exceeded",
                    }
                ]
            return []

    progress: BackfillProgress = {
        "c1": BackfillChunkState(
            status="submitted",
            query_id=f"backfill-{PLAN_ID}-c1",
            single_send=True,
        ),
    }

    synced = sync_progress(FailedServerStateExecutor(), PLAN_ID, ["c1"], progress)
    assert synced["c1"].status == "failed"
    assert synced["c1"].error == "Memory limit exceeded"


# #289: a chunk query runs on the replica that received it. Resume submits
# every chunk ``sync_progress`` does not find, so it reads each replica.


class ReplicatedServerExecutor(SubmitRecordingExecutor):
    """A multi-replica server: the replica probe of ``cluster`` finds ``replicas``.
    ``running`` is in system.processes for the first ``running_reads`` reads;
    then ``finished`` is a QueryFinish row of each of them."""

    def __init__(
        self,
        *,
        cluster: str = "default",
        replicas: int = 2,
        running: list[str] | None = None,
        running_reads: int = 1_000_000,
        finished: dict[str, int] | None = None,
        fail_on: str | None = None,
    ) -> None:
        super().__init__({})
        self._cluster = cluster
        self._replicas = replicas
        self._running = running or []
        self._running_reads = running_reads
        self._finished = finished or {}
        self._fail_on = fail_on
        self.process_reads = 0
        self.queries: list[str] = []

    def query(self, statement: str) -> _Result:
        self.queries.append(statement)
        if f"clusterAllReplicas('{self._cluster}', system.one)" in statement:
            return _Result([{"replicas": self._replicas}])
        if self._fail_on is not None and self._fail_on in statement:
            msg = "Code: 279. ALL_CONNECTION_TRIES_FAILED"
            raise RuntimeError(msg)
        if f"clusterAllReplicas('{self._cluster}', system.processes)" in statement:
            self.process_reads += 1
            if self.process_reads <= self._running_reads:
                return _Result([{"query_id": query_id} for query_id in self._running])
            return _Result([])
        if (
            f"clusterAllReplicas('{self._cluster}', system.query_log)" in statement
            and self.process_reads > self._running_reads
        ):
            return _Result(
                [
                    _scripted_log_row(
                        query_id, QueryStatus(status="finished", written_rows=rows)
                    )
                    for query_id, rows in self._finished.items()
                ]
            )
        return _Result([])

    def status_reads(self) -> list[str]:
        return [
            sql
            for sql in self.queries
            if "system.processes" in sql or "system.query_log" in sql
        ]


def test_sync_reads_every_replica_without_clickhouse_cluster() -> None:
    executor = ReplicatedServerExecutor(running=[f"backfill-{PLAN_ID}-c1"])

    synced = sync_progress(
        executor, PLAN_ID, ["c1"], {"c1": BackfillChunkState(status="pending")}
    )

    assert synced["c1"].status == "running"
    assert "FROM clusterAllReplicas('default', system.one)" in executor.queries[0]
    processes, query_log = executor.status_reads()
    assert "FROM clusterAllReplicas('default', system.processes)" in processes
    assert "FROM clusterAllReplicas('default', system.query_log)" in query_log
    # A replica that cannot be read fails the read instead of being skipped.
    assert "SETTINGS skip_unavailable_shards = 0" in processes
    assert "SETTINGS skip_unavailable_shards = 0" in query_log


def test_sync_fails_instead_of_reporting_a_chunk_not_running() -> None:
    executor = ReplicatedServerExecutor(fail_on="system.processes")

    with pytest.raises(
        RuntimeError,
        match=(
            rf"Backfill plan {PLAN_ID}: could not check which chunks are still "
            r"running on the server \(Code: 279\. ALL_CONNECTION_TRIES_FAILED\)\. "
            "Nothing was submitted"
        ),
    ):
        sync_progress(executor, PLAN_ID, ["c1"], {"c1": BackfillChunkState(status="pending")})


def test_resume_reads_configured_cluster_and_attaches_to_running_chunk() -> None:
    query_id = f"backfill-{PLAN_ID}-c1"
    # Running at the resume's read, finished by the first poll.
    executor = ReplicatedServerExecutor(
        cluster="analytics",
        replicas=4,
        running=[query_id],
        running_reads=1,
        finished={query_id: 7},
    )

    result = execute_backfill(
        executor=executor,
        cluster="analytics",
        plan_id=PLAN_ID,
        chunk_ids=["c1"],
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=10,
        # A run that crashed between submit and its state write.
        resume_from={"c1": BackfillChunkState(status="pending")},
    )

    assert executor.submit_order == []
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].query_id == query_id
    assert result.progress["c1"].written_rows == 7
    assert not any("clusterAllReplicas('default'" in sql for sql in executor.queries)


def test_resume_submits_nothing_when_a_replica_cannot_be_read() -> None:
    executor = ReplicatedServerExecutor(fail_on="system.query_log")

    with pytest.raises(RuntimeError, match="could not check which chunks are still running"):
        execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1", "c2"],
            build_query=lambda _chunk_id: "SELECT 1",
            poll_interval_ms=10,
            resume_from={
                "c1": BackfillChunkState(status="failed", error="Lost contact"),
                "c2": BackfillChunkState(status="pending"),
            },
            replay_failed=True,
        )
    assert executor.submit_order == []


# A ClickHouse stand-in with the timing that matters for a replay (#765). An
# attempt the run submits is in system.processes for ``running_reads`` reads of
# system.processes, then logged once ``unflushed_log_reads`` more query_log
# reads have passed: the flush gap. An attempt that ended before the run
# starts is logged after ``hidden_log_reads`` query_log reads (infinity:
# never, as with log_queries = 0 or a log that has not flushed). Earlier
# attempts' rows stay visible throughout. The time probe answers
# ``clock_offset_ms`` from the client's clock; the replica that runs a
# submitted attempt stamps it ``submit_clock_offset_ms`` from it. A query_log
# read pruned by event_date hides the rows of attempts that started before
# that day.
DAY_MS = 24 * 60 * 60_000
_PRUNING = re.compile(r"event_date >= toDate32\(parseDateTimeBestEffort\('([^']*)'\)\) - 1")


@dataclass
class _SimAttempt:
    query_id: str
    outcome: str  # finished | failed | partial (failed after writing rows) | started
    start_ms: float | None = None
    running_reads: int = 0
    status_reads: int = 0
    logged_at_log_read: float = 0


class SimulatedServer(MockExecutor):
    def __init__(
        self,
        *,
        attempts: list[_SimAttempt] | None = None,
        next_outcomes: list[str] | None = None,
        clock_offset_ms: float = 0,
        submit_clock_offset_ms: float | None = None,
        unflushed_log_reads: int = 1,
        deny_probe: str | None = None,
    ) -> None:
        super().__init__()
        self.offset = clock_offset_ms
        self.submit_offset = (
            submit_clock_offset_ms if submit_clock_offset_ms is not None else clock_offset_ms
        )
        self.unflushed_log_reads = unflushed_log_reads
        self.deny_probe = deny_probe
        self.attempts = list(attempts or [])
        for attempt in self.attempts:
            if attempt.start_ms is None:
                attempt.start_ms = self.server_now()
        self.next_outcomes = list(next_outcomes or [])
        self.submits: list[str] = []
        self.persisted: list[BackfillProgress] = []
        self.log_queries: list[str] = []
        self.log_reads = 0

    def server_now(self) -> float:
        return time.time() * 1000 + self.offset

    def _running(self, attempt: _SimAttempt) -> bool:
        return attempt.status_reads < attempt.running_reads

    def _logged(self) -> list[_SimAttempt]:
        # Latest first, as the reader orders by event_time DESC.
        return [
            attempt
            for attempt in reversed(self.attempts)
            if not self._running(attempt) and self.log_reads > attempt.logged_at_log_read
        ]

    def submit(self, statement: str, query_id: str | None = None) -> str:
        submitted = query_id if query_id is not None else str(uuid.uuid4())
        with self._lock:
            self.submits.append(submitted)
            # The attempt's id is durable before its submit.
            saved = self.persisted[-1].get("c1") if self.persisted else None
            if saved is None or saved.status != "pending" or saved.query_id != submitted:
                msg = f"submitted {submitted} before the checkpoint recorded it ({saved})"
                raise AssertionError(msg)
            if not self.next_outcomes:
                msg = f"unexpected submit of {submitted}"
                raise AssertionError(msg)
            self.attempts.append(
                _SimAttempt(
                    query_id=submitted,
                    outcome=self.next_outcomes.pop(0),
                    start_ms=time.time() * 1000 + self.submit_offset,
                    running_reads=1,
                    logged_at_log_read=self.log_reads + self.unflushed_log_reads,
                )
            )
        return submitted

    def _rows(self, statement: str) -> list[dict[str, object]]:
        if "system.one" in statement:
            if self.deny_probe is not None:
                raise RuntimeError(self.deny_probe)
            return [{"replicas": 1}]
        ids = _ids_in(statement)

        def matches(query_id: str) -> bool:
            return ids is None or query_id in ids

        with self._lock:
            if "now64" in statement:
                return [{"now_ms": str(int(self.server_now()))}]
            if "system.processes" in statement:
                running = [
                    attempt
                    for attempt in self.attempts
                    if self._running(attempt) and matches(attempt.query_id)
                ]
                for attempt in running:
                    attempt.status_reads += 1
                return [
                    {
                        "query_id": attempt.query_id,
                        "read_rows": "0",
                        "read_bytes": "0",
                        "written_rows": "0",
                        "written_bytes": "0",
                        "elapsed": 0,
                    }
                    for attempt in running
                ]
            if "system.query_log" in statement:
                self.log_reads += 1
                self.log_queries.append(statement)
                floor = _pruned_before(statement)
                return [
                    row
                    for attempt in self._logged()
                    if matches(attempt.query_id)
                    and (floor is None or (attempt.start_ms or 0) >= floor)
                    for row in _log_rows(attempt)
                ]
        return []


def _pruned_before(statement: str) -> float | None:
    """``event_date >= toDate32(after) - 1``, as a time in ms."""
    after = _PRUNING.search(statement)
    if after is None:
        return None
    after_ms = datetime.fromisoformat(after.group(1).replace("Z", "+00:00")).timestamp() * 1000
    return (after_ms // DAY_MS) * DAY_MS - DAY_MS


def _log_rows(attempt: _SimAttempt) -> list[dict[str, object]]:
    base: dict[str, object] = {"query_id": attempt.query_id}
    start = {
        **base,
        "type": "QueryStart",
        "written_rows": "0",
        "written_bytes": "0",
        "query_duration_ms": "0",
        "exception": "",
    }
    if attempt.outcome == "started":
        return [start]
    finished = attempt.outcome == "finished"
    end = {
        **base,
        "type": "QueryFinish" if finished else "ExceptionWhileProcessing",
        "written_rows": "42" if finished or attempt.outcome == "partial" else "0",
        "written_bytes": "0",
        "query_duration_ms": "1",
        "exception": "" if finished else "Code: 394. QUERY_WAS_CANCELLED",
    }
    return [end, start]


FIRST_ID = f"backfill-{PLAN_ID}-c1"
RECORDED_REPLAY_ID = f"{FIRST_ID}-recorded"
NO_OUTCOME = "it is not running on any replica and system.query_log has no outcome for it"
SHARED_ID = (
    "an older release ran it under the chunk's shared query id, so the failure in "
    "system.query_log may be an earlier attempt's"
)
NEVER = float("inf")


def _killed_first() -> _SimAttempt:
    # The killed first attempt, seconds before the replay: its failure is newer
    # than the 60 s window older releases subtracted from the replay's start.
    return _SimAttempt(
        query_id=FIRST_ID, outcome="failed", start_ms=time.time() * 1000 - 5_000
    )


def _iso_ms_ago(ms: float) -> str:
    moment = datetime.now(tz=UTC) - timedelta(milliseconds=ms)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _hour_ago() -> str:
    return _iso_ms_ago(60 * 60_000)


def _run_once(
    server: SimulatedServer,
    resume_from: BackfillProgress | None,
    *,
    replay_failed: bool = False,
    accept_unknown: bool = False,
    max_poll_errors: int = 10,
    outcome_recheck_interval_ms: int = 1,
    checkpoint_version: int | None = CHECKPOINT_VERSION,
) -> BackfillResult:
    return execute_backfill(
        executor=server,
        plan_id=PLAN_ID,
        chunk_ids=["c1"],
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        max_poll_errors=max_poll_errors,
        outcome_recheck_attempts=3,
        outcome_recheck_interval_ms=outcome_recheck_interval_ms,
        resume_from=resume_from,
        checkpoint_version=checkpoint_version,
        replay_failed=replay_failed,
        accept_unknown=accept_unknown,
        on_progress=server.persisted.append,
    )


def _pending_replay() -> BackfillProgress:
    return {
        "c1": BackfillChunkState(
            status="pending",
            query_id=RECORDED_REPLAY_ID,
            submitted_at=_hour_ago(),
            single_send=True,
        )
    }


def test_replay_started_seconds_after_the_failure_ends_done() -> None:
    server = SimulatedServer(attempts=[_killed_first()], next_outcomes=["finished"])

    result = _run_once(
        server,
        {
            "c1": BackfillChunkState(
                status="failed",
                query_id=FIRST_ID,
                error="Code: 394. QUERY_WAS_CANCELLED",
                single_send=True,
            )
        },
        replay_failed=True,
    )

    # Releases that reused the first id read its failure while the replay ran.
    assert len(server.submits) == 1
    replay_id = server.submits[0]
    assert replay_id != FIRST_ID
    assert replay_id.startswith(f"{FIRST_ID}-")
    assert result.failed == 0
    c1 = result.progress["c1"]
    assert (c1.status, c1.query_id, c1.written_rows) == ("done", replay_id, 42)


def test_resume_in_the_flush_gap_of_a_committed_replay_records_it_done() -> None:
    # The run died while the replay's submit waited for the INSERT, which then
    # committed; its QueryFinish is not in query_log at the first read.
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="finished", logged_at_log_read=1),
        ]
    )

    result = _run_once(server, _pending_replay())

    assert server.submits == []
    c1 = result.progress["c1"]
    assert (c1.status, c1.query_id, c1.written_rows) == ("done", RECORDED_REPLAY_ID, 42)


def test_resume_in_the_flush_gap_of_a_failed_replay_records_it_failed() -> None:
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="failed", logged_at_log_read=1),
        ]
    )

    result = _run_once(server, _pending_replay())

    assert server.submits == []
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == (
        "failed",
        RECORDED_REPLAY_ID,
    )


# Finding 1: query_log can flush after the recheck window, or not at all, so
# no row is no proof that a recorded attempt never ran.
@pytest.mark.parametrize("recorded_id", [RECORDED_REPLAY_ID, FIRST_ID])
def test_a_recorded_attempt_with_no_row_stops_the_resume_and_accept_unknown_replays_it(
    recorded_id: str,
) -> None:
    def recorded() -> BackfillProgress:
        if recorded_id == FIRST_ID:
            return {
                "c1": BackfillChunkState(status="pending", query_id=FIRST_ID, single_send=True)
            }
        return _pending_replay()

    server = SimulatedServer(
        attempts=[_SimAttempt(query_id=recorded_id, outcome="finished", logged_at_log_read=NEVER)],
        next_outcomes=["finished"],
    )

    for replay_failed in (False, True):
        with pytest.raises(RuntimeError) as raised:
            _run_once(server, recorded(), replay_failed=replay_failed)
        assert str(raised.value) == _unknown_error(recorded_id, NO_OUTCOME)
    assert server.submits == []
    # The last read has no time bound.
    assert "event_date" not in server.log_queries[-1]

    accepted = _run_once(server, recorded(), accept_unknown=True)

    assert len(server.submits) == 1
    assert server.submits[0] != recorded_id
    assert server.submits[0].startswith(f"{FIRST_ID}-")
    assert (accepted.progress["c1"].status, accepted.progress["c1"].query_id) == (
        "done",
        server.submits[0],
    )


# The submit returns when the INSERT ends, so every poll starts in the
# query_log flush gap. A short poll interval must not shorten the wait.
def test_polls_wait_out_a_flush_gap_longer_than_max_poll_errors_polls() -> None:
    server = SimulatedServer(next_outcomes=["finished"], unflushed_log_reads=15)

    result = _run_once(server, None, max_poll_errors=3, outcome_recheck_interval_ms=100)

    assert server.submits == [FIRST_ID]
    c1 = result.progress["c1"]
    assert (c1.status, c1.query_id, c1.written_rows) == ("done", FIRST_ID, 42)
    assert len(server.log_queries) > 3


@pytest.mark.parametrize("replay_failed", [False, True])
def test_replay_that_started_without_an_outcome_stops_the_resume(
    replay_failed: bool,
) -> None:
    server = SimulatedServer(
        attempts=[_killed_first(), _SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="started")],
        next_outcomes=["finished"],
    )

    with pytest.raises(RuntimeError) as raised:
        _run_once(server, _pending_replay(), replay_failed=replay_failed)
    assert str(raised.value) == _unknown_error(RECORDED_REPLAY_ID, NO_OUTCOME)
    assert server.submits == []


def test_run_stopped_between_replay_submit_and_state_write_attaches() -> None:
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="finished", running_reads=2),
        ]
    )

    result = _run_once(server, _pending_replay())

    assert server.submits == []
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == (
        "done",
        RECORDED_REPLAY_ID,
    )


def test_resume_reads_a_finished_replay_by_its_own_id() -> None:
    server = SimulatedServer(
        attempts=[_killed_first(), _SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="finished")]
    )

    result = _run_once(
        server,
        {
            "c1": BackfillChunkState(
                status="running",
                query_id=RECORDED_REPLAY_ID,
                submitted_at=_hour_ago(),
                single_send=True,
            )
        },
    )

    assert server.submits == []
    c1 = result.progress["c1"]
    assert (c1.status, c1.query_id, c1.written_rows) == ("done", RECORDED_REPLAY_ID, 42)


def test_failed_replay_keeps_its_id_and_is_replayed_under_a_third_id() -> None:
    server = SimulatedServer(attempts=[_killed_first()], next_outcomes=["failed", "finished"])

    first = _run_once(
        server,
        {"c1": BackfillChunkState(status="failed", query_id=FIRST_ID, single_send=True)},
        replay_failed=True,
    )
    assert (first.progress["c1"].status, first.progress["c1"].query_id) == (
        "failed",
        server.submits[0],
    )
    plain = _run_once(server, first.progress)
    assert (plain.progress["c1"].status, plain.progress["c1"].query_id) == (
        "failed",
        server.submits[0],
    )

    second = _run_once(server, plain.progress, replay_failed=True)

    assert len(server.submits) == 2
    assert len({FIRST_ID, *server.submits}) == 3
    assert (second.progress["c1"].status, second.progress["c1"].query_id) == (
        "done",
        server.submits[1],
    )


# Round-2 item 7: whether an attempt is unknown never depends on the flags.
# --replay-failed replays a proved failure, --accept-unknown an unresolved
# attempt, such as a failure an older release recorded for a polling outage,
# which the server never showed.
@pytest.mark.parametrize(
    ("replay_failed", "accept_unknown", "replayed"),
    [
        (False, False, None),
        (True, False, None),
        (False, True, ["c1"]),
        (True, True, ["c1", "c2"]),
    ],
)
def test_replay_failed_and_accept_unknown_each_replay_their_own_chunks(
    replay_failed: bool, accept_unknown: bool, replayed: list[str] | None
) -> None:
    finished = [QueryStatus(status="finished", written_rows=1, written_bytes=1, duration_ms=1)]
    executor = SubmitRecordingExecutor(
        {
            f"backfill-{PLAN_ID}-c2": [QueryStatus(status="failed", error="OOM", duration_ms=1)],
            f"backfill-{PLAN_ID}-c1-*": finished,
            f"backfill-{PLAN_ID}-c2-*": finished,
        }
    )

    def run() -> BackfillResult:
        return execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1", "c2"],
            build_query=lambda _chunk_id: "SELECT 1",
            poll_interval_ms=1,
            outcome_recheck_attempts=2,
            outcome_recheck_interval_ms=1,
            resume_from={
                "c1": BackfillChunkState(
                    status="failed",
                    error="Lost contact with query after 10 consecutive poll errors",
                ),
                "c2": BackfillChunkState(
                    status="failed", query_id=f"backfill-{PLAN_ID}-c2", single_send=True
                ),
            },
            checkpoint_version=CHECKPOINT_VERSION,
            replay_failed=replay_failed,
            accept_unknown=accept_unknown,
        )

    if replayed is None:
        with pytest.raises(RuntimeError) as raised:
            run()
        assert (
            f"chunk c1 (query_id backfill-{PLAN_ID}-c1): it is not running on any replica "
            "and system.query_log has no outcome for it."
        ) in str(raised.value)
        assert executor.submit_order == []
        return
    result = run()
    assert sorted("-".join(qid.split("-")[:4]) for qid in executor.submit_order) == [
        f"backfill-{PLAN_ID}-{chunk_id}" for chunk_id in replayed
    ]
    assert result.progress["c1"].status == "done"
    assert result.progress["c2"].status == ("done" if replay_failed else "failed")


PARTIAL = "it failed after writing 42 rows, which a replay would write again"


# Round-2 item 5: an attempt that failed after writing rows leaves them in the
# table; a replay writes them again.
def test_a_failure_after_written_rows_is_unknown_and_only_accept_unknown_replays_it() -> None:
    server = SimulatedServer(
        attempts=[_SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="partial")],
        next_outcomes=["finished"],
    )

    # In flight when the run stopped: this release never records such a failure.
    def recorded() -> BackfillProgress:
        return {
            "c1": BackfillChunkState(
                status="submitted",
                query_id=RECORDED_REPLAY_ID,
                submitted_at=_hour_ago(),
                single_send=True,
            )
        }

    with pytest.raises(RuntimeError) as raised:
        _run_once(server, recorded(), replay_failed=True)
    assert str(raised.value) == _unknown_error(RECORDED_REPLAY_ID, PARTIAL)
    assert server.submits == []

    accepted = _run_once(server, recorded(), accept_unknown=True)
    assert len(server.submits) == 1
    assert (accepted.progress["c1"].status, accepted.progress["c1"].query_id) == (
        "done",
        server.submits[0],
    )


def test_a_run_whose_chunk_fails_after_written_rows_stops_instead_of_recording_it_failed() -> None:
    server = SimulatedServer(next_outcomes=["partial"])

    with pytest.raises(RuntimeError) as raised:
        _run_once(server, None)

    assert str(raised.value) == _unknown_error(FIRST_ID, PARTIAL)
    # Seen running, then failed: it keeps that state, not failed.
    assert (server.persisted[-1]["c1"].status, server.persisted[-1]["c1"].query_id) == (
        "running",
        FIRST_ID,
    )


# Round-2 item 6: an older release saved a chunk's query id only after its
# submit returned, so a chunk its checkpoint lists as pending, or not at all,
# may have run.
@pytest.mark.parametrize("listed", [False, True])
def test_an_unversioned_checkpoints_pending_or_missing_chunk_with_no_outcome_is_unknown(
    listed: bool,
) -> None:
    def resume_from() -> BackfillProgress:
        return {"c1": BackfillChunkState(status="pending")} if listed else {}

    legacy = SimulatedServer(
        attempts=[_SimAttempt(query_id=FIRST_ID, outcome="finished", logged_at_log_read=NEVER)],
        next_outcomes=["finished"],
    )
    with pytest.raises(RuntimeError) as raised:
        _run_once(legacy, resume_from(), checkpoint_version=None)
    assert str(raised.value) == _unknown_error(FIRST_ID, NO_OUTCOME)
    assert legacy.submits == []
    # Saved in this release's format: recorded as may have run.
    assert legacy.persisted[-1]["c1"] == BackfillChunkState(status="pending", query_id=FIRST_ID)

    accepted = _run_once(legacy, resume_from(), accept_unknown=True, checkpoint_version=None)
    assert len(legacy.submits) == 1
    assert legacy.submits[0] != FIRST_ID
    assert accepted.progress["c1"].status == "done"

    current = SimulatedServer(next_outcomes=["finished"])
    result = _run_once(current, resume_from(), checkpoint_version=CHECKPOINT_VERSION)
    assert current.submits == [FIRST_ID]
    assert result.progress["c1"].status == "done"


def test_an_unversioned_checkpoints_chunk_that_committed_is_done_without_a_flag() -> None:
    server = SimulatedServer(
        attempts=[_SimAttempt(query_id=FIRST_ID, outcome="finished", logged_at_log_read=1)]
    )

    result = _run_once(
        server, {"c1": BackfillChunkState(status="pending")}, checkpoint_version=None
    )

    assert server.submits == []
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == ("done", FIRST_ID)


# Finding 6: the replica that runs the replay can stamp it days before the
# replica the bound came from. Pruned reads miss it; the last read does not.
def test_a_replay_stamped_by_a_replica_clock_days_behind_the_time_probe_settles_done() -> None:
    server = SimulatedServer(
        attempts=[_killed_first()],
        next_outcomes=["finished"],
        submit_clock_offset_ms=-3 * DAY_MS,
    )

    result = _run_once(
        server,
        {"c1": BackfillChunkState(status="failed", query_id=FIRST_ID, single_send=True)},
        replay_failed=True,
        max_poll_errors=4,
    )

    replay_id = server.submits[0]
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == ("done", replay_id)
    # The bound prunes query_log by event_date: an hour before the server's time.
    submitted_at = result.progress["c1"].submitted_at or ""
    lag = time.time() * 1000 - datetime.fromisoformat(
        submitted_at.replace("Z", "+00:00")
    ).timestamp() * 1000
    assert 59 * 60_000 < lag < 61 * 60_000
    assert any("event_date" in sql for sql in server.log_queries)


def test_a_resume_after_the_same_skew_settles_a_recorded_replay_done() -> None:
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(
                query_id=RECORDED_REPLAY_ID,
                outcome="finished",
                start_ms=time.time() * 1000 - 3 * DAY_MS,
                logged_at_log_read=1,
            ),
        ]
    )

    result = _run_once(server, _pending_replay())

    assert server.submits == []
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == (
        "done",
        RECORDED_REPLAY_ID,
    )


# Finding 2: an older release replayed under the chunk's id, so the first
# attempt's failure is a row of the replay's id too.
def test_older_release_shared_id_replay_with_only_a_failure_is_unknown_not_failed() -> None:
    submitted_at = _iso_ms_ago(60_000)
    server = SimulatedServer(attempts=[_killed_first()], next_outcomes=["finished"])

    for state in (
        BackfillChunkState(status="pending", submitted_at=submitted_at),
        BackfillChunkState(status="failed", query_id=FIRST_ID, submitted_at=submitted_at),
    ):
        with pytest.raises(RuntimeError) as raised:
            _run_once(server, {"c1": state}, replay_failed=True)
        assert str(raised.value) == _unknown_error(FIRST_ID, SHARED_ID)
    assert server.submits == []

    accepted = _run_once(
        server,
        {"c1": BackfillChunkState(status="pending", submitted_at=submitted_at)},
        accept_unknown=True,
    )

    assert len(server.submits) == 1
    assert server.submits[0] != FIRST_ID
    assert (accepted.progress["c1"].status, accepted.progress["c1"].query_id) == (
        "done",
        server.submits[0],
    )


def test_older_release_shared_id_replay_seen_running_is_not_taken_for_the_failure() -> None:
    submitted_at = _iso_ms_ago(60_000)
    # Running at the resume's read; its QueryFinish appears a few log reads
    # after it leaves system.processes, while the first failure is visible.
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(
                query_id=FIRST_ID, outcome="finished", running_reads=1, logged_at_log_read=4
            ),
        ]
    )

    # A wide flush window: the QueryFinish shows a few log reads late.
    result = _run_once(
        server,
        {"c1": BackfillChunkState(status="pending", submitted_at=submitted_at)},
        outcome_recheck_interval_ms=100,
    )

    assert server.submits == []
    c1 = result.progress["c1"]
    assert (c1.status, c1.query_id, c1.written_rows) == ("done", FIRST_ID, 42)


def test_older_release_shared_id_replay_that_stops_with_no_finish_ends_the_run_unknown() -> None:
    submitted_at = _iso_ms_ago(60_000)
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(query_id=FIRST_ID, outcome="started", running_reads=1),
        ]
    )

    with pytest.raises(RuntimeError) as raised:
        _run_once(
            server,
            {
                "c1": BackfillChunkState(
                    status="running", query_id=FIRST_ID, submitted_at=submitted_at
                )
            },
            max_poll_errors=3,
        )

    assert str(raised.value) == _unknown_error(FIRST_ID, SHARED_ID)
    assert server.submits == []
    assert (server.persisted[-1]["c1"].status, server.persisted[-1]["c1"].query_id) == (
        "running",
        FIRST_ID,
    )


@pytest.mark.parametrize("status", ["pending", "running"])
def test_older_release_replay_committed_in_the_flush_gap_is_not_taken_for_the_failure(
    status: str,
) -> None:
    # An older release reset c1 (submitted_at = now - 60 s) and submitted the
    # replay under the shared id; the run died and this release resumes before
    # the replay's QueryFinish is in query_log.
    submitted_at = _iso_ms_ago(60_000)
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(query_id=FIRST_ID, outcome="finished", logged_at_log_read=1),
        ]
    )
    state = (
        BackfillChunkState(status="pending", submitted_at=submitted_at)
        if status == "pending"
        else BackfillChunkState(status="running", query_id=FIRST_ID, submitted_at=submitted_at)
    )

    result = _run_once(server, {"c1": state})

    assert (result.progress["c1"].status, result.progress["c1"].query_id) == ("done", FIRST_ID)
    assert server.submits == []


def test_older_release_replay_that_committed_is_done_when_its_clock_ran_ahead() -> None:
    # The older release stamped submitted_at from a client clock 3 minutes
    # ahead, so the replay's QueryFinish started before that bound.
    submitted_at = _iso_ms_ago(-2 * 60_000)
    server = SimulatedServer(
        attempts=[_killed_first(), _SimAttempt(query_id=FIRST_ID, outcome="finished")]
    )

    result = _run_once(
        server, {"c1": BackfillChunkState(status="pending", submitted_at=submitted_at)}
    )

    assert server.submits == []
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == ("done", FIRST_ID)


def test_replay_an_older_release_left_running_is_polled_to_its_outcome() -> None:
    submitted_at = _iso_ms_ago(60_000)
    killed = _killed_first()
    killed.start_ms = time.time() * 1000 - 120_000
    server = SimulatedServer(
        attempts=[killed, _SimAttempt(query_id=FIRST_ID, outcome="finished", running_reads=2)]
    )

    result = _run_once(
        server,
        {"c1": BackfillChunkState(status="running", query_id=FIRST_ID, submitted_at=submitted_at)},
    )

    assert server.submits == []
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == ("done", FIRST_ID)


def test_resume_whose_replica_probe_fails_submits_nothing() -> None:
    server = SimulatedServer(
        attempts=[_killed_first()],
        next_outcomes=["finished"],
        deny_probe="Code: 210. NETWORK_ERROR",
    )

    with pytest.raises(
        RuntimeError,
        match=(
            r"could not check which chunks are still running on the server "
            r"\(Code: 210\. NETWORK_ERROR\)"
        ),
    ):
        _run_once(server, _pending_replay())
    assert server.submits == []


# Finding 4 / round-2 item 4: a user denied clusterAllReplicas reads one
# replica. A run or a QueryFinish it finds there holds; anything else, a
# failure row included, may differ on another replica.
DENIED = "Code: 497. DB::Exception: default: Not enough privileges. (ACCESS_DENIED)"
DENIED_REASON = (
    f"the user may not read every replica ({DENIED}), and the replica it can read "
    "shows neither a run of it nor a QueryFinish"
)


def test_resume_whose_replica_probe_is_denied_trusts_only_a_run_or_a_finish() -> None:
    absent = SimulatedServer(
        attempts=[_killed_first()], next_outcomes=["finished"], deny_probe=DENIED
    )
    with pytest.raises(RuntimeError) as raised:
        _run_once(absent, _pending_replay())
    assert str(raised.value) == _unknown_error(RECORDED_REPLAY_ID, DENIED_REASON)
    assert absent.submits == []

    failed_locally = SimulatedServer(
        attempts=[_SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="failed")],
        next_outcomes=["finished"],
        deny_probe=DENIED,
    )
    submitted_state = _pending_replay()["c1"].model_copy(update={"status": "submitted"})
    with pytest.raises(RuntimeError) as raised:
        _run_once(failed_locally, {"c1": submitted_state}, replay_failed=True)
    assert str(raised.value) == _unknown_error(RECORDED_REPLAY_ID, DENIED_REASON)
    assert failed_locally.submits == []

    # A failure this release proved before the denial stays proven.
    proven = SimulatedServer(
        attempts=[_SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="failed")],
        next_outcomes=["finished"],
        deny_probe=DENIED,
    )
    failed_state = _pending_replay()["c1"].model_copy(update={"status": "failed"})
    replayed = _run_once(proven, {"c1": failed_state}, replay_failed=True)
    assert len(proven.submits) == 1
    assert (replayed.progress["c1"].status, replayed.progress["c1"].query_id) == (
        "done",
        proven.submits[0],
    )

    found = SimulatedServer(
        attempts=[_killed_first(), _SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="finished")],
        deny_probe=DENIED,
    )
    result = _run_once(found, _pending_replay())
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == (
        "done",
        RECORDED_REPLAY_ID,
    )
    assert found.submits == []


# Round-2 item 8: with clickhouse.cluster set and the cluster denied, the
# reads use the local tables, as TS does.
def test_a_denied_explicit_cluster_reads_the_local_tables_the_polls_too() -> None:
    class DeniedCluster(SimulatedServer):
        def __init__(self) -> None:
            super().__init__(
                attempts=[_SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="started")],
                next_outcomes=["finished"],
            )
            self.reads: list[str] = []

        def _rows(self, statement: str) -> list[dict[str, object]]:
            if "clusterAllReplicas" in statement:
                raise RuntimeError(DENIED)
            if "system.processes" in statement or "system.query_log" in statement:
                self.reads.append(statement)
            return super()._rows(statement)

    server = DeniedCluster()

    def run(*, accept_unknown: bool) -> BackfillResult:
        return execute_backfill(
            executor=server,
            cluster="default",
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "SELECT 1",
            poll_interval_ms=1,
            outcome_recheck_attempts=2,
            outcome_recheck_interval_ms=1,
            resume_from=_pending_replay(),
            checkpoint_version=CHECKPOINT_VERSION,
            accept_unknown=accept_unknown,
            on_progress=server.persisted.append,
        )

    with pytest.raises(RuntimeError) as raised:
        run(accept_unknown=False)
    assert (
        f"chunk c1 (query_id {RECORDED_REPLAY_ID}): the user may not read every replica ({DENIED})"
    ) in str(raised.value)
    assert server.submits == []

    accepted = run(accept_unknown=True)
    assert len(server.submits) == 1
    assert accepted.progress["c1"].status == "done"
    assert len(server.reads) > 4
    for sql in server.reads:
        assert re.search(r"FROM system\.(processes|query_log)", sql)


# Round-2 item 1: SIGINT and SIGTERM set the run's stop event.
def test_a_stopped_run_submits_no_new_chunk_and_reports_nothing_after_it_raises() -> None:
    stop = threading.Event()
    release = threading.Event()

    class BlockingSubmit(SubmitRecordingExecutor):
        def submit(self, statement: str, query_id: str | None = None) -> str:
            submitted = super().submit(statement, query_id)
            stop.set()
            release.wait(5)
            return submitted

    executor = BlockingSubmit(
        {
            f"backfill-{PLAN_ID}-c1": [
                QueryStatus(status="finished", written_rows=1, written_bytes=1, duration_ms=1)
            ]
        }
    )
    reports: list[BackfillProgress] = []

    with pytest.raises(RuntimeError, match=rf"Backfill plan {PLAN_ID}: interrupted\. No new chunk"):
        execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1", "c2"],
            build_query=lambda _chunk_id: "SELECT 1",
            concurrency=1,
            poll_interval_ms=1,
            stop=stop,
            on_progress=reports.append,
        )
    reported = len(reports)
    release.set()
    time.sleep(0.1)

    assert executor.submit_order == [f"backfill-{PLAN_ID}-c1"]
    assert len(reports) == reported
    assert reports[-1]["c1"] == BackfillChunkState(
        status="pending", query_id=f"backfill-{PLAN_ID}-c1", single_send=True
    )


# Round 3 item 1: before this release a resume could send the chunk's id a
# second time, so a failure row of an older release's attempt may belong to a
# send whose QueryFinish is still on its way.
RESENT = (
    "an older release may have sent it more than once under this query id, so the "
    "failure in system.query_log may not be its last send"
)


@pytest.mark.parametrize("saved", ["missing", "pending", "failed"])
def test_a_failure_row_of_an_attempt_an_older_release_recorded_is_unknown(saved: str) -> None:
    resume_from: BackfillProgress = {
        "missing": {},
        "pending": {"c1": BackfillChunkState(status="pending")},
        "failed": {"c1": BackfillChunkState(status="failed", query_id=FIRST_ID)},
    }[saved]
    server = SimulatedServer(attempts=[_killed_first()], next_outcomes=["finished"])

    with pytest.raises(RuntimeError) as raised:
        _run_once(server, resume_from, replay_failed=True, checkpoint_version=None)

    assert str(raised.value) == _unknown_error(FIRST_ID, RESENT)
    assert server.submits == []


def test_an_older_releases_second_send_that_committed_is_done_once_its_finish_shows() -> None:
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(query_id=FIRST_ID, outcome="finished", logged_at_log_read=2),
        ]
    )

    result = _run_once(
        server,
        {"c1": BackfillChunkState(status="pending")},
        replay_failed=True,
        checkpoint_version=None,
    )

    assert server.submits == []
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == ("done", FIRST_ID)


# Round 3 item 2: two replicas, one unavailable. A probe that skipped it would
# count one host and read one replica's log as the whole truth.
def test_a_resume_whose_strict_probe_meets_an_unavailable_replica_submits_nothing() -> None:
    class OneReplicaDown(SimulatedServer):
        def _rows(self, statement: str) -> list[dict[str, object]]:
            if "system.one" in statement:
                if "skip_unavailable_shards = 0" in statement:
                    msg = "Code: 279. DB::NetException: All connection tries failed."
                    raise RuntimeError(msg)
                return [{"replicas": 1}]
            return super()._rows(statement)

    server = OneReplicaDown(
        attempts=[_SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="failed")],
        next_outcomes=["finished"],
    )
    state = _pending_replay()["c1"].model_copy(update={"status": "failed"})

    with pytest.raises(RuntimeError, match=r"could not check which chunks are still running on the server \(Code: 279\."):
        _run_once(server, {"c1": state}, replay_failed=True)
    assert server.submits == []


# Round 3 item 3: chunk B waits on its pre-send checkpoint while chunk A's
# outcome turns out unknown. B must not be sent, and keeps its state.
def test_a_chunk_whose_pre_send_checkpoint_finishes_after_the_dispatch_stopped_is_not_sent() -> None:
    class PartialA(SubmitRecordingExecutor):
        def _rows(self, statement: str) -> list[dict[str, object]]:
            rows = super()._rows(statement)
            return [{**row, "written_rows": "7"} if "type" in row else row for row in rows]

    executor = PartialA(
        {f"backfill-{PLAN_ID}-c1": [QueryStatus(status="failed", error="late block", duration_ms=1)]}
    )
    saved: list[BackfillProgress] = []
    held: list[bool] = []

    def on_progress(progress: BackfillProgress) -> None:
        saved.append(progress)
        # Hold B's pre-send write while A's polls classify A.
        if progress["c2"].query_id is not None and not held:
            held.append(True)
            time.sleep(0.2)

    with pytest.raises(RuntimeError, match=rf"chunk c1 \(query_id backfill-{PLAN_ID}-c1\): it failed after writing 7 rows"):
        execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1", "c2"],
            build_query=lambda _chunk_id: "SELECT 1",
            concurrency=2,
            poll_interval_ms=1,
            on_progress=on_progress,
        )

    assert held == [True]
    assert executor.submit_order == [f"backfill-{PLAN_ID}-c1"]
    assert saved[-1]["c2"] == BackfillChunkState(status="pending")


# Round 3 item 3: the interrupt lands while a worker builds its chunk's SQL.
def test_a_worker_paused_in_build_query_during_an_interrupt_never_sends() -> None:
    stop = threading.Event()
    building = threading.Event()
    resume_building = threading.Event()
    executor = SubmitRecordingExecutor({})

    def build_query(_chunk_id: str) -> str:
        building.set()
        resume_building.wait(5)
        return "SELECT 1"

    def interrupt() -> None:
        building.wait(5)
        stop.set()

    threading.Thread(target=interrupt, daemon=True).start()
    with pytest.raises(RuntimeError, match=rf"Backfill plan {PLAN_ID}: interrupted\."):
        execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=build_query,
            poll_interval_ms=1,
            stop=stop,
        )
    # The worker finishes building only after execute_backfill returned.
    resume_building.set()
    time.sleep(0.2)

    assert executor.submit_order == []


# Round 3 item 8: a replay gets its id when it is sent, so a proved failure
# the run never reaches keeps its evidence.
def test_a_replay_the_run_never_reaches_keeps_its_failed_state_and_query_id() -> None:
    class FailingSubmit(MockExecutor):
        def submit(self, statement: str, query_id: str | None = None) -> str:
            msg = "Code: 241. MEMORY_LIMIT_EXCEEDED"
            raise RuntimeError(msg)

    c2 = BackfillChunkState(status="failed", query_id=f"backfill-{PLAN_ID}-c2", single_send=True)
    saved: list[BackfillProgress] = []

    with pytest.raises(RuntimeError, match="MEMORY_LIMIT_EXCEEDED"):
        execute_backfill(
            executor=FailingSubmit(
                {
                    f"backfill-{PLAN_ID}-c1": [QueryStatus(status="failed", error="OOM", duration_ms=1)],
                    f"backfill-{PLAN_ID}-c2": [QueryStatus(status="failed", error="OOM", duration_ms=1)],
                }
            ),
            plan_id=PLAN_ID,
            chunk_ids=["c1", "c2"],
            build_query=lambda _chunk_id: "SELECT 1",
            concurrency=1,
            poll_interval_ms=1,
            resume_from={
                "c1": BackfillChunkState(
                    status="failed", query_id=f"backfill-{PLAN_ID}-c1", single_send=True
                ),
                "c2": c2,
            },
            checkpoint_version=CHECKPOINT_VERSION,
            replay_failed=True,
            on_progress=saved.append,
        )

    assert saved[-1]["c2"].status == "failed"
    assert saved[-1]["c2"].query_id == c2.query_id
    assert (saved[-1]["c1"].query_id or "").startswith(f"backfill-{PLAN_ID}-c1-")


# Round 3 item 9: a read that hangs before the dispatch does not keep an
# interrupted resume waiting.
def test_a_stop_during_a_hung_resume_read_raises_at_once() -> None:
    stop = threading.Event()

    class Hung(MockExecutor):
        def query(self, statement: str) -> _Result:
            threading.Event().wait(30)
            return _Result([])

    threading.Timer(0.1, stop.set).start()
    started = time.monotonic()
    with pytest.raises(RuntimeError, match=rf"Backfill plan {PLAN_ID}: interrupted\."):
        execute_backfill(
            executor=Hung(),
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "SELECT 1",
            resume_from={"c1": BackfillChunkState(status="pending", query_id=FIRST_ID, single_send=True)},
            checkpoint_version=CHECKPOINT_VERSION,
            stop=stop,
        )
    assert time.monotonic() - started < 5


# Round 4 item 3: the checkpoint a rollback to an older release rewrites
# without a version keeps this release's single_send markers; that release may
# have resent the ids, so the markers prove nothing (fixture shared with TS).
ROLLBACK_FIXTURE = (
    Path(__file__).resolve().parents[2] / "test" / "fixtures" / "backfill-rollback-checkpoint.json"
)


def test_a_rolled_back_checkpoints_single_send_markers_prove_nothing() -> None:
    raw = json.loads(ROLLBACK_FIXTURE.read_text(encoding="utf-8"))
    progress = {
        chunk_id: BackfillChunkState.model_validate(state)
        for chunk_id, state in raw["progress"].items()
    }
    failed = [QueryStatus(status="failed", error="Code: 394. QUERY_WAS_CANCELLED", duration_ms=1)]
    finished = [QueryStatus(status="finished", written_rows=1, written_bytes=1, duration_ms=1)]
    executor = SubmitRecordingExecutor(
        {
            f"backfill-{PLAN_ID}-c1": failed,
            f"backfill-{PLAN_ID}-c2": failed,
            f"backfill-{PLAN_ID}-c1-*": finished,
            f"backfill-{PLAN_ID}-c2-*": finished,
        }
    )

    def resume(*, replay_failed: bool = False, accept_unknown: bool = False) -> BackfillResult:
        return execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1", "c2"],
            build_query=lambda _chunk_id: "SELECT 1",
            poll_interval_ms=1,
            outcome_recheck_attempts=2,
            outcome_recheck_interval_ms=1,
            resume_from=progress,
            replay_failed=replay_failed,
            accept_unknown=accept_unknown,
        )

    with pytest.raises(RuntimeError) as raised:
        resume(replay_failed=True)
    assert (
        f"chunk c1 (query_id backfill-{PLAN_ID}-c1): {RESENT}; chunk c2 (query_id "
        f"backfill-{PLAN_ID}-c2): {RESENT}."
    ) in str(raised.value)
    assert executor.submit_order == []

    accepted = resume(accept_unknown=True)
    assert len(executor.submit_order) == 2
    assert accepted.completed == 2


# Round 4 item 2: an executor without a single-attempt send records no
# single_send, so a failure of its attempt is never proof.
def test_an_attempt_of_an_executor_that_may_resend_is_never_proved_failed() -> None:
    class Retrying:
        def __init__(self) -> None:
            self._inner = MockExecutor(
                {f"backfill-{PLAN_ID}-c1": [QueryStatus(status="failed", error="OOM", duration_ms=1)]}
            )

        def submit(self, statement: str, query_id: str | None = None) -> str:
            return self._inner.submit(statement, query_id)

        def query(self, statement: str) -> object:
            return self._inner.query(statement)

    saved: list[BackfillProgress] = []

    with pytest.raises(RuntimeError, match=r"an older release may have sent it more than once"):
        execute_backfill(
            executor=Retrying(),
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "SELECT 1",
            poll_interval_ms=1,
            max_poll_errors=2,
            outcome_recheck_attempts=1,
            outcome_recheck_interval_ms=1,
            on_progress=saved.append,
        )
    assert all(progress["c1"].single_send is None for progress in saved)


# Round 4 items 1 and 4, through ClickHouseClient.submit_once and its
# single-attempt pool: a fake urllib3 pool whose request() enters urlopen().

def _write_body(body: object) -> None:
    """Read the body as urllib3 does once the headers are written."""
    if body is not None and not isinstance(body, (bytes, str)):
        for _chunk in body:  # type: ignore[attr-defined]
            pass

class _FakePool:
    def __init__(self, gate: threading.Event | None = None) -> None:
        self.gate = gate
        self.entered: list[str] = []

    def request(self, method: str, url: str, **kwargs: object) -> object:
        if self.gate is not None:
            self.gate.wait(5)
        return self.urlopen(method, url, **kwargs)

    def urlopen(self, method: str, url: str, **kwargs: object) -> object:
        _write_body(kwargs.get("body"))
        self.entered.append(url)
        return MagicMock(status=200)


def _client_executor(pool: _FakePool) -> tuple[object, ClickHouseClient]:
    driver = MagicMock()
    driver.http = pool
    driver.command.side_effect = lambda statement, **_kw: driver.http.request("POST", "http://ch/")
    client = ClickHouseClient(
        MagicMock(),
        ChxResolvedClickHouseConfig(
            url="http://localhost:8123", username="default", password="", database="default", secure=False
        ),
    )
    install_send_hook(pool)
    client._send_once_client = driver
    previous = BackfillChunkState(status="failed", query_id=FIRST_ID, single_send=True)
    reads = MockExecutor(
        {FIRST_ID: [QueryStatus(status="failed", error="OOM", duration_ms=0)]}
    )

    class Executor:
        transport_admission = True

        def submit(self, statement: str, query_id: str | None = None) -> str:
            raise AssertionError("submit_once is used")

        def submit_once(self, statement: str, query_id: str) -> str:
            return client.submit_once(statement, query_id)

        def query(self, statement: str) -> object:
            return reads.query(statement)

    assert previous.single_send
    return Executor(), client


def _interrupted_replay(
    executor: object,
    stop: threading.Event,
    build_query: Callable[[str], str],
    on_report: Callable[[BackfillProgress], None] | None = None,
) -> list[BackfillProgress]:
    reports: list[BackfillProgress] = []

    def on_progress(progress: BackfillProgress) -> None:
        reports.append(progress)
        if on_report is not None:
            on_report(progress)

    with pytest.raises(RuntimeError, match=rf"Backfill plan {PLAN_ID}: interrupted\."):
        execute_backfill(
            executor=executor,  # type: ignore[arg-type]
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=build_query,
            poll_interval_ms=1,
            resume_from={"c1": BackfillChunkState(status="failed", query_id=FIRST_ID, single_send=True)},
            checkpoint_version=CHECKPOINT_VERSION,
            replay_failed=True,
            stop=stop,
            on_progress=on_progress,
        )
    return reports


def test_an_interrupt_waits_for_an_admitted_send_to_reach_the_transport() -> None:
    gate = threading.Event()
    pool = _FakePool(gate)
    executor, _client = _client_executor(pool)
    stop = threading.Event()

    def build_query(_chunk_id: str) -> str:
        # Admitted, then held before urlopen; the interrupt comes meanwhile.
        threading.Timer(0.05, stop.set).start()
        threading.Timer(0.3, gate.set).start()
        return "INSERT INTO t SELECT 1"

    started = time.monotonic()
    reports = _interrupted_replay(executor, stop, build_query)
    waited = time.monotonic() - started
    time.sleep(0.2)

    # The interrupt returned only once the held send reached urlopen, where
    # the stop refused it: nothing was sent, and the proved failure is back.
    assert waited >= 0.25
    assert pool.entered == []
    assert reports[-1]["c1"].status == "failed"
    assert reports[-1]["c1"].query_id == FIRST_ID


def test_a_send_refused_after_its_record_saves_the_proved_failure_back_before_the_interrupt_returns() -> None:
    pool = _FakePool()
    executor, _client = _client_executor(pool)
    stop = threading.Event()

    def on_report(progress: BackfillProgress) -> None:
        # The interrupt lands while the replay's new id is being saved.
        if (progress["c1"].query_id or "").startswith(f"{FIRST_ID}-") and not stop.is_set():
            stop.set()
            time.sleep(0.2)

    reports = _interrupted_replay(executor, stop, lambda _chunk_id: "INSERT INTO t SELECT 1", on_report)
    reported = len(reports)
    time.sleep(0.2)

    assert pool.entered == []
    assert len(reports) == reported
    assert any((r["c1"].query_id or "").startswith(f"{FIRST_ID}-") for r in reports)
    assert reports[-1]["c1"].status == "failed"
    assert reports[-1]["c1"].query_id == FIRST_ID


# Round 5 item 2: connection setup that stalls happens before the chunk is
# admitted, so it holds neither the interrupt nor the lock release.
def test_a_stalled_connection_setup_does_not_hold_the_interrupt() -> None:
    setup = threading.Event()
    stop = threading.Event()

    class StalledSetup(SubmitRecordingExecutor):
        def prepare_submit_once(self) -> None:
            stop.set()
            setup.wait(5)

    executor = StalledSetup({})
    reports: list[BackfillProgress] = []
    started = time.monotonic()

    with pytest.raises(RuntimeError, match=rf"Backfill plan {PLAN_ID}: interrupted\."):
        execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "SELECT 1",
            poll_interval_ms=1,
            stop=stop,
            on_progress=reports.append,
        )
    assert time.monotonic() - started < 2
    setup.set()
    time.sleep(0.1)

    assert executor.submit_order == []
    assert reports[-1]["c1"] == BackfillChunkState(status="pending")


# Round 5 item 4: an executor that cannot refuse a send at its transport
# could send after the interrupt returned, so an interruptible run refuses it.
def test_an_interruptible_run_refuses_an_executor_without_submit_once() -> None:
    class SubmitOnly:
        def submit(self, statement: str, query_id: str | None = None) -> str:
            return query_id or ""

        def query(self, statement: str) -> object:
            return _Result([])

    with pytest.raises(ValueError, match="An interruptible backfill needs an executor with transport_admission"):
        execute_backfill(
            executor=SubmitOnly(),
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "SELECT 1",
            stop=threading.Event(),
        )


# Round 5 item 5: a version-2 writer saved each id before its submit, so its
# pending chunk without one was never sent; only its single_send is dropped.
def test_a_version_2_checkpoint_keeps_its_never_sent_chunks_and_drops_single_send() -> None:
    server = SimulatedServer(attempts=[_killed_first()], next_outcomes=["finished", "finished"])

    with pytest.raises(RuntimeError) as raised:
        _run_once(
            server,
            {"c1": BackfillChunkState(status="failed", query_id=FIRST_ID, single_send=True)},
            replay_failed=True,
            checkpoint_version=2,
        )
    assert str(raised.value) == _unknown_error(FIRST_ID, RESENT)
    assert server.submits == []

    fresh = SimulatedServer(next_outcomes=["finished"])
    result = _run_once(fresh, {"c1": BackfillChunkState(status="pending")}, checkpoint_version=2)
    assert fresh.submits == [FIRST_ID]
    assert result.progress["c1"].status == "done"


# Round 6 item 2: a submit_once of another executor may ignore the run's
# admission; only the declared capability counts.
def test_an_interruptible_run_refuses_a_submit_once_without_the_transport_admission_marker() -> None:
    sent: list[str] = []

    class OneShot:
        def submit(self, statement: str, query_id: str | None = None) -> str:
            raise AssertionError("submit is not used")

        def submit_once(self, statement: str, query_id: str) -> str:
            sent.append(query_id)
            return query_id

        def query(self, statement: str) -> object:
            return _Result([])

    with pytest.raises(ValueError, match="needs an executor with transport_admission"):
        execute_backfill(
            executor=OneShot(),
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "SELECT 1",
            stop=threading.Event(),
        )
    assert sent == []

    # Without a stop it still sends through submit_once (a plain submit may
    # resend), and records no single_send: nothing proves its admission.
    saved: list[BackfillProgress] = []
    with pytest.raises(RuntimeError, match="the outcome of the last attempt is unknown"):
        execute_backfill(
            executor=OneShot(),
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "SELECT 1",
            poll_interval_ms=1,
            max_poll_errors=2,
            outcome_recheck_attempts=1,
            outcome_recheck_interval_ms=1,
            on_progress=saved.append,
        )
    assert sent == [f"backfill-{PLAN_ID}-c1"]
    assert saved[-1]["c1"].single_send is None



# Round 7 item 1: an executor whose submit_once lacks the transport_admission
# marker still sends through it, not through a submit that resends a reset
# request. A connection reset counts the transport attempts.
def test_an_unmarked_submit_once_is_still_preferred_over_a_resending_submit() -> None:
    def reset() -> ProtocolError:
        error = ProtocolError("remote closed")
        error.__context__ = ConnectionResetError("reset")
        return error

    class CountingPool:
        def __init__(self) -> None:
            self.attempts = 0

        def request(self, method: str, url: str, **kwargs: object) -> object:
            return self.urlopen(method, url, **kwargs)

        def urlopen(self, method: str, url: str, **kwargs: object) -> object:
            self.attempts += 1
            raise reset()

        def clear(self) -> None:
            pass

    def fake_driver(pool: CountingPool) -> MagicMock:
        driver = MagicMock()
        driver.headers = {}
        driver.params = {}
        driver._send_progress = False
        driver._progress_interval = None
        driver._autogenerate_query_id = False
        driver.url = "http://localhost:8123"
        driver.server_host_name = None
        driver.http = pool
        driver.command.side_effect = lambda statement, **_kw: HttpClient._raw_request(driver, statement, {})
        return driver

    once_pool, resending_pool = CountingPool(), CountingPool()
    install_send_hook(once_pool)
    client = ClickHouseClient(
        MagicMock(),
        ChxResolvedClickHouseConfig(
            url="http://localhost:8123", username="default", password="", database="default", secure=False
        ),
    )
    client._send_once_client = fake_driver(once_pool)
    client._submit_client = fake_driver(resending_pool)
    reads = MockExecutor()

    class Unmarked:
        def submit(self, statement: str, query_id: str | None = None) -> str:
            return client.submit(statement, query_id)

        def submit_once(self, statement: str, query_id: str) -> str:
            return client.submit_once(statement, query_id)

        def query(self, statement: str) -> object:
            return reads.query(statement)

    saved: list[BackfillProgress] = []
    with pytest.raises(RuntimeError, match="cannot be resent"):
        execute_backfill(
            executor=Unmarked(),
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "INSERT INTO t SELECT 1",
            on_progress=saved.append,
        )

    assert once_pool.attempts == 1
    assert resending_pool.attempts == 0
    assert saved[-1]["c1"].single_send is None


# #765 whole-branch review: a stop during the dispatcher's last wait, whose
# only worker is then refused, must not end the run as if it had run.
def test_a_stop_during_the_last_wait_raises_instead_of_returning_an_unrun_chunk() -> None:
    stop = threading.Event()
    executor = SubmitRecordingExecutor({})

    def build_query(_chunk_id: str) -> str:
        stop.set()  # the worker is then refused at its admission
        return "SELECT 1"

    with pytest.raises(RuntimeError, match=rf"Backfill plan {PLAN_ID}: interrupted\."):
        execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=build_query,
            poll_interval_ms=1,
            stop=stop,
        )
    assert executor.submit_order == []


# #765 whole-branch review: a failure proves a safe replay only with an
# explicit zero for its written rows, and none seen written before.
@pytest.mark.parametrize(
    ("written_rows", "seen", "reason"),
    [
        (None, None, "system.query_log does not say how many rows it wrote"),
        ("", None, "system.query_log does not say how many rows it wrote"),
        ("0", 37, "it failed after writing 37 rows, which a replay would write again"),
    ],
)
def test_a_failure_without_an_explicit_zero_write_is_unknown(
    written_rows: object, seen: int | None, reason: str
) -> None:
    class Rows(SubmitRecordingExecutor):
        def _rows(self, statement: str) -> list[dict[str, object]]:
            if "system.one" in statement:
                return [{"replicas": 1}]
            if "system.query_log" in statement:
                return [
                    {
                        "query_id": FIRST_ID,
                        "type": "ExceptionWhileProcessing",
                        "written_rows": written_rows,
                        "written_bytes": "0",
                        "query_duration_ms": "1",
                        "exception": "late block",
                    }
                ]
            return []

    executor = Rows({})
    with pytest.raises(RuntimeError) as raised:
        execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "SELECT 1",
            # In flight when the run stopped: its failure is proven here or never.
            resume_from={
                "c1": BackfillChunkState(
                    status="submitted", query_id=FIRST_ID, single_send=True, written_rows=seen
                )
            },
            checkpoint_version=CHECKPOINT_VERSION,
            replay_failed=True,
            outcome_recheck_attempts=1,
            outcome_recheck_interval_ms=1,
        )
    assert str(raised.value) == _unknown_error(FIRST_ID, reason)
    assert executor.submit_order == []


# Opus critic, item 2: a failure this release proved is not proven again. Its
# query_log rows may have aged out, or sit on a replica the resume cannot read.
_PROVEN_FAILURE = BackfillChunkState(
    status="failed", query_id=f"backfill-{PLAN_ID}-c1", error="Code: 241 MEMORY_LIMIT_EXCEEDED"
)


class _FinishesWhatItSends(MockExecutor):
    """query_log has nothing for c1; every attempt sent finishes."""

    def __init__(self) -> None:
        super().__init__({})
        self.submits: list[str] = []

    def submit_once(self, statement: str, query_id: str) -> str:
        with self._lock:
            self.submits.append(query_id)
            self._statuses[query_id] = [QueryStatus(status="finished", written_rows=1)]
        return super().submit_once(statement, query_id)


def _resume_after_proven_failure(
    c1: BackfillChunkState, *, replay_failed: bool = False
) -> tuple[BackfillResult, list[str]]:
    executor = _FinishesWhatItSends()
    result = execute_backfill(
        executor=executor,
        plan_id=PLAN_ID,
        chunk_ids=["c1", "c2"],
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        outcome_recheck_attempts=1,
        outcome_recheck_interval_ms=1,
        resume_from={"c1": c1, "c2": BackfillChunkState(status="pending")},
        checkpoint_version=CHECKPOINT_VERSION,
        replay_failed=replay_failed,
    )
    return result, executor.submits


def test_a_plain_resume_skips_a_proven_failure_whose_rows_are_gone() -> None:
    proven = _PROVEN_FAILURE.model_copy(update={"single_send": True})

    result, submits = _resume_after_proven_failure(proven)

    assert submits == [f"backfill-{PLAN_ID}-c2"]
    assert result.progress["c1"] == proven
    assert result.progress["c2"].status == "done"
    assert (result.total, result.completed, result.failed) == (2, 1, 1)


def test_replay_failed_replays_a_proven_failure_whose_rows_are_gone() -> None:
    proven = _PROVEN_FAILURE.model_copy(update={"single_send": True})

    result, submits = _resume_after_proven_failure(proven, replay_failed=True)

    replays = [query_id for query_id in submits if query_id.startswith(f"backfill-{PLAN_ID}-c1-")]
    assert sorted(submits) == sorted([f"backfill-{PLAN_ID}-c2", *replays])
    assert len(replays) == 1
    assert (result.progress["c1"].status, result.progress["c1"].query_id) == ("done", replays[0])


@pytest.mark.parametrize("replay_failed", [False, True])
def test_a_failure_an_older_release_recorded_still_needs_proof(replay_failed: bool) -> None:
    with pytest.raises(RuntimeError) as raised:
        _resume_after_proven_failure(_PROVEN_FAILURE, replay_failed=replay_failed)

    assert (
        f"chunk c1 (query_id backfill-{PLAN_ID}-c1): it is not running on any replica and "
        "system.query_log has no outcome for it."
    ) in str(raised.value)


# Opus critic, item 1: an interrupt never waits without end for a request that
# was admitted and never started.
def test_a_send_stuck_before_its_transport_keeps_the_lock() -> None:
    sending = threading.Event()

    class Stuck(MockExecutor):
        # Admitted by the run, then stuck before its request reaches the
        # transport (nothing there to abandon).
        def submit_once(self, statement: str, query_id: str) -> str:
            sending.set()
            threading.Event().wait(30)
            return query_id

    stop = threading.Event()
    outcome: list[BaseException] = []

    def run() -> None:
        try:
            execute_backfill(
                executor=Stuck({}),
                plan_id=PLAN_ID,
                chunk_ids=["c1"],
                build_query=lambda _chunk_id: "INSERT INTO t SELECT 1",
                poll_interval_ms=1,
                stop=stop,
                handoff_timeout_ms=100,
            )
        except BaseException as error:
            outcome.append(error)

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    assert sending.wait(5)

    stop.set()
    worker.join(5)

    assert len(outcome) == 1
    error = outcome[0]
    assert isinstance(error, BackfillInterruptedError)
    assert error.keep_lock is True
    assert (
        "The send of chunk c1 did not reach the server in time and could not be stopped "
        "(chunk c1): it may still be sent while this process runs, so its attempt stays "
        "recorded as one that may have run and the plan's lock stays in place."
    ) in str(error)


# Opus critic, parallel_distributed_insert_select: with no failure provable for
# the target, a zero-row failure is unknown and nothing is replayed.
def test_a_zero_row_failure_of_a_target_whose_failures_cannot_be_proven_is_unknown() -> None:
    reason = (
        "its target app.events is a Distributed table, whose shards can write the rows of "
        "an INSERT SELECT without system.query_log counting them in its written_rows"
    )
    executor = SubmitRecordingExecutor(
        {f"backfill-{PLAN_ID}-c1": [QueryStatus(status="failed", error="shard failed")]}
    )

    def run(resume_from: BackfillProgress | None, *, replay_failed: bool = False) -> None:
        execute_backfill(
            executor=executor,
            plan_id=PLAN_ID,
            chunk_ids=["c1"],
            build_query=lambda _chunk_id: "INSERT INTO app.events SELECT 1",
            poll_interval_ms=1,
            outcome_recheck_attempts=1,
            outcome_recheck_interval_ms=1,
            resume_from=resume_from,
            checkpoint_version=CHECKPOINT_VERSION,
            replay_failed=replay_failed,
            unprovable_failures=reason,
        )

    # A run that sees the failure stops instead of recording it failed.
    with pytest.raises(RuntimeError) as raised:
        run(None)
    assert f"chunk c1 (query_id backfill-{PLAN_ID}-c1): {reason}." in str(raised.value)
    assert executor.submit_order == [f"backfill-{PLAN_ID}-c1"]
    # A resume with --replay-failed replays nothing.
    submitted = BackfillChunkState(
        status="submitted", query_id=f"backfill-{PLAN_ID}-c1", single_send=True
    )
    with pytest.raises(RuntimeError) as raised:
        run({"c1": submitted}, replay_failed=True)
    assert f"chunk c1 (query_id backfill-{PLAN_ID}-c1): {reason}." in str(raised.value)
    assert len(executor.submit_order) == 1
