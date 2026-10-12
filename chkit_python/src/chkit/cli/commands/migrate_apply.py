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
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from chkit import __version__
from chkit.cli.commands.migrate_async_apply import (
    AsyncApplyInput,
    apply_async_statement,
    fresh_migration_state,
    iso_without_zone,
    upsert_operation,
)
from chkit.cli.commands.migrate_errors import in_progress_checksum_mismatch_error
from chkit.cli.commands.migrate_recovery import (
    RetryEditMismatch,
    StatementIdentity,
    has_statement_progress,
    rebase_in_progress_state,
    retry_mismatch_error,
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
)
from chkit.cli.migration_store import MigrationJournalEntry, checksum_sql, now_iso
from chkit.cli.plugin_runtime import PluginRuntime
from chkit.cli.safety_markers import extract_migration_operation_summaries
from chkit.cli.table_scope import TableScope
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_ddl_propagation
from chkit.core.model import ChxResolvedConfig
from chkit.core.sql_splitter import extract_executable_statements
from chkit.plugins import ChxOnAfterApplyContext, ChxOnBeforeApplyContext

_WHITESPACE_RE = re.compile(r"\s+")


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
    # Warnings (DDL propagation) are suppressed in --json mode.
    warn: Callable[[str], None]


class StatementError(RuntimeError):
    """A statement-execution failure with the file, position and SQL preview."""


def apply_migration(input_: ApplyMigrationInput) -> MigrationJournalEntry:
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
                flags={},
                migration=file,
                sql=sql,
                statements=parsed_statements,
            )
        )
    )
    migration_checksum = checksum_sql(sql)

    initial_state = journal_store.read_migration_state(file)
    if (
        initial_state is not None
        and not initial_state.migration_completed
        and initial_state.checksum != migration_checksum
    ):
        _accept_edited_migration(
            file=file,
            state=initial_state,
            checksum=migration_checksum,
            identities=statement_identities(operation_summaries, len(statements)),
            retry=input_.retry,
            journal_store=journal_store,
            log=input_.log,
        )

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
                        before_retry=operation.before_retry,
                        log=input_.log,
                    )
                )
            except Exception as error:
                raise statement_error(
                    file=file, index=index, total=total, statement=statement, error=error
                ) from error
            # Async ops are DML (loads, backfills) — no DDL propagation to wait on.
            continue
        # Sync DDL path with per-statement journaling + resume. Re-read state
        # each iteration so async ops written above (or in a prior run) are kept.
        state_before = journal_store.read_migration_state(file)
        if _operation_is_completed(state_before, index):
            continue
        identity = statement_identity(operation_summaries, index)
        base_state = state_before or fresh_migration_state(file, migration_checksum)
        journal_store.write_migration_state(
            upsert_operation(
                base_state,
                _sync_operation_state(index, identity.type, identity.key, "started"),
                iso_without_zone(datetime.now(tz=UTC)),
            )
        )
        try:
            input_.client.execute(statement)
        except Exception as error:
            state_on_error = journal_store.read_migration_state(file) or base_state
            journal_store.write_migration_state(
                upsert_operation(
                    state_on_error,
                    _sync_operation_state(
                        index, identity.type, identity.key, "failed", str(error)
                    ),
                    iso_without_zone(datetime.now(tz=UTC)),
                )
            )
            raise statement_error(
                file=file, index=index, total=total, statement=statement, error=error
            ) from error
        # Mark completed as soon as the statement has executed — BEFORE waiting
        # for DDL propagation, so a propagation timeout never makes a re-run
        # replay this statement into an "already exists" error.
        state_after = journal_store.read_migration_state(file) or base_state
        journal_store.write_migration_state(
            upsert_operation(
                state_after,
                _sync_operation_state(index, identity.type, identity.key, "completed"),
                iso_without_zone(datetime.now(tz=UTC)),
            )
        )
        if operation is not None:
            # Poll system.tables / system.columns until the DDL is visible.
            # Critical for Replicated / ObsessionDB Shared engines.
            try:
                wait_for_ddl_propagation(
                    input_.client,
                    operation.type,
                    operation.key,
                    cluster=input_.config.clickhouse.cluster if input_.config.clickhouse else None,
                )
            except Exception as wait_error:
                input_.warn(
                    f"  ⚠ DDL propagation wait failed for {operation.key}: {wait_error}"
                )

    entry = MigrationJournalEntry(
        name=file, applied_at=now_iso(), checksum=migration_checksum
    )
    journal_store.append_entry(entry, chkit_version=__version__)
    input_.plugin_runtime.run_on_after_apply(
        ChxOnAfterApplyContext(
            command="migrate",
            config=input_.config,
            table_scope=input_.table_scope,
            flags={},
            migration=file,
            statements=statements,
            applied_at=entry.applied_at,
        )
    )
    return entry


def preview_statement(sql: str, max_length: int = 120) -> str:
    """One-line, length-capped preview of a SQL statement for error messages."""
    one_line = _WHITESPACE_RE.sub(" ", sql).strip()
    return f"{one_line[:max_length]}…" if len(one_line) > max_length else one_line


def statement_error(
    *, file: str, index: int, total: int, statement: str, error: BaseException
) -> StatementError:
    """Wrap a statement failure with the file, position and a SQL preview."""
    return StatementError(
        f"Migration {file} failed at statement {index + 1} of {total}:\n"
        f"  {preview_statement(statement)}\n"
        f"{error}"
    )


def _accept_edited_migration(
    *,
    file: str,
    state: MigrationRowState,
    checksum: str,
    identities: list[StatementIdentity],
    retry: RetryResume | None,
    journal_store: JournalStore,
    log: Callable[[str], None],
) -> None:
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
    journal_store.write_migration_state(
        rebase_in_progress_state(
            state,
            checksum=checksum,
            identities=identities,
            applied_at=iso_without_zone(datetime.now(tz=UTC)),
        )
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
    operation_type: str,
    operation_key: str,
    status: OperationStatus,
    last_error: str = "",
) -> OperationState:
    timestamp = iso_without_zone(datetime.now(tz=UTC))
    return OperationState.model_validate(
        {
            "operationIndex": index,
            "operationKey": operation_key,
            "operationType": operation_type,
            "queryId": "",
            "status": status,
            "startedAt": timestamp,
            "finishedAt": None if status == "started" else timestamp,
            "lastError": last_error,
        }
    )
