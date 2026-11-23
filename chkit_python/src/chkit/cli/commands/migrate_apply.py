"""Apply one migration with per-statement journaling and resume.

Port of ``packages/cli/src/commands/migrate/apply.ts``.

If a prior run left per-statement journal state for the migration,
statements already marked completed are skipped instead of replayed, so a
partial failure no longer bricks the migration on re-run with "column
already exists". Resuming across a file edit is gated by ``--retry`` unless
no statement is recorded as completed or started (#233).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from chkit import __version__
from chkit.cli.commands.migrate_async_apply import (
    AsyncApplyInput,
    KnownOutcome,
    apply_async_statement,
    finished_record_of,
    fresh_migration_state,
    iso_without_zone,
    outcome_unknown_error,
    resolve_recorded_attempt,
    reusable_outcome,
    stop_running_advice,
    upsert_operation,
)
from chkit.cli.commands.migrate_errors import (
    MigrateError,
    PendingNonSelectBarrier,
    in_progress_checksum_mismatch_error,
    non_select_barrier_error,
    recorded_statements_changed_error,
    statement_split_changed_error,
)
from chkit.cli.commands.migrate_query_intents import QueryContext, QueryTracker
from chkit.cli.commands.migrate_recovery import (
    RetryEditMismatch,
    StatementIdentity,
    assert_completed_statement,
    has_statement_progress,
    rebase_in_progress_state,
    recorded_statement_mismatches,
    retry_mismatch_error,
    split_changed_statements,
    statement_identities,
    statement_identity,
    verify_retry_edit,
)
from chkit.cli.commands.migrate_retry import RetryResume
from chkit.cli.journal_store import (
    JournalStore,
    MigrationRowState,
    OperationState,
    OperationStatus,
    resolve_journal_table_name,
)
from chkit.cli.migration_store import MigrationJournalEntry, checksum_sql
from chkit.cli.plugin_runtime import PluginRuntime
from chkit.cli.safety_markers import (
    MigrationOperationSummary,
    async_insert_operations,
    extract_migration_operation_summaries,
    find_non_select_barriers,
)
from chkit.cli.table_scope import TableScope
from chkit.clickhouse.async_insert_guard import assert_no_fire_and_forget_async_inserts
from chkit.clickhouse.client import ClickHouseClient, clickhouse_error_message
from chkit.clickhouse.ddl_propagation import (
    parse_exchange_tables,
    wait_for_ddl_propagation,
    wait_for_exchange,
)
from chkit.clickhouse.insert_barrier import wait_for_insert_barrier
from chkit.core.model import ChxResolvedConfig
from chkit.core.sql_fingerprint import statement_fingerprint
from chkit.core.sql_lexer import JS_WHITESPACE_RUN, js_trim
from chkit.core.sql_splitter import (
    extract_executable_statements,
    extract_legacy_executable_statements,
)
from chkit.plugins import ChxOnAfterApplyContext, ChxOnBeforeApplyContext

_CUTOVER_START_KEY = re.compile(r"^table:([^.]+)\.(.+):cutover:start$")

# ``last_error`` of a completed sync statement whose DDL propagation wait has
# not passed yet (#513, TS ``PROPAGATION_WAIT_PENDING``). A statement is
# recorded completed before its wait, so a re-run never replays it; while this
# marker is set, a re-run waits for it again before it runs the next statement.
# A write after the wait passes clears it. --abandon replaces it, and --retry
# keeps it with the record.
PROPAGATION_WAIT_PENDING = "executed; waiting for the change to reach every replica"


@dataclass(frozen=True, slots=True)
class ApplyMigrationInput:
    client: ClickHouseClient
    journal_store: JournalStore
    plugin_runtime: PluginRuntime
    config: ChxResolvedConfig
    table_scope: TableScope
    migrations_dir: Path
    file: str
    # Set when --retry verified an edit of this in-progress migration before the run.
    retry: RetryResume | None
    # Progress lines; the command sends them to stderr in --json mode.
    log: Callable[[str], None]
    # --setting values, sent with every statement of the migration (sync,
    # async, barrier, before-retry).
    settings: dict[str, str] | None = None
    # The command's parsed flags, keyed as in TS, for the apply hooks.
    flags: dict[str, Any] = field(default_factory=dict)
    query_tracker: QueryTracker | None = None
    # Set when the run holds no migrate lock because the target database did
    # not exist (#767).
    lockless_bootstrap: bool = False


class StatementError(RuntimeError):
    """A statement-execution failure with the file, position and SQL preview."""


def apply_migration(input_: ApplyMigrationInput) -> MigrationJournalEntry:  # noqa: PLR0912, PLR0915
    file = input_.file
    journal_store = input_.journal_store
    sql = (input_.migrations_dir / file).read_text(encoding="utf-8")
    parsed_statements = extract_executable_statements(sql)
    operation_summaries = extract_migration_operation_summaries(sql)

    statements = list(
        input_.plugin_runtime.run_on_before_apply(
            ChxOnBeforeApplyContext(
                command="migrate",
                config=input_.config,
                table_scope=input_.table_scope,
                flags=input_.flags,
                migration=file,
                sql=sql,
                statements=parsed_statements,
            )
        )
    )
    if input_.flags.get("--async-inserts") is True:
        operation_summaries = async_insert_operations(statements, operation_summaries)
    # migrate refused a file's non-SELECT barrier before the run; a plugin may
    # have rewritten the statements since (#634).
    barriers = non_select_barriers(file, statements, operation_summaries)
    if barriers:
        raise non_select_barrier_error(barriers)

    migration_checksum = checksum_sql(sql)
    # What the journal records for each statement run, and checks against (#599).
    fingerprints = [statement_fingerprint(statement) for statement in statements]
    sql_by_fingerprint = dict(zip(fingerprints, statements, strict=True))

    initial_state = journal_store.read_migration_state(file)
    # Releases before #562 did not know `//` and `#` comments, so the statement
    # positions they recorded do not hold where their split and this one
    # differ. A state this release recorded is split as now.
    if (
        initial_state is not None
        and not initial_state.migration_completed
        and initial_state.chkit_version != __version__
    ):
        changed = split_changed_statements(
            initial_state.operations,
            legacy=extract_legacy_executable_statements(sql),
            current=parsed_statements,
            positions_kept=statements == parsed_statements,
        )
        if changed:
            raise statement_split_changed_error(
                migration=file,
                statements=changed,
                recorded_by=initial_state.chkit_version,
                cli_version=__version__,
            )
    # A statement a plugin's onBeforeApply dropped is never visited below, so
    # its recorded async attempt is read, against the identity it was recorded
    # with, before anything runs and before the recorded statements are
    # checked: one still running or without an outcome stops the run with the
    # journal as it was, instead of the migration being recorded as applied,
    # or the record being refused unread (#767).
    if (
        initial_state is not None
        and not initial_state.migration_completed
        and initial_state.checksum == migration_checksum
    ):
        omitted = [
            op for op in initial_state.operations if op.operation_index >= len(statements)
        ]
        if omitted:
            _assert_recorded_attempts_resolved(
                input_.client,
                journal_store,
                file=file,
                state=initial_state.model_copy(update={"operations": omitted}),
                rebased=initial_state,
                sql_by_fingerprint=sql_by_fingerprint,
                log=input_.log,
            )
    # The file is unchanged, so the statements this run gets should be those
    # the journal recorded. They are not when the split or a plugin's
    # on_before_apply changed since: then positions do not hold (#599). An
    # edited file is checked by --retry below.
    if (
        initial_state is not None
        and not initial_state.migration_completed
        and initial_state.checksum == migration_checksum
    ):
        mismatched = recorded_statement_mismatches(initial_state.operations, fingerprints)
        if mismatched:
            raise recorded_statements_changed_error(
                migration=file,
                statements=mismatched,
                recorded_by=initial_state.chkit_version,
                cli_version=__version__,
            )
    # The outcomes the edit's check read for the attempts it keeps, so the
    # sync path does not look them up, through the query_log rechecks, again.
    edit_resolved: dict[int, KnownOutcome] = {}
    if (
        initial_state is not None
        and not initial_state.migration_completed
        and initial_state.checksum != migration_checksum
    ):
        edit_resolved = _accept_edited_migration(
            client=input_.client,
            file=file,
            state=initial_state,
            checksum=migration_checksum,
            identities=statement_identities(operation_summaries, fingerprints),
            sql_by_fingerprint=sql_by_fingerprint,
            retry=input_.retry,
            journal_store=journal_store,
            log=input_.log,
        )

    # An async attempt is submitted only once the journal stored its fence
    # (#767), so a journal that cannot store one stops the migration before any
    # of its statements runs: nothing needs reconciling.
    if any(
        operation is not None and operation.mode == "async" for operation in operation_summaries
    ) and not journal_store.stores_attempt_fences():
        raise _unfenced_journal_error(file)

    total = len(statements)
    for index, statement in enumerate(statements):
        operation = operation_summaries[index] if index < len(operation_summaries) else None
        if operation is not None and operation.mode == "async":
            try:
                apply_async_statement(
                    AsyncApplyInput(
                        client=input_.client,
                        journal_store=journal_store,
                        sql=statement,
                        migration_name=file,
                        migration_checksum=migration_checksum,
                        statement_index=index,
                        operation_type=operation.type,
                        operation_key=operation.key,
                        fingerprint=fingerprints[index],
                        before_retry=operation.before_retry,
                        log=input_.log,
                        settings=input_.settings,
                        query_tracker=input_.query_tracker,
                        lockless_bootstrap=input_.lockless_bootstrap,
                        known=edit_resolved.get(index),
                    )
                )
            except Exception as error:
                wrapped = statement_error(
                    file=file, index=index, total=total, statement=statement, error=error
                )
                # A stop of an async statement keeps its code for --json (#767).
                if isinstance(error, MigrateError) and error.code in _ASYNC_STOP_CODES:
                    raise MigrateError(error.code, str(wrapped)) from error
                raise wrapped from error
            # Async ops are DML (loads, backfills) — no DDL propagation to wait on.
            continue
        # Sync DDL path with per-statement journaling + resume. Re-read state
        # each iteration so async ops written above (or in a prior run) are kept.
        state_before = journal_store.read_migration_state(file)
        cluster = input_.config.clickhouse.cluster if input_.config.clickhouse else None
        identity = statement_identity(operation_summaries, index)
        fingerprint = fingerprints[index]
        if state_before is not None and _operation_is_completed(state_before, index):
            assert_completed_statement(
                state_before,
                migration=file,
                index=index,
                fingerprint=fingerprint,
                cli_version=__version__,
            )
            if _propagation_wait_pending(state_before, index):
                # The run that completed it stopped before its propagation
                # wait passed (#513): wait again before the next statement runs.
                _complete_propagation(
                    input_,
                    fallback_state=state_before,
                    index=index,
                    identity=identity,
                    fingerprint=fingerprint,
                    operation=operation,
                    statement=statement,
                    cluster=cluster,
                )
            continue
        prior_attempt = (
            next((op for op in state_before.operations if op.operation_index == index), None)
            if state_before is not None
            else None
        )
        resolved = "run"
        if prior_attempt is not None and state_before is not None:
            resolved = _resolve_async_attempt_before_sync(
                input_.client,
                journal_store,
                file=file,
                state=state_before,
                op=prior_attempt,
                fingerprint=fingerprint,
                sql=statement,
                operation_type=identity.type,
                log=input_.log,
                known=edit_resolved.get(index),
            )
            if resolved == "completed":
                continue
        # An async attempt that was never sent ran nothing: no before-retry SQL.
        if (
            prior_attempt is not None
            and operation is not None
            and operation.before_retry
            and resolved != "unsent"
        ):
            try:
                _run_before_retry(
                    input_.client,
                    operation.type,
                    statement,
                    operation.before_retry,
                    cluster=cluster,
                    settings=input_.settings,
                    log=input_.log,
                    status=prior_attempt.status,
                    query_tracker=input_.query_tracker,
                    query_context=QueryContext(file, index, statement, operation.before_retry),
                )
            except Exception as error:
                raise statement_error(
                    file=file, index=index, total=total, statement=statement, error=error
                ) from error
        swapped = (
            _swapped_tables(operation.type, operation.key, statement)
            if operation is not None
            else None
        )
        if swapped:
            try:
                assert_no_fire_and_forget_async_inserts(
                    input_.client, swapped, cluster=cluster, log=input_.log
                )
            except Exception as error:
                raise statement_error(
                    file=file, index=index, total=total, statement=statement, error=error
                ) from error
        base_state = state_before or fresh_migration_state(file, migration_checksum)
        journal_store.write_migration_state(
            upsert_operation(
                base_state,
                _sync_operation_state(index, identity, fingerprint, "started"),
                iso_without_zone(datetime.now(tz=UTC)),
            )
        )
        try:
            if operation is not None and operation.mode == "barrier":
                wait_for_insert_barrier(
                    input_.client,
                    statement,
                    cluster=cluster,
                    settings=input_.settings,
                    log=input_.log,
                )
            elif input_.query_tracker is not None:
                input_.query_tracker.command(
                    QueryContext(
                        file, index, statement,
                        operation.before_retry if operation is not None else None,
                    ),
                    "forward", statement, input_.settings,
                )
            else:
                input_.client.execute(statement, settings=input_.settings)
        except Exception as error:
            state_on_error = journal_store.read_migration_state(file) or base_state
            journal_store.write_migration_state(
                upsert_operation(
                    state_on_error,
                    _sync_operation_state(
                        index,
                        identity,
                        fingerprint,
                        "failed",
                        clickhouse_error_message(error),
                    ),
                    iso_without_zone(datetime.now(tz=UTC)),
                )
            )
            raise statement_error(
                file=file, index=index, total=total, statement=statement, error=error
            ) from error
        # Mark completed as soon as the statement has executed — BEFORE waiting
        # for DDL propagation, so a propagation timeout never makes a re-run
        # replay this statement into an "already exists" error. Until its wait
        # passes, the record carries PROPAGATION_WAIT_PENDING, so a re-run
        # waits for it again before the next statement (#513).
        waits = _has_propagation_wait(operation)
        state_after = journal_store.read_migration_state(file) or base_state
        journal_store.write_migration_state(
            upsert_operation(
                state_after,
                _sync_operation_state(
                    index,
                    identity,
                    fingerprint,
                    "completed",
                    PROPAGATION_WAIT_PENDING if waits else "",
                ),
                iso_without_zone(datetime.now(tz=UTC)),
            )
        )
        if waits:
            _complete_propagation(
                input_,
                fallback_state=state_after,
                index=index,
                identity=identity,
                fingerprint=fingerprint,
                operation=operation,
                statement=statement,
                cluster=cluster,
            )

    # TS ``toISOString().replace('Z', '')``: a `Z` suffix only parses with
    # date_time_input_format=best_effort, which the ObsessionDB API does not set.
    entry = MigrationJournalEntry(
        name=file,
        applied_at=iso_without_zone(datetime.now(tz=UTC)),
        checksum=migration_checksum,
    )
    journal_store.append_entry(entry, chkit_version=__version__)
    input_.plugin_runtime.run_on_after_apply(
        ChxOnAfterApplyContext(
            command="migrate",
            config=input_.config,
            table_scope=input_.table_scope,
            flags=input_.flags,
            migration=file,
            statements=statements,
            applied_at=entry.applied_at,
        )
    )
    return entry


def preview_statement(sql: str, max_length: int = 120) -> str:
    """One-line, length-capped preview of a SQL statement for error messages."""
    one_line = js_trim(JS_WHITESPACE_RUN.sub(" ", sql))
    return f"{one_line[:max_length]}…" if len(one_line) > max_length else one_line


def non_select_barriers(
    migration: str,
    statements: Sequence[str],
    operations: Sequence[MigrationOperationSummary],
) -> list[PendingNonSelectBarrier]:
    """A migration's statements marked ``mode=barrier`` that are not a SELECT (#634)."""
    return [
        PendingNonSelectBarrier(
            migration=migration,
            statement=barrier.index + 1,
            total=len(statements),
            operation=barrier.summary,
            preview=preview_statement(barrier.statement),
        )
        for barrier in find_non_select_barriers(statements, operations)
    ]


def statement_error(
    *, file: str, index: int, total: int, statement: str, error: BaseException
) -> StatementError:
    """Wrap a statement failure with the file, position and a SQL preview."""
    return StatementError(
        f"Migration {file} failed at statement {index + 1} of {total}:\n"
        f"  {preview_statement(statement)}\n"
        f"{clickhouse_error_message(error)}"
    )


def _propagation_wait_pending(state: MigrationRowState, index: int) -> bool:
    """Whether completed statement ``index`` carries PROPAGATION_WAIT_PENDING
    (TS ``propagationWaitPending``)."""
    return any(
        op.operation_index == index
        and op.status == "completed"
        and op.last_error == PROPAGATION_WAIT_PENDING
        for op in state.operations
    )


def _has_propagation_wait(operation: MigrationOperationSummary | None) -> bool:
    """A barrier changes no object, so it has no wait: migrate refuses a
    barrier statement that is not a SELECT before anything runs (#634)."""
    return operation is not None and operation.mode != "barrier"


def _complete_propagation(
    input_: ApplyMigrationInput,
    *,
    fallback_state: MigrationRowState,
    index: int,
    identity: StatementIdentity,
    fingerprint: str,
    operation: MigrationOperationSummary | None,
    statement: str,
    cluster: str | None,
) -> None:
    """Wait until a sync statement's DDL reaches every replica, then clear its
    pending marker (TS ``completePropagation``). A resumed run calls it with
    the same inputs as the first."""
    _wait_for_propagation(input_.client, operation, statement, cluster)
    state = input_.journal_store.read_migration_state(input_.file) or fallback_state
    input_.journal_store.write_migration_state(
        upsert_operation(
            state,
            _sync_operation_state(index, identity, fingerprint, "completed"),
            iso_without_zone(datetime.now(tz=UTC)),
        )
    )


def _wait_for_propagation(
    client: ClickHouseClient,
    operation: MigrationOperationSummary | None,
    statement: str,
    cluster: str | None,
) -> None:
    """Wait until a sync statement's DDL reaches every replica. A wait that
    times out stops the migration, as in TS."""
    if operation is None or operation.mode == "barrier":
        return
    if operation.type == "exchange_tables":
        # A swap that has not reached every replica stops the migration (as
        # in TS): the cutover steps after it would read a replica that
        # still has the old names.
        wait_for_exchange(client, statement, cluster=cluster)
    else:
        # Poll system.tables / system.columns until the DDL is visible.
        # Critical for Replicated / ObsessionDB Shared engines.
        wait_for_ddl_propagation(
            client,
            operation.type,
            operation.key,
            cluster=cluster,
            statement=statement,
        )


def _swapped_tables(
    operation_type: str, operation_key: str, statement: str
) -> list[tuple[str, str]] | None:
    """The tables a statement is about to swap, whose fire-and-forget async
    inserts would be dropped: both tables of an EXCHANGE TABLES, and the table
    of a cutover at its first step, so that the cutover stops before its copy
    (TS ``swappedTables``)."""
    if operation_type == "exchange_tables":
        tables = parse_exchange_tables(statement)
        return list(tables) if tables is not None else None
    if operation_type != "cutover_validate":
        return None
    match = _CUTOVER_START_KEY.match(operation_key)
    if match is None:
        return None
    return [(match.group(1), match.group(2))]


def _run_before_retry(
    client: ClickHouseClient,
    operation_type: str,
    statement: str,
    before_retry: str,
    *,
    cluster: str | None,
    settings: dict[str, str] | None,
    log: Callable[[str], None],
    status: OperationStatus,
    query_tracker: QueryTracker | None = None,
    query_context: QueryContext | None = None,
) -> None:
    """Run a statement's ``-- before-retry:`` SQL before chkit attempts it again
    after an earlier attempt failed or was interrupted (TS ``runBeforeRetry``).

    Before an EXCHANGE TABLES the replicas first have to agree on both tables:
    a swap that ran but whose acknowledgement was lost may not have reached the
    replica the guard reads yet, and exchanging again would swap the tables back.
    """
    if operation_type == "exchange_tables":
        wait_for_exchange(client, statement, cluster=cluster)
    attempt = "failed" if status == "failed" else "was interrupted"
    log(f"  {operation_type}: an earlier attempt {attempt} — running before-retry SQL")
    if query_tracker is not None and query_context is not None:
        query_tracker.command(query_context, "compensation", before_retry, settings)
    else:
        client.execute(before_retry, settings=settings)


def _accept_edited_migration(
    *,
    client: ClickHouseClient,
    file: str,
    state: MigrationRowState,
    checksum: str,
    identities: list[StatementIdentity],
    sql_by_fingerprint: dict[str, str],
    retry: RetryResume | None,
    journal_store: JournalStore,
    log: Callable[[str], None],
) -> dict[int, KnownOutcome]:
    """Resume an in-progress migration whose file changed, or refuse.

    It resumes when this run's --retry verified the edit, or when no
    statement is recorded as completed or started (the first statement
    failed, or --abandon marked every statement failed): the file then runs
    again from statement 1. The state is re-keyed to the new checksum before
    anything runs, so a later failure resumes without --retry.
    """
    retry_verified = (
        retry is not None
        and retry.previous_checksum == state.checksum
        and retry.checksum == checksum
    )
    if retry_verified:
        # --retry checked the file's statements; apply indexes the statements
        # the plugins returned, so check those too.
        check = verify_retry_edit(state.operations, identities)
        if isinstance(check, RetryEditMismatch):
            raise retry_mismatch_error(file, check)
    elif has_statement_progress(state):
        raise in_progress_checksum_mismatch_error(
            migration=file,
            journal_checksum=state.checksum,
            file_checksum=checksum,
            is_async=False,
        )
    else:
        log(
            f"{file} changed since its last failed attempt; no statement is recorded "
            "as completed, so it runs again from statement 1."
        )
    rebased = rebase_in_progress_state(
        state,
        checksum=checksum,
        identities=identities,
        applied_at=iso_without_zone(datetime.now(tz=UTC)),
    )
    resolved = _assert_recorded_attempts_resolved(
        client,
        journal_store,
        file=file,
        state=state,
        rebased=rebased,
        sql_by_fingerprint=sql_by_fingerprint,
        log=log,
    )
    journal_store.write_migration_state(rebased)
    return resolved


def _assert_recorded_attempts_resolved(
    client: ClickHouseClient,
    journal_store: JournalStore,
    *,
    file: str,
    state: MigrationRowState,
    rebased: MigrationRowState,
    sql_by_fingerprint: dict[str, str],
    log: Callable[[str], None],
) -> dict[int, KnownOutcome]:
    """Resolve every recorded async attempt before an edit is accepted (#767).

    The ones the re-key would drop are included, each read against the
    identity it was recorded with. An attempt still running, one whose
    outcome is unknown, and one that finished but whose record the edit drops
    (its statement would run again) stop the run here, with the journal as it
    was and nothing run. A dropped record is otherwise the only trace of an
    attempt under a random id (#701). Returns the outcomes of the records the
    edit keeps, by statement index.
    """
    resolved: dict[int, KnownOutcome] = {}
    for op in state.operations:
        if op.status == "completed" or op.query_id == "":
            continue
        recorded = resolve_recorded_attempt(
            client,
            journal_store=journal_store,
            migration_name=file,
            op=op,
            fingerprint=op.fingerprint,
            # The record's own SQL, when it is one of the statements this run has.
            sql=sql_by_fingerprint.get(op.fingerprint) if op.fingerprint else None,
            query_id=op.query_id,
            operation_type=op.operation_type,
            log=log,
        )
        if recorded.kind == "running":
            raise _attempt_still_running_error(file, op)
        dropped = not any(kept is op for kept in rebased.operations)
        reason: str | None = None
        if recorded.kind == "unknown":
            reason = recorded.reason
        elif recorded.kind == "finished" and dropped:
            reason = (
                "it finished on the server, but the edit drops its record, so the edited "
                "statement would run again"
            )
        if reason is not None:
            raise outcome_unknown_error(
                op.operation_type, op.operation_index, file, op.query_id, reason
            )
        if not dropped:
            resolved[op.operation_index] = (op, recorded)
    return resolved


_ASYNC_STOP_CODES = frozenset(
    {"async_outcome_unknown", "async_attempt_unfenced", "async_needs_lock"}
)


def _unfenced_journal_error(file: str) -> MigrateError:
    table = resolve_journal_table_name()
    return MigrateError(
        "async_attempt_unfenced",
        f"Cannot apply {file}: it has async statements, and the journal {table} has no "
        "operation_fingerprints column, which records each async attempt's fence (#767). "
        "Nothing ran. Add the column with a user that can alter the journal: run chkit "
        f"migrate --apply as that user, or ALTER TABLE <database>.{table} ADD COLUMN IF NOT "
        "EXISTS operation_fingerprints Array(String) DEFAULT [] (ON CLUSTER in cluster "
        "mode), then apply again.",
    )


def _resolve_async_attempt_before_sync(
    client: ClickHouseClient,
    journal_store: JournalStore,
    *,
    file: str,
    state: MigrationRowState,
    op: OperationState,
    fingerprint: str,
    sql: str,
    operation_type: str,
    log: Callable[[str], None],
    known: KnownOutcome | None = None,
) -> str:
    """Resolve a recorded async attempt before a sync or barrier run of its statement.

    A mode-only edit with --retry resolves the attempt as an async re-run
    does (#767): a QueryFinish records the statement completed, a server
    failure is journaled failed before any before-retry SQL runs, and an
    attempt that may have finished stops the run before anything is written
    or run. A running attempt keeps its record: its query id is the only way
    to find it later.

    ``known`` is the outcome the edit's check read for this attempt (#767).
    Only an outcome query_log settled for this very record, and the SQL the
    statement still has, stands for a new lookup: an unsent, failed or
    finished attempt stays so under the lock. An attempt that ended without
    one is checked in system.processes again right before the statement runs.
    """
    if op.status == "completed" or op.query_id == "":
        return "run"
    recorded = reusable_outcome(known, op, fingerprint) or resolve_recorded_attempt(
        client,
        journal_store=journal_store,
        migration_name=file,
        op=op,
        fingerprint=fingerprint,
        sql=sql,
        query_id=op.query_id,
        operation_type=operation_type,
        log=log,
    )
    if recorded.kind == "running":
        raise _attempt_still_running_error(file, op)
    if recorded.kind == "unknown":
        raise outcome_unknown_error(
            operation_type, op.operation_index, file, op.query_id, recorded.reason
        )
    now = iso_without_zone(datetime.now(tz=UTC))
    if recorded.kind == "finished":
        journal_store.write_migration_state(upsert_operation(state, finished_record_of(op), now))
        log(
            f"  {operation_type}: earlier async attempt of query_id={op.query_id} finished "
            "on the server, recording it as completed"
        )
        return "completed"
    if recorded.kind == "failed":
        journal_store.write_migration_state(
            upsert_operation(
                state,
                op.model_copy(
                    update={"status": "failed", "finished_at": now, "last_error": recorded.error}
                ),
                now,
            )
        )
    if recorded.kind == "unsent":
        return "unsent"
    return "run"


def _attempt_still_running_error(file: str, op: OperationState) -> MigrateError:
    return MigrateError(
        "retry_mismatch",
        f"Cannot apply {file}: the earlier attempt of statement "
        f"{op.operation_index + 1} (query_id {op.query_id}) is still running on the "
        "server, and continuing would discard its query id. "
        f"{stop_running_advice(op.query_id)}",
    )


def _operation_is_completed(state: MigrationRowState | None, index: int) -> bool:
    if state is None:
        return False
    return any(
        op.operation_index == index and op.status == "completed"
        for op in state.operations
    )


def _sync_operation_state(
    index: int,
    identity: StatementIdentity,
    fingerprint: str,
    status: OperationStatus,
    last_error: str = "",
) -> OperationState:
    timestamp = iso_without_zone(datetime.now(tz=UTC))
    return OperationState.model_validate(
        {
            "operationIndex": index,
            "operationKey": identity.key,
            "operationType": identity.type,
            "queryId": "",
            "status": status,
            "startedAt": timestamp,
            "finishedAt": None if status == "started" else timestamp,
            "lastError": last_error,
            "fingerprint": fingerprint,
        }
    )
