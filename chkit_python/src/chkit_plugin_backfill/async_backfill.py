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
from dataclasses import dataclass, field
from datetime import UTC, datetime
from threading import Lock
from typing import Protocol, TypeAlias, TypeVar

from chkit.clickhouse import client as _client
from chkit.clickhouse.client import SEND_ADMISSION, SendNotAdmittedError
from chkit.clickhouse.replicas import (
    STRICT_READ_SETTINGS,
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
# How long an interrupt waits for abandoned requests to end.
_ABANDON_GRACE_MS = 1000

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
    """``execute_backfill`` stopped because its ``stop`` event was set.
    ``note`` says what the interrupt did beyond the usual stop, for its exit
    message; ``keep_lock`` is set when a request of the run may still be
    sent, so the plan's lock must stay."""

    def __init__(self, message: str, *, note: str | None = None, keep_lock: bool = False) -> None:
        super().__init__(f"{message} {note}" if note else message)
        self.note = note
        self.keep_lock = keep_lock


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
            # Written rows are evidence against a failure proof (#765): never
            # lower than what the checkpoint or an earlier read already saw.
            "written_rows": _raised_written_rows(state, _row_count(row.get("written_rows"))),
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
    unprovable_failures: str | None = None,
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
        executor, plan_id, cluster, prefix=f"backfill-{plan_id}-", unprovable=unprovable_failures
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
    unprovable: str | None = None,
    persist: Callable[[BackfillProgress], None] | None = None,
) -> tuple[BackfillProgress, list[_UnknownAttempt]]:
    """The sync before a resume submits anything: one read of every chunk,
    then reads of the chunks whose outcome is not settled yet, ``attempts``
    times, ``interval_ms`` apart, which covers the query_log flush interval
    (#765, as #721 does for async migrate). The last read has no time bound,
    so a replica clock that differs from the one the bound came from cannot
    hide a row. Returns the chunks whose attempt may have run and has no
    settled outcome. ``persist`` saves the progress whenever a read changed
    it, before the next read or wait: what a read saw outlives a later read
    that fails."""
    to_sync = _chunks_to_sync(chunk_ids, progress)
    if not to_sync:
        return progress, []
    current = progress
    persisted = [progress]

    def save() -> None:
        if current != persisted[0]:
            persisted[0] = current
            if persist is not None:
                persist(current)

    def observe(seen: _ChunkEvidence) -> None:
        nonlocal current
        current = _observed_progress(plan_id, to_sync, current, seen)
        _save_during_read(save)

    def read(**scope: object) -> _ChunkEvidence:
        # What system.processes shows is merged and saved before query_log is
        # read, so a log read that fails or hangs loses none of it.
        return _read_chunk_queries(
            executor, plan_id, cluster, unprovable=unprovable, observe=observe, **scope  # type: ignore[arg-type]
        )

    evidence = read(prefix=f"backfill-{plan_id}-")
    unknown: list[_UnknownAttempt] = []
    round_ = 0
    while True:
        passed = _apply_evidence(
            plan_id, to_sync, current, evidence, final=round_ >= attempts
        )
        current = passed.progress
        unknown = [*unknown, *passed.unknown]
        save()
        if not passed.waiting:
            return current, unknown
        to_sync = passed.waiting
        if stop is not None and stop.wait(interval_ms / 1000):
            raise _interrupted_error(plan_id)
        if stop is None:
            time.sleep(interval_ms / 1000)
        states = [_get_chunk(current, chunk_id) for chunk_id in to_sync]
        last = round_ + 1 >= attempts
        evidence = read(
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
    - failed without ``single_send``: an older release's checkpoint can
      record a failure the server never showed (it recorded a lost contact
      while polling as failed), or one that wrote rows. Whether it is
      replayed is up to the flags, not this. (This release's failures stay
      proven, see ``_classify_attempt``.)

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
    # Why no failure of this target can be proven (``unprovable_failures``).
    unprovable: str | None = None
    # The secondary queries the attempts started (by ``initial_query_id``).
    secondary_running: list[dict[str, object]] = field(default_factory=list)
    secondary_log: list[dict[str, object]] = field(default_factory=list)


def _is_secondary(row: dict[str, object]) -> bool:
    value = row.get("is_initial_query")
    return value is not None and str(value) in {"0", "False"}


def _secondary_reason(secondary: str) -> str:
    return (
        f"it ran a secondary query on another replica or shard (query_id {secondary}), "
        "whose writes system.query_log may show late or not at all, so its failure "
        "proves nothing"
    )


def _contradiction(
    query_id: str, state: BackfillChunkState, evidence: _ChunkEvidence
) -> str | None:
    """Why a failure this release proved no longer holds, if it does not (TS
    ``contradiction``): a secondary query of the attempt, or a written row,
    seen now or recorded by an earlier read. query_log rows that aged out
    prove nothing either way."""
    secondary = state.secondary_query_id or _secondary_query_of(query_id, evidence)
    if secondary is not None:
        return _secondary_reason(secondary)
    written = max(state.written_rows or 0, _own_written_rows(query_id, evidence))
    if written > 0:
        return f"it failed after writing {written} rows, which a replay would write again"
    return None


def _own_written_rows(query_id: str, evidence: _ChunkEvidence) -> int:
    counts = [
        count
        for row in evidence.log_rows
        if str(row.get("query_id")) == query_id
        and (count := _row_count(row.get("written_rows"))) is not None
    ]
    return max([0, *counts])


def _noted_state(
    plan_id: str, chunk_id: str, state: BackfillChunkState, evidence: _ChunkEvidence
) -> BackfillChunkState:
    """``state`` with what this read saw of the attempt that must outlive the
    read (#765, TS ``notedState``): the first secondary query of it, and the
    most rows it wrote, by its own query_log rows or its process. The written
    rows only ever grow. The caller saves
    it, so a later read, or a resume after a restart, still knows once the
    evidence is gone."""
    query_id = _attempt_query_id(plan_id, chunk_id, state)
    update: dict[str, object] = {}
    secondary = _secondary_query_of(query_id, evidence)
    if secondary is not None and state.secondary_query_id is None:
        update["secondary_query_id"] = secondary
    running = evidence.running.get(query_id)
    written = _raised_written_rows(
        state,
        max(
            _own_written_rows(query_id, evidence),
            (_row_count(running.get("written_rows")) or 0) if running is not None else 0,
        ),
    )
    if written != (state.written_rows or 0):
        update["written_rows"] = written
    return state.model_copy(update=update) if update else state


def _raised_written_rows(state: BackfillChunkState, count: int | None) -> int:
    """The attempt's written rows after a read that reports ``count`` (#765,
    TS ``raisedWrittenRows``): the maximum of every count seen, never lower.
    Every write of ``written_rows`` goes through it."""
    return max(state.written_rows or 0, count or 0)


class _CheckpointSaveError(Exception):
    """A checkpoint save that failed while a read was under way (TS
    ``CheckpointSaveError``): it is not a read error the read may retry, so it
    ends the run as a failed save does anywhere else."""

    def __init__(self, cause: BaseException) -> None:
        super().__init__(str(cause))
        self.cause = cause


def _save_during_read(save: Callable[[], None]) -> None:
    """``save()``, its failure marked so that read-error handling passes it on."""
    try:
        save()
    except Exception as error:
        raise _CheckpointSaveError(error) from error


#: Called with what system.processes showed, before query_log is read: the
#: caller merges and saves it (see ``_observed_progress``). It is evidence
#: against a proof, never a proof.
_ObserveProcesses: TypeAlias = "Callable[[_ChunkEvidence], None]"


def _observed_progress(
    plan_id: str, chunk_ids: list[str], progress: BackfillProgress, evidence: _ChunkEvidence
) -> BackfillProgress:
    """``progress`` with every observation of ``evidence`` merged into the
    attempts of ``chunk_ids`` (see ``_noted_state``), whether the read was
    whole or partial (TS ``observedProgress``). The one place a read's
    evidence enters the progress; callers save the result before their next
    read or wait."""
    updated = dict(progress)
    for chunk_id in chunk_ids:
        saved = _get_chunk(updated, chunk_id)
        noted = _noted_state(plan_id, chunk_id, saved, evidence)
        if noted is not saved:
            updated[chunk_id] = noted
    return updated


def _secondary_query_of(query_id: str, evidence: _ChunkEvidence) -> str | None:
    """The query id of a secondary query of the attempt (on another replica or
    shard, by its ``initial_query_id``), if any was seen (TS
    ``secondaryQueryOf``). Its writes may not be in the initiator's
    written_rows, and its own query_log row can flush late, or not at all, so
    a failure with one proves nothing. The chunk INSERT pins settings that keep
    it from running any (see ``PINNED_INSERT_SETTINGS``)."""
    for row in [*evidence.secondary_log, *evidence.secondary_running]:
        if row.get("initial_query_id") == query_id:
            return str(row.get("query_id"))
    return None


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


def _classify_attempt(  # noqa: PLR0911, PLR0912 — mirrors the TS classifier
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
    - A failure this release recorded (``failed`` with ``single_send``, which
      only a proof below records): it stays failed. It is not proven again.
    - A failure row of an attempt sent once under its id (``single_send``),
      read on every replica, with no row of the id that wrote a row: failed.
      Only that proves a replay cannot write the chunk's rows twice. A failure
      after a written row is unknown at once: those rows stay, and a replay
      writes them again. So is any failure of a target whose failures cannot
      be proven (``unprovable_failures``), and any failure of an attempt that
      ran a secondary query (see ``_secondary_query_of``). A failure is
      recorded only on the read after the flush window, so a row a replica
      flushes late can still turn it unknown. An attempt
      an older release recorded may have been sent twice under its id, so
      its failure rows prove nothing, and a read that may have missed a
      replica cannot rule out a run or a QueryFinish on it.
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
    # A failure this release proved stays proven, whatever query_log shows
    # now: its rows may have aged out (TTL), or sit on a replica this read
    # cannot reach. Only a newer outcome of the id, read above, replaces it.
    # Evidence against it, seen now or recorded by an earlier read, revokes it.
    if state.status == "failed" and state.single_send is True:
        revoked = _contradiction(query_id, state, evidence)
        return _Outcome("unchanged") if revoked is None else _Outcome("unknown", reason=revoked)
    kind = _attempt_kind(plan_id, chunk_id, state)
    failure = next((row for row in own if row.get("type") in _FAILURE_TYPES), None)
    if failure is not None and state.single_send is True and evidence.partial is None:
        if evidence.unprovable is not None:
            return _Outcome("unknown", reason=evidence.unprovable)
        secondary = state.secondary_query_id or _secondary_query_of(query_id, evidence)
        if secondary is not None:
            return _Outcome("unknown", reason=_secondary_reason(secondary))
        # Proof needs every row of the id to state, as a number, that it
        # wrote nothing, and no earlier poll of this attempt to have seen it
        # write.
        counts = [_row_count(row.get("written_rows")) for row in own]
        if any(count is None for count in counts):
            return _Outcome(
                "unknown", reason="system.query_log does not say how many rows it wrote"
            )
        written = max([*(count or 0 for count in counts), state.written_rows or 0])
        # Only once the flush window is over: a replica that flushes its
        # query_log late can still show a row that turns it unknown.
        if written == 0:
            return _Outcome("failed", failure) if final else _Outcome("wait")
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
    updated = _observed_progress(plan_id, chunk_ids, progress, evidence)
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
                "written_rows": _raised_written_rows(current, _row_count(row.get("written_rows"))),
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
    unprovable: str | None = None,
    observe: _ObserveProcesses | None = None,
) -> _ChunkEvidence:
    """``_read_evidence`` for the resume's sync: a failed read, including a
    replica probe that fails for any reason other than a missing cluster or a
    denied user, stops the resume, whatever the flags: nothing was read."""
    try:
        return _read_evidence(
            executor,
            cluster,
            prefix=prefix,
            ids=ids,
            after=after,
            unprovable=unprovable,
            observe=observe,
        )
    except _CheckpointSaveError as error:
        raise error.cause from None
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
    unprovable: str | None = None,
    observe: _ObserveProcesses | None = None,
) -> _ChunkEvidence:
    """Read the chunks' rows in system.processes and system.query_log: by the
    plan's prefix, or by exact ids, pruned by event_date from ``after``. The
    pruning keeps a day of slack, and no row is filtered by its start time,
    since replicas' clocks can differ (#765). When the probe cannot show that
    every replica answers, the reads use the local tables, also with
    ``clickhouse.cluster`` set, as TS does, and what they do not find proves
    nothing."""
    def match_on(column: str) -> str:
        if prefix is not None:
            return f"{column} LIKE '{_escape_like_prefix(prefix)}%'"
        return f"{column} IN ({', '.join(string_literal(i) for i in ids or [])})"

    match = match_on("query_id")
    # The attempts' own queries, and the secondary queries they started on
    # other replicas or shards (parallel replicas, a Distributed INSERT
    # SELECT): those write rows the initial query's written_rows may not count.
    own_or_secondary = (
        f"((user = currentUser() AND {match} AND is_initial_query = 1) OR "
        f"(initial_user = currentUser() AND {match_on('initial_query_id')} "
        "AND is_initial_query = 0))"
    )
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
        "SELECT query_id, initial_query_id, is_initial_query, read_rows, read_bytes, "
        "written_rows, written_bytes, elapsed "
        f"FROM {source('system.processes')} "
        f"WHERE {own_or_secondary} "
        f"SETTINGS {STRICT_READ_SETTINGS}"
    )
    running_rows = _rows_of(running_result)
    # Saved before the next read: a query_log read that fails or hangs (and a
    # stop during it) loses none of what system.processes showed.
    if observe is not None:
        observe(
            _ChunkEvidence(
                running={
                    str(row.get("query_id")): row
                    for row in running_rows
                    if row.get("query_id") is not None and not _is_secondary(row)
                },
                log_rows=[],
                secondary_running=[row for row in running_rows if _is_secondary(row)],
            )
        )
    log_result = executor.query(
        "SELECT query_id, initial_query_id, is_initial_query, type, written_rows, "
        "written_bytes, query_duration_ms, exception\n"
        f"FROM {source('system.query_log')}\n"
        f"WHERE {own_or_secondary}\n"
        "  AND type IN ('QueryStart', 'QueryFinish', 'ExceptionBeforeStart',"
        f" 'ExceptionWhileProcessing'){pruning}\n"
        "ORDER BY event_time DESC\n"
        f"SETTINGS {STRICT_READ_SETTINGS}"
    )
    log_rows = _rows_of(log_result)
    running = {
        str(row.get("query_id")): row
        for row in running_rows
        if row.get("query_id") is not None and not _is_secondary(row)
    }
    return _ChunkEvidence(
        running=running,
        log_rows=[row for row in log_rows if not _is_secondary(row)],
        secondary_running=[row for row in running_rows if _is_secondary(row)],
        secondary_log=[row for row in log_rows if _is_secondary(row)],
        partial=access.reason if access.kind == "partial" else None,
        unprovable=unprovable,
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


_UNLESS_LOGGED = (
    "Unless system.query_log shows its outcome, a resume stops on it, and only "
    "--accept-unknown replays it."
)


def _send_failed_error(
    plan_id: str, chunk_id: str, query_id: str, error: BaseException
) -> RuntimeError:
    """A send that failed (a connect timeout, a lost connection, an error the
    server returned): it may have reached the server, so its attempt stays
    recorded as one that may have run, and nothing attaches to it."""
    return RuntimeError(
        f"Backfill plan {plan_id}: the send of chunk {chunk_id} (query_id {query_id}) "
        f"failed: {error} It may have reached the server, so its attempt stays recorded "
        f"as one that may have run. {_UNLESS_LOGGED}"
    )


def _interrupted_error(
    plan_id: str,
    abandoned: list[str] | None = None,
    alive: list[str] | None = None,
    *,
    write_hung: bool = False,
) -> BackfillInterruptedError:
    message = (
        f"Backfill plan {plan_id}: interrupted. No new chunk was submitted; a chunk "
        "already submitted keeps running on the server, and a resume attaches to it."
    )
    hung = (
        "The checkpoint write under way did not finish in time: it may still complete "
        "while this process runs, so the plan's lock stays in place."
        if write_hung
        else None
    )
    if not abandoned:
        if hung is None:
            return BackfillInterruptedError(message)
        return BackfillInterruptedError(message, note=hung, keep_lock=True)
    chunks = f"chunk{'' if len(abandoned) == 1 else 's'} {', '.join(abandoned)}"
    if not alive:
        note = (
            f"The send of {chunks} did not reach the server in time and was abandoned: it "
            "may still have reached it, so its attempt stays recorded as one that may have run. "
            f"{_UNLESS_LOGGED}"
        )
    else:
        note = (
            f"The send of {chunks} did not reach the server in time and could not be stopped "
            f"(chunk{'' if len(alive) == 1 else 's'} {', '.join(alive)}): it may still be sent "
            "while this process runs, so its attempt stays recorded as one that may have run "
            "and the plan's lock stays in place."
        )
    if hung is not None:
        note = f"{note} {hung}"
    return BackfillInterruptedError(message, note=note, keep_lock=bool(alive) or write_hung)


def _admits_at_transport(executor: object) -> bool:
    """Whether the executor declares (``transport_admission = True``) that its
    ``submit_once`` sends once and asks ``SEND_ADMISSION`` as the request
    enters its transport: only such an attempt is single-send, and only
    such an executor can serve an interruptible run. A method named
    ``submit_once`` alone proves neither."""
    return getattr(executor, "transport_admission", False) is True and callable(
        getattr(executor, "submit_once", None)
    )


@dataclass(frozen=True)
class _Handoff:
    """A chunk's ``SendAdmission``: asks the run again at the transport,
    gives the run the request's ``abandon``, and releases the chunk's
    admission once its request entered it."""

    may_send: Callable[[], bool]
    release: Callable[[], None]
    attach: Callable[[Callable[[], None]], None]

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


def _row_count(value: object) -> int | None:
    """A row count as query_log reports it: a whole number, or its digits."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


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
    handoff_timeout_ms: int | None = None,
    unprovable_failures: str | None = None,
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
    Chunks already submitted keep running on the server. ``handoff_timeout_ms``
    is how long an interrupt waits for the chunks it admitted to hand their
    request off before it abandons them (default: the connect timeout plus
    5 s); their attempts stay recorded as ones that may have run.
    ``unprovable_failures`` is set, to the reason, when no failure of the
    target can be proven: a failure is then unknown, never failed. The
    plugin sets it for a Distributed target, whose shards write the rows of
    an INSERT SELECT (parallel_distributed_insert_select, 2 by default in
    ClickHouse 26.3) while the initial query's written_rows does not count
    them."""
    if handoff_timeout_ms is None:
        handoff_timeout_ms = _client.SEND_CONNECT_TIMEOUT_MS + 5000
    if stop is not None and not _admits_at_transport(executor):
        msg = (
            "An interruptible backfill needs an executor with transport_admission and "
            "submit_once, which sends once and asks the run's admission at the "
            "transport: another executor could send a chunk after the interrupt returned."
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
        # The resume's sync saves what each read saw before its next read or
        # wait. A stop starts no such save, and waits for the one under way as
        # for any checkpoint write: a write still under way keeps the lock.
        sync_write = threading.Condition()
        sync_state = {"writing": False, "sealed": False}

        def persist_sync(next_progress: BackfillProgress) -> None:
            if on_progress is None:
                return
            with sync_write:
                if sync_state["sealed"] or (stop is not None and stop.is_set()):
                    return
                sync_state["writing"] = True
            try:
                on_progress(dict(next_progress))
            finally:
                with sync_write:
                    sync_state["writing"] = False
                    sync_write.notify_all()

        try:
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
                    unprovable=unprovable_failures,
                    persist=persist_sync,
                ),
                stop,
                plan_id,
            )
        except BackfillInterruptedError:
            with sync_write:
                sync_state["sealed"] = True
                ended = sync_write.wait_for(
                    lambda: not sync_state["writing"], handoff_timeout_ms / 1000
                )
            if not ended:
                raise _interrupted_error(plan_id, write_hung=True) from None
            raise
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
    # On the first chunk whose outcome is unknown, or whose send or poll
    # raises, no new chunk starts; the chunks in flight end first. A chunk the
    # server shows failed is recorded failed, and the other chunks keep running.
    dispatch_stopped = threading.Event()

    def write_checkpoint(*, after_close: bool) -> None:
        """Report the progress, one write at a time. A write starts only
        before close() seals the run, and after close() began only for an
        admitted chunk's own record (``after_close``). close() never waits
        for the write lock, only for the write under way, through ``writing``."""
        if on_progress is None:
            return
        with persist_lock:
            with admission:
                if sealed[0] or (closed.is_set() and not after_close):
                    return
                writing[0] += 1
            try:
                with lock:
                    snapshot = dict(progress)
                on_progress(snapshot)
            finally:
                with admission:
                    writing[0] -= 1
                    admission.notify_all()

    def emit_progress() -> None:
        write_checkpoint(after_close=False)

    def first_report() -> None:
        if stop is None:
            emit_progress()
            return
        failure: list[BaseException] = []

        def write() -> None:
            try:
                emit_progress()
            except BaseException as error:
                failure.append(error)

        writer = threading.Thread(target=write, name="backfill-first-checkpoint", daemon=True)
        writer.start()
        while writer.is_alive():
            if stop.is_set():
                raise close()
            writer.join(_STOP_CHECK_S)
        if failure:
            raise failure[0]

    # Chunks between their admission and their request's handoff to the
    # transport (or their refusal and saved-back state). close() waits for
    # them, so no chunk of a stopped run is sent or saved after it returns,
    # and it never waits for an INSERT's response.
    admission = threading.Condition(Lock())
    admitted = [0]
    # The admitted chunks' releases, and the abandon of each request that
    # reached the transport.
    in_flight: dict[str, Callable[[], None]] = {}
    abandons: dict[str, Callable[[], None]] = {}
    # Set once close() abandons the sends that did not hand off in time.
    abandoning = [False]
    # The checkpoint write under way, and whether close() sealed the run: no
    # write starts after that.
    writing = [0]
    sealed = [False]
    single_send = _admits_at_transport(executor)

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

    def close() -> BackfillInterruptedError:
        """Stop the run without waiting for the write lock. Within
        ``handoff_timeout_ms``, the admitted chunks hand off (or are refused
        and saved back) and the checkpoint write under way ends. A chunk that
        does not hand off in time is abandoned: no more of its request is
        written, then its admission is released. Then the run is sealed: no
        checkpoint write starts after close() returns. A send or a write
        still under way then keeps the plan's lock."""
        deadline = time.monotonic() + handoff_timeout_ms / 1000

        def left(at_least: float = 0.0) -> float:
            return max(at_least, deadline - time.monotonic())

        with admission:
            closed.set()
            dispatch_stopped.set()
            handed = admission.wait_for(lambda: admitted[0] == 0, left())
            abandoned: list[str] = []
            stuck: list[tuple[Callable[[], None], Callable[[], None]]] = []
            if not handed:
                abandoning[0] = True
                abandoned = sorted(in_flight)
                stuck = [
                    (abandons[chunk_id], in_flight[chunk_id])
                    for chunk_id in abandoned
                    if chunk_id in abandons
                ]
        # A request at the transport is stopped first, then released; one
        # that has not reached it yet is refused there, and ends on its own.
        for abandon, release_chunk in stuck:
            abandon()
            release_chunk()
        grace = _ABANDON_GRACE_MS / 1000
        with admission:
            if abandoned:
                admission.wait_for(lambda: admitted[0] == 0, grace)
            admission.wait_for(lambda: writing[0] == 0, left(grace if abandoned else 0.0))
            sealed[0] = True
            alive = sorted(in_flight) if abandoned else []
            write_hung = writing[0] > 0
        return _interrupted_error(plan_id, abandoned, alive, write_hung=write_hung)

    # Save the reconciled state, every chunk included, before anything is
    # submitted: a chunk this checkpoint lists as pending without a query id
    # was never submitted. A stop during this write waits for it as long as
    # for any other (``handoff_timeout_ms``, through close()), then seals the
    # run; a write still under way keeps the lock.
    first_report()

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

    def poll_chunk(  # noqa: PLR0912 — mirrors the TS pollChunk
        initial: BackfillChunkState, chunk_id: str
    ) -> _UnknownAttempt | None:
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
            def observe(seen: _ChunkEvidence) -> None:
                nonlocal state
                observed = _noted_state(plan_id, chunk_id, state, seen)
                if observed is not state:
                    state = observed
                    saving = state
                    _save_during_read(lambda: set_chunk(chunk_id, saving))

            try:
                evidence = _read_evidence(
                    executor,
                    cluster,
                    ids=[query_id],
                    after=None if final else state.submitted_at,
                    unprovable=unprovable_failures,
                    observe=observe,
                )
                noted = _noted_state(plan_id, chunk_id, state, evidence)
                outcome = _classify_attempt(plan_id, chunk_id, noted, evidence, final=final)
            except _CheckpointSaveError as error:
                # A failed checkpoint save is no read error to retry: it ends
                # the run.
                raise error.cause from None
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
            # What this read saw of the attempt is saved whatever its outcome.
            saw_more = noted is not state
            state = noted
            if outcome.kind == "running":
                empty_since = None
                next_state, changed = _running_state(state, outcome.row or {})
                if changed or saw_more:
                    state = next_state
                    set_chunk(chunk_id, state)
            elif outcome.kind in {"done", "failed"}:
                state = _settled_state(state, query_id, outcome)
                set_chunk(chunk_id, state)
            elif outcome.kind == "unknown":
                # No other chunk is sent from here on, before this save
                # (which can wait behind another chunk's write) is made.
                dispatch_stopped.set()
                if saw_more:
                    set_chunk(chunk_id, state)
                return _UnknownAttempt(chunk_id, query_id, outcome.reason or "")
            else:
                if saw_more:
                    set_chunk(chunk_id, state)
                if empty_since is None:
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
        """An admitted chunk's own record, saved even after close() began
        (close() waits for it), never after close() sealed the run."""
        with lock:
            progress[chunk_id] = next_state
        write_checkpoint(after_close=True)

    def send(  # noqa: PLR0915 — mirrors the TS send
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
        if single_send and callable(prepare):
            prepare()
        if not admit():
            return None
        released = [False]

        def release_once() -> None:
            with admission:
                if released[0]:
                    return
                released[0] = True
                in_flight.pop(chunk_id, None)
                abandons.pop(chunk_id, None)
            release()

        def attach(abandon: Callable[[], None]) -> None:
            with admission:
                if released[0]:
                    return
                if not abandoning[0]:
                    abandons[chunk_id] = abandon
                    return
            # Admitted just as close() abandoned the others: stopped alike.
            abandon()
            release_once()

        with admission:
            in_flight[chunk_id] = release_once

        token = None
        try:
            record(chunk_id, attempt)
            if not may_send():
                record(chunk_id, previous)
                return None
            # A submit_once is always preferred: a plain submit may resend
            # the INSERT under its id. Without the transport_admission
            # marker it is not trusted to ask the admission (the attempt is
            # not single-send, and only a run without a stop gets here).
            submit_once = getattr(executor, "submit_once", None)
            if single_send and callable(submit_once):
                token = SEND_ADMISSION.set(_Handoff(may_send, release_once, attach))
                submit_once(sql, query_id)
            elif callable(submit_once):
                release_once()
                submit_once(sql, query_id)
            else:
                release_once()
                executor.submit(sql, query_id)
        except SendNotAdmittedError:
            record(chunk_id, previous)
            return None
        except Exception as error:
            raise _send_failed_error(plan_id, chunk_id, query_id, error) from error
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
                    raise close()
                _done, pending_futures = wait(
                    pending_futures, timeout=_STOP_CHECK_S, return_when=FIRST_COMPLETED
                )
            # A stop during the last wait: a worker it refused left its chunk
            # unrun, and the run must not end as if it had run.
            if stop is not None and stop.is_set():
                interrupted = True
                raise close()
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
