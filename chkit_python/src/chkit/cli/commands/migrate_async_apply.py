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
from typing import Literal

from chkit import __version__
from chkit.cli.commands.migrate_errors import MigrateError, in_progress_checksum_mismatch_error
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
from chkit.clickhouse.client import ClickHouseClient, QueryStatus, clickhouse_error_message
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
# query_log is flushed on a timer, every 7.5 s by default. A fenced started
# attempt that no replica runs and that has no query_log entry is checked
# again this many times, QUERY_LOG_FLUSH_RECHECK_INTERVAL_SECONDS apart,
# before it counts as having no outcome, so an attempt that ended right before
# the check is found (#701).
QUERY_LOG_FLUSH_RECHECKS = 5
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


class _Submission:
    """The submit request, open on its own thread while the poller runs.

    The request returns when the query ends (or a proxy cuts it), so the
    poller does not wait for it: TS starts ``db.submit`` without awaiting it.
    ``error`` is set once the request has failed.
    """

    def __init__(self, submit: Callable[[], object]) -> None:
        self.error: Exception | None = None
        # A daemon, so an interrupted run exits while the request is open;
        # the query keeps running and a re-run attaches to it.
        self._thread = threading.Thread(
            target=self._run, args=(submit,), name=SUBMIT_THREAD_NAME, daemon=True
        )
        self._thread.start()

    def _run(self, submit: Callable[[], object]) -> None:
        try:
            submit()
        except Exception as error:  # the poller decides what it means
            self.error = error

    def wait(self) -> Exception | None:
        self._thread.join()
        return self.error


def apply_async_statement(input_: AsyncApplyInput) -> AsyncApplyResult:
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
    attempt_check = _started_attempt_check(prior_op, input_.fingerprint)
    in_flight = _check_attempt(input_, query_id, attempt_check)
    # Only the outcome read of a started attempt can tell that it ended.
    attempt_outcome = "unknown" if attempt_check is None else in_flight.status
    if in_flight.status == "running":
        return _attach(input_, initial_state, prior_op, query_id, attempt_check)

    # 3. A started attempt that no replica runs any more finished on the
    # server when query_log has its QueryFinish (#672): its run ended before
    # it journaled the outcome. Record it, without compensating or resubmitting.
    if attempt_outcome == "finished" and initial_state is not None and prior_op is not None:
        return _record_finished_attempt(input_, initial_state, prior_op, in_flight)

    # 4. A started attempt of this statement's SQL without an outcome: no
    # query_log entry of its fenced id, or a record whose id may name earlier
    # attempts too (#767). It may have finished, so running it again, even
    # after before-retry SQL that cannot tell, could load its rows twice or
    # take a stale outcome for it. Stop, writing nothing, so a later run
    # still finds a late query_log entry.
    if attempt_outcome != "failed" and _is_attempt_of_statement(prior_op, input_.fingerprint):
        raise _outcome_unknown_error(input_, query_id, fenced=attempt_check is not None)

    # 5 / 6. Submit (with optional before-retry on resubmit) under a new
    # random id, which no other attempt or run ever submits and which is
    # recorded before its submit (#701, #767). A started attempt that failed
    # on the server is retried the same way, reported with its error.
    attempt_query_id = str(uuid.uuid4())
    if prior_op is not None:
        prior_status: str = prior_op.status
        prior_error = prior_op.last_error
        if attempt_outcome == "failed":
            prior_status = "failed"
            prior_error = in_flight.error or "<unknown>"
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
            attempt_check is not None
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
    # This write alone fences a record (#767).
    journal_store.write_migration_state(
        upsert_operation(
            base_state,
            OperationState(
                operation_index=input_.statement_index,
                operation_key=input_.operation_key,
                operation_type=input_.operation_type,
                query_id=attempt_query_id,
                status="started",
                started_at=started_at,
                finished_at=None,
                last_error=ATTEMPT_RECORD_MARKER,
                fingerprint=input_.fingerprint,
                attempt_fenced=True,
            ),
            iso_without_zone(datetime.now(tz=UTC)),
        )
    )

    state_after_start = journal_store.read_migration_state(input_.migration_name)
    _assert_attempt_recorded(input_, state_after_start, attempt_query_id)
    poll_after_time = _query_log_lower_bound(server_now_ms)
    # Polling decides the outcome, as in TS: the submit error is raised only
    # when the server never saw the query, so it is not logged here (#561).
    if input_.query_tracker is not None:
        input_.query_tracker.record_async(
            QueryContext(
                input_.migration_name, input_.statement_index,
                input_.sql, input_.before_retry,
            ),
            attempt_query_id,
        )
    submission = _Submission(
        lambda: client.submit(input_.sql, query_id=attempt_query_id, settings=input_.settings)
    )

    return _poll_until_terminal(
        input_=input_,
        migration_state=state_after_start,
        query_id=attempt_query_id,
        poll_after_time=poll_after_time,
        submission=submission,
        started_at=started_at,
        fingerprint=input_.fingerprint,
    )


def _attach(
    input_: AsyncApplyInput,
    initial_state: MigrationRowState | None,
    prior_op: OperationState | None,
    query_id: str,
    attempt_check: _StartedAttemptCheck | None,
) -> AsyncApplyResult:
    """Poll a running earlier attempt until terminal, when its fenced record names it."""
    # The running attempt is the SQL its record names (#599): an attempt
    # of other SQL, kept by --abandon and an edit, must not finish as this one.
    attempt_fingerprint = prior_op.fingerprint if prior_op is not None else ""
    if attempt_fingerprint not in ("", input_.fingerprint):
        msg = (
            f"Async migration step {input_.operation_type} (query_id {query_id}): an "
            "earlier attempt with different SQL is still running on the server. Wait "
            f"for it to finish or run KILL QUERY WHERE query_id = '{query_id}', then "
            "re-run chkit migrate --apply."
        )
        raise RuntimeError(msg)
    # Only a fenced record's id names the running attempt alone; any other
    # may also name earlier attempts, whose QueryFinish polls could take
    # for this one's outcome (#767).
    if attempt_check is None or prior_op is None:
        reason = (
            "but the journal records that attempt as failed, so chkit does not attach to "
            "it, and the next chkit migrate --apply runs the statement again (after its "
            "before-retry SQL, when it has one)"
            if prior_op is not None and prior_op.status == "failed"
            else "but its query id was not recorded by this chkit release for that attempt "
            "alone, so chkit cannot tell its outcome from system.query_log once it ends"
        )
        msg = (
            f"Async migration step {input_.operation_type} (statement "
            f"{input_.statement_index + 1} of {input_.migration_name}, query_id "
            f"{query_id}) is still running on the server, {reason}. Nothing was "
            "submitted and no before-retry SQL ran. Wait for it to finish or run "
            f"KILL QUERY WHERE query_id = '{query_id}', then run chkit migrate "
            "--apply again."
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
        poll_after_time=attempt_check.after_time,
        submission=None,
        fingerprint=input_.fingerprint,
        started_at=prior_op.started_at,
    )


def _assert_attempt_recorded(
    input_: AsyncApplyInput, state: MigrationRowState | None, query_id: str
) -> None:
    """Refuse to submit an attempt whose random id the journal does not have (#767).

    Only the journal knows the id, so a re-run could not find the attempt.
    """
    recorded = next(
        (
            o
            for o in (state.operations if state is not None else [])
            if o.operation_index == input_.statement_index
        ),
        None,
    )
    if recorded is None or recorded.query_id != query_id:
        msg = (
            f"Async migration step {input_.operation_type} (query_id {query_id}): "
            "the journal does not have the attempt's started record, so it was not "
            "submitted. Re-run `chkit migrate --apply`."
        )
        raise RuntimeError(msg)


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
) -> AsyncApplyResult:
    """Poll, then wait for the submit request to close, as TS does.

    Only an ``Exception`` waits for it: on Ctrl-C the run stops at once.
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
        )
    except Exception:
        if submission is not None:
            submission.wait()
        raise
    if submission is not None:
        submission.wait()
    return result


def _poll(
    *,
    input_: AsyncApplyInput,
    migration_state: MigrationRowState | None,
    query_id: str,
    poll_after_time: str,
    submission: _Submission | None,
    started_at: str,
    fingerprint: str,
) -> AsyncApplyResult:
    poll_started_at = time.monotonic()
    transient_errors = 0
    # Once a poll found the query running, the server has it, so a failed
    # submit request (a gateway 524, a timeout) says nothing about its outcome (#657).
    seen_running = False
    unknown_polls_after_submit_error = 0

    while True:
        time.sleep(input_.poll_interval_seconds)
        try:
            status = input_.client.query_status(query_id, after_time=poll_after_time)
            transient_errors = 0
        except Exception as poll_error:
            transient_errors += 1
            elapsed_sec = int(time.monotonic() - poll_started_at)
            if transient_errors > MAX_TRANSIENT_POLL_ERRORS:
                # A submit error is the only trace of e.g. a rejected statement (#561).
                # The caller waits for the submit anyway; wait here so its error
                # makes it into the message.
                submit_error = submission.wait() if submission is not None else None
                submit_tail = (
                    f" The submit request failed too ({_describe_error(submit_error)})."
                    if submit_error is not None
                    else ""
                )
                msg = (
                    f"Async migration step {input_.operation_type} "
                    f"(query_id {query_id}): polling failed {transient_errors}\u00d7 "
                    f"({_describe_error(poll_error)}).{submit_tail} The load may still be "
                    f"running server-side — re-run `chkit migrate --apply` to re-attach."
                )
                raise RuntimeError(msg) from poll_error
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
            input_.journal_store.write_migration_state(
                upsert_operation(
                    base_state,
                    finished_op,
                    iso_without_zone(datetime.now(tz=UTC)),
                )
            )
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
            )
            input_.journal_store.write_migration_state(
                upsert_operation(
                    base_state,
                    failed_op,
                    iso_without_zone(datetime.now(tz=UTC)),
                )
            )
            msg = (
                f"Async migration step {input_.operation_type} failed "
                f"(query_id {query_id}): {status.error or '<unknown>'}"
            )
            raise RuntimeError(msg)

        if status.status == "running":
            seen_running = True
            unknown_polls_after_submit_error = 0
            input_.log(_progress_line(input_.operation_type, status, elapsed_sec))
            continue

        # status is "unknown" here. If submit already raised and no poll found
        # the query running, it never made it server-side (e.g. SQL parse
        # error): record the attempt as failed and surface that error. Known
        # gap: a load that ends before the first poll, with a transport error
        # on its submit, also lands here (#657). Otherwise it's a transient gap
        # (just-submitted, or just-finished before query_log has it).
        submit_error = submission.error if submission is not None else None
        if submit_error is not None and not seen_running:
            input_.journal_store.write_migration_state(
                upsert_operation(
                    base_state,
                    OperationState.model_validate(
                        {
                            "operationIndex": input_.statement_index,
                            "operationKey": input_.operation_key,
                            "operationType": input_.operation_type,
                            "queryId": query_id,
                            "status": "failed",
                            "startedAt": started_at,
                            "finishedAt": iso_without_zone(datetime.now(tz=UTC)),
                            "lastError": _describe_error(submit_error),
                            "fingerprint": fingerprint,
                        }
                    ),
                    iso_without_zone(datetime.now(tz=UTC)),
                )
            )
            raise submit_error
        if submit_error is not None:
            unknown_polls_after_submit_error += 1
            if unknown_polls_after_submit_error > MAX_TRANSIENT_POLL_ERRORS:
                msg = (
                    f"Async migration step {input_.operation_type} "
                    f"(query_id {query_id}): the submit request failed "
                    f"({_describe_error(submit_error)}) and polling found no outcome "
                    f"{unknown_polls_after_submit_error}\u00d7. A re-run of `chkit migrate "
                    f"--apply` attaches to the query if it still runs, records its outcome "
                    f"from system.query_log, and stops with async_outcome_unknown when there "
                    f"is none."
                )
                raise RuntimeError(msg) from submit_error
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


def _check_attempt(
    input_: AsyncApplyInput, query_id: str, attempt_check: _StartedAttemptCheck | None
) -> QueryStatus:
    """The in-flight check, repeated while query_log is flushed when it waits (#701)."""
    after_time = attempt_check.after_time if attempt_check is not None else None
    in_flight = _check_in_flight(input_.client, query_id, input_.operation_type, after_time)
    if attempt_check is None or in_flight.status != "unknown":
        return in_flight
    input_.log(
        f"  {input_.operation_type}: previous attempt of query_id={query_id} is not "
        "running and has no outcome in system.query_log yet — checking again while "
        "query_log is flushed"
    )
    for _ in range(QUERY_LOG_FLUSH_RECHECKS):
        time.sleep(QUERY_LOG_FLUSH_RECHECK_INTERVAL_SECONDS)
        in_flight = _check_in_flight(input_.client, query_id, input_.operation_type, after_time)
        if in_flight.status != "unknown":
            break
    return in_flight


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
    """
    try:
        if attempt_after_time is None:
            return client.query_status(query_id, every_replica=True, running_only=True)
        return client.query_status(
            query_id, every_replica=True, after_time=attempt_after_time
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
            raise RuntimeError(msg) from error
        msg = (
            f"Async migration step {operation_type} (query_id {query_id}): could "
            f"not check whether a previous attempt is still running "
            f"({_describe_error(error)}). Nothing was resubmitted and no "
            f"before-retry SQL ran — re-run `chkit migrate --apply`."
        )
        raise RuntimeError(msg) from error


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


@dataclass(frozen=True, slots=True)
class _StartedAttemptCheck:
    # Only query_log entries of queries started at or after this time count.
    after_time: str


def _started_attempt_check(
    op: OperationState | None, fingerprint: str
) -> _StartedAttemptCheck | None:
    """How a re-run reads the outcome of a started attempt (#672, #767).

    Only a started attempt of this statement's SQL can have finished without
    its run journaling the outcome: a failed attempt has its outcome, a record
    without a query id never ran under one, and a finished attempt of other
    SQL (kept by --abandon and an edit) did not run this statement. Its
    outcome is read from query_log only when the record is fenced: its id
    names that attempt alone (#767). Any other started record is checked in
    system.processes only.
    """
    if op is None or not op.attempt_fenced or not _is_attempt_of_statement(op, fingerprint):
        return None
    return _StartedAttemptCheck(after_time=_query_log_lower_bound(_journal_time_ms(op.started_at)))


def _is_attempt_of_statement(op: OperationState | None, fingerprint: str) -> bool:
    return (
        op is not None
        and op.status == "started"
        and op.query_id != ""
        and op.fingerprint in ("", fingerprint)
    )


def _outcome_unknown_error(input_: AsyncApplyInput, query_id: str, *, fenced: bool) -> MigrateError:
    reason = (
        "system.query_log has no entry for its query id (query logging is off for the "
        "user, query_log is flushed later than chkit waits, or the run stopped before it "
        "submitted the statement)"
        if fenced
        else "an earlier chkit release recorded it, or the journal could not store the "
        "record's fence (it has no operation_fingerprints column), so its query id may "
        "name earlier attempts too"
    )
    msg = (
        f"Async migration step {input_.operation_type} (statement "
        f"{input_.statement_index + 1} of {input_.migration_name}, query_id {query_id}): "
        "the journal records an attempt as started and no replica runs it, but chkit "
        f"cannot tell whether it finished: {reason}. Nothing was submitted and no "
        "before-retry SQL ran. Check in ClickHouse whether the statement's rows reached "
        f"its target. Then reconcile every statement of {input_.migration_name} that "
        "already ran, since an abandon runs the migration again from statement 1, run "
        f"chkit migrate --apply --abandon {input_.migration_name}, and apply again."
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
