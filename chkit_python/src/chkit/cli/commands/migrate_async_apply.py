"""Apply one async (long-running) statement with deterministic resume.

1:1 port of ``packages/cli/src/commands/migrate/async-apply.ts``.

Submits the statement via ``ClickHouseClient.submit`` with a random
``query_id`` of its own, recorded in the journal before the submit (#767),
and, without waiting for its response, polls
``query_status`` until terminal. The per-statement journal state
is written before submit (intent), after each progress poll (heartbeat),
and on terminal (completed | failed) so a CLI crash or kill mid-migration
can resume on the next run.

Key invariants:

- A re-run attaches to an in-flight server-side query by the id a fenced
  journal record names. Every attempt submits under a new random id (#701,
  #767), which no other attempt or run submits.
- ``before_retry`` SQL (parsed from the migration's ``-- before-retry:``
  line) runs only on resubmit, never on first attempt.
- A re-run of a step journaled ``started`` that no replica runs any more
  reads that attempt's outcome from ``system.query_log`` (#672) when the
  record is fenced: a ``QueryFinish`` is recorded as completed instead of
  resubmitted, and a missing entry is checked again while query_log is
  flushed (#701). A started attempt without an outcome stops the run with
  ``async_outcome_unknown`` (#767).
- Status ``unknown`` is a transient state (just-submitted or
  just-finished gap); loop until ``running`` / ``finished`` / ``failed``
  unless the submit itself rejected before any poll found the query
  running, which is recorded as failed.
- Every entry of an attempt's id is that attempt's.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, TypeVar

from chkit import __version__
from chkit.cli.commands.migrate_errors import MigrateError, in_progress_checksum_mismatch_error
from chkit.cli.commands.migrate_interrupt import as_cleanup
from chkit.cli.commands.migrate_lock import async_without_lock_accepted, migrate_lock_disabled
from chkit.cli.commands.migrate_query_intents import QueryContext, QueryTracker
from chkit.cli.commands.migrate_recovery import (
    assert_completed_statement,
    has_statement_progress,
)
from chkit.cli.journal_store import (
    JournalStore,
    MigrationRowState,
    OperationState,
    resolve_journal_table_name,
)
from chkit.cli.safety_markers import rejection_runs_nothing
from chkit.clickhouse.client import (
    SUBMIT_CONNECT_TIMEOUT_SECONDS,
    ClickHouseClient,
    QueryStatus,
    SubmitNotSentError,
    clickhouse_error_message,
)
from chkit.core.jsnum import js_math_round, js_number_to_string, js_to_fixed

POLL_INTERVAL_SECONDS = 5.0
# Every attempt, the first included, submits under a random query id of its
# own, recorded in the journal before the submit (#767), so every
# system.query_log entry of that id is the attempt's. The bound on them only
# lets query_log prune its partitions (event_date), and leaves replica clocks
# an hour of skew: an entry it misses reads as no outcome, which stops a
# re-run instead of retrying.
QUERY_LOG_MARGIN_MS = 3_600_000
# Poll request failures in a row, and `unknown` polls after a failed submit (#657).
MAX_TRANSIENT_POLL_ERRORS = 20
# The last_error of a 'started' record this release writes. The record is
# fenced (OperationState.attempt_fenced): its query id names this attempt
# alone, and a retry by this release journals the attempt failed before its
# before-retry SQL runs, so a QueryFinish of the id is the statement's
# outcome (#767). Releases from #701 wrote the same text, under the
# statement's deterministic id for a first attempt, without the fence.
ATTEMPT_RECORD_MARKER = (
    "submitted under its own query id; a retry reads its outcome from system.query_log"
)
# The last_error of a 'started' record of an attempt that was never sent
# (#767). The record moves to ATTEMPT_RECORD_MARKER, and the server returns
# it, before the statement is submitted, so a re-run that finds an attempt
# still prepared, with nothing of its id on the server, runs it again.
PREPARED_RECORD_MARKER = "prepared under its own query id; not submitted yet"
# query_log is flushed on a timer, every 7.5 s by default. A fenced started
# attempt that no replica runs and that has no query_log entry is checked
# again this many times, QUERY_LOG_FLUSH_RECHECK_INTERVAL_SECONDS apart,
# before it counts as having no outcome, so an attempt that ended right before
# the check is found (#701).
QUERY_LOG_FLUSH_RECHECKS = 5
# Polls in a row that find the query neither running nor in query_log before
# the run reads every replica once more, then stops without an outcome (#767).
MAX_UNKNOWN_POLLS = 20
QUERY_LOG_FLUSH_RECHECK_INTERVAL_SECONDS = 2.0
# ClickHouse's ACCESS_DENIED (497) for system.query_log, as the native client
# and the ObsessionDB console relay it.
_QUERY_LOG_ACCESS_DENIED = re.compile(
    r"(ACCESS_DENIED|Code: 497|Not enough privileges)[\s\S]*query_log"
    r"|query_log[\s\S]*(ACCESS_DENIED|Code: 497)"
)
SUBMIT_THREAD_NAME = "chkit-async-submit"
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_BYTES_KIB = 1024
_BYTES_MIB = _BYTES_KIB * 1024
_BYTES_GIB = _BYTES_MIB * 1024
_ROWS_K = 1_000
_ROWS_M = 1_000_000


AsyncApplyKind = Literal["completed", "skipped"]


@dataclass(frozen=True, slots=True)
class AsyncApplyResult:
    kind: AsyncApplyKind
    operation: OperationState


@dataclass(frozen=True, slots=True)
class AsyncApplyInput:
    client: ClickHouseClient
    journal_store: JournalStore
    sql: str
    migration_name: str
    migration_checksum: str
    statement_index: int
    operation_type: str
    operation_key: str
    # ``statement_fingerprint(sql)``, recorded with every write of this statement (#599).
    fingerprint: str
    before_retry: str | None
    log: Callable[[str], None]
    poll_interval_seconds: float = POLL_INTERVAL_SECONDS
    # --setting values, sent with the submitted statement and its before-retry SQL.
    settings: dict[str, str] | None = None
    query_tracker: QueryTracker | None = None
    # The run holds no migrate lock because the target database did not exist (#767).
    lockless_bootstrap: bool = False
    # The outcome a --retry edit's check read for this statement's record (#767).
    known: KnownOutcome | None = None


def iso_without_zone(dt: datetime) -> str:
    """ISO timestamp matching the TS ``new Date().toISOString().replace('Z','')``."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]


def make_deterministic_query_id(
    database: str, journal_table: str, migration_name: str, statement_index: int
) -> str:
    """SHA-256 of ``chkit:{database}:{journal table}:{migration}:{index}`` as a UUID.

    The id earlier releases submitted a statement's first attempt under. The
    database and journal table keep runs of one migration file against other
    databases, or by other projects in the same database, from sharing the id
    (#463). This release submits every attempt under a random id recorded
    before its submit (#767), and only checks this one in system.processes
    when the journal has no record of the statement.
    """
    digest = hashlib.sha256(
        f"chkit:{database}:{journal_table}:{migration_name}:{statement_index}".encode()
    ).hexdigest()
    return (
        f"{digest[:8]}-{digest[8:12]}-{digest[12:16]}-{digest[16:20]}-{digest[20:32]}"
    )


def fresh_migration_state(name: str, checksum: str) -> MigrationRowState:
    return MigrationRowState(
        name=name,
        applied_at="1970-01-01 00:00:00.000",
        checksum=checksum,
        chkit_version="",
        migration_completed=False,
        operations=[],
    )


def upsert_operation(
    state: MigrationRowState, op: OperationState, now_iso: str
) -> MigrationRowState:
    others = [o for o in state.operations if o.operation_index != op.operation_index]
    operations = sorted([*others, op], key=lambda o: o.operation_index)
    return state.model_copy(
        update={
            "applied_at": now_iso,
            "operations": operations,
            # migration_completed stays as-is until apply_migration flips it
            "migration_completed": state.migration_completed,
        }
    )


def _first_line(value: str) -> str:
    return value.split("\n", 1)[0]


# float(value): TS reads a count as a double before dividing it.
def _format_rows(value: int | None) -> str:
    if value is None or value == 0:
        return "0 rows"
    if value >= _ROWS_M:
        return f"{js_to_fixed(float(value) / _ROWS_M, 2)}M rows"
    if value >= _ROWS_K:
        return f"{js_to_fixed(float(value) / _ROWS_K, 1)}K rows"
    return f"{value} rows"


def _format_bytes(value: int | None) -> str:
    if value is None or value == 0:
        return "0 B"
    if value >= _BYTES_GIB:
        return f"{js_to_fixed(float(value) / _BYTES_GIB, 2)} GiB"
    if value >= _BYTES_MIB:
        return f"{js_to_fixed(float(value) / _BYTES_MIB, 1)} MiB"
    if value >= _BYTES_KIB:
        return f"{js_to_fixed(float(value) / _BYTES_KIB, 1)} KiB"
    return f"{value} B"


def _progress_line(label: str, status: QueryStatus, elapsed_sec: int) -> str:
    rows = _format_rows(status.written_rows)
    byte_str = _format_bytes(status.written_bytes)
    return f"  {label}: written={rows} ({byte_str}), elapsed {elapsed_sec}s"


def _describe_error(error: BaseException) -> str:
    return clickhouse_error_message(error)


_T = TypeVar("_T")


class _Submission:
    """The submit request, open on its own thread while the poller runs.

    The request returns when the query ends (or a proxy cuts it), so the
    poller does not wait for it: TS starts ``db.submit`` without awaiting it.
    ``error`` is set once the request has failed.

    It is also the request's guard (#767): called before the request starts,
    and around writing the request (``begin_write`` at its first bytes,
    ``end_write`` once written), once its connection is open. A run that gives
    up on it (``abandon``) refuses both, and waits until a send that started
    connecting was stopped, or one writing was written or failed: the request
    is written before the run stops, or never started.

    It is created before its thread starts (``start``), so a run stopped while
    the thread starts can already give it up (#793).
    """

    def __init__(self, submit: Callable[[_Submission], object]) -> None:
        self.error: Exception | None = None
        self._cond = threading.Condition()
        self._cancelled = False
        # idle, connecting, writing, sent, done
        self._state = "idle"
        # Whether a write of the request was let through.
        self._written = False
        # What a completed abandon returned, so a later one does not wait again.
        self._excluded: bool | None = None
        # A daemon, so an interrupted run exits while the request is open;
        # the query keeps running and a re-run attaches to it.
        self._thread = threading.Thread(
            target=self._run, args=(submit,), name=SUBMIT_THREAD_NAME, daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def _run(self, submit: Callable[[_Submission], object]) -> None:
        try:
            submit(self)
        except Exception as error:  # the poller decides what it means
            self.error = error
        finally:
            with self._cond:
                self._state = "done"
                self._cond.notify_all()

    def __call__(self) -> None:
        with self._cond:
            if self._cancelled:
                msg = "The run stopped without an outcome; the submit was not sent"
                raise RuntimeError(msg)
            self._state = "connecting"

    def begin_write(self) -> None:
        """Start writing the request, unless the run gave up on it."""
        with self._cond:
            if self._cancelled:
                msg = "The run stopped without an outcome; the submit was not sent"
                raise RuntimeError(msg)
            self._state = "writing"
            self._written = True

    def end_write(self) -> None:
        """The request is written, or its write failed."""
        with self._cond:
            if self._state == "writing":
                self._state = "sent"
                self._cond.notify_all()

    def first_write(self, write: Callable[[], _T]) -> _T:
        """Write a whole request in one call, unless the run gave up on it."""
        self.begin_write()
        try:
            return write()
        finally:
            self.end_write()

    def commit(self) -> None:
        """A write that writes nothing (a transport without a hook)."""
        self.first_write(lambda: None)

    def abandon(self) -> bool:
        """Give up on the request; return whether a late send is excluded.

        A send not started never starts, and one still connecting never
        writes: it is waited for up to the connect timeout and a margin. A
        request whose bytes are being written keeps the run, and its migrate
        lock, until its write completed or failed, however long that takes;
        the transport's write timeout bounds it. Once it returned, a later
        call returns the same answer at once (#793); an interrupted one waits
        again.
        """
        with self._cond:
            self._cancelled = True
            if self._excluded is not None:
                return self._excluded
            excluded = self._cond.wait_for(
                lambda: self._state != "connecting", SUBMIT_CONNECT_TIMEOUT_SECONDS + 5
            )
            self._cond.wait_for(lambda: self._state != "writing")
            self._excluded = excluded
            return excluded

    def abandon_unsent(self) -> bool:
        """Give up on the request; return whether it was, and will be, never written."""
        excluded = self.abandon()
        with self._cond:
            return excluded and not self._written

    @property
    def abandoned(self) -> bool:
        with self._cond:
            return self._cancelled

    def wait(self) -> Exception | None:
        self._thread.join()
        return self.error


def apply_async_statement(input_: AsyncApplyInput) -> AsyncApplyResult:  # noqa: PLR0912
    """Submit ``sql`` and poll until terminal, journalling each transition."""
    client = input_.client
    journal_store = input_.journal_store

    initial_state = _accept_changed_checksum(
        journal_store.read_migration_state(input_.migration_name),
        input_.migration_name,
        input_.migration_checksum,
    )
    prior_op = None
    if initial_state is not None:
        prior_op = next(
            (
                o
                for o in initial_state.operations
                if o.operation_index == input_.statement_index
            ),
            None,
        )

    # 1. Already completed → skip entirely, when it is this statement that ran (#599)
    if initial_state is not None and prior_op is not None and prior_op.status == "completed":
        assert_completed_statement(
            initial_state,
            migration=input_.migration_name,
            index=input_.statement_index,
            fingerprint=input_.fingerprint,
            cli_version=__version__,
        )
        input_.log(
            f"  {input_.operation_type}: query_id={prior_op.query_id} already "
            f"completed in prior run — skipping"
        )
        return AsyncApplyResult(kind="skipped", operation=prior_op)

    # 2. Currently in flight on the server → attach (no submit, just poll).
    server_now_ms, database = _read_server_state(client)
    # The id of the attempt the journal tracks. Without a record, the id an
    # earlier release submitted a statement's first attempt under, so an
    # attempt of it whose record the journal lost is not run twice.
    query_id = (prior_op.query_id if prior_op is not None else "") or make_deterministic_query_id(
        database,
        resolve_journal_table_name(),
        input_.migration_name,
        input_.statement_index,
    )
    known = reusable_outcome(input_.known, prior_op, input_.fingerprint)
    recorded = known or resolve_recorded_attempt(
        client,
        journal_store=journal_store,
        migration_name=input_.migration_name,
        op=prior_op,
        fingerprint=input_.fingerprint,
        sql=input_.sql,
        query_id=query_id,
        operation_type=input_.operation_type,
        log=input_.log,
    )
    if recorded.kind == "running":
        return _attach(input_, initial_state, prior_op, query_id, recorded)

    # 3. A started attempt that no replica runs any more finished on the
    # server when query_log has its QueryFinish (#672): its run ended before
    # it journaled the outcome. Record it, without compensating or resubmitting.
    if (
        recorded.kind == "finished"
        and recorded.status is not None
        and initial_state is not None
        and prior_op is not None
    ):
        return _record_finished_attempt(input_, initial_state, prior_op, recorded.status)

    # 4. An attempt of this statement's SQL without a server-recorded outcome
    # may have finished (#767), so running it again, even after before-retry
    # SQL, could load its rows twice or remove rows that landed. Stop,
    # writing nothing, so a later run still finds a late query_log entry.
    if recorded.kind == "unknown":
        raise outcome_unknown_error(
            input_.operation_type,
            input_.statement_index,
            input_.migration_name,
            query_id,
            recorded.reason,
        )
    _assert_lock_held(input_)

    # 5 / 6. Submit (with optional before-retry on resubmit) under a new
    # random id, which no other attempt or run ever submits and which is
    # recorded before its submit (#701, #767). A started attempt that failed
    # on the server is retried the same way, reported with its error.
    attempt_query_id = str(uuid.uuid4())
    # An attempt that was never sent ran nothing: it is submitted again
    # without the before-retry SQL, which runs only after a rejection or an abandon.
    if recorded.kind == "unsent":
        input_.log(
            f"  {input_.operation_type}: previous attempt of query_id={query_id} was never "
            f"sent — submitting async (query_id={attempt_query_id})"
        )
    elif prior_op is not None:
        prior_status: str = prior_op.status
        prior_error = prior_op.last_error
        if recorded.kind == "failed":
            prior_status = "failed"
            prior_error = recorded.error
        err_tail = f": {_first_line(prior_error)}" if prior_error else ""
        input_.log(
            f"  {input_.operation_type}: previous attempt of query_id={query_id} is "
            f"no longer running (status={prior_status}{err_tail}) — "
            f"running before-retry then resubmitting as query_id={attempt_query_id}"
        )
        # The checked attempt is journaled failed before it is compensated.
        # Its QueryFinish can still reach query_log after this check (query_log
        # is flushed on a timer), and a run that stops between the compensation
        # and the next 'started' write must not take it for this statement's
        # outcome on its re-run (#672). Without compensation nothing is written
        # until the next 'started' write, which replaces the record.
        if (
            recorded.kind == "failed"
            and initial_state is not None
            and input_.before_retry is not None
        ):
            _journal_attempt_failed(journal_store, initial_state, prior_op, prior_error)
        if input_.before_retry is not None:
            _execute_before_retry(input_, input_.before_retry)
    else:
        input_.log(
            f"  {input_.operation_type}: submitting async (query_id={attempt_query_id})"
        )

    # The attempt's start on the server clock, which also stamps query_log,
    # read before the attempt is journaled and submitted.
    started_at = iso_without_zone(_EPOCH + timedelta(milliseconds=server_now_ms))

    base_state = initial_state or fresh_migration_state(
        input_.migration_name, input_.migration_checksum
    )
    back_to_prepared = _record_attempt(input_, base_state, attempt_query_id, started_at)
    try:
        state_after_start = journal_store.read_migration_state(input_.migration_name)
        if input_.query_tracker is not None:
            input_.query_tracker.record_async(
                QueryContext(
                    input_.migration_name, input_.statement_index,
                    input_.sql, input_.before_retry,
                ),
                attempt_query_id,
            )
        poll_after_time = _query_log_lower_bound(server_now_ms)
        # Polling decides the outcome, as in TS: the submit error is raised only
        # when the server never saw the query, so it is not logged here (#561).
        submission = _Submission(
            lambda before_send: client.submit(
                input_.sql,
                query_id=attempt_query_id,
                settings=input_.settings,
                before_send=before_send,
            )
        )
    except BaseException as error:
        back_to_prepared(error)
        raise

    return _start_and_poll(
        input_,
        submission,
        back_to_prepared,
        migration_state=state_after_start,
        query_id=attempt_query_id,
        poll_after_time=poll_after_time,
        started_at=started_at,
    )


def _start_and_poll(
    input_: AsyncApplyInput,
    submission: _Submission,
    back_to_prepared: Callable[[BaseException], None],
    *,
    migration_state: MigrationRowState | None,
    query_id: str,
    poll_after_time: str,
    started_at: str,
) -> AsyncApplyResult:
    """Start the submit and poll until terminal.

    From the thread's start on, every stop, Ctrl-C included, gives the submit
    up before the migrate lock is released (#793). A stop before polling
    whose request was never written puts the record back to prepared; once
    polling started, the fenced record stays, as in TS.
    """
    polling = False
    try:
        submission.start()
        polling = True
        return _poll_until_terminal(
            input_=input_,
            migration_state=migration_state,
            query_id=query_id,
            poll_after_time=poll_after_time,
            submission=submission,
            started_at=started_at,
            fingerprint=input_.fingerprint,
            back_to_prepared=back_to_prepared,
        )
    except BaseException as error:
        if submission.abandon_unsent() and not polling:
            back_to_prepared(error)
        raise


def _assert_lock_held(input_: AsyncApplyInput) -> None:
    """Two runs without the lock could both submit the statement, each under an
    id of its own (#767). The run stops before it; the next one takes the lock."""
    # A run with the lock turned off holds none either, unless the user
    # accepts the risk (#810).
    if migrate_lock_disabled() and not async_without_lock_accepted():
        msg = (
            f"Async migration step {input_.operation_type} (statement "
            f"{input_.statement_index + 1} of {input_.migration_name}) was not submitted: "
            "CHKIT_MIGRATE_LOCK is off, so this run holds no migrate lock, and two runs "
            "without the lock could both submit it. The statements before it are "
            "recorded. Unset CHKIT_MIGRATE_LOCK and run chkit migrate --apply again to "
            "submit it under the lock. When the lock cannot work on this target "
            "(migrate_lock_unverifiable) and no other migrate runs against it, set "
            "CHKIT_MIGRATE_ASYNC_WITHOUT_LOCK=1 to submit it without the lock."
        )
        raise MigrateError("async_needs_lock", msg)
    if not input_.lockless_bootstrap:
        return
    msg = (
        f"Async migration step {input_.operation_type} (statement "
        f"{input_.statement_index + 1} of {input_.migration_name}) was not submitted: "
        "this run holds no migrate lock, because the target database did not exist "
        "when it started, and two runs without the lock could both submit it. The "
        "statements before it are recorded. Run chkit migrate --apply again: the "
        "database exists now, so that run takes the migrate lock and submits the "
        "statement."
    )
    raise MigrateError("async_needs_lock", msg)


def _record_attempt(
    input_: AsyncApplyInput, base_state: MigrationRowState, attempt_query_id: str, started_at: str
) -> Callable[[BaseException], None]:
    """Journal the attempt before its submit, read back from the server (#767).

    Returns what puts the record back to prepared when the run stops before
    the submit.
    """
    journal_store = input_.journal_store
    # These writes alone fence a record (#767). The attempt is prepared first,
    # and moves to "may have been sent" only once the server returned the
    # prepared record: a run that stops before that move, or whose read of it
    # lags, leaves an attempt a re-run can tell was never sent.
    def attempt_record(last_error: str) -> OperationState:
        return OperationState(
            operation_index=input_.statement_index,
            operation_key=input_.operation_key,
            operation_type=input_.operation_type,
            query_id=attempt_query_id,
            status="started",
            started_at=started_at,
            finished_at=None,
            last_error=last_error,
            fingerprint=input_.fingerprint,
            attempt_fenced=True,
        )

    def write_attempt(last_error: str) -> None:
        journal_store.write_migration_state(
            upsert_operation(
                base_state, attempt_record(last_error), iso_without_zone(datetime.now(tz=UTC))
            )
        )

    write_attempt(PREPARED_RECORD_MARKER)
    _assert_attempt_stored(input_, attempt_query_id, PREPARED_RECORD_MARKER)
    write_attempt(ATTEMPT_RECORD_MARKER)

    def back_to_prepared(error: BaseException) -> None:
        # Not sent: put the record back to prepared, so a re-run runs it
        # again without an abandon (#767). Ctrl-C included: it is cleanup (#816).
        try:
            with as_cleanup():
                write_attempt(PREPARED_RECORD_MARKER)
        except Exception as revert_error:
            raise RuntimeError(
                _not_reverted_message(error, revert_error, input_.migration_name)
            ) from error

    try:
        _assert_attempt_stored(input_, attempt_query_id, ATTEMPT_RECORD_MARKER)
    except BaseException as error:
        back_to_prepared(error)
        raise
    return back_to_prepared


def _attach(
    input_: AsyncApplyInput,
    initial_state: MigrationRowState | None,
    prior_op: OperationState | None,
    query_id: str,
    recorded: RecordedAttempt,
) -> AsyncApplyResult:
    """Poll a running earlier attempt until terminal, when its fenced record names it."""
    # Only a fenced record's id names the running attempt alone; any other
    # may also name earlier attempts, whose QueryFinish polls could take
    # for this one's outcome (#767).
    if recorded.after_time is None or prior_op is None:
        reason = recorded.reason
        msg = (
            f"Async migration step {input_.operation_type} (statement "
            f"{input_.statement_index + 1} of {input_.migration_name}, query_id "
            f"{query_id}) is still running on the server, {reason}. Nothing was "
            f"submitted and no before-retry SQL ran. {stop_running_advice(query_id)}"
        )
        raise MigrateError("async_outcome_unknown", msg)
    input_.log(
        f"  {input_.operation_type}: query_id={query_id} already running on "
        f"server — attaching to in-flight query"
    )
    # The record already names the attempt, and stays as it is.
    return _poll_until_terminal(
        input_=input_,
        migration_state=initial_state,
        query_id=query_id,
        poll_after_time=recorded.after_time,
        submission=None,
        fingerprint=input_.fingerprint,
        started_at=prior_op.started_at,
    )


def _execute_before_retry(input_: AsyncApplyInput, before_retry: str) -> None:
    input_.log(f"  {input_.operation_type}: running before-retry SQL")
    if input_.query_tracker is not None:
        input_.query_tracker.command(
            QueryContext(
                input_.migration_name, input_.statement_index, input_.sql, before_retry,
            ),
            "compensation", before_retry, input_.settings,
        )
    else:
        input_.client.execute(before_retry, settings=input_.settings)


def _poll_until_terminal(
    *,
    input_: AsyncApplyInput,
    migration_state: MigrationRowState | None,
    query_id: str,
    poll_after_time: str,
    submission: _Submission | None,
    started_at: str,
    fingerprint: str,
    back_to_prepared: Callable[[BaseException], None] | None = None,
) -> AsyncApplyResult:
    """Poll, then wait for the submit request to close, as TS does.

    Only an ``Exception`` waits for it. On Ctrl-C (any ``BaseException``) the
    run gives the submit up first, through its guard, which waits for a
    connect or a write under way (#767), then stops without waiting for the
    response: the migrate lock is released only after that.
    """
    try:
        result = _poll(
            input_=input_,
            migration_state=migration_state,
            query_id=query_id,
            poll_after_time=poll_after_time,
            submission=submission,
            started_at=started_at,
            fingerprint=fingerprint,
            back_to_prepared=back_to_prepared,
        )
    except Exception:
        # A run that stopped without an outcome does not wait for a submit
        # request that may never settle (#767).
        if submission is not None and not submission.abandoned:
            submission.wait()
        raise
    except BaseException:
        if submission is not None:
            submission.abandon()
        raise
    if submission is not None and not submission.abandoned:
        submission.wait()
    return result


def _poll(  # noqa: PLR0912, PLR0915 - one branch per poll outcome, as in TS
    *,
    input_: AsyncApplyInput,
    migration_state: MigrationRowState | None,
    query_id: str,
    poll_after_time: str,
    submission: _Submission | None,
    started_at: str,
    fingerprint: str,
    back_to_prepared: Callable[[BaseException], None] | None,
) -> AsyncApplyResult:
    poll_started_at = time.monotonic()
    transient_errors = 0
    # Polls in a row that found the query neither running nor in query_log,
    # however polling started (#767).
    unknown_polls = 0
    # Whether a poll found the query on the server: then its submit was sent,
    # whatever its error says (#800).
    seen_on_server = False

    while True:
        time.sleep(input_.poll_interval_seconds)
        # A submit the executor proved was never sent (a refused connect, a
        # failed host lookup) ran nothing: the attempt goes back to prepared and
        # the run stops, so a re-run submits it again without an abandon (#800).
        not_sent = submission.error if submission is not None else None
        if (
            submission is not None
            and isinstance(not_sent, SubmitNotSentError)
            and not seen_on_server
            and back_to_prepared is not None
        ):
            submission.abandon()
            back_to_prepared(not_sent)
            msg = (
                f"Async migration step {input_.operation_type} (query_id {query_id}) was "
                "not sent: the submit request never reached ClickHouse "
                f"({_describe_error(not_sent)}), so it was not submitted. Re-run "
                "`chkit migrate --apply`: an attempt that was never sent runs again."
            )
            raise RuntimeError(msg) from not_sent
        try:
            status = input_.client.query_status(
                query_id, after_time=poll_after_time, include_before_start=True
            )
            transient_errors = 0
        except Exception as poll_error:
            transient_errors += 1
            unknown_polls = 0
            elapsed_sec = int(time.monotonic() - poll_started_at)
            if transient_errors > MAX_TRANSIENT_POLL_ERRORS:
                raise _stop_without_outcome(
                    input_,
                    query_id,
                    submission,
                    f"polling failed {transient_errors}\u00d7 in a row "
                    f"({_describe_error(poll_error)})",
                ) from poll_error
            input_.log(
                f"  {input_.operation_type}: poll request failed "
                f"({_describe_error(poll_error)}) — load may still be running, "
                f"retrying (elapsed {elapsed_sec}s)"
            )
            continue

        elapsed_sec = int(time.monotonic() - poll_started_at)
        base_state = migration_state or fresh_migration_state(
            input_.migration_name, input_.migration_checksum
        )

        # A submit error (a gateway 524, a lost response) says nothing about
        # the outcome: the query may have run (#657, #767). Only the server's
        # record for the id decides it. After the budget, every replica is
        # read once more, through a query_log flush, before the run stops
        # with the attempt still recorded as started.
        unknown_polls = unknown_polls + 1 if status.status == "unknown" else 0
        if unknown_polls >= MAX_UNKNOWN_POLLS:
            try:
                status = _final_outcome_check(
                    input_.client, query_id, input_.operation_type, poll_after_time
                )
            except Exception as error:
                # The request's own error, not the check's wrapped message.
                cause = error.__cause__ or error
                raise _stop_without_outcome(
                    input_,
                    query_id,
                    submission,
                    f"the final check of every replica failed ({_describe_error(cause)})",
                ) from error
            if status.status == "unknown":
                raise _stop_without_outcome(
                    input_,
                    query_id,
                    submission,
                    "polling found it neither running nor in system.query_log "
                    f"{unknown_polls}\u00d7 in a row",
                )
            unknown_polls = 0
        # After the final check too: it can find the query (#800).
        if status.status != "unknown":
            seen_on_server = True

        if status.status == "finished":
            finished_op = OperationState(
                operation_index=input_.statement_index,
                operation_key=input_.operation_key,
                operation_type=input_.operation_type,
                query_id=query_id,
                status="completed",
                started_at=started_at,
                finished_at=iso_without_zone(datetime.now(tz=UTC)),
                last_error="",
                fingerprint=fingerprint,
            )
            # Once the outcome's journal write settled, written or rejected, a
            # proxy holding the submit's response does not keep the run, or
            # its migrate lock (#767).
            try:
                input_.journal_store.write_migration_state(
                    upsert_operation(
                        base_state,
                        finished_op,
                        iso_without_zone(datetime.now(tz=UTC)),
                    )
                )
            finally:
                if submission is not None:
                    submission.abandon()
            # TS reads the duration as a double and prints the result as String(n).
            finished_sec = js_number_to_string(
                js_math_round(float(status.duration_ms or 0) / 1000)
            )
            input_.log(
                f"  {input_.operation_type}: finished — "
                f"written={_format_rows(status.written_rows)} "
                f"({_format_bytes(status.written_bytes)}) in {finished_sec}s"
            )
            return AsyncApplyResult(kind="completed", operation=finished_op)

        if status.status == "failed":
            # Only a statement the server rejected before it started (#767)
            # ran nothing: one that failed while it ran can have applied
            # writes, so its fenced started record stays for the operator.
            if not status.before_start or not rejection_runs_nothing(input_.sql):
                # A proxy may hold the submit's response: the run stops as
                # every other stop without an outcome does, without waiting.
                if submission is not None:
                    submission.abandon()
                raise _failed_while_running_error(
                    input_,
                    query_id,
                    status.error or "<unknown>",
                    before_start=bool(status.before_start),
                )
            failed_op = OperationState(
                operation_index=input_.statement_index,
                operation_key=input_.operation_key,
                operation_type=input_.operation_type,
                query_id=query_id,
                status="failed",
                started_at=started_at,
                finished_at=iso_without_zone(datetime.now(tz=UTC)),
                last_error=status.error or "<unknown>",
                fingerprint=fingerprint,
                # A rejection the server recorded for this id: a re-run may retry it.
                attempt_fenced=True,
            )
            try:
                input_.journal_store.write_migration_state(
                    upsert_operation(
                        base_state,
                        failed_op,
                        iso_without_zone(datetime.now(tz=UTC)),
                    )
                )
            finally:
                if submission is not None:
                    submission.abandon()
            msg = (
                f"Async migration step {input_.operation_type} failed "
                f"(query_id {query_id}): {status.error or '<unknown>'}"
            )
            raise RuntimeError(msg)

        if status.status == "running":
            input_.log(_progress_line(input_.operation_type, status, elapsed_sec))
            continue

        input_.log(
            f"  {input_.operation_type}: status unknown — still polling "
            f"(elapsed {elapsed_sec}s)"
        )


def _accept_changed_checksum(
    state: MigrationRowState | None,
    migration_name: str,
    migration_checksum: str,
) -> MigrationRowState | None:
    """Defense in depth behind apply's re-keying of an edited in-progress state.

    A state whose checksum still differs is accepted only when no statement
    is recorded as completed or started, and the writes that follow carry
    the new checksum.
    """
    if (
        state is None
        or state.migration_completed
        or state.checksum == migration_checksum
    ):
        return state
    if has_statement_progress(state):
        raise in_progress_checksum_mismatch_error(
            migration=migration_name,
            journal_checksum=state.checksum,
            file_checksum=migration_checksum,
            is_async=True,
        )
    return state.model_copy(update={"checksum": migration_checksum})


def _stop_without_outcome(
    input_: AsyncApplyInput, query_id: str, submission: _Submission | None, reason: str
) -> MigrateError:
    """Every stop without an outcome (#767).

    The submit is given up, so a request not sent yet never starts, the run
    does not wait for one that may never settle, and the fenced started
    record stays for the next run.
    """
    submit_error = submission.error if submission is not None else None
    if submission is not None:
        submission.abandon()
    submit_tail = (
        f", and the submit request failed ({_describe_error(submit_error)})"
        if submit_error is not None
        else ""
    )
    return outcome_unknown_error(
        input_.operation_type,
        input_.statement_index,
        input_.migration_name,
        query_id,
        f"{reason}{submit_tail}",
    )


def _final_outcome_check(
    client: ClickHouseClient, query_id: str, operation_type: str, after_time: str
) -> QueryStatus:
    """After the unknown-poll budget: every replica, then the query_log flush rechecks."""
    status = _check_in_flight(client, query_id, operation_type, after_time)
    if status.status != "unknown":
        return status
    return _recheck_through_flush(client, query_id, operation_type, after_time)


def _recheck_through_flush(
    client: ClickHouseClient, query_id: str, operation_type: str, after_time: str
) -> QueryStatus:
    """Check the attempt again while query_log is flushed (#701)."""
    status = QueryStatus(status="unknown")
    for _ in range(QUERY_LOG_FLUSH_RECHECKS):
        time.sleep(QUERY_LOG_FLUSH_RECHECK_INTERVAL_SECONDS)
        status = _check_in_flight(client, query_id, operation_type, after_time)
        if status.status != "unknown":
            break
    return status


def _check_in_flight(
    client: ClickHouseClient,
    query_id: str,
    operation_type: str,
    attempt_after_time: str | None,
) -> QueryStatus:
    """Whether a previous attempt still runs, read on every replica (#246).

    The retry path that follows a 'not running' answer runs before-retry SQL
    (e.g. a TRUNCATE) and resubmits, so the answer must cover every replica:
    the attempt runs on the replica that received it. A replica that cannot be
    read fails the check instead of being skipped, and a failed check stops
    here, before anything is compensated or resubmitted. Without a started
    attempt only ``system.processes`` is read: the check needs no outcome, and
    a fresh server has no ``system.query_log`` until its first log flush. With
    one, the check also reads the attempt's outcome from ``system.query_log``
    (#672), and fails like an unreadable replica when query_log cannot be read.
    A failed outcome lookup leaves the attempt's outcome unknown, so it stops
    with ``async_outcome_unknown`` (#782).
    """
    try:
        if attempt_after_time is None:
            return client.query_status(query_id, every_replica=True, running_only=True)
        return client.query_status(
            query_id,
            every_replica=True,
            after_time=attempt_after_time,
            include_before_start=True,
        )
    except Exception as error:
        if attempt_after_time is not None and _QUERY_LOG_ACCESS_DENIED.search(
            _describe_error(error)
        ):
            msg = (
                f"Async migration step {operation_type} (query_id {query_id}): the "
                "ClickHouse user cannot read system.query_log, which tells whether the "
                f"previous attempt finished ({_describe_error(error)}). Nothing was "
                "resubmitted and no before-retry SQL ran. Grant SELECT ON "
                "system.query_log to the user; until then a re-run of `chkit migrate "
                "--apply` stops here too."
            )
            raise MigrateError("async_outcome_unknown", msg) from error
        msg = (
            f"Async migration step {operation_type} (query_id {query_id}): could "
            f"not check whether a previous attempt is still running "
            f"({_describe_error(error)}). Nothing was resubmitted and no "
            f"before-retry SQL ran — re-run `chkit migrate --apply`."
        )
        if attempt_after_time is None:
            raise RuntimeError(msg) from error
        raise MigrateError("async_outcome_unknown", msg) from error


def _record_finished_attempt(
    input_: AsyncApplyInput,
    state: MigrationRowState,
    op: OperationState,
    status: QueryStatus,
) -> AsyncApplyResult:
    """Journal a started attempt that finished on the server as completed (#672)."""
    finished_op = op.model_copy(
        update={
            "status": "completed",
            "finished_at": iso_without_zone(datetime.now(tz=UTC)),
            "last_error": "",
        }
    )
    input_.journal_store.write_migration_state(
        upsert_operation(state, finished_op, iso_without_zone(datetime.now(tz=UTC)))
    )
    # TS reads the duration as a double and prints the result as String(n).
    finished_sec = js_number_to_string(js_math_round(float(status.duration_ms or 0) / 1000))
    input_.log(
        f"  {input_.operation_type}: previous attempt of query_id={op.query_id} "
        f"finished on the server — written={_format_rows(status.written_rows)} "
        f"({_format_bytes(status.written_bytes)}) in {finished_sec}s, "
        f"recording it as completed"
    )
    return AsyncApplyResult(kind="completed", operation=finished_op)


def _journal_attempt_failed(
    journal_store: JournalStore,
    state: MigrationRowState,
    op: OperationState,
    last_error: str,
) -> None:
    """Journal a checked started attempt failed before it is compensated (#672)."""
    journal_store.write_migration_state(
        upsert_operation(
            state,
            op.model_copy(
                update={
                    "status": "failed",
                    "finished_at": iso_without_zone(datetime.now(tz=UTC)),
                    "last_error": last_error,
                }
            ),
            iso_without_zone(datetime.now(tz=UTC)),
        )
    )


RecordedAttemptKind = Literal["running", "finished", "failed", "unknown", "unsent", "ended"]


@dataclass(frozen=True, slots=True)
class RecordedAttempt:
    """What the server shows of the attempt a statement's record names (#767).

    ``running``: ``after_time`` is set when the record is fenced, so its id
    names that attempt alone. ``failed``: the server's failure of the fenced
    id. ``unknown``: an attempt of this statement without a server-recorded
    outcome. ``ended``: no attempt to resolve (none, a server-recorded failure
    or an abandon, or another statement's SQL).
    """

    kind: RecordedAttemptKind
    after_time: str | None = None
    reason: str = ""
    status: QueryStatus | None = None
    error: str = ""


# An outcome ``resolve_recorded_attempt`` read earlier in this run, with the
# record it read it for (#767).
KnownOutcome = tuple[OperationState, RecordedAttempt]


def reusable_outcome(
    known: KnownOutcome | None, op: OperationState | None, fingerprint: str
) -> RecordedAttempt | None:
    """The outcome read earlier for ``op``, when it stands for a new lookup (#767).

    Only one query_log settled (an unsent, failed or finished attempt, which
    stays so under the lock), for this very record and the SQL the statement
    still has. An attempt that ended without one is checked in
    system.processes again right before the statement runs.
    """
    if known is None or op is None or known[1].kind == "ended":
        return None
    recorded_op, recorded = known
    same = (
        recorded_op.query_id == op.query_id
        and recorded_op.status == op.status
        and recorded_op.last_error == op.last_error
        and recorded_op.fingerprint == fingerprint
    )
    return recorded if same else None


_NO_ENTRY_REASON = (
    "system.query_log has no entry for its query id (query logging is off for the user, "
    "query_log is flushed later than chkit waits, or the run stopped before it submitted "
    "the statement)"
)
_UNFENCED_REASON = (
    "an earlier chkit release recorded it, or the journal could not store the record's "
    "fence (it has no operation_fingerprints column), so its query id may name earlier "
    "attempts too"
)
_UNVERIFIED_FAILURE_REASON = (
    "the journal records it as failed, but not from a rejection the server recorded before "
    "it started (an earlier chkit release recorded it, it failed while it ran, or a run lost "
    "its submit response), so some of its writes may have been applied"
)
_WHILE_PROCESSING_REASON = (
    "the server reports it failed while it ran (ExceptionWhileProcessing), and a statement "
    "that fails while it runs can leave some of its writes applied (parts of an INSERT ... "
    "SELECT, a DDL that ran on some hosts)"
)
_BEFORE_START_EFFECTS_REASON = (
    "the server reports it was rejected before it started (ExceptionBeforeStart), but a "
    "statement other than a SELECT or an INSERT can apply effects before that (an ALTER's "
    "mutation keeps running in system.mutations, or applied to some partitions before one "
    "failed)"
)
_STALE_PREPARED_REASON = (
    "the journal records it as prepared, not sent, but chkit cannot read every copy of the "
    "journal to rule out a newer record of it (one that may have been sent)"
)
_OTHER_SQL_REASON = (
    "it ran other SQL than the statement now has (an edit, or a plugin's onBeforeApply "
    "rewrite)"
)
_NOT_RECORDED_RUNNING = (
    "but its query id was not recorded by this chkit release for that attempt alone, so "
    "chkit cannot tell its outcome from system.query_log once it ends"
)
_FAILED_RUNNING = (
    "but the journal records that attempt as failed, so chkit does not attach to it, and "
    "the next chkit migrate --apply runs the statement again (after its before-retry SQL, "
    "when it has one)"
)
# The last_error prefix of a record --abandon reset: the operator's decision
# to run the statement again (migrate_abandon.py).
_ABANDONED_PREFIX = "abandoned via chkit migrate --abandon (was "


def resolve_recorded_attempt(  # noqa: PLR0911, PLR0912 - one return per outcome, as in TS
    client: ClickHouseClient,
    *,
    journal_store: JournalStore,
    migration_name: str,
    op: OperationState | None,
    fingerprint: str,
    # The statement's SQL, when known: only it can show a rejection ran nothing (#767).
    sql: str | None,
    query_id: str,
    operation_type: str,
    log: Callable[[str], None],
) -> RecordedAttempt:
    """Read the outcome of the attempt ``op`` records, on every replica (#246).

    Only a fenced record's id names its attempt alone, so only its query_log
    entries count (#767): a QueryFinish completes it, a rejection before the
    start lets it be retried, and no entry, after the query_log flush
    rechecks (#701), is unknown. A started record without the fence, or a
    failed one that no rejection or abandon recorded, may have finished, so
    it is unknown once it no longer runs. The record is read as it was
    recorded, whatever SQL the statement has now (an edit, a plugin's
    onBeforeApply rewrite).
    """
    recorded = op is not None and op.query_id != ""
    other_sql = op is not None and op.fingerprint not in ("", fingerprint)
    # Only this release writes a prepared record, and only under an id of its
    # own, so its id names that attempt alone too.
    prepared = (
        recorded
        and op is not None
        and op.status == "started"
        and op.last_error == PREPARED_RECORD_MARKER
    )
    fenced = (
        recorded and op is not None and op.status == "started" and op.attempt_fenced
    ) and not prepared
    after_time = (
        _query_log_lower_bound(_journal_time_ms(op.started_at))
        if (fenced or prepared) and op is not None
        else None
    )
    status = _check_in_flight(client, query_id, operation_type, after_time)
    if after_time is not None and status.status == "unknown":
        log(
            f"  {operation_type}: previous attempt of query_id={query_id} is not "
            "running and has no outcome in system.query_log yet — checking again while "
            "query_log is flushed"
        )
        status = _recheck_through_flush(client, query_id, operation_type, after_time)
    if status.status == "running":
        if other_sql:
            # The running attempt is the SQL its record names (#599): an attempt
            # of other SQL, kept by --abandon and an edit, must not finish as this one.
            msg = (
                f"Async migration step {operation_type} (query_id {query_id}): an "
                "earlier attempt with different SQL is still running on the server. "
                f"{stop_running_advice(query_id)}"
            )
            raise RuntimeError(msg)
        reason = (
            _FAILED_RUNNING if op is not None and op.status == "failed" else _NOT_RECORDED_RUNNING
        )
        return RecordedAttempt(kind="running", after_time=after_time, reason=reason)
    if op is not None and after_time is not None:
        if status.status == "finished":
            if other_sql:
                return RecordedAttempt(kind="unknown", reason=_OTHER_SQL_REASON)
            return RecordedAttempt(kind="finished", status=status)
        if status.status == "failed":
            if not status.before_start:
                return RecordedAttempt(kind="unknown", reason=_WHILE_PROCESSING_REASON)
            if sql is not None and rejection_runs_nothing(sql):
                return RecordedAttempt(kind="failed", error=status.error or "<unknown>")
            return RecordedAttempt(kind="unknown", reason=_BEFORE_START_EFFECTS_REASON)
        if not prepared:
            return RecordedAttempt(kind="unknown", reason=_NO_ENTRY_REASON)
        # A prepared attempt with nothing of its id on the server was never
        # sent, when no copy of the journal holds a newer record of it.
        if _prepared_is_current(journal_store, migration_name, op):
            return RecordedAttempt(kind="unsent")
        return RecordedAttempt(kind="unknown", reason=_STALE_PREPARED_REASON)
    if not recorded or op is None or op.status == "completed":
        return RecordedAttempt(kind="ended")
    if op.status == "started":
        return RecordedAttempt(kind="unknown", reason=_UNFENCED_REASON)
    if op.attempt_fenced or op.last_error.startswith(_ABANDONED_PREFIX):
        return RecordedAttempt(kind="ended")
    return RecordedAttempt(kind="unknown", reason=_UNVERIFIED_FAILURE_REASON)


def _prepared_is_current(
    journal_store: JournalStore, migration_name: str, op: OperationState
) -> bool:
    """Whether a journal read that covers every copy still holds ``op`` as prepared (#767).

    A read of one replica behind a load balancer can return a prepared row
    that another replica has superseded with a record of an attempt that may
    have been sent. A read that fails counts as no.
    """
    try:
        read = journal_store.read_operation_on_every_copy(migration_name, op.operation_index)
    except Exception:
        return False
    if not read.covered:
        return False
    current = read.op
    return (
        current is not None
        and current.status == "started"
        and current.query_id == op.query_id
        and current.last_error == PREPARED_RECORD_MARKER
    )


def finished_record_of(op: OperationState) -> OperationState:
    """The record of an attempt that finished on the server."""
    return op.model_copy(
        update={
            "status": "completed",
            "finished_at": iso_without_zone(datetime.now(tz=UTC)),
            "last_error": "",
        }
    )


# How many times, and how far apart, a started record's read-back is tried
# before the attempt is not submitted: a read can land on a replica that has
# not got the write yet.
_STORED_ATTEMPT_READS = 5
_STORED_ATTEMPT_READ_INTERVAL_SECONDS = 1.0


def _assert_attempt_stored(input_: AsyncApplyInput, query_id: str, last_error: str) -> None:
    """Refuse to submit until the journal's server returns the attempt's record (#767).

    It must carry the attempt's id, fingerprint, marker and fence: only the
    journal knows the random id, and only the fence stops an earlier release
    from resuming the record without recording it failed first. A read that
    fails is tried again like one that lags.
    """
    stored: OperationState | None = None
    read_error: Exception | None = None
    for read in range(_STORED_ATTEMPT_READS):
        if read > 0:
            time.sleep(_STORED_ATTEMPT_READ_INTERVAL_SECONDS)
        try:
            stored = input_.journal_store.read_stored_operation(
                input_.migration_name, input_.statement_index
            )
            read_error = None
        except Exception as error:
            read_error = error
            continue
        if (
            stored is not None
            and stored.status == "started"
            and stored.query_id == query_id
            and stored.fingerprint == input_.fingerprint
            and stored.last_error == last_error
            and stored.attempt_fenced
        ):
            return
    prefix = f"Async migration step {input_.operation_type} (query_id {query_id})"
    if stored is not None and stored.query_id == query_id and not stored.attempt_fenced:
        msg = (
            f"{prefix}: the journal stored the attempt without its fence, because it has no "
            "operation_fingerprints column, so it was not submitted and stays prepared. An "
            "earlier chkit release could resume an attempt stored that way and run its "
            "before-retry SQL without recording it, which loses rows. Add the column with a "
            "user that can alter the journal (ALTER TABLE <database>."
            f"{resolve_journal_table_name()} ADD COLUMN IF NOT EXISTS operation_fingerprints "
            "Array(String) DEFAULT [] ON every replica, or any chkit migrate --apply by that "
            "user), then run chkit migrate --apply again: it submits the statement, and the "
            "statements that completed stay completed."
        )
        raise MigrateError("async_attempt_unfenced", msg)
    tail = f" ({_describe_error(read_error)})" if read_error is not None else ""
    msg = (
        f"{prefix}: the journal did not return the attempt's record{tail}, so it was not "
        "submitted. Re-run `chkit migrate --apply`: an attempt that was never sent runs again."
    )
    raise RuntimeError(msg) from read_error


def _not_reverted_message(
    error: BaseException, revert_error: BaseException, migration_name: str
) -> str:
    """A stop before the submit whose record could not go back to prepared (#767)."""
    return (
        f"{_describe_error(error)}. The attempt was never sent, but chkit could not put its "
        f"record back to prepared ({_describe_error(revert_error)}), so the next chkit "
        "migrate --apply stops with async_outcome_unknown: run chkit migrate --apply "
        f"--abandon {migration_name} to run it again."
    )


def stop_running_advice(query_id: str) -> str:
    """What to do about an attempt still running (#767).

    A killed statement can still have applied effects, so the operator
    reconciles before applying.
    """
    return (
        f"Wait for it to finish, or stop it with KILL QUERY WHERE query_id = '{query_id}'. "
        "A stopped statement can still have applied effects (an ALTER's mutation keeps "
        "running, see system.mutations), so check what it applied and reconcile before you "
        "run chkit migrate --apply again: until its outcome is known, migrate stops with "
        "async_outcome_unknown."
    )


def _failed_while_running_error(
    input_: AsyncApplyInput, query_id: str, error: str, *, before_start: bool
) -> MigrateError:
    what = (
        f"was rejected before it started (ExceptionBeforeStart): {error}. A statement other "
        "than a SELECT or an INSERT can apply effects before that (an ALTER's mutation keeps "
        "running in system.mutations, or applied to some partitions before one failed)"
        if before_start
        else f"failed while it ran: {error}. A statement that fails while it runs can leave "
        "some of its writes applied (parts of an INSERT ... SELECT, a DDL that ran on some "
        "hosts)"
    )
    msg = (
        f"Async migration step {input_.operation_type} (statement "
        f"{input_.statement_index + 1} of {input_.migration_name}, query_id {query_id}) "
        f"{what}, so chkit does not run it, or its before-retry SQL, again. Check in "
        "ClickHouse what the statement applied. Then reconcile every statement of "
        f"{input_.migration_name} "
        "that already ran, since an abandon runs the migration again from statement 1, run "
        f"chkit migrate --apply --abandon {input_.migration_name}, and apply again."
    )
    return MigrateError("async_outcome_unknown", msg)


def outcome_unknown_error(
    operation_type: str,
    statement_index: int,
    migration_name: str,
    query_id: str,
    reason: str,
) -> MigrateError:
    msg = (
        f"Async migration step {operation_type} (statement "
        f"{statement_index + 1} of {migration_name}, query_id {query_id}): "
        "the journal records an attempt of it and no replica runs it, but chkit cannot "
        f"tell whether it finished: {reason}. Nothing was submitted and no before-retry SQL "
        "ran. Check in ClickHouse whether the statement's rows reached its target. Then "
        f"reconcile every statement of {migration_name} that already ran, since an abandon "
        "runs the migration again from statement 1, run chkit migrate --apply --abandon "
        f"{migration_name}, and apply again."
    )
    return MigrateError("async_outcome_unknown", msg)


def _journal_time(value: str) -> datetime:
    """The journal returns DateTime64 without a zone, all of it UTC."""
    parsed = datetime.fromisoformat(value.strip().replace(" ", "T"))
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def _journal_time_ms(value: str) -> int:
    return (_journal_time(value) - _EPOCH) // timedelta(milliseconds=1)


def _query_log_lower_bound(started_ms: int) -> str:
    return _iso_bound(started_ms - QUERY_LOG_MARGIN_MS)


def _iso_bound(bound_ms: int) -> str:
    return (
        datetime.fromtimestamp(bound_ms / 1000, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _read_server_state(client: ClickHouseClient) -> tuple[int, str]:
    rows = client.query(
        "SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms, currentDatabase() AS database"
    ).rows
    msg = "Could not read the ClickHouse server time and database for an async statement."
    try:
        now_ms = int(rows[0]["now_ms"])
        database = rows[0]["database"]
    except (IndexError, KeyError, TypeError, ValueError) as error:
        raise RuntimeError(msg) from error
    if not isinstance(database, str) or database == "":
        raise RuntimeError(msg)
    return now_ms, database
