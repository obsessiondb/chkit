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
