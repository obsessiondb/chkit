"""``migrate --abandon <migration>``: reset a failed migration's journal state.

1:1 port of ``packages/cli/src/commands/migrate/abandon.ts``.
"""

from __future__ import annotations

from collections.abc import Callable, Collection
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field

from chkit.cli.commands.migrate_async_apply import iso_without_zone
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.journal_store import MigrationRowState, OperationState, OperationStatus

_OPERATION_STATUSES: tuple[OperationStatus, ...] = ("completed", "failed", "started")


class AbandonReport(BaseModel):
    """What --abandon reports, before and after it resets the journal state."""

    model_config = ConfigDict(frozen=True)

    migration: str
    # Checksum recorded for the failed attempt.
    checksum: str
    # Statements that completed, including those an earlier --abandon marked failed.
    completed_statements: int = Field(..., serialization_alias="completedStatements")
    # The recorded per-statement progress, sorted by statement index.
    operations: list[OperationState]

    def to_payload(self) -> dict[str, Any]:
        """The ``abandon`` object of the ``--json`` payload (camelCase keys)."""
        return self.model_dump(by_alias=True)


class JournalStateStore(Protocol):
    def read_migration_state(self, migration_name: str) -> MigrationRowState | None: ...

    def write_migration_state(self, state: MigrationRowState) -> None: ...


def read_abandonable_state(
    *,
    migration: str,
    applied_names: Collection[str],
    journal_store: JournalStateStore,
) -> MigrationRowState:
    """Read the in-progress state --abandon resets; raises when there is none."""
    if migration in applied_names:
        raise _already_applied_error(migration)
    state = journal_store.read_migration_state(migration)
    if state is None:
        msg = f"Cannot abandon {migration}: the journal has no in-progress state for it."
        raise MigrateError("migration_not_in_progress", msg)
    if state.migration_completed:
        raise _already_applied_error(migration)
    return state


def abandon_migration_state(
    state: MigrationRowState,
    *,
    journal_store: JournalStateStore,
    now: Callable[[], datetime] | None = None,
) -> None:
    """Supersede an in-progress state with one where every statement failed.

    The next apply runs the file from statement 1: sync statements run
    again, and async statements keep their query ids, so they take the retry
    path (``-- before-retry:`` compensation, then a resubmit). Like every
    journal write this is an INSERT of a newer row version, so it needs no
    DELETE privilege and leaves no mutation behind.
    """
    timestamp = iso_without_zone((now or (lambda: datetime.now(tz=UTC)))())
    journal_store.write_migration_state(_abandoned_state(state, timestamp))


def abandon_report(state: MigrationRowState) -> AbandonReport:
    operations = sorted(state.operations, key=lambda op: op.operation_index)
    return AbandonReport(
        migration=state.name,
        checksum=state.checksum,
        completed_statements=sum(
            1 for op in operations if status_before_abandon(op) == "completed"
        ),
        operations=operations,
    )


def status_before_abandon(op: OperationState) -> OperationStatus:
    """The status a statement had before --abandon marked it failed.

    Or its recorded status when no abandon touched it. A statement that
    completed before an abandon stays applied in ClickHouse.
    """
    previous = _abandoned_from(op)
    return previous if previous is not None else op.status


def _abandoned_state(state: MigrationRowState, now: str) -> MigrationRowState:
    # A statement an earlier --abandon already marked failed keeps that
    # record, so abandoning again does not lose which statements completed.
    operations = [
        op
        if _abandoned_from(op) is not None
        else op.model_copy(
            update={
                "status": "failed",
                "finished_at": op.finished_at if op.finished_at is not None else now,
                "last_error": _abandoned_error(op.status),
            }
        )
        for op in state.operations
    ]
    return state.model_copy(
        update={"applied_at": now, "migration_completed": False, "operations": operations}
    )


def _abandoned_from(op: OperationState) -> OperationStatus | None:
    """The status before an earlier --abandon, or None when none marked it."""
    if op.status != "failed":
        return None
    return next(
        (s for s in _OPERATION_STATUSES if op.last_error == _abandoned_error(s)),
        None,
    )


def _abandoned_error(previous: OperationStatus) -> str:
    return f"abandoned via chkit migrate --abandon (was {previous})"


def _already_applied_error(migration: str) -> MigrateError:
    return MigrateError(
        "migration_already_applied",
        f"Cannot abandon {migration}: it is already applied. --abandon only resets a "
        "migration that failed part-way; to undo an applied migration, write a new "
        "migration.",
    )
