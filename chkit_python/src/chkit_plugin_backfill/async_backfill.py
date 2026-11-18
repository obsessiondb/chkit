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
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock
from typing import Protocol, TypeAlias

from chkit.clickhouse.client import QueryStatus
from chkit.clickhouse.replicas import (
    all_replicas,
    resolve_replica_fanout_or_raise,
    string_literal,
)
from chkit_plugin_backfill.types import (
    BackfillChunkState,
    BackfillProgress,
)

_DEFAULT_CONCURRENCY = 3
_DEFAULT_POLL_INTERVAL_MS = 5000
_DEFAULT_MAX_POLL_ERRORS = 10
# A resume reads an unsettled replay outcome again 5 times, 2 s apart, which
# covers query_log's default 7.5 s flush interval (as #721 does for migrate).
_OUTCOME_RECHECK_ATTEMPTS = 5
_OUTCOME_RECHECK_INTERVAL_MS = 2000
_REPLAY_BOUND_MARGIN_MS = 60 * 60 * 1000

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
    """Build the deterministic query ID of a chunk's first attempt."""
    return f"backfill-{plan_id}-{chunk_id}"


def _replay_query_id(plan_id: str, chunk_id: str) -> str:
    """Build the query ID of a replayed attempt (#765).

    It is random, so the ``system.query_log`` rows under it belong to that
    attempt alone, and it keeps the plan's prefix, so ``sync_progress`` still
    finds it.
    """
    return f"{chunk_query_id(plan_id, chunk_id)}-{uuid.uuid4()}"


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
    *,
    cluster: str | None = None,
) -> BackfillProgress:
    """Reconcile local progress with server-side state.

    Queries ``system.processes`` and ``system.query_log`` for all chunk query
    IDs to discover queries that were submitted but whose status was never
    persisted locally (e.g. client crash between submit and state write).

    A chunk query runs on the replica that received it, and a chunk this read
    does not find is submitted again (#289). So on a multi-replica target both
    tables are read on every replica of ``cluster`` (the configured
    ``clickhouse.cluster``, or ``default``) through ``clusterAllReplicas``, as
    the client's ``query_status`` does, and a replica (or the replica probe)
    that cannot be read fails the sync instead of being skipped.

    This is one read. An outcome it cannot settle yet (see
    ``_classify_attempt``) leaves the chunk as it was; ``execute_backfill``
    reads those chunks again through the query_log flush window before it
    submits anything.
    """
    to_sync = _chunks_to_sync(chunk_ids, progress)
    if not to_sync:
        return progress
    evidence = _read_chunk_queries(
        executor, plan_id, cluster, prefix=f"backfill-{plan_id}-"
    )
    return _apply_evidence(plan_id, to_sync, progress, evidence, final=False).progress


def _chunks_to_sync(chunk_ids: list[str], progress: BackfillProgress) -> list[str]:
    return [
        chunk_id
        for chunk_id in chunk_ids
        if (state := progress.get(chunk_id)) is not None and state.status != "done"
    ]


def _reconcile_progress(
    executor: BackfillExecutor,
    plan_id: str,
    chunk_ids: list[str],
    progress: BackfillProgress,
    *,
    cluster: str | None,
    attempts: int,
    interval_ms: int,
) -> tuple[BackfillProgress, list[str]]:
    """The sync before a resume submits anything: one read of every chunk,
    then reads of the chunks whose outcome is not settled yet, ``attempts``
    times, ``interval_ms`` apart, which covers the query_log flush interval
    (#765, as #721 does for async migrate). Returns the chunks whose attempt
    started and still has no outcome after the last read."""
    to_sync = _chunks_to_sync(chunk_ids, progress)
    if not to_sync:
        return progress, []
    evidence = _read_chunk_queries(
        executor, plan_id, cluster, prefix=f"backfill-{plan_id}-"
    )
    current = progress
    round_ = 0
    while True:
        passed = _apply_evidence(
            plan_id, to_sync, current, evidence, final=round_ >= attempts
        )
        current = passed.progress
        if not passed.waiting:
            return current, passed.unknown
        to_sync = passed.waiting
        time.sleep(interval_ms / 1000)
        states = [_get_chunk(current, chunk_id) for chunk_id in to_sync]
        evidence = _read_chunk_queries(
            executor,
            plan_id,
            cluster,
            ids=[
                _attempt_query_id(plan_id, chunk_id, state)
                for chunk_id, state in zip(to_sync, states, strict=True)
            ],
            after=_earliest_bound(states),
        )
        round_ += 1


def _attempt_query_id(plan_id: str, chunk_id: str, state: BackfillChunkState) -> str:
    """The query id of a chunk's latest attempt."""
    if state.query_id is not None:
        return state.query_id
    return chunk_query_id(plan_id, chunk_id)


def _attempt_kind(plan_id: str, chunk_id: str, state: BackfillChunkState) -> str:
    """How a chunk's latest attempt was recorded.

    - ``replay``: a replay of this release, under a query id of its own
      (#765). Its submitted_at is the server time an hour before the replay,
      a bound that only prunes query_log.
    - ``legacy``: a replay recorded by an older release, which reused the
      chunk's id and set submitted_at to the client time a minute before the
      replay. A failure row after that bound may be the earlier attempt's.
    - ``first``: the first attempt, under the chunk's id.
    """
    if _attempt_query_id(plan_id, chunk_id, state) != chunk_query_id(plan_id, chunk_id):
        return "replay"
    return "legacy" if state.submitted_at else "first"


@dataclass(frozen=True)
class _ChunkEvidence:
    running: set[str]
    log_rows: list[dict[str, object]]


@dataclass(frozen=True)
class _Outcome:
    kind: str  # running | done | failed | unchanged | wait | unknown
    row: dict[str, object] | None = None


def _classify_attempt(  # noqa: PLR0911 — mirrors the TS classifier
    plan_id: str,
    chunk_id: str,
    state: BackfillChunkState,
    evidence: _ChunkEvidence,
    *,
    final: bool,
) -> _Outcome:
    """Classify the attempt from every row of its id, not the latest one: a
    short query's QueryStart and QueryFinish can share an event_time second.

    - Running on a replica, or any QueryFinish: running, or done.
    - A failure: failed, except that a legacy failure is the attempt's own
      only once the flush window has passed without a QueryFinish.
    - A pending replay (this release's or a legacy one) is pending because its
      submit did not return: it may not have run, or it ended and is not in
      query_log yet. It waits through the flush window. Then a QueryStart
      without an outcome is unknown, and no row at all means it never ran.
    - Anything else stays as it is, as before #765: a first attempt is
      submitted again when nothing is found, and a submitted or running chunk
      is polled.
    """
    query_id = _attempt_query_id(plan_id, chunk_id, state)
    if query_id in evidence.running:
        return _Outcome("running")
    bound = (
        int(_parse_iso_ms(state.submitted_at) // 1000)
        if state.submitted_at
        else None
    )
    rows = [
        row
        for row in evidence.log_rows
        if str(row.get("query_id")) == query_id
        and (
            bound is None
            or row.get("start_unix") is None
            or (_to_int(row.get("start_unix")) or 0) >= bound
        )
    ]
    finish = next((row for row in rows if row.get("type") == "QueryFinish"), None)
    if finish is not None:
        return _Outcome("done", finish)
    kind = _attempt_kind(plan_id, chunk_id, state)
    failure = next(
        (row for row in rows if row.get("type") == "ExceptionWhileProcessing"), None
    )
    if failure is not None:
        if kind == "legacy" and not final:
            return _Outcome("wait")
        return _Outcome("failed", failure)
    if state.status != "pending" or kind == "first":
        return _Outcome("unchanged")
    if not final:
        return _Outcome("wait")
    if any(row.get("type") == "QueryStart" for row in rows):
        return _Outcome("unknown")
    return _Outcome("unchanged")


@dataclass(frozen=True)
class _EvidencePass:
    progress: BackfillProgress
    waiting: list[str]
    unknown: list[str]


def _apply_evidence(
    plan_id: str,
    chunk_ids: list[str],
    progress: BackfillProgress,
    evidence: _ChunkEvidence,
    *,
    final: bool,
) -> _EvidencePass:
    updated = dict(progress)
    waiting: list[str] = []
    unknown: list[str] = []
    for chunk_id in chunk_ids:
        current = _get_chunk(updated, chunk_id)
        query_id = _attempt_query_id(plan_id, chunk_id, current)
        outcome = _classify_attempt(plan_id, chunk_id, current, evidence, final=final)
        row = outcome.row or {}
        if outcome.kind == "running":
            updated[chunk_id] = current.model_copy(
                update={"status": "running", "query_id": query_id}
            )
        elif outcome.kind == "done":
            updated[chunk_id] = current.model_copy(
                update={
                    "status": "done",
                    "query_id": query_id,
                    "finished_at": _now_iso(),
                    "written_rows": _to_int(row.get("written_rows")),
                    "written_bytes": _to_int(row.get("written_bytes")),
                    "duration_ms": _to_int(row.get("query_duration_ms")),
                }
            )
        elif outcome.kind == "failed":
            updated[chunk_id] = current.model_copy(
                update={
                    "status": "failed",
                    "query_id": query_id,
                    "finished_at": _now_iso(),
                    "duration_ms": _to_int(row.get("query_duration_ms")),
                    "error": _to_str(row.get("exception")),
                }
            )
        elif outcome.kind == "wait":
            waiting.append(chunk_id)
        elif outcome.kind == "unknown":
            unknown.append(chunk_id)
    return _EvidencePass(updated, waiting, unknown)


def _parse_iso_ms(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


def _earliest_bound(states: list[BackfillChunkState]) -> str | None:
    bounds = [state.submitted_at for state in states]
    present = [bound for bound in bounds if bound is not None]
    if len(present) != len(bounds):
        return None
    return min(present, key=_parse_iso_ms)


def _read_chunk_queries(
    executor: BackfillExecutor,
    plan_id: str,
    cluster: str | None,
    *,
    prefix: str | None = None,
    ids: list[str] | None = None,
    after: str | None = None,
) -> _ChunkEvidence:
    """Read the chunks' rows in system.processes and system.query_log: by the
    plan's prefix, or by exact ids (the rechecks), then pruned by ``after``."""
    if prefix is not None:
        match = f"query_id LIKE '{_escape_like_prefix(prefix)}%'"
    else:
        match = f"query_id IN ({', '.join(string_literal(i) for i in ids or [])})"
    pruning = (
        "\n  AND event_date >= toDate32(parseDateTimeBestEffort("
        f"{string_literal(after)})) - 1"
        if after
        else ""
    )
    try:
        fanout = resolve_replica_fanout_or_raise(executor, cluster)

        def source(table: str) -> str:
            return all_replicas(fanout, table) if fanout else table

        running_result = executor.query(
            f"SELECT query_id FROM {source('system.processes')} "
            f"WHERE user = currentUser() AND {match} "
            "SETTINGS skip_unavailable_shards = 0"
        )
        log_result = executor.query(
            "SELECT query_id, type, written_rows, written_bytes, query_duration_ms,"
            " exception, toUnixTimestamp(query_start_time) AS start_unix\n"
            f"FROM {source('system.query_log')}\n"
            "WHERE user = currentUser()\n"
            f"  AND {match}\n"
            "  AND type IN ('QueryStart', 'QueryFinish', 'ExceptionWhileProcessing')\n"
            f"  AND is_initial_query = 1{pruning}\n"
            "ORDER BY event_time DESC\n"
            "SETTINGS skip_unavailable_shards = 0"
        )
    except Exception as error:
        msg = (
            f"Backfill plan {plan_id}: could not check which chunks are still "
            f"running on the server ({error}). Nothing was submitted — re-run "
            "the resume."
        )
        raise RuntimeError(msg) from error
    running = {
        str(row.get("query_id"))
        for row in _rows_of(running_result)
        if row.get("query_id") is not None
    }
    return _ChunkEvidence(running=running, log_rows=_rows_of(log_result))


def _read_replay_bound(executor: BackfillExecutor, plan_id: str) -> str:
    """The bound a replay's query_log reads start from: the server's time an
    hour before the replay. It only prunes query_log by event_date, and the
    hour covers clock skew between replicas; the replay's own query id is what
    tells its rows apart (#765)."""
    try:
        rows = _rows_of(
            executor.query("SELECT toString(toUnixTimestamp64Milli(now64(3))) AS now_ms")
        )
        now_ms = _to_int(rows[0].get("now_ms")) if rows else None
        if now_ms is None:
            msg = "the server returned no time"
            raise RuntimeError(msg)
    except Exception as error:
        msg = (
            f"Backfill plan {plan_id}: could not read the server time for a replay "
            f"({error}). Nothing was submitted — re-run the resume."
        )
        raise RuntimeError(msg) from error
    bound = datetime.fromtimestamp((now_ms - _REPLAY_BOUND_MARGIN_MS) / 1000, tz=UTC)
    return bound.strftime("%Y-%m-%dT%H:%M:%S.") + f"{bound.microsecond // 1000:03d}Z"


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
    cluster: str | None = None,
    concurrency: int = _DEFAULT_CONCURRENCY,
    poll_interval_ms: int = _DEFAULT_POLL_INTERVAL_MS,
    max_poll_errors: int = _DEFAULT_MAX_POLL_ERRORS,
    on_progress: _OnProgress | None = None,
    resume_from: BackfillProgress | None = None,
    replay_failed: bool = False,
    outcome_recheck_attempts: int = _OUTCOME_RECHECK_ATTEMPTS,
    outcome_recheck_interval_ms: int = _OUTCOME_RECHECK_INTERVAL_MS,
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
    unknown: list[str] = []
    if resume_from is not None:
        progress, unknown = _reconcile_progress(
            executor,
            plan_id,
            chunk_ids,
            progress,
            cluster=cluster,
            attempts=outcome_recheck_attempts,
            interval_ms=outcome_recheck_interval_ms,
        )

    # Reset confirmed-failed chunks to pending AFTER sync so we operate on
    # ground truth. Each replay gets a new random query id, recorded here with
    # its query_log bound and persisted below before it is submitted, so
    # polling and a later sync only ever read that attempt's own rows (#765).
    # Reusing the failed attempt's id let its ExceptionWhileProcessing row mark
    # the replay failed while it ran. A replay an older release reset but did
    # not record as submitted gets one too.
    if not unknown:
        replays = [
            chunk_id
            for chunk_id in chunk_ids
            if (state := progress.get(chunk_id)) is not None
            and (
                (replay_failed and state.status == "failed")
                or (
                    state.status == "pending"
                    and _attempt_kind(plan_id, chunk_id, state) == "legacy"
                )
            )
        ]
        if replays:
            submitted_at = _read_replay_bound(executor, plan_id)
            for chunk_id in replays:
                progress[chunk_id] = BackfillChunkState(
                    status="pending",
                    query_id=_replay_query_id(plan_id, chunk_id),
                    submitted_at=submitted_at,
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

    # A replay that started and has no outcome may have written its rows:
    # submitting the chunk again could write them twice (#765).
    if unknown:
        attempts = ", ".join(
            f"chunk {chunk_id} (query_id "
            f"{_attempt_query_id(plan_id, chunk_id, _get_chunk(progress, chunk_id))})"
            for chunk_id in unknown
        )
        msg = (
            f"Backfill plan {plan_id}: the last attempt of {attempts} started, but "
            "it is not running on any replica and system.query_log has no outcome "
            "for it. Nothing was submitted, so no chunk runs twice. Re-run the "
            "resume once system.query_log records the outcome."
        )
        raise RuntimeError(msg)

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

        # Submit and poll. A pending chunk with a query_id is a replay whose id
        # and bound were persisted before this submit; a run that stopped
        # before the replay ran submits it under that same id. A first attempt
        # has no submitted_at, as before #765.
        with lock:
            recorded_id = _get_chunk(progress, chunk_id).query_id
        query_id = (
            recorded_id if recorded_id is not None else chunk_query_id(plan_id, chunk_id)
        )
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
