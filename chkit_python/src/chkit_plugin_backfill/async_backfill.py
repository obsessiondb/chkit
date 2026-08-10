"""Chunked backfill execution loop with polling + checkpointing.

Port of ``packages/plugin-backfill/src/async-backfill.ts``.

Concurrency model (documented in DRIFT.md): TS submits fire-and-forget HTTP
queries and polls them from one event loop, bounded by ``pMap``. The Python
ClickHouse client is synchronous, so this port runs each chunk's
submit-then-poll lifecycle on a :class:`~concurrent.futures.ThreadPoolExecutor`
bounded by ``concurrency``. The shared progress map is guarded by a lock and
``on_progress`` always receives a consistent snapshot. The executor object
must be safe for concurrent use across those worker threads (the plugin's run
command hands in a per-thread-connection wrapper; the deterministic query-id +
``sync_progress`` reconciliation semantics are unchanged).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Protocol, TypeAlias

from chkit.clickhouse.client import QueryStatus
from chkit_plugin_backfill.types import (
    BackfillChunkState,
    BackfillProgress,
)

_DEFAULT_CONCURRENCY = 3
_DEFAULT_POLL_INTERVAL_MS = 5000
_DEFAULT_MAX_POLL_ERRORS = 10
_REPLAY_AFTER_TIME_BUFFER_MS = 60_000

_BuildQuery: TypeAlias = Callable[[str], str]
_OnProgress: TypeAlias = "Callable[[BackfillProgress], None]"


class BackfillExecutor(Protocol):
    """Executor surface the loop needs (duck-typed; thread-safe across workers)."""

    def submit(self, statement: str, query_id: str | None = None) -> str: ...

    def query_status(
        self, query_id: str, *, after_time: str | None = None
    ) -> QueryStatus: ...

    def query(self, statement: str) -> object: ...


@dataclass(frozen=True)
class BackfillResult:
    total: int
    completed: int
    failed: int
    progress: BackfillProgress


def _now_iso() -> str:
    utc = datetime.now(tz=UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def chunk_query_id(plan_id: str, chunk_id: str) -> str:
    """Build the deterministic query ID for a chunk."""
    return f"backfill-{plan_id}-{chunk_id}"


def _apply_query_status(
    state: BackfillChunkState,
    qs: QueryStatus,
) -> tuple[BackfillChunkState, bool]:
    if qs.status == "running":
        next_state = state.model_copy(
            update={
                "status": "running",
                "read_rows": qs.read_rows,
                "read_bytes": qs.read_bytes,
                "written_rows": qs.written_rows,
                "written_bytes": qs.written_bytes,
                "elapsed_ms": qs.elapsed_ms,
            }
        )
        metrics_changed = (
            state.status != "running"
            or state.read_rows != qs.read_rows
            or state.written_rows != qs.written_rows
            or state.elapsed_ms != qs.elapsed_ms
        )
        return next_state, metrics_changed
    if qs.status == "finished":
        return (
            state.model_copy(
                update={
                    "status": "done",
                    "finished_at": _now_iso(),
                    "duration_ms": qs.duration_ms,
                    "written_rows": qs.written_rows,
                    "written_bytes": qs.written_bytes,
                }
            ),
            True,
        )
    if qs.status == "failed":
        return (
            state.model_copy(
                update={
                    "status": "failed",
                    "finished_at": _now_iso(),
                    "duration_ms": qs.duration_ms,
                    "error": qs.error,
                }
            ),
            True,
        )
    # 'unknown' — leave status as-is (query_log may not have flushed yet)
    return state, False


def _get_chunk(progress: BackfillProgress, chunk_id: str) -> BackfillChunkState:
    state = progress.get(chunk_id)
    if state is None:
        msg = f"No progress entry for chunk {chunk_id}"
        raise RuntimeError(msg)
    return state


def _escape_like_prefix(prefix: str) -> str:
    return (
        prefix.replace("'", "''").replace("%", "\\%").replace("_", "\\_")
    )


def sync_progress(
    executor: BackfillExecutor,
    plan_id: str,
    chunk_ids: list[str],
    progress: BackfillProgress,
) -> BackfillProgress:
    """Reconcile local progress with server-side state.

    Queries ``system.processes`` and ``system.query_log`` for all chunk query
    IDs to discover queries that were submitted but whose status was never
    persisted locally (e.g. client crash between submit and state write).

    Divergence from TS (mirrors the Python client's ``query_status``): plain
    ``system.processes`` / ``system.query_log`` instead of
    ``clusterAllReplicas('cluster', ...)`` — the TS spelling assumes
    ObsessionDB-style cluster naming that isn't portable across bare
    ClickHouse installs. Recorded in DRIFT.md.
    """
    prefix = f"backfill-{plan_id}-"

    # Collect query IDs for non-terminal chunks that need reconciliation
    chunk_ids_to_sync: list[str] = []
    for chunk_id in chunk_ids:
        state = progress.get(chunk_id)
        if state is None or state.status == "done":
            continue
        chunk_ids_to_sync.append(chunk_id)

    if not chunk_ids_to_sync:
        return progress

    # Escape single-quotes in the prefix for safe SQL embedding
    safe_prefix = _escape_like_prefix(prefix)

    running_result = executor.query(
        "SELECT query_id FROM system.processes "
        f"WHERE user = currentUser() AND query_id LIKE '{safe_prefix}%'"
    )
    running_set = {
        str(row.get("query_id"))
        for row in _rows_of(running_result)
        if row.get("query_id") is not None
    }

    log_result = executor.query(
        "SELECT query_id, type, written_rows, written_bytes, query_duration_ms,"
        " exception\n"
        "FROM system.query_log\n"
        "WHERE user = currentUser()\n"
        f"  AND query_id LIKE '{safe_prefix}%'\n"
        "  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')\n"
        "  AND is_initial_query = 1\n"
        "ORDER BY event_time DESC"
    )

    # Deduplicate: take the latest log entry per query_id (results are ordered
    # by event_time DESC)
    latest_log_by_query_id: dict[str, dict[str, object]] = {}
    for row in _rows_of(log_result):
        query_id = str(row.get("query_id"))
        if query_id not in latest_log_by_query_id:
            latest_log_by_query_id[query_id] = row

    updated = dict(progress)

    for chunk_id in chunk_ids_to_sync:
        query_id = chunk_query_id(plan_id, chunk_id)
        current = updated.get(chunk_id)
        if current is None:
            continue

        if query_id in running_set:
            updated[chunk_id] = current.model_copy(
                update={"status": "running", "query_id": query_id}
            )
        else:
            log_entry = latest_log_by_query_id.get(query_id)
            if log_entry is not None:
                if str(log_entry.get("type")) == "QueryFinish":
                    updated[chunk_id] = current.model_copy(
                        update={
                            "status": "done",
                            "query_id": query_id,
                            "finished_at": _now_iso(),
                            "written_rows": _to_int(log_entry.get("written_rows")),
                            "written_bytes": _to_int(log_entry.get("written_bytes")),
                            "duration_ms": _to_int(log_entry.get("query_duration_ms")),
                        }
                    )
                else:
                    updated[chunk_id] = current.model_copy(
                        update={
                            "status": "failed",
                            "query_id": query_id,
                            "finished_at": _now_iso(),
                            "duration_ms": _to_int(log_entry.get("query_duration_ms")),
                            "error": _to_str(log_entry.get("exception")),
                        }
                    )

    return updated


def _rows_of(result: object) -> list[dict[str, object]]:
    """Accept either a raw row list or the client's ``QueryResult`` envelope."""
    rows = getattr(result, "rows", result)
    if isinstance(rows, list):
        return [row for row in rows if isinstance(row, dict)]
    return []


def _to_int(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(float(str(value)))
    except ValueError:
        return None


def _to_str(value: object) -> str | None:
    return str(value) if value is not None else None


def execute_backfill(  # noqa: PLR0915 — mirrors the TS loop's structure
    *,
    executor: BackfillExecutor,
    plan_id: str,
    chunk_ids: list[str],
    build_query: _BuildQuery,
    concurrency: int = _DEFAULT_CONCURRENCY,
    poll_interval_ms: int = _DEFAULT_POLL_INTERVAL_MS,
    max_poll_errors: int = _DEFAULT_MAX_POLL_ERRORS,
    on_progress: _OnProgress | None = None,
    resume_from: BackfillProgress | None = None,
    replay_failed: bool = False,
) -> BackfillResult:
    progress: BackfillProgress = {}
    for chunk_id in chunk_ids:
        resumed = resume_from.get(chunk_id) if resume_from is not None else None
        progress[chunk_id] = (
            resumed.model_copy()
            if resumed is not None
            else BackfillChunkState(status="pending")
        )

    # When resuming, reconcile local state with the server before processing.
    # This catches queries that were submitted but whose status was never
    # persisted (e.g. client crash between submit() and state file write).
    if resume_from is not None:
        progress = sync_progress(executor, plan_id, chunk_ids, progress)

    # Reset confirmed-failed chunks to pending AFTER sync so we operate on
    # ground truth. The deterministic query_id is reused; the after_time filter
    # in query_status ensures we ignore stale query_log entries from prior
    # attempts.
    if replay_failed:
        # Stamp submitted_at with a 60s buffer so the after_time filter in
        # query_status ignores stale query_log entries from the prior failed
        # attempt while tolerating clock skew between client and server.
        replay_after = datetime.now(tz=UTC) - timedelta(
            milliseconds=_REPLAY_AFTER_TIME_BUFFER_MS
        )
        replay_after_time = (
            replay_after.strftime("%Y-%m-%dT%H:%M:%S.")
            + f"{replay_after.microsecond // 1000:03d}Z"
        )
        for chunk_id in chunk_ids:
            state = progress.get(chunk_id)
            if state is not None and state.status == "failed":
                progress[chunk_id] = BackfillChunkState(
                    status="pending", submitted_at=replay_after_time
                )

    lock = Lock()
    # Serializes snapshot + on_progress so checkpoint writes stay ordered and
    # never interleave (TS is single-threaded, so its writeJson calls are
    # naturally sequential — this lock restores that invariant).
    persist_lock = Lock()

    def emit_progress() -> None:
        if on_progress is not None:
            with persist_lock:
                with lock:
                    snapshot = dict(progress)
                on_progress(snapshot)

    # Persist the reconciled state so the caller's checkpoint is up to date
    if resume_from is not None or replay_failed:
        emit_progress()

    def set_chunk(chunk_id: str, next_state: BackfillChunkState) -> None:
        with lock:
            progress[chunk_id] = next_state
        emit_progress()

    def poll_chunk(initial: BackfillChunkState, chunk_id: str) -> BackfillChunkState:
        state = initial
        consecutive_errors = 0
        while state.status in {"submitted", "running"}:
            time.sleep(poll_interval_ms / 1000)
            if state.query_id is None:
                break
            try:
                qs = executor.query_status(
                    state.query_id, after_time=state.submitted_at
                )
            except Exception:
                consecutive_errors += 1
                if consecutive_errors >= max_poll_errors:
                    state = state.model_copy(
                        update={
                            "status": "failed",
                            "finished_at": _now_iso(),
                            "error": (
                                "Lost contact with query after "
                                f"{consecutive_errors} consecutive poll errors"
                            ),
                        }
                    )
                    set_chunk(chunk_id, state)
                    break
                continue
            consecutive_errors = 0
            next_state, changed = _apply_query_status(state, qs)
            if changed:
                state = next_state
                set_chunk(chunk_id, state)
        return state

    def run_chunk(chunk_id: str) -> None:
        with lock:
            state = _get_chunk(progress, chunk_id)

        # Already terminal from a previous run
        if state.status in {"done", "failed"}:
            return

        # Resumed in-flight: poll to completion
        if state.status in {"submitted", "running"}:
            if state.query_id is None:
                set_chunk(chunk_id, state.model_copy(update={"status": "pending"}))
            else:
                poll_chunk(state, chunk_id)
                return

        # Submit and poll.
        # submitted_at is intentionally omitted on first submission — it's only
        # used as an after_time filter to ignore stale query_log entries when
        # replaying a previously failed chunk with the same deterministic
        # query_id. Setting it to local time here would cause clock-skew issues
        # with the ClickHouse server, making the filter exclude valid entries.
        query_id = chunk_query_id(plan_id, chunk_id)
        sql = build_query(chunk_id)
        executor.submit(sql, query_id)
        with lock:
            submitted = _get_chunk(progress, chunk_id).model_copy(
                update={"status": "submitted", "query_id": query_id}
            )
        set_chunk(chunk_id, submitted)

        poll_chunk(submitted, chunk_id)

    if chunk_ids:
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            futures = [pool.submit(run_chunk, chunk_id) for chunk_id in chunk_ids]
            try:
                for future in futures:
                    future.result()
            except BaseException:
                # pMap's default stopOnError: stop launching queued chunks on
                # the first failure (already-running ones still finish).
                for future in futures:
                    future.cancel()
                raise

    with lock:
        completed = sum(
            1
            for chunk_id in chunk_ids
            if _get_chunk(progress, chunk_id).status == "done"
        )
        failed = sum(
            1
            for chunk_id in chunk_ids
            if _get_chunk(progress, chunk_id).status == "failed"
        )
        final_progress = dict(progress)

    return BackfillResult(
        total=len(chunk_ids),
        completed=completed,
        failed=failed,
        progress=final_progress,
    )


__all__ = [
    "BackfillExecutor",
    "BackfillResult",
    "chunk_query_id",
    "execute_backfill",
    "sync_progress",
]
