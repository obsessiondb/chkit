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

import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock
from typing import Protocol, TypeAlias, TypeVar

from chkit.clickhouse.client import SEND_ADMISSION, SendNotAdmittedError
from chkit.clickhouse.replicas import (
    all_replicas,
    probe_replica_access,
    string_literal,
)
from chkit.core.jsnum import js_math_round
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
# How often the dispatching thread looks at the stop event.
_STOP_CHECK_S = 0.05

#: The checkpoint format of this release (#765): every attempt's query id is
#: saved before its submit, so a pending chunk without one was never
#: submitted, and ``single_send`` marks an attempt sent once. Older releases
#: saved no version; progress in any other format keeps no ``single_send``.
CHECKPOINT_VERSION = 3

_BuildQuery: TypeAlias = Callable[[str], str]
_OnProgress: TypeAlias = "Callable[[BackfillProgress], None]"


_T = TypeVar("_T")


class StopSignal(Protocol):
    """What ``execute_backfill`` reads to stop: a ``threading.Event``, or the
    lock-free flag ``with_run_lock`` sets from a signal handler."""

    def is_set(self) -> bool: ...

    def wait(self, timeout: float | None = None) -> bool: ...


class BackfillExecutor(Protocol):
    """Executor surface the loop needs (duck-typed; thread-safe across workers)."""

    def submit(self, statement: str, query_id: str | None = None) -> str: ...

    def query(self, statement: str) -> object: ...


@dataclass(frozen=True)
class BackfillResult:
    total: int
    completed: int
    failed: int
    progress: BackfillProgress


class BackfillInterruptedError(RuntimeError):
    """``execute_backfill`` stopped because its ``stop`` event was set."""


class UnknownOutcomeError(RuntimeError):
    """The run stopped on chunks whose last attempt has an unknown outcome."""


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


def _running_state(
    state: BackfillChunkState, row: dict[str, object]
) -> tuple[BackfillChunkState, bool]:
    elapsed = row.get("elapsed")
    next_state = state.model_copy(
        update={
            "status": "running",
            "read_rows": _to_int(row.get("read_rows")),
            "read_bytes": _to_int(row.get("read_bytes")),
            "written_rows": _to_int(row.get("written_rows")),
            "written_bytes": _to_int(row.get("written_bytes")),
            "elapsed_ms": int(js_math_round(float(str(elapsed)) * 1000))
            if elapsed is not None
            else None,
        }
    )
    changed = (
        state.status != "running"
        or state.read_rows != next_state.read_rows
        or state.written_rows != next_state.written_rows
        or state.elapsed_ms != next_state.elapsed_ms
    )
    return next_state, changed


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


_ID_BEFORE_SUBMIT_VERSION = 2


def _upgrade_progress(
    plan_id: str,
    chunk_ids: list[str],
    progress: BackfillProgress,
    version: int | None,
) -> BackfillProgress:
    """Progress in another format, in this release's terms. A ``single_send``
    from another format proves nothing: a release that ignores it (a rollback
    to an older one) keeps it and may resend the id. Version 2 already saved
    each query id before its submit, so its pending chunk without one was
    never sent. Any other format (an older release's, which saved the id only
    after the submit returned) may list a chunk as pending, submitted or
    running without an id, or not at all, after it ran under the chunk's id:
    it is recorded under that id, which this release reads as "may have
    run"."""
    upgraded = dict(progress)
    for chunk_id in chunk_ids:
        saved = progress.get(chunk_id)
        state = (
            saved.model_copy(update={"single_send": None})
            if saved is not None
            else BackfillChunkState(status="pending")
        )
        ids_saved_first = version == _ID_BEFORE_SUBMIT_VERSION
        if ids_saved_first or state.status in {"done", "failed"} or state.query_id is not None:
            if saved is not None:
                upgraded[chunk_id] = state
            continue
        upgraded[chunk_id] = state.model_copy(
            update={"query_id": chunk_query_id(plan_id, chunk_id)}
        )
    return upgraded


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
    return _apply_evidence(plan_id, to_sync, progress, evidence, final=False).progress


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
    stop: StopSignal | None,
) -> tuple[BackfillProgress, list[_UnknownAttempt]]:
    """The sync before a resume submits anything: one read of every chunk,
    then reads of the chunks whose outcome is not settled yet, ``attempts``
    times, ``interval_ms`` apart, which covers the query_log flush interval
    (#765, as #721 does for async migrate). The last read has no time bound,
    so a replica clock that differs from the one the bound came from cannot
    hide a row. Returns the chunks whose attempt may have run and has no
    settled outcome."""
    to_sync = _chunks_to_sync(chunk_ids, progress)
    if not to_sync:
        return progress, []
    evidence = _read_chunk_queries(
        executor, plan_id, cluster, prefix=f"backfill-{plan_id}-"
    )
    current = progress
    unknown: list[_UnknownAttempt] = []
    round_ = 0
    while True:
        passed = _apply_evidence(
            plan_id, to_sync, current, evidence, final=round_ >= attempts
        )
        current = passed.progress
        unknown = [*unknown, *passed.unknown]
        if not passed.waiting:
            return current, unknown
        to_sync = passed.waiting
        if stop is not None and stop.wait(interval_ms / 1000):
            raise _interrupted_error(plan_id)
        if stop is None:
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


def _attempt_may_have_run(state: BackfillChunkState) -> bool:
    """Whether the chunk's last attempt may have reached the server, so that
    finding no proof of its outcome leaves it unknown:

    - submitted or running;
    - pending with a recorded query id, which is saved before every submit;
    - pending with an older release's replay bound;
    - failed: a checkpoint can record a failure the server never showed (an
      older release recorded a lost contact while polling as failed), or one
      that wrote rows. Whether it is replayed is up to the flags, not this.

    A pending chunk without either was never submitted.
    """
    if state.status in {"submitted", "running", "failed"}:
        return True
    return state.status == "pending" and (
        state.query_id is not None or state.submitted_at is not None
    )


@dataclass(frozen=True)
class _ChunkEvidence:
    running: dict[str, dict[str, object]]
    log_rows: list[dict[str, object]]
    # Why the reads may have missed a replica (see ``probe_replica_access``).
    partial: str | None = None


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
_RESENT_REASON = (
    "an older release may have sent it more than once under this query id, so the "
    "failure in system.query_log may not be its last send"
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
) -> _Outcome:
    """Classify the attempt from every row of its id, not the latest one: a
    short query's QueryStart and QueryFinish can share an event_time second.
    The flags never change the classification; they decide what is replayed.

    - Running on a replica, or any QueryFinish of the id: running, or done.
      A QueryFinish means a whole attempt of the chunk committed.
    - A failure row of an attempt sent once under its id (``single_send``),
      read on every replica, with no row of the id that wrote a row: failed.
      Only that proves a replay cannot write the chunk's rows twice. A failure
      after a written row is unknown at once: those rows stay, and a replay
      writes them again. An attempt an older release recorded may have been
      sent twice under its id, so its failure rows prove nothing, and a read
      that may have missed a replica cannot rule out a run or a QueryFinish
      on it.
    - Otherwise an attempt that may have run (see ``_attempt_may_have_run``)
      waits through the flush window, then its outcome is unknown. An empty
      query_log is no proof that it never ran: logs can flush late, or not at
      all.
    - Anything else stays as it is.
    """
    query_id = _attempt_query_id(plan_id, chunk_id, state)
    running = evidence.running.get(query_id)
    if running is not None:
        return _Outcome("running", running)
    own = [row for row in evidence.log_rows if str(row.get("query_id")) == query_id]
    finish = next((row for row in own if row.get("type") == "QueryFinish"), None)
    if finish is not None:
        return _Outcome("done", finish)
    kind = _attempt_kind(plan_id, chunk_id, state)
    failure = next((row for row in own if row.get("type") in _FAILURE_TYPES), None)
    if failure is not None and state.single_send is True and evidence.partial is None:
        written = max((_to_int(row.get("written_rows")) or 0) for row in own)
        if written == 0:
            return _Outcome("failed", failure)
        return _Outcome(
            "unknown",
            reason=f"it failed after writing {written} rows, which a replay would write again",
        )
    if not _attempt_may_have_run(state):
        return _Outcome("unchanged")
    if not final:
        return _Outcome("wait")
    if failure is not None and kind == "legacy":
        return _Outcome("unknown", reason=_SHARED_ID_REASON)
    if evidence.partial is not None:
        return _Outcome(
            "unknown",
            reason=(
                f"{evidence.partial}, and the replica it can read shows neither a run "
                "of it nor a QueryFinish"
            ),
        )
    if failure is not None:
        return _Outcome("unknown", reason=_RESENT_REASON)
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
) -> _EvidencePass:
    updated = dict(progress)
    waiting: list[str] = []
    unknown: list[_UnknownAttempt] = []
    for chunk_id in chunk_ids:
        current = _get_chunk(updated, chunk_id)
        query_id = _attempt_query_id(plan_id, chunk_id, current)
        outcome = _classify_attempt(plan_id, chunk_id, current, evidence, final=final)
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
    """``_read_evidence`` for the resume's sync: a failed read, including a
    replica probe that fails for any reason other than a missing cluster or a
    denied user, stops the resume, whatever the flags: nothing was read."""
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
    since replicas' clocks can differ (#765). When the probe cannot show that
    every replica answers, the reads use the local tables, also with
    ``clickhouse.cluster`` set, as TS does, and what they do not find proves
    nothing."""
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
        "SELECT query_id, read_rows, read_bytes, written_rows, written_bytes, elapsed "
        f"FROM {source('system.processes')} "
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
        str(row.get("query_id")): row
        for row in _rows_of(running_result)
        if row.get("query_id") is not None
    }
    return _ChunkEvidence(
        running=running,
        log_rows=_rows_of(log_result),
        partial=access.reason if access.kind == "partial" else None,
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


def _interrupted_error(plan_id: str) -> BackfillInterruptedError:
    return BackfillInterruptedError(
        f"Backfill plan {plan_id}: interrupted. No new chunk was submitted; a chunk "
        "already submitted keeps running on the server, and a resume attaches to it."
    )


@dataclass(frozen=True)
class _Handoff:
    """A chunk's ``SendAdmission``: asks the run again at the transport and
    releases the chunk's admission once its request entered it."""

    may_send: Callable[[], bool]
    release: Callable[[], None]

    def admit(self) -> bool:
        return self.may_send()

    def handed_off(self) -> None:
        self.release()


def run_interruptible(fn: Callable[[], _T], stop: StopSignal | None, plan_id: str) -> _T:
    """``fn()``, or a ``BackfillInterruptedError`` as soon as ``stop`` is set.
    A synchronous read cannot be aborted, so ``fn`` runs on its own daemon
    thread, which is left behind on a stop; the caller exits soon after."""
    if stop is None:
        return fn()
    outcome: list[tuple[bool, object]] = []

    def target() -> None:
        try:
            outcome.append((True, fn()))
        except BaseException as error:
            outcome.append((False, error))

    worker = threading.Thread(target=target, name="backfill-read", daemon=True)
    worker.start()
    while not outcome:
        if stop.is_set():
            raise _interrupted_error(plan_id)
        worker.join(_STOP_CHECK_S)
    ok, value = outcome[0]
    if not ok:
        raise value  # type: ignore[misc]
    return value  # type: ignore[return-value]


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
    checkpoint_version: int | None = None,
    replay_failed: bool = False,
    accept_unknown: bool = False,
    outcome_recheck_attempts: int = _OUTCOME_RECHECK_ATTEMPTS,
    outcome_recheck_interval_ms: int = _OUTCOME_RECHECK_INTERVAL_MS,
    stop: StopSignal | None = None,
) -> BackfillResult:
    """Run the chunks. ``max_poll_errors`` is how many consecutive polls may
    fail before the chunk's outcome is recorded unknown and the run stops.
    ``checkpoint_version`` is the format ``resume_from`` was saved in
    (``CHECKPOINT_VERSION`` for progress this release reported); omit it for
    progress an older release reported, where a chunk listed as pending
    without a query id, or not at all, may have run. ``replay_failed``
    replays chunks whose last attempt the server shows failed before it
    wrote any row; ``accept_unknown`` replays those whose outcome is unknown
    instead of stopping, which can write their rows twice. Setting ``stop``
    stops the run: no new chunk starts, no progress is reported after the
    last report finishes, and a ``BackfillInterruptedError`` is raised.
    Chunks already submitted keep running on the server."""
    if stop is not None and not callable(getattr(executor, "submit_once", None)):
        msg = (
            "An interruptible backfill needs an executor with submit_once, which sends "
            "once and asks the run's admission at the transport: another executor could "
            "send a chunk after the interrupt returned."
        )
        raise ValueError(msg)
    saved = (
        _upgrade_progress(plan_id, chunk_ids, resume_from, checkpoint_version)
        if resume_from is not None and checkpoint_version != CHECKPOINT_VERSION
        else resume_from
    )
    progress: BackfillProgress = {}
    for chunk_id in chunk_ids:
        resumed = saved.get(chunk_id) if saved is not None else None
        progress[chunk_id] = (
            resumed.model_copy()
            if resumed is not None
            else BackfillChunkState(status="pending")
        )

    # When resuming, reconcile local state with the server before processing.
    # This catches queries that were submitted but whose status was never
    # persisted (e.g. client crash between submit() and state file write), and
    # checks the failure of every chunk the checkpoint records failed.
    # A read that hangs (a stalled replica) must not keep an interrupted run,
    # and its lock, waiting: a stop stops waiting for it.
    unknown: list[_UnknownAttempt] = []
    if resume_from is not None:
        reconcile_from = progress
        progress, unknown = run_interruptible(
            lambda: _reconcile_progress(
                executor,
                plan_id,
                chunk_ids,
                reconcile_from,
                cluster=cluster,
                attempts=outcome_recheck_attempts,
                interval_ms=outcome_recheck_interval_ms,
                stop=stop,
            ),
            stop,
            plan_id,
        )
    if stop is not None and stop.is_set():
        raise _interrupted_error(plan_id)

    # Replay the chunks the server shows failed before they wrote a row (with
    # --replay-failed) and, with --accept-unknown, those whose outcome is
    # unknown. A replay gets a new random query id only when its chunk is
    # about to be sent, recorded with its query_log bound before the send, so
    # polling and a later sync only ever read that attempt's own rows (#765),
    # and a chunk the run never reaches keeps its proven state.
    accepted = {attempt.chunk_id for attempt in unknown} if accept_unknown else set()
    if accept_unknown:
        unknown = []
    replays = {
        chunk_id
        for chunk_id in chunk_ids
        if (state := progress.get(chunk_id)) is not None
        and (chunk_id in accepted or (replay_failed and state.status == "failed"))
    }
    replay_bound = (
        run_interruptible(lambda: _read_replay_bound(executor, plan_id), stop, plan_id)
        if not unknown and replays
        else None
    )

    lock = Lock()
    # Serializes snapshot + on_progress so checkpoint writes stay ordered and
    # never interleave (TS is single-threaded, so its writeJson calls are
    # naturally sequential — this lock restores that invariant). Once closed
    # (on stop), nothing is reported after the report in progress ends.
    persist_lock = Lock()
    closed = threading.Event()
    # On the first chunk that fails, or whose outcome is unknown, no new
    # chunk starts; the chunks in flight end first.
    dispatch_stopped = threading.Event()

    def emit_progress() -> None:
        if on_progress is not None:
            with persist_lock:
                if closed.is_set():
                    return
                with lock:
                    snapshot = dict(progress)
                on_progress(snapshot)

    # Chunks between their admission and their request's handoff to the
    # transport (or their refusal and saved-back state). close() waits for
    # them, so no chunk of a stopped run is sent or saved after it returns,
    # and it never waits for an INSERT's response.
    admission = threading.Condition(Lock())
    admitted = [0]
    single_send = callable(getattr(executor, "submit_once", None))

    def stopping() -> bool:
        # The stop itself counts at once, before the dispatching thread sees it.
        return (
            closed.is_set()
            or dispatch_stopped.is_set()
            or (stop is not None and stop.is_set())
        )

    def may_send() -> bool:
        with admission:
            return not stopping()

    def admit() -> bool:
        with admission:
            if stopping():
                return False
            admitted[0] += 1
            return True

    def release() -> None:
        with admission:
            admitted[0] -= 1
            admission.notify_all()

    def close() -> None:
        with persist_lock, admission:
            closed.set()
            dispatch_stopped.set()
        with admission:
            admission.wait_for(lambda: admitted[0] == 0)

    # Save the reconciled state, every chunk included, before anything is
    # submitted: a chunk this checkpoint lists as pending without a query id
    # was never submitted.
    emit_progress()

    # An attempt that may have run and has no outcome may have written its
    # rows: submitting the chunk again could write them twice (#765).
    if unknown:
        raise _unknown_outcome_error(plan_id, unknown)

    def set_chunk(chunk_id: str, next_state: BackfillChunkState) -> None:
        if closed.is_set():
            return
        with lock:
            progress[chunk_id] = next_state
        emit_progress()

    # How long polls wait for a finished attempt's outcome to reach query_log:
    # never shorter than the resume's recheck window, whatever the poll interval.
    empty_window_ms = max(
        outcome_recheck_attempts * outcome_recheck_interval_ms,
        max_poll_errors * poll_interval_ms,
    )

    def poll_chunk(initial: BackfillChunkState, chunk_id: str) -> _UnknownAttempt | None:
        """Follow a submitted attempt to its outcome, on every replica,
        classified as the resume's sync does it, so a shared-id failure or a
        partial write is never taken for a failure a replay can follow. After
        ``max_poll_errors`` consecutive poll errors, or once polls have found
        the attempt neither running nor with an outcome for
        ``empty_window_ms`` (the query_log flush gap every finished attempt
        goes through), the outcome is unknown: the last read has no time
        bound, the chunk keeps its state, and the run stops once the chunks
        in flight end."""
        state = initial
        errors = 0
        empty_since: float | None = None
        while state.status in {"submitted", "running"} and not closed.is_set():
            time.sleep(poll_interval_ms / 1000)
            query_id = state.query_id
            if query_id is None:
                break
            final = (
                empty_since is not None
                and time.monotonic() * 1000 - empty_since >= empty_window_ms
            )
            try:
                evidence = _read_evidence(
                    executor,
                    cluster,
                    ids=[query_id],
                    after=None if final else state.submitted_at,
                )
                outcome = _classify_attempt(plan_id, chunk_id, state, evidence, final=final)
            except Exception as error:
                errors += 1
                if errors >= max_poll_errors:
                    return _UnknownAttempt(
                        chunk_id,
                        query_id,
                        f"lost contact with the server after {errors} consecutive "
                        f"poll errors ({error})",
                    )
                continue
            errors = 0
            if outcome.kind == "running":
                empty_since = None
                next_state, changed = _running_state(state, outcome.row or {})
                if changed:
                    state = next_state
                    set_chunk(chunk_id, state)
            elif outcome.kind in {"done", "failed"}:
                state = _settled_state(state, query_id, outcome)
                set_chunk(chunk_id, state)
            elif outcome.kind == "unknown":
                return _UnknownAttempt(chunk_id, query_id, outcome.reason or "")
            elif empty_since is None:
                empty_since = time.monotonic() * 1000
        return None

    def run_chunk(chunk_id: str) -> _UnknownAttempt | None:
        # A replay: its own query id, recorded with the bound right before
        # the send.
        if chunk_id in replays and replay_bound is not None:
            with lock:
                previous = _get_chunk(progress, chunk_id)
            return send(
                chunk_id,
                previous,
                BackfillChunkState(
                    status="pending",
                    query_id=_replay_query_id(plan_id, chunk_id),
                    submitted_at=replay_bound,
                    single_send=True if single_send else None,
                ),
            )

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
        # that looks unsubmitted. A first attempt runs under the chunk's id,
        # without submitted_at. (A pending chunk with an id here may have run,
        # and the resume's sync settled it, so it is never resent under it.)
        with lock:
            pending = _get_chunk(progress, chunk_id)
        if pending.query_id is not None:
            return None
        return send(
            chunk_id,
            pending,
            pending.model_copy(
                update={
                    "query_id": chunk_query_id(plan_id, chunk_id),
                    "single_send": True if single_send else None,
                }
            ),
        )

    def record(chunk_id: str, next_state: BackfillChunkState) -> None:
        """An admitted chunk's own record, saved even after close() began:
        close() waits for it."""
        with lock:
            progress[chunk_id] = next_state
        if on_progress is not None:
            with persist_lock:
                with lock:
                    snapshot = dict(progress)
                on_progress(snapshot)

    def send(
        chunk_id: str, previous: BackfillChunkState, attempt: BackfillChunkState
    ) -> _UnknownAttempt | None:
        """Record ``attempt`` and send the chunk under its query id. The SQL is
        built first. The chunk is admitted before its record: from then until
        its request enters the transport (``submit_once`` reports the handoff
        through ``SEND_ADMISSION``), or is refused and ``previous`` is saved
        back, close() waits for it. Another executor's request has no
        handoff, so its attempt is not single-send and is released before its
        submit."""
        query_id = attempt.query_id or ""
        sql = build_query(chunk_id)
        # Connection setup, which may stall, happens before the admission:
        # a stop that comes meanwhile refuses the send, and close() never
        # waits for it.
        prepare = getattr(executor, "prepare_submit_once", None)
        if callable(prepare):
            prepare()
        if not admit():
            return None
        released = [False]

        def release_once() -> None:
            if not released[0]:
                released[0] = True
                release()

        token = None
        try:
            record(chunk_id, attempt)
            if not may_send():
                record(chunk_id, previous)
                return None
            submit_once = getattr(executor, "submit_once", None)
            if callable(submit_once):
                token = SEND_ADMISSION.set(_Handoff(may_send, release_once))
                submit_once(sql, query_id)
            else:
                release_once()
                executor.submit(sql, query_id)
        except SendNotAdmittedError:
            record(chunk_id, previous)
            return None
        finally:
            if token is not None:
                SEND_ADMISSION.reset(token)
            release_once()
        with lock:
            submitted = _get_chunk(progress, chunk_id).model_copy(
                update={"status": "submitted", "query_id": query_id}
            )
        set_chunk(chunk_id, submitted)

        return poll_chunk(submitted, chunk_id)

    def guarded(chunk_id: str) -> _UnknownAttempt | None:
        if dispatch_stopped.is_set():
            return None
        try:
            lost = run_chunk(chunk_id)
        except BaseException:
            dispatch_stopped.set()
            raise
        if lost is not None:
            dispatch_stopped.set()
        return lost

    poll_unknown: list[_UnknownAttempt] = []
    first_error: BaseException | None = None
    if chunk_ids:
        pool = ThreadPoolExecutor(max_workers=max(1, concurrency))
        interrupted = False
        try:
            futures: list[Future[_UnknownAttempt | None]] = [
                pool.submit(guarded, chunk_id) for chunk_id in chunk_ids
            ]
            pending_futures = set(futures)
            while pending_futures:
                if stop is not None and stop.is_set():
                    # The chunks in flight keep running; they report nothing.
                    interrupted = True
                    close()
                    raise _interrupted_error(plan_id)
                _done, pending_futures = wait(
                    pending_futures, timeout=_STOP_CHECK_S, return_when=FIRST_COMPLETED
                )
            for future in futures:
                error = future.exception()
                if error is not None:
                    first_error = first_error or error
                elif (lost := future.result()) is not None:
                    poll_unknown.append(lost)
        finally:
            pool.shutdown(wait=not interrupted, cancel_futures=True)
    if first_error is not None:
        raise first_error
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
    "CHECKPOINT_VERSION",
    "BackfillExecutor",
    "BackfillInterruptedError",
    "BackfillResult",
    "StopSignal",
    "UnknownOutcomeError",
    "chunk_query_id",
    "execute_backfill",
    "run_interruptible",
    "sync_progress",
]
