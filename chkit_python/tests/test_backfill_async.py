"""Tests for the async backfill execution loop.

1:1 port of ``packages/plugin-backfill/src/async-backfill.test.ts``.

Covers ``execute_backfill`` (completion, failures, concurrency ordering,
progress callbacks, intermediate metrics, resume, poll-error handling,
replay of failed chunks) and ``sync_progress`` (server-side reconciliation
via ``system.processes`` / ``system.query_log``).
"""

from __future__ import annotations

import threading
import uuid

import pytest

from chkit.clickhouse.client import QueryStatus
from chkit_plugin_backfill.async_backfill import execute_backfill, sync_progress
from chkit_plugin_backfill.types import BackfillChunkState, BackfillProgress

PLAN_ID = "test-plan"

CHUNK_IDS = ["c1", "c2"]
CHUNK_WINDOWS = {
    "c1": ("2024-01-01", "2024-01-02"),
    "c2": ("2024-01-02", "2024-01-03"),
}


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

    def query(self, statement: str) -> list[dict[str, object]]:
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

    result = execute_backfill(
        executor=MockExecutor(statuses),
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
        def query(self, statement: str) -> list[dict[str, object]]:
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
        def query(self, statement: str) -> list[dict[str, object]]:
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
            submitted_at="2024-01-01T00:00:00Z",
        ),
    }

    synced = sync_progress(FailedServerStateExecutor(), PLAN_ID, ["c1"], progress)
    assert synced["c1"].status == "failed"
    assert synced["c1"].error == "Memory limit exceeded"


# #289: a chunk query runs on the replica that received it. Resume submits
# every chunk ``sync_progress`` does not find, so it reads each replica.


class _Result:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows


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

    def query(self, statement: str) -> _Result:  # type: ignore[override]
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
