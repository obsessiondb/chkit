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
    probe_replica_access,
    string_literal,
)
from chkit_plugin_backfill.types import (
    BackfillChunkState,
    BackfillProgress,
)

_DEFAULT_CONCURRENCY = 3
_DEFAULT_POLL_INTERVAL_MS = 5000
_DEFAULT_MAX_POLL_ERRORS = 10
# A resume reads an unsettled outcome again 5 times, 2 s apart, which covers
# query_log's default 7.5 s flush interval (as #721 does for migrate). An
# outcome still missing after that is unknown, never taken for "never ran".
_OUTCOME_RECHECK_ATTEMPTS = 5
_OUTCOME_RECHECK_INTERVAL_MS = 2000
_REPLAY_BOUND_MARGIN_MS = 60 * 60 * 1000

_BuildQuery: TypeAlias = Callable[[str], str]
_OnProgress: TypeAlias = "Callable[[BackfillProgress], None]"


class BackfillExecutor(Protocol):
    """Executor surface the loop needs (duck-typed; thread-safe across workers)."""

    def submit(self, statement: str, query_id: str | None = None) -> str: ...

    def query_status(self, query_id: str, *, running_only: bool = False) -> QueryStatus: ...

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

    A chunk query runs on the replica that received it. So on a multi-replica
    target both tables are read on every replica of ``cluster`` (the
    configured ``clickhouse.cluster``, or ``default``) through
    ``clusterAllReplicas``, and a replica (or the replica probe) that cannot
    be read fails the sync instead of being skipped (#289).

    This is one read. An outcome it cannot settle (see ``_classify_attempt``)
    leaves the chunk as it was; ``execute_backfill`` reads those chunks again
    through the query_log flush window before it submits anything.
    """
    to_sync = _chunks_to_sync(chunk_ids, progress)
    if not to_sync:
        return progress
    evidence = _read_chunk_queries(
        executor, plan_id, cluster, prefix=f"backfill-{plan_id}-"
    )
    return _apply_evidence(
        plan_id, to_sync, progress, evidence, final=False, verify_failed=False
    ).progress


def _chunks_to_sync(chunk_ids: list[str], progress: BackfillProgress) -> list[str]:
    return [
        chunk_id
        for chunk_id in chunk_ids
        if (state := progress.get(chunk_id)) is not None and state.status != "done"
    ]


@dataclass(frozen=True)
class _UnknownAttempt:
    """A chunk whose last attempt may have run, and whose outcome the server
    does not show."""

    chunk_id: str
    query_id: str
    reason: str


def _reconcile_progress(
    executor: BackfillExecutor,
    plan_id: str,
    chunk_ids: list[str],
    progress: BackfillProgress,
    *,
    cluster: str | None,
    attempts: int,
    interval_ms: int,
    verify_failed: bool,
) -> tuple[BackfillProgress, list[_UnknownAttempt]]:
    """The sync before a resume submits anything: one read of every chunk,
    then reads of the chunks whose outcome is not settled yet, ``attempts``
    times, ``interval_ms`` apart, which covers the query_log flush interval
    (#765, as #721 does for async migrate). The last read has no time bound,
    so a replica clock that differs from the one the bound came from cannot
    hide a row. Returns the chunks whose attempt may have run and still has no
    outcome."""
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
            plan_id,
            to_sync,
            current,
            evidence,
            final=round_ >= attempts,
            verify_failed=verify_failed,
        )
        current = passed.progress
        if not passed.waiting:
            return current, passed.unknown
        to_sync = passed.waiting
        time.sleep(interval_ms / 1000)
        states = [_get_chunk(current, chunk_id) for chunk_id in to_sync]
        last = round_ + 1 >= attempts
        evidence = _read_chunk_queries(
            executor,
            plan_id,
            cluster,
            ids=[
                _attempt_query_id(plan_id, chunk_id, state)
                for chunk_id, state in zip(to_sync, states, strict=True)
            ],
            after=None if last else _earliest_bound(states),
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
      a bound that only prunes query_log by event_date.
    - ``legacy``: a replay recorded by an older release, which reused the
      chunk's id and set submitted_at to the client time a minute before the
      replay. A failure row of that id may be the earlier attempt's.
    - ``first``: the first attempt, under the chunk's id.
    """
    if _attempt_query_id(plan_id, chunk_id, state) != chunk_query_id(plan_id, chunk_id):
        return "replay"
    return "legacy" if state.submitted_at else "first"


def _attempt_may_have_run(state: BackfillChunkState, *, verify_failed: bool) -> bool:
    """Whether the chunk's last attempt may have reached the server, so that
    finding no row of it is no proof that it never ran:

    - submitted or running;
    - pending with a recorded query id, which is saved before every submit;
    - pending with an older release's replay bound;
    - failed, when the resume is about to replay it (``verify_failed``): a
      checkpoint can record a failure the server never showed, such as a lost
      contact while polling.

    A pending chunk without either was never submitted by this release.
    """
    if state.status in {"submitted", "running"}:
        return True
    if state.status == "pending":
        return state.query_id is not None or state.submitted_at is not None
    return state.status == "failed" and verify_failed


@dataclass(frozen=True)
class _ChunkEvidence:
    running: set[str]
    log_rows: list[dict[str, object]]
    # Set when the replica probe was denied: the reads saw one replica only.
    denied: str | None = None


@dataclass(frozen=True)
class _Outcome:
    kind: str  # running | done | failed | unchanged | wait | unknown
    row: dict[str, object] | None = None
    reason: str | None = None


_FAILURE_TYPES = frozenset({"ExceptionBeforeStart", "ExceptionWhileProcessing"})
_SHARED_ID_REASON = (
    "an older release ran it under the chunk's shared query id, so the failure "
    "in system.query_log may be an earlier attempt's"
)
_NO_OUTCOME_REASON = (
    "it is not running on any replica and system.query_log has no outcome for it"
)


def _classify_attempt(  # noqa: PLR0911 — mirrors the TS classifier
    plan_id: str,
    chunk_id: str,
    state: BackfillChunkState,
    evidence: _ChunkEvidence,
    *,
    final: bool,
    verify_failed: bool,
) -> _Outcome:
    """Classify the attempt from every row of its id, not the latest one: a
    short query's QueryStart and QueryFinish can share an event_time second.

    - Running on a replica, or any QueryFinish of the id: running, or done.
      A QueryFinish means a whole attempt of the chunk committed.
    - A failure row of the attempt's own id: failed. Only that is proof that
      the attempt failed, and so that replaying the chunk cannot write its
      rows twice. An older release's replay shares the id with the earlier
      attempt, so its failure rows prove nothing.
    - Otherwise an attempt that may have run (see ``_attempt_may_have_run``)
      waits through the flush window, then its outcome is unknown. An empty
      query_log is no proof that it never ran: logs can flush late, or not at
      all, and a denied replica probe reads one replica only.
    - Anything else stays as it is.
    """
    query_id = _attempt_query_id(plan_id, chunk_id, state)
    if query_id in evidence.running:
        return _Outcome("running")
    own = [row for row in evidence.log_rows if str(row.get("query_id")) == query_id]
    finish = next((row for row in own if row.get("type") == "QueryFinish"), None)
    if finish is not None:
        return _Outcome("done", finish)
    kind = _attempt_kind(plan_id, chunk_id, state)
    failure = next((row for row in own if row.get("type") in _FAILURE_TYPES), None)
    if failure is not None and kind != "legacy":
        return _Outcome("failed", failure)
    if not _attempt_may_have_run(state, verify_failed=verify_failed):
        return _Outcome("unchanged")
    if not final:
        return _Outcome("wait")
    if failure is not None:
        return _Outcome("unknown", reason=_SHARED_ID_REASON)
    if evidence.denied is not None:
        return _Outcome(
            "unknown",
            reason=(
                f"the user may not read every replica ({evidence.denied}), and the "
                "replica it can read neither runs it nor has an outcome for it"
            ),
        )
    return _Outcome("unknown", reason=_NO_OUTCOME_REASON)


@dataclass(frozen=True)
class _EvidencePass:
    progress: BackfillProgress
    waiting: list[str]
    unknown: list[_UnknownAttempt]


def _apply_evidence(
    plan_id: str,
    chunk_ids: list[str],
    progress: BackfillProgress,
    evidence: _ChunkEvidence,
    *,
    final: bool,
    verify_failed: bool,
) -> _EvidencePass:
    updated = dict(progress)
    waiting: list[str] = []
    unknown: list[_UnknownAttempt] = []
    for chunk_id in chunk_ids:
        current = _get_chunk(updated, chunk_id)
        query_id = _attempt_query_id(plan_id, chunk_id, current)
        outcome = _classify_attempt(
            plan_id, chunk_id, current, evidence, final=final, verify_failed=verify_failed
        )
        if outcome.kind == "running":
            updated[chunk_id] = current.model_copy(
                update={"status": "running", "query_id": query_id}
            )
        elif outcome.kind in {"done", "failed"}:
            updated[chunk_id] = _settled_state(current, query_id, outcome)
        elif outcome.kind == "wait":
            waiting.append(chunk_id)
        elif outcome.kind == "unknown":
            unknown.append(_UnknownAttempt(chunk_id, query_id, outcome.reason or ""))
    return _EvidencePass(updated, waiting, unknown)


def _settled_state(
    current: BackfillChunkState, query_id: str, outcome: _Outcome
) -> BackfillChunkState:
    row = outcome.row or {}
    if outcome.kind == "done":
        return current.model_copy(
            update={
                "status": "done",
                "query_id": query_id,
                "finished_at": _now_iso(),
                "written_rows": _to_int(row.get("written_rows")),
                "written_bytes": _to_int(row.get("written_bytes")),
                "duration_ms": _to_int(row.get("query_duration_ms")),
            }
        )
    return current.model_copy(
        update={
            "status": "failed",
            "query_id": query_id,
            "finished_at": _now_iso(),
            "duration_ms": _to_int(row.get("query_duration_ms")),
            "error": _to_str(row.get("exception")),
        }
    )


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
    """``_read_evidence`` for the resume's sync: a failed read stops the resume."""
    try:
        return _read_evidence(executor, cluster, prefix=prefix, ids=ids, after=after)
    except Exception as error:
        msg = (
            f"Backfill plan {plan_id}: could not check which chunks are still "
            f"running on the server ({error}). Nothing was submitted — re-run "
            "the resume."
        )
        raise RuntimeError(msg) from error


def _read_evidence(
    executor: BackfillExecutor,
    cluster: str | None,
    *,
    prefix: str | None = None,
    ids: list[str] | None = None,
    after: str | None = None,
) -> _ChunkEvidence:
    """Read the chunks' rows in system.processes and system.query_log: by the
    plan's prefix, or by exact ids, pruned by event_date from ``after``. The
    pruning keeps a day of slack, and no row is filtered by its start time,
    since replicas' clocks can differ (#765)."""
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
    access = probe_replica_access(executor, cluster)

    def source(table: str) -> str:
        return all_replicas(access.fanout, table) if access.fanout is not None else table

    running_result = executor.query(
        f"SELECT query_id FROM {source('system.processes')} "
        f"WHERE user = currentUser() AND {match} "
        "SETTINGS skip_unavailable_shards = 0"
    )
    log_result = executor.query(
        "SELECT query_id, type, written_rows, written_bytes, query_duration_ms,"
        " exception\n"
        f"FROM {source('system.query_log')}\n"
        "WHERE user = currentUser()\n"
        f"  AND {match}\n"
        "  AND type IN ('QueryStart', 'QueryFinish', 'ExceptionBeforeStart',"
        " 'ExceptionWhileProcessing')\n"
        f"  AND is_initial_query = 1{pruning}\n"
        "ORDER BY event_time DESC\n"
        "SETTINGS skip_unavailable_shards = 0"
    )
    running = {
        str(row.get("query_id"))
        for row in _rows_of(running_result)
        if row.get("query_id") is not None
    }
    return _ChunkEvidence(
        running=running,
        log_rows=_rows_of(log_result),
        denied=access.error if access.kind == "denied" else None,
    )


def _read_replay_bound(executor: BackfillExecutor, plan_id: str) -> str:
    """The bound a replay's query_log reads start from: the server's time an
    hour before the replay. It only prunes query_log by event_date, with a day
    of slack; the replay's own query id is what tells its rows apart (#765)."""
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


class UnknownOutcomeError(RuntimeError):
    """The run stopped on chunks whose last attempt has an unknown outcome."""


def _unknown_outcome_error(plan_id: str, unknown: list[_UnknownAttempt]) -> UnknownOutcomeError:
    attempts = "; ".join(
        f"chunk {attempt.chunk_id} (query_id {attempt.query_id}): {attempt.reason}"
        for attempt in unknown
    )
    return UnknownOutcomeError(
        f"Backfill plan {plan_id}: the outcome of the last attempt is unknown for "
        f"{attempts}. A chunk whose outcome is unknown is not submitted again, as "
        "it may have written its rows. Re-run the resume once system.query_log "
        "records the outcome, or pass --accept-unknown to replay it under a new "
        "query id, which can write its rows twice."
    )


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


def execute_backfill(  # noqa: PLR0912, PLR0915 — mirrors the TS loop's structure
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
    accept_unknown: bool = False,
    outcome_recheck_attempts: int = _OUTCOME_RECHECK_ATTEMPTS,
    outcome_recheck_interval_ms: int = _OUTCOME_RECHECK_INTERVAL_MS,
) -> BackfillResult:
    """Run the chunks. ``max_poll_errors`` is how many consecutive polls may
    fail, or find a chunk neither running nor with an outcome in
    system.query_log, before its outcome is recorded unknown and the run
    stops. ``replay_failed`` replays chunks whose last attempt the server
    shows failed; ``accept_unknown`` replays those whose outcome is unknown
    instead of stopping, which can write their rows twice."""
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
    # persisted (e.g. client crash between submit() and state file write), and
    # confirms the failure of each chunk --replay-failed is about to replay.
    unknown: list[_UnknownAttempt] = []
    if resume_from is not None:
        progress, unknown = _reconcile_progress(
            executor,
            plan_id,
            chunk_ids,
            progress,
            cluster=cluster,
            attempts=outcome_recheck_attempts,
            interval_ms=outcome_recheck_interval_ms,
            verify_failed=replay_failed,
        )

    # Replay the chunks the server shows failed (with --replay-failed) and,
    # with --accept-unknown, those whose outcome is unknown. Each replay gets a
    # new random query id, recorded here with its query_log bound and persisted
    # below before it is submitted, so polling and a later sync only ever read
    # that attempt's own rows (#765).
    accepted = {attempt.chunk_id for attempt in unknown} if accept_unknown else set()
    if accept_unknown:
        unknown = []
    if not unknown:
        replays = [
            chunk_id
            for chunk_id in chunk_ids
            if (state := progress.get(chunk_id)) is not None
            and (chunk_id in accepted or (replay_failed and state.status == "failed"))
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

    # An attempt that may have run and has no outcome may have written its
    # rows: submitting the chunk again could write them twice (#765).
    if unknown:
        raise _unknown_outcome_error(plan_id, unknown)

    def set_chunk(chunk_id: str, next_state: BackfillChunkState) -> None:
        with lock:
            progress[chunk_id] = next_state
        emit_progress()

    def poll_once(
        state: BackfillChunkState, chunk_id: str, query_id: str, *, final: bool
    ) -> _Outcome | QueryStatus:
        qs = executor.query_status(query_id, running_only=True)
        if qs.status == "running":
            return qs
        evidence = _read_evidence(
            executor, cluster, ids=[query_id], after=None if final else state.submitted_at
        )
        return _classify_attempt(
            plan_id, chunk_id, state, evidence, final=final, verify_failed=False
        )

    def poll_chunk(initial: BackfillChunkState, chunk_id: str) -> _UnknownAttempt | None:
        """Follow a submitted attempt to its outcome. Running is read from
        system.processes (as query_status does, with its metrics); once the
        attempt is not running, the outcome is classified as the resume's
        sync does it, on every replica, so a shared-id failure is never taken
        for the attempt's own. Polls that fail, or find no outcome, count
        towards ``max_poll_errors``; the last has no time bound, and then the
        outcome is unknown: the chunk keeps its state, and the run stops once
        the other chunks end."""
        state = initial
        misses = 0
        while state.status in {"submitted", "running"}:
            time.sleep(poll_interval_ms / 1000)
            query_id = state.query_id
            if query_id is None:
                break
            final = misses + 1 >= max_poll_errors
            try:
                outcome = poll_once(state, chunk_id, query_id, final=final)
            except Exception as error:
                misses += 1
                if misses >= max_poll_errors:
                    return _UnknownAttempt(
                        chunk_id,
                        query_id,
                        f"lost contact with the server after {misses} consecutive "
                        f"poll errors ({error})",
                    )
                continue
            if isinstance(outcome, QueryStatus) or outcome.kind == "running":
                misses = 0
                if isinstance(outcome, QueryStatus):
                    next_state, changed = _apply_query_status(state, outcome)
                else:
                    next_state = state.model_copy(update={"status": "running"})
                    changed = state.status != "running"
                if changed:
                    state = next_state
                    set_chunk(chunk_id, state)
            elif outcome.kind in {"done", "failed"}:
                state = _settled_state(state, query_id, outcome)
                set_chunk(chunk_id, state)
            elif outcome.kind == "unknown":
                return _UnknownAttempt(chunk_id, query_id, outcome.reason or "")
            else:
                misses += 1
        return None

    def run_chunk(chunk_id: str) -> _UnknownAttempt | None:
        with lock:
            state = _get_chunk(progress, chunk_id)

        # Already terminal from a previous run
        if state.status in {"done", "failed"}:
            return None

        # Resumed in-flight: poll to completion
        if state.status in {"submitted", "running"}:
            if state.query_id is None:
                set_chunk(chunk_id, state.model_copy(update={"status": "pending"}))
            else:
                return poll_chunk(state, chunk_id)

        # Record the attempt's query id before its submit, so a run that stops
        # while the INSERT runs leaves a chunk that may have run, never one
        # that looks unsubmitted. A replay's id and bound were recorded
        # already. A first attempt runs under the chunk's id, without
        # submitted_at.
        with lock:
            pending = _get_chunk(progress, chunk_id)
        query_id = (
            pending.query_id
            if pending.query_id is not None
            else chunk_query_id(plan_id, chunk_id)
        )
        if pending.query_id is None:
            set_chunk(chunk_id, pending.model_copy(update={"query_id": query_id}))
        sql = build_query(chunk_id)
        executor.submit(sql, query_id)
        with lock:
            submitted = _get_chunk(progress, chunk_id).model_copy(
                update={"status": "submitted", "query_id": query_id}
            )
        set_chunk(chunk_id, submitted)

        return poll_chunk(submitted, chunk_id)

    poll_unknown: list[_UnknownAttempt] = []
    if chunk_ids:
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            futures = [pool.submit(run_chunk, chunk_id) for chunk_id in chunk_ids]
            try:
                for future in futures:
                    lost = future.result()
                    if lost is not None:
                        poll_unknown.append(lost)
            except BaseException:
                # pMap's default stopOnError: stop launching queued chunks on
                # the first failure; the pool waits for the running ones, so
                # nothing writes the checkpoint after the run returns.
                for future in futures:
                    future.cancel()
                raise
    if poll_unknown:
        raise _unknown_outcome_error(plan_id, poll_unknown)

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
    "UnknownOutcomeError",
    "chunk_query_id",
    "execute_backfill",
    "sync_progress",
]
