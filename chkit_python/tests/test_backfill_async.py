"""Tests for the async backfill execution loop.

1:1 port of ``packages/plugin-backfill/src/async-backfill.test.ts``.

Covers ``execute_backfill`` (completion, failures, concurrency ordering,
progress callbacks, intermediate metrics, resume, poll-error handling,
replay of failed chunks) and ``sync_progress`` (server-side reconciliation
via ``system.processes`` / ``system.query_log``).
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest

from chkit.clickhouse.client import QueryStatus
from chkit_plugin_backfill.async_backfill import (
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


class _Result:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows


class MockExecutor:
    """Match query IDs by chunk prefix (e.g. "backfill-test-plan-c1")."""

    def __init__(self, statuses: dict[str, list[QueryStatus]] | None = None) -> None:
        self._statuses = statuses if statuses is not None else {}
        self._call_counts: dict[str, int] = {}
        self._lock = threading.Lock()

    def submit(self, statement: str, query_id: str | None = None) -> str:
        return query_id if query_id is not None else str(uuid.uuid4())

    def query_status(self, query_id: str, *, after_time: str | None = None) -> QueryStatus:
        sequence = self._statuses.get(query_id, [QueryStatus(status="unknown")])
        with self._lock:
            count = self._call_counts.get(query_id, 0)
            self._call_counts[query_id] = count + 1
        return sequence[min(count, len(sequence) - 1)]

    def query(self, statement: str) -> _Result:
        # Rows in a result, as the client returns them (the replica probe
        # reads ``.rows``).
        return _Result(self._rows(statement))

    def _rows(self, statement: str) -> list[dict[str, object]]:
        # A replay reads the server time for its query_log bound.
        if "now64" in statement:
            return [{"now_ms": str(int(time.time() * 1000))}]
        return []


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
            super().__init__()
            self.call_count = 0
            self._count_lock = threading.Lock()

        def query_status(
            self, query_id: str, *, after_time: str | None = None
        ) -> QueryStatus:
            with self._count_lock:
                self.call_count += 1
                count = self.call_count
            if count <= 2:
                msg = "ECONNRESET"
                raise ConnectionError(msg)
            return QueryStatus(status="finished", written_rows=10, written_bytes=40, duration_ms=30)

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


def test_fails_chunk_after_max_consecutive_poll_errors() -> None:
    class AlwaysErrorExecutor(MockExecutor):
        def query_status(
            self, query_id: str, *, after_time: str | None = None
        ) -> QueryStatus:
            msg = "ETIMEDOUT"
            raise ConnectionError(msg)

    result = execute_backfill(
        executor=AlwaysErrorExecutor(),
        plan_id=PLAN_ID,
        chunk_ids=["c1"],
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        max_poll_errors=3,
    )

    assert result.completed == 0
    assert result.failed == 1
    assert result.progress["c1"].status == "failed"
    assert result.progress["c1"].error is not None
    assert "3 consecutive poll errors" in result.progress["c1"].error


def test_replay_failed_resets_failed_chunks_after_sync() -> None:
    query_id = f"backfill-{PLAN_ID}-c1"
    statuses = {
        query_id: [
            QueryStatus(status="finished", written_rows=42, written_bytes=200, duration_ms=80),
        ],
        f"backfill-{PLAN_ID}-c2": [
            QueryStatus(status="finished", written_rows=10, written_bytes=50, duration_ms=20),
        ],
    }

    resume_from: BackfillProgress = {
        "c1": BackfillChunkState(status="failed", query_id=query_id, error="OOM"),
        "c2": BackfillChunkState(
            status="done", query_id=f"backfill-{PLAN_ID}-c2", written_rows=10
        ),
    }

    class ReplayExecutor(MockExecutor):
        # The replay runs under its own id (#765), which starts with the chunk's.
        def query_status(
            self, query_id: str, *, after_time: str | None = None
        ) -> QueryStatus:
            replayed = query_id.startswith(f"{first_id}-")
            return super().query_status(
                first_id if replayed else query_id, after_time=after_time
            )

    first_id = query_id
    result = execute_backfill(
        executor=ReplayExecutor(statuses),
        plan_id=PLAN_ID,
        chunk_ids=CHUNK_IDS,
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        resume_from=resume_from,
        replay_failed=True,
    )

    assert result.completed == 2
    assert result.failed == 0
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].written_rows == 42


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
        ),
    }

    synced = sync_progress(FailedServerStateExecutor(), PLAN_ID, ["c1"], progress)
    assert synced["c1"].status == "failed"
    assert synced["c1"].error == "Memory limit exceeded"


# #289: a chunk query runs on the replica that received it. Resume submits
# every chunk ``sync_progress`` does not find, so it reads each replica.


class ReplicatedServerExecutor(SubmitRecordingExecutor):
    """A multi-replica server: the replica probe of ``cluster`` finds ``replicas``."""

    def __init__(
        self,
        *,
        cluster: str = "default",
        replicas: int = 2,
        running: list[str] | None = None,
        fail_on: str | None = None,
        statuses: dict[str, list[QueryStatus]] | None = None,
    ) -> None:
        super().__init__(statuses or {})
        self._cluster = cluster
        self._replicas = replicas
        self._running = running or []
        self._fail_on = fail_on
        self.queries: list[str] = []

    def query(self, statement: str) -> _Result:
        self.queries.append(statement)
        if f"clusterAllReplicas('{self._cluster}', system.one)" in statement:
            return _Result([{"replicas": self._replicas}])
        if self._fail_on is not None and self._fail_on in statement:
            msg = "Code: 279. ALL_CONNECTION_TRIES_FAILED"
            raise RuntimeError(msg)
        if f"clusterAllReplicas('{self._cluster}', system.processes)" in statement:
            return _Result([{"query_id": query_id} for query_id in self._running])
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
    executor = ReplicatedServerExecutor(
        cluster="analytics",
        replicas=4,
        running=[query_id],
        statuses={query_id: [QueryStatus(status="finished", written_rows=7)]},
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
# attempt the run submits is in system.processes for ``running_reads`` status
# reads of its id, then logged once more query_log reads (by query_status or
# by a resume's sync) have passed: the flush gap. An attempt that ended before
# the run starts is logged after ``hidden_log_reads`` query_log reads. Earlier
# attempts' rows stay visible throughout. The server clock runs
# ``clock_offset_ms`` from the client's, and query_status applies after_time to
# query_start_time as the real one does.
@dataclass
class _SimAttempt:
    query_id: str
    outcome: str  # finished | failed | started
    start_ms: float | None = None
    running_reads: int = 0
    status_reads: int = 0
    logged_at_log_read: int = 0


class SimulatedServer(MockExecutor):
    def __init__(
        self,
        *,
        attempts: list[_SimAttempt] | None = None,
        next_outcomes: list[str] | None = None,
        clock_offset_ms: float = 0,
    ) -> None:
        super().__init__()
        self.offset = clock_offset_ms
        self.attempts = list(attempts or [])
        for attempt in self.attempts:
            if attempt.start_ms is None:
                attempt.start_ms = self.server_now()
        self.next_outcomes = list(next_outcomes or [])
        self.submits: list[str] = []
        self.persisted: list[BackfillProgress] = []
        self.after_times: dict[str, list[str | None]] = {}
        self.log_reads = 0

    def server_now(self) -> float:
        return time.time() * 1000 + self.offset

    def _running(self, attempt: _SimAttempt) -> bool:
        return attempt.status_reads < attempt.running_reads

    def _logged(self) -> list[_SimAttempt]:
        # Latest first, as both readers order by event_time DESC.
        return [
            attempt
            for attempt in reversed(self.attempts)
            if not self._running(attempt) and self.log_reads > attempt.logged_at_log_read
        ]

    def submit(self, statement: str, query_id: str | None = None) -> str:
        submitted = query_id if query_id is not None else str(uuid.uuid4())
        with self._lock:
            self.submits.append(submitted)
            # The replay's id is durable before its submit.
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
                    start_ms=self.server_now(),
                    running_reads=1,
                    logged_at_log_read=self.log_reads + 1,
                )
            )
        return submitted

    def query_status(self, query_id: str, *, after_time: str | None = None) -> QueryStatus:
        with self._lock:
            self.after_times.setdefault(query_id, []).append(after_time)
            own = [attempt for attempt in self.attempts if attempt.query_id == query_id]
            latest = own[-1] if own else None
            if latest is not None and self._running(latest):
                latest.status_reads += 1
                return QueryStatus(
                    status="running",
                    read_rows=0,
                    read_bytes=0,
                    written_rows=0,
                    written_bytes=0,
                    elapsed_ms=0,
                )
            if latest is not None:
                latest.status_reads += 1
            self.log_reads += 1
            after = _seconds(after_time) if after_time else 0
            row = next(
                (
                    attempt
                    for attempt in self._logged()
                    if attempt.query_id == query_id
                    and attempt.outcome != "started"
                    and int((attempt.start_ms or 0) // 1000) >= after
                ),
                None,
            )
        if row is None:
            return QueryStatus(status="unknown")
        if row.outcome == "finished":
            return QueryStatus(
                status="finished", written_rows=42, written_bytes=0, duration_ms=1
            )
        return QueryStatus(
            status="failed", duration_ms=1, error="Code: 394. QUERY_WAS_CANCELLED"
        )

    def _rows(self, statement: str) -> list[dict[str, object]]:
        with self._lock:
            if "now64" in statement:
                return [{"now_ms": str(int(self.server_now()))}]
            if "system.processes" in statement:
                return [
                    {"query_id": attempt.query_id}
                    for attempt in self.attempts
                    if self._running(attempt)
                ]
            if "system.query_log" in statement:
                self.log_reads += 1
                return [row for attempt in self._logged() for row in _log_rows(attempt)]
        return []


def _seconds(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def _log_rows(attempt: _SimAttempt) -> list[dict[str, object]]:
    base: dict[str, object] = {
        "query_id": attempt.query_id,
        "start_unix": str(int((attempt.start_ms or 0) // 1000)),
    }
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
        "written_rows": "42" if finished else "0",
        "written_bytes": "0",
        "query_duration_ms": "1",
        "exception": "" if finished else "Code: 394. QUERY_WAS_CANCELLED",
    }
    return [end, start]


FIRST_ID = f"backfill-{PLAN_ID}-c1"
RECORDED_REPLAY_ID = f"{FIRST_ID}-recorded"


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
    resume_from: BackfillProgress,
    *,
    replay_failed: bool = False,
) -> BackfillResult:
    return execute_backfill(
        executor=server,
        plan_id=PLAN_ID,
        chunk_ids=["c1"],
        build_query=lambda _chunk_id: "SELECT 1",
        poll_interval_ms=1,
        outcome_recheck_attempts=3,
        outcome_recheck_interval_ms=1,
        resume_from=resume_from,
        replay_failed=replay_failed,
        on_progress=server.persisted.append,
    )


def _pending_replay() -> BackfillProgress:
    return {
        "c1": BackfillChunkState(
            status="pending", query_id=RECORDED_REPLAY_ID, submitted_at=_hour_ago()
        )
    }


def test_replay_started_seconds_after_the_failure_ends_done() -> None:
    server = SimulatedServer(attempts=[_killed_first()], next_outcomes=["finished"])

    result = _run_once(
        server,
        {
            "c1": BackfillChunkState(
                status="failed", query_id=FIRST_ID, error="Code: 394. QUERY_WAS_CANCELLED"
            )
        },
        replay_failed=True,
    )

    # Releases that reused the first id read its failure while the replay ran.
    assert result.progress["c1"].status == "done"
    assert len(server.submits) == 1
    replay_id = server.submits[0]
    assert replay_id != FIRST_ID
    assert replay_id.startswith(f"{FIRST_ID}-")
    assert result.failed == 0
    assert result.progress["c1"].query_id == replay_id
    assert result.progress["c1"].written_rows == 42


def test_resume_in_the_flush_gap_of_a_committed_replay_records_it_done() -> None:
    # The run died while the replay's submit waited for the INSERT, which then
    # committed; its QueryFinish is not in query_log at the first read.
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(
                query_id=RECORDED_REPLAY_ID, outcome="finished", logged_at_log_read=1
            ),
        ]
    )

    result = _run_once(server, _pending_replay())

    assert server.submits == []
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].query_id == RECORDED_REPLAY_ID
    assert result.progress["c1"].written_rows == 42


def test_resume_in_the_flush_gap_of_a_failed_replay_records_it_failed() -> None:
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(
                query_id=RECORDED_REPLAY_ID, outcome="failed", logged_at_log_read=1
            ),
        ]
    )

    result = _run_once(server, _pending_replay())

    assert server.submits == []
    assert result.progress["c1"].status == "failed"
    assert result.progress["c1"].query_id == RECORDED_REPLAY_ID


def test_replay_that_never_ran_is_submitted_once_under_its_recorded_id() -> None:
    server = SimulatedServer(attempts=[_killed_first()], next_outcomes=["finished"])

    result = _run_once(server, _pending_replay())

    assert server.submits == [RECORDED_REPLAY_ID]
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].query_id == RECORDED_REPLAY_ID


@pytest.mark.parametrize("replay_failed", [False, True])
def test_replay_that_started_without_an_outcome_stops_the_resume(
    replay_failed: bool,
) -> None:
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="started"),
        ],
        next_outcomes=["finished"],
    )

    with pytest.raises(RuntimeError) as raised:
        _run_once(server, _pending_replay(), replay_failed=replay_failed)

    assert str(raised.value).startswith(
        f"Backfill plan {PLAN_ID}: the last attempt of chunk c1 (query_id "
        f"{RECORDED_REPLAY_ID}) started, but it is not running on any replica and "
        "system.query_log has no outcome for it. Nothing was submitted, so no chunk "
        "runs twice."
    )
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
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].query_id == RECORDED_REPLAY_ID


def test_resume_reads_a_finished_replay_by_its_own_id() -> None:
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(query_id=RECORDED_REPLAY_ID, outcome="finished"),
        ]
    )

    result = _run_once(
        server,
        {
            "c1": BackfillChunkState(
                status="running", query_id=RECORDED_REPLAY_ID, submitted_at=_hour_ago()
            )
        },
    )

    assert server.submits == []
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].query_id == RECORDED_REPLAY_ID
    assert result.progress["c1"].written_rows == 42


def test_failed_replay_keeps_its_id_and_is_replayed_under_a_third_id() -> None:
    server = SimulatedServer(
        attempts=[_killed_first()], next_outcomes=["failed", "finished"]
    )

    first = _run_once(
        server,
        {"c1": BackfillChunkState(status="failed", query_id=FIRST_ID)},
        replay_failed=True,
    )
    assert first.progress["c1"].status == "failed"
    assert first.progress["c1"].query_id == server.submits[0]
    plain = _run_once(server, first.progress)
    assert plain.progress["c1"].status == "failed"
    assert plain.progress["c1"].query_id == server.submits[0]

    second = _run_once(server, plain.progress, replay_failed=True)

    assert len(server.submits) == 2
    assert len({FIRST_ID, *server.submits}) == 3
    assert second.progress["c1"].status == "done"
    assert second.progress["c1"].query_id == server.submits[1]


def test_replay_is_polled_with_a_server_time_bound_across_clock_skew() -> None:
    server = SimulatedServer(
        attempts=[_killed_first()],
        next_outcomes=["finished"],
        clock_offset_ms=-10 * 60_000,
    )

    result = _run_once(
        server,
        {"c1": BackfillChunkState(status="failed", query_id=FIRST_ID)},
        replay_failed=True,
    )

    replay_id = server.submits[0]
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].query_id == replay_id
    # The bound prunes query_log by event_date: an hour before the server's time.
    bounds = server.after_times.get(replay_id, [])
    assert bounds
    for bound in bounds:
        assert bound is not None
        lag = time.time() * 1000 - 10 * 60_000 - _seconds(bound) * 1000
        assert 59 * 60_000 < lag < 61 * 60_000


def test_replay_an_older_release_reset_but_never_submitted_gets_a_new_id() -> None:
    # Older releases reset a failed chunk to pending with submitted_at = now - 60 s.
    server = SimulatedServer(attempts=[_killed_first()], next_outcomes=["finished"])

    result = _run_once(
        server,
        {"c1": BackfillChunkState(status="pending", submitted_at=_iso_ms_ago(60_000))},
        replay_failed=True,
    )

    assert len(server.submits) == 1
    assert server.submits[0] != FIRST_ID
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].query_id == server.submits[0]


@pytest.mark.parametrize("status", ["pending", "running"])
def test_older_release_replay_committed_in_the_flush_gap_is_not_taken_for_the_failure(
    status: str,
) -> None:
    # An older release reset c1 (submitted_at = now - 60 s) and submitted the
    # replay under the shared id; the run died and this release resumes before
    # the replay's QueryFinish is in query_log.
    server = SimulatedServer(
        attempts=[
            _killed_first(),
            _SimAttempt(query_id=FIRST_ID, outcome="finished", logged_at_log_read=1),
        ]
    )

    result = _run_once(
        server,
        {
            "c1": BackfillChunkState.model_validate(
                {
                    "status": status,
                    "submittedAt": _iso_ms_ago(60_000),
                    **({"queryId": FIRST_ID} if status == "running" else {}),
                }
            )
        },
    )

    assert server.submits == []
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].query_id == FIRST_ID


def test_older_release_shared_id_replay_that_failed_is_recorded_failed() -> None:
    server = SimulatedServer(attempts=[_killed_first()])

    result = _run_once(
        server,
        {"c1": BackfillChunkState(status="pending", submitted_at=_iso_ms_ago(60_000))},
    )

    assert server.submits == []
    assert result.progress["c1"].status == "failed"
    assert result.progress["c1"].query_id == FIRST_ID


def test_replay_an_older_release_left_running_is_polled_from_its_submitted_at() -> None:
    killed = _killed_first()
    killed.start_ms = time.time() * 1000 - 120_000
    server = SimulatedServer(
        attempts=[
            killed,
            _SimAttempt(query_id=FIRST_ID, outcome="finished", running_reads=2),
        ]
    )

    result = _run_once(
        server,
        {
            "c1": BackfillChunkState(
                status="running", query_id=FIRST_ID, submitted_at=_iso_ms_ago(60_000)
            )
        },
    )

    assert server.submits == []
    assert result.progress["c1"].status == "done"
    assert result.progress["c1"].query_id == FIRST_ID


def test_resume_whose_replica_probe_fails_submits_nothing() -> None:
    class ProbeFails(SimulatedServer):
        def _rows(self, statement: str) -> list[dict[str, object]]:
            if "system.one" in statement:
                msg = "Code: 210. NETWORK_ERROR"
                raise RuntimeError(msg)
            return super()._rows(statement)

    server = ProbeFails(attempts=[_killed_first()], next_outcomes=["finished"])

    with pytest.raises(RuntimeError, match=r"could not check which chunks are still running on the server \(Code: 210\. NETWORK_ERROR\)"):
        _run_once(server, _pending_replay())
    assert server.submits == []
