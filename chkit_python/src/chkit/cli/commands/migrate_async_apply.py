"""Apply one async (long-running) statement with deterministic resume.

1:1 port of ``packages/cli/src/commands/migrate/async-apply.ts``.

Submits the statement via ``ClickHouseClient.submit`` with a deterministic
``query_id`` derived from ``(migration_name, statement_index)``, then
polls ``query_status`` until terminal. The per-statement journal state
is written before submit (intent), after each progress poll (heartbeat),
and on terminal (completed | failed) so a CLI crash or kill mid-migration
can resume on the next run.

Key invariants:

- The query_id is deterministic — re-running the same migration produces
  the same id, so a partial run can re-attach to an in-flight server-side
  query.
- ``before_retry`` SQL (parsed from the migration's ``-- before-retry:``
  line) runs only on resubmit, never on first attempt.
- Status ``unknown`` is a transient state (just-submitted or
  just-finished gap); loop until ``running`` / ``finished`` / ``failed``
  unless the submit itself rejected, which is recorded as failed.
- The query id is deterministic, so ``system.query_log`` can still hold
  entries of an earlier attempt of the same statement (abandoned, or
  retried after an edit). A new submission only trusts entries of queries
  started after it, and an attach only those started no earlier than the
  attempt it attaches to. The bound comes from the server clock minus a
  margin for clock skew between replicas.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from chkit.cli.commands.migrate_errors import in_progress_checksum_mismatch_error
from chkit.cli.commands.migrate_recovery import has_statement_progress
from chkit.cli.journal_store import (
    JournalStore,
    MigrationRowState,
    OperationState,
)
from chkit.clickhouse.client import ClickHouseClient, QueryStatus

POLL_INTERVAL_SECONDS = 5.0
# query_status compares whole seconds, so the margin stays more than a second
# below POLL_INTERVAL_SECONDS: an earlier attempt that a previous run polled to
# its end started at least one poll interval ago and always falls before the bound.
QUERY_LOG_SKEW_MARGIN_MS = 2_000
# query_status's own default: every query_log entry for the id counts.
UNBOUNDED_POLL_AFTER_TIME = "1970-01-01 00:00:00"
MAX_TRANSIENT_POLL_ERRORS = 20
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
    before_retry: str | None
    log: Callable[[str], None]
    poll_interval_seconds: float = POLL_INTERVAL_SECONDS


def iso_without_zone(dt: datetime) -> str:
    """ISO timestamp matching the TS ``new Date().toISOString().replace('Z','')``."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]


def make_deterministic_query_id(migration_name: str, statement_index: int) -> str:
    """SHA-256 of ``chkit:{migration}:{index}`` formatted as a UUID."""
    digest = hashlib.sha256(
        f"chkit:{migration_name}:{statement_index}".encode()
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


def _format_rows(value: int | None) -> str:
    if value is None or value == 0:
        return "0 rows"
    if value >= _ROWS_M:
        return f"{value / _ROWS_M:.2f}M rows"
    if value >= _ROWS_K:
        return f"{value / _ROWS_K:.1f}K rows"
    return f"{value} rows"


def _format_bytes(value: int | None) -> str:
    if value is None or value == 0:
        return "0 B"
    if value >= _BYTES_GIB:
        return f"{value / _BYTES_GIB:.2f} GiB"
    if value >= _BYTES_MIB:
        return f"{value / _BYTES_MIB:.1f} MiB"
    if value >= _BYTES_KIB:
        return f"{value / _BYTES_KIB:.1f} KiB"
    return f"{value} B"


def _progress_line(label: str, status: QueryStatus, elapsed_sec: int) -> str:
    rows = _format_rows(status.written_rows)
    byte_str = _format_bytes(status.written_bytes)
    return f"  {label}: written={rows} ({byte_str}), elapsed {elapsed_sec}s"


def _describe_error(error: BaseException) -> str:
    return str(error)


def apply_async_statement(input_: AsyncApplyInput) -> AsyncApplyResult:
    """Submit ``sql`` and poll until terminal, journalling each transition."""
    client = input_.client
    journal_store = input_.journal_store

    query_id = make_deterministic_query_id(
        input_.migration_name, input_.statement_index
    )
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

    # 1. Already completed → skip entirely
    if prior_op is not None and prior_op.status == "completed":
        input_.log(
            f"  {input_.operation_type}: query_id={query_id} already completed "
            f"in prior run — skipping"
        )
        return AsyncApplyResult(kind="skipped", operation=prior_op)

    # 2. Currently in flight on the server → attach (no submit, just poll).
    # The server clock is read before the check, so the start derived from it
    # and the attempt's elapsed time never falls after the start that
    # query_log records for the attempt.
    server_now_ms = _read_server_now_ms(client)
    in_flight = client.query_status(query_id)
    if in_flight.status == "running":
        input_.log(
            f"  {input_.operation_type}: query_id={query_id} already running on "
            f"server — attaching to in-flight query"
        )
        return _poll_until_terminal(
            input_=input_,
            migration_state=initial_state,
            query_id=query_id,
            poll_after_time=_attach_lower_bound(server_now_ms, in_flight.elapsed_ms),
            submit_error=None,
            started_at=prior_op.started_at
            if prior_op is not None
            else iso_without_zone(datetime.now(tz=UTC)),
        )

    # 3 / 4. Submit (with optional before-retry on resubmit).
    if prior_op is not None:
        err_tail = (
            f": {_first_line(prior_op.last_error)}" if prior_op.last_error else ""
        )
        input_.log(
            f"  {input_.operation_type}: previous attempt of query_id={query_id} is "
            f"no longer running (status={prior_op.status}{err_tail}) — "
            f"running before-retry then resubmitting"
        )
        if input_.before_retry is not None:
            input_.log(f"  {input_.operation_type}: running before-retry SQL")
            client.execute(input_.before_retry)
    else:
        input_.log(
            f"  {input_.operation_type}: submitting async (query_id={query_id})"
        )

    started_at = iso_without_zone(datetime.now(tz=UTC))

    base_state = initial_state or fresh_migration_state(
        input_.migration_name, input_.migration_checksum
    )
    journal_store.write_migration_state(
        upsert_operation(
            base_state,
            OperationState(
                operation_index=input_.statement_index,
                operation_key=input_.operation_key,
                operation_type=input_.operation_type,
                query_id=query_id,
                status="started",
                started_at=started_at,
                finished_at=None,
                last_error="",
            ),
            iso_without_zone(datetime.now(tz=UTC)),
        )
    )

    state_after_start = journal_store.read_migration_state(input_.migration_name)

    poll_after_time = _query_log_lower_bound(_read_server_now_ms(client), 0)
    submit_error: Exception | None = None
    try:
        client.submit(input_.sql, query_id=query_id)
    except Exception as error:
        submit_error = error
        input_.log(
            f"  {input_.operation_type}: submit raised "
            f"({_describe_error(error)}) — polling for the server-side state"
        )

    return _poll_until_terminal(
        input_=input_,
        migration_state=state_after_start,
        query_id=query_id,
        poll_after_time=poll_after_time,
        submit_error=submit_error,
        started_at=started_at,
    )


def _poll_until_terminal(
    *,
    input_: AsyncApplyInput,
    migration_state: MigrationRowState | None,
    query_id: str,
    poll_after_time: str,
    submit_error: Exception | None,
    started_at: str,
) -> AsyncApplyResult:
    poll_started_at = time.monotonic()
    transient_errors = 0

    while True:
        time.sleep(input_.poll_interval_seconds)
        try:
            status = input_.client.query_status(query_id, after_time=poll_after_time)
            transient_errors = 0
        except Exception as poll_error:
            transient_errors += 1
            elapsed_sec = int(time.monotonic() - poll_started_at)
            if transient_errors > MAX_TRANSIENT_POLL_ERRORS:
                msg = (
                    f"Async migration step {input_.operation_type} "
                    f"(query_id {query_id}): polling failed {transient_errors}x "
                    f"({_describe_error(poll_error)}). The load may still be "
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
            )
            input_.journal_store.write_migration_state(
                upsert_operation(
                    base_state,
                    finished_op,
                    iso_without_zone(datetime.now(tz=UTC)),
                )
            )
            finished_sec = round((status.duration_ms or 0) / 1000)
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
            input_.log(_progress_line(input_.operation_type, status, elapsed_sec))
            continue

        # status is "unknown" here. If submit already raised, the query never
        # made it server-side (e.g. SQL parse error): record the attempt as
        # failed and surface that error. Otherwise it's a transient gap.
        if submit_error is not None:
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
                        }
                    ),
                    iso_without_zone(datetime.now(tz=UTC)),
                )
            )
            raise submit_error
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


def _attach_lower_bound(server_now_ms: int, elapsed_ms: int | None) -> str:
    """Bound an attach by the attached attempt's start.

    Without an elapsed time its start is unknown, and only the unbounded
    lookup still finds its entry.
    """
    if elapsed_ms is None:
        return UNBOUNDED_POLL_AFTER_TIME
    return _query_log_lower_bound(server_now_ms, elapsed_ms)


def _query_log_lower_bound(server_now_ms: int, started_ms_ago: int) -> str:
    bound_ms = server_now_ms - started_ms_ago - QUERY_LOG_SKEW_MARGIN_MS
    return (
        datetime.fromtimestamp(bound_ms / 1000, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _read_server_now_ms(client: ClickHouseClient) -> int:
    rows = client.query("SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms").rows
    try:
        return int(rows[0]["now_ms"])
    except (IndexError, KeyError, TypeError, ValueError) as error:
        msg = "Could not read the ClickHouse server time for an async statement."
        raise RuntimeError(msg) from error
