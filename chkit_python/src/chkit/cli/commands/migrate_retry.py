"""Resolve what ``migrate --retry <migration>`` does in this run.

1:1 port of ``packages/cli/src/commands/migrate/retry.ts``.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from chkit.cli.commands.migrate_recovery import (
    RetryEditMismatch,
    retry_mismatch_error,
    statement_identities,
    verify_retry_edit,
)
from chkit.cli.journal_store import MigrationRowState
from chkit.cli.migration_store import checksum_sql
from chkit.cli.safety_markers import extract_migration_operation_summaries
from chkit.core.sql_splitter import extract_executable_statements

RetryNoopReason = Literal[
    "already_applied",
    "not_in_scope",
    "empty_migration",
    "not_in_progress",
    "checksum_unchanged",
]


class RetryResume(BaseModel):
    model_config = ConfigDict(frozen=True)

    action: Literal["resume"] = "resume"
    migration: str
    previous_checksum: str = Field(..., serialization_alias="previousChecksum")
    checksum: str
    total_statements: int = Field(..., serialization_alias="totalStatements")
    completed_statements: int = Field(..., serialization_alias="completedStatements")
    # 1-based number of the first statement that runs; None when every statement completed.
    resume_at_statement: int | None = Field(..., serialization_alias="resumeAtStatement")
    # Completed statements without an ``-- operation:`` marker, matched by position only.
    unmarked_completed_statements: int = Field(
        ..., serialization_alias="unmarkedCompletedStatements"
    )


class RetryNoop(BaseModel):
    model_config = ConfigDict(frozen=True)

    action: Literal["none"] = "none"
    migration: str
    reason: RetryNoopReason


RetryResolution = RetryResume | RetryNoop


class _ReadsMigrationState(Protocol):
    def read_migration_state(self, migration_name: str) -> MigrationRowState | None: ...


def resolve_retry(  # noqa: PLR0911 - one return per TS no-op reason
    *,
    migration: str,
    migrations_dir: Path,
    pending: Sequence[str],
    empty_migrations: Sequence[str],
    applied_names: Collection[str],
    journal_store: _ReadsMigrationState,
) -> RetryResolution:
    """Decide what --retry does, before anything is applied.

    A target that is not an edited in-progress migration is a no-op, so the
    same command can run against every environment; an edit that moved or
    changed a statement that already ran raises ``retry_mismatch``.
    """
    if migration in applied_names:
        return RetryNoop(migration=migration, reason="already_applied")
    if migration not in pending:
        return RetryNoop(migration=migration, reason="not_in_scope")
    if migration in empty_migrations:
        return RetryNoop(migration=migration, reason="empty_migration")
    state = journal_store.read_migration_state(migration)
    if state is None:
        return RetryNoop(migration=migration, reason="not_in_progress")
    if state.migration_completed:
        return RetryNoop(migration=migration, reason="already_applied")
    sql = (migrations_dir / migration).read_text(encoding="utf-8")
    checksum = checksum_sql(sql)
    if state.checksum == checksum:
        return RetryNoop(migration=migration, reason="checksum_unchanged")
    # The file's statements before on_before_apply; apply checks again against
    # the statements the plugins return.
    identities = statement_identities(
        extract_migration_operation_summaries(sql),
        len(extract_executable_statements(sql)),
    )
    check = verify_retry_edit(state.operations, identities)
    if isinstance(check, RetryEditMismatch):
        raise retry_mismatch_error(migration, check)
    return RetryResume(
        migration=migration,
        previous_checksum=state.checksum,
        checksum=checksum,
        total_statements=len(identities),
        completed_statements=check.completed,
        resume_at_statement=None if check.resume_index is None else check.resume_index + 1,
        unmarked_completed_statements=check.unmarked_completed,
    )


def retry_payload(retry: RetryResolution) -> dict[str, Any]:
    """The ``retry`` object of the ``--json`` payload (camelCase keys)."""
    return retry.model_dump(by_alias=True)
