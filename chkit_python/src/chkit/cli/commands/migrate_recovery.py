"""Shared logic of ``migrate --retry`` and ``migrate --abandon``.

1:1 port of ``packages/cli/src/commands/migrate/recovery.ts``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field

from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.journal_store import MigrationRowState, OperationState, OperationStatus
from chkit.cli.safety_markers import MigrationOperationSummary


@dataclass(frozen=True, slots=True)
class RecoveryTargets:
    """``--retry`` / ``--abandon`` targets as migration file names."""

    retry_target: str | None
    abandon_target: str | None


@dataclass(frozen=True, slots=True)
class StatementIdentity:
    type: str
    key: str
    # False for a statement without an ``-- operation:`` marker, matched by position only.
    marked: bool


class Marker(BaseModel):
    model_config = ConfigDict(frozen=True)

    type: str
    key: str


class OperationMismatch(BaseModel):
    model_config = ConfigDict(frozen=True)

    # 1-based statement number.
    statement: int
    # ``completed``, or ``started`` for an async statement that may still be running.
    status: OperationStatus
    query_id: str = Field(..., serialization_alias="queryId")
    recorded: Marker
    # None when the edited file has no statement at that position.
    current: Marker | None


class RecordedStatement(BaseModel):
    model_config = ConfigDict(frozen=True)

    statement: int
    status: OperationStatus


class SharedMarkerMismatch(BaseModel):
    """A shared marker the edited file carries on fewer statements than recorded."""

    model_config = ConfigDict(frozen=True)

    type: str
    key: str
    recorded: list[RecordedStatement]
    current_count: int = Field(..., serialization_alias="currentCount")


@dataclass(frozen=True, slots=True)
class RetryEditOk:
    completed: int
    unmarked_completed: int
    # 0-based index of the first statement that did not complete; None when all did.
    resume_index: int | None
    ok: bool = True


@dataclass(frozen=True, slots=True)
class RetryEditMismatch:
    mismatches: list[OperationMismatch]
    shared_markers: list[SharedMarkerMismatch]
    ok: bool = False


RetryEditCheck = RetryEditOk | RetryEditMismatch

# Flags that mean nothing next to --abandon, which only changes the journal.
_ABANDON_CONFLICTING_FLAGS = ("--retry", "--table", "--allow-destructive")


def resolve_recovery_targets(
    *,
    retry: str | None,
    abandon: str | None,
    table: str | None = None,
    allow_destructive: bool = False,
) -> RecoveryTargets:
    """Read --retry and --abandon; usage errors surface before any connection."""
    retry_target = (
        normalize_migration_name(retry, "--retry") if retry is not None else None
    )
    abandon_target = (
        normalize_migration_name(abandon, "--abandon") if abandon is not None else None
    )
    if abandon_target is not None:
        present = {
            "--retry": retry is not None,
            "--table": table is not None,
            "--allow-destructive": allow_destructive,
        }
        conflicts = [name for name in _ABANDON_CONFLICTING_FLAGS if present[name]]
        if conflicts:
            msg = (
                f"--abandon cannot be combined with {', '.join(conflicts)}. It only "
                "resets the journal state of one migration and applies nothing."
            )
            raise MigrateError("invalid_usage", msg)
    return RecoveryTargets(retry_target=retry_target, abandon_target=abandon_target)


def normalize_migration_name(raw: str, flag: str) -> str:
    """``name``, ``name.sql`` or a path to the file → ``name.sql``."""
    base = re.split(r"[\\/]", raw.strip())[-1].strip()
    if base in {"", ".sql"}:
        msg = (
            f"{flag} requires a migration file name, for example "
            f"{flag} 20260101000000_add_users.sql."
        )
        raise MigrateError("invalid_usage", msg)
    return base if base.endswith(".sql") else f"{base}.sql"


def statement_identity(
    operations: Sequence[MigrationOperationSummary], index: int
) -> StatementIdentity:
    """The (type, key) the journal records for statement ``index``."""
    if index >= len(operations):
        return StatementIdentity(type="sql_statement", key=f"statement:{index}", marked=False)
    operation = operations[index]
    return StatementIdentity(type=operation.type, key=operation.key, marked=True)


def statement_identities(
    operations: Sequence[MigrationOperationSummary], statement_count: int
) -> list[StatementIdentity]:
    return [statement_identity(operations, index) for index in range(statement_count)]


def verify_retry_edit(
    operations: Sequence[OperationState],
    identities: Sequence[StatementIdentity],
) -> RetryEditCheck:
    """Whether --retry may resume an in-progress migration with an edited file.

    apply skips completed statements and re-attaches a running async
    statement by position, so each of them must keep its position and
    operation marker. The journal records only type and key per statement,
    not its SQL.
    """
    bound = sorted(
        (op for op in operations if _is_bound_to_position(op)),
        key=lambda op: op.operation_index,
    )
    mismatches: list[OperationMismatch] = []
    completed = 0
    unmarked_completed = 0
    for op in bound:
        current = (
            identities[op.operation_index]
            if op.operation_index < len(identities)
            else None
        )
        if current is None or not _same_identity(current, op):
            mismatches.append(
                OperationMismatch(
                    statement=op.operation_index + 1,
                    status=op.status,
                    query_id=op.query_id,
                    recorded=_marker_of(op),
                    current=(
                        None
                        if current is None
                        else Marker(type=current.type, key=current.key)
                    ),
                )
            )
            continue
        if op.status != "completed":
            continue
        completed += 1
        if not current.marked:
            unmarked_completed += 1
    shared = _find_shared_marker_mismatches(operations, identities, mismatches)
    if mismatches or shared:
        return RetryEditMismatch(mismatches=mismatches, shared_markers=shared)
    done = {op.operation_index for op in operations if op.status == "completed"}
    resume_index = next(
        (index for index in range(len(identities)) if index not in done), None
    )
    return RetryEditOk(
        completed=completed,
        unmarked_completed=unmarked_completed,
        resume_index=resume_index,
    )


def retry_mismatch_error(
    migration: str,
    check: RetryEditMismatch,
) -> MigrateError:
    lines: list[str] = []
    for mismatch in check.mismatches:
        recorded = mismatch.recorded
        current = mismatch.current
        statement = mismatch.statement
        label = (
            f"completed as {recorded.type} {recorded.key}"
            if mismatch.status == "completed"
            else (
                f"started as {recorded.type} {recorded.key} "
                f"(async query_id {mismatch.query_id})"
            )
        )
        found = (
            f"the edited file has no statement {statement}"
            if current is None
            else f"the edited file has {current.type} {current.key} there"
        )
        lines.append(f"  statement {statement}: {label}, but {found}")
    for shared in check.shared_markers:
        statements = _join_with_and(
            [f"{item.statement} ({item.status})" for item in shared.recorded]
        )
        plural = "" if shared.current_count == 1 else "s"
        lines.append(
            f"  statements {statements} share {shared.type} {shared.key}, but the "
            f"edited file has {shared.current_count} statement{plural} with that marker"
        )
    shared_hint = (
        ""
        if not check.shared_markers
        else (
            "\nStatements that share a marker, such as a column's REMOVE DEFAULT and "
            "the MODIFY COLUMN after it, are told apart only by position, so chkit "
            "cannot tell which one the edit removed. Keep each of them and edit only "
            "the one that failed."
        )
    )
    running_hint = "".join(
        f"\nStatement {mismatch.statement} may still be running on the server. "
        "Wait for it to finish or run KILL QUERY WHERE query_id = "
        f"'{mismatch.query_id}' before you abandon the partial run."
        for mismatch in check.mismatches
        if mismatch.status == "started"
    )
    joined = "\n".join(lines)
    return MigrateError(
        "retry_mismatch",
        f"Cannot retry {migration}: statements that completed or may still be "
        "running no longer match the edited file.\n"
        f"{joined}\n"
        "chkit skips completed statements and re-attaches running async statements "
        "by position, so they must keep their position and operation marker."
        f"{shared_hint}{running_hint}"
        "\nRestore them, or discard the partial run so the next apply starts the "
        f"file over: chkit migrate --apply --abandon {migration}",
    )


def rebase_in_progress_state(
    state: MigrationRowState,
    *,
    checksum: str,
    identities: Sequence[StatementIdentity],
    applied_at: str,
) -> MigrationRowState:
    """Re-key an in-progress state to an edited file.

    Completed statements stay recorded (--retry verified them). A failed or
    started statement stays only if the same operation still sits at its
    index, so a retry keeps its ``-- before-retry:`` compensation and query
    id; any other record is dropped.
    """

    def keep(op: OperationState) -> bool:
        if op.status == "completed":
            return True
        if op.operation_index >= len(identities):
            return False
        return _same_identity(identities[op.operation_index], op)

    return state.model_copy(
        update={
            "checksum": checksum,
            "applied_at": applied_at,
            "operations": [op for op in state.operations if keep(op)],
        }
    )


def has_statement_progress(state: MigrationRowState) -> bool:
    """Whether any statement of an in-progress state completed or may have run."""
    return any(op.status in {"completed", "started"} for op in state.operations)


def _find_shared_marker_mismatches(
    operations: Sequence[OperationState],
    identities: Sequence[StatementIdentity],
    mismatches: Sequence[OperationMismatch],
) -> list[SharedMarkerMismatch]:
    """Markers a completed statement shares, now on fewer statements.

    A column's generated ``REMOVE DEFAULT`` or ``REMOVE MATERIALIZED``
    carries the type and key of the MODIFY COLUMN after it. When the edited
    file carries such a marker on fewer statements than the journal
    recorded, the position check cannot tell which one the edit removed. A
    marker that a positional mismatch already reports is left out.
    """
    markers: list[Marker] = []
    for op in operations:
        if not _is_bound_to_position(op):
            continue
        marker = _marker_of(op)
        if marker in markers:
            continue
        if any(mismatch.recorded == marker for mismatch in mismatches):
            continue
        markers.append(marker)
    out: list[SharedMarkerMismatch] = []
    for marker in markers:
        recorded = [
            RecordedStatement(statement=op.operation_index + 1, status=op.status)
            for op in sorted(operations, key=lambda op: op.operation_index)
            if _marker_of(op) == marker
        ]
        current_count = sum(
            1
            for identity in identities
            if identity.type == marker.type and identity.key == marker.key
        )
        if current_count < len(recorded):
            out.append(
                SharedMarkerMismatch(
                    type=marker.type,
                    key=marker.key,
                    recorded=recorded,
                    current_count=current_count,
                )
            )
    return out


def _is_bound_to_position(op: OperationState) -> bool:
    """A completed statement, or an async statement whose query may still run."""
    return op.status == "completed" or (op.status == "started" and op.query_id != "")


def _same_identity(identity: StatementIdentity, op: OperationState) -> bool:
    return identity.type == op.operation_type and identity.key == op.operation_key


def _marker_of(op: OperationState) -> Marker:
    return Marker(type=op.operation_type, key=op.operation_key)


def _join_with_and(items: Sequence[str]) -> str:
    """``['1', '2', '3']`` → ``1, 2 and 3``."""
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} and {items[-1]}"
