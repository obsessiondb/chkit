"""``migrate --mark-applied`` / ``--mark-not-applied <migration>``.

Record the operator's outcome for the one statement that stopped with
``async_outcome_unknown``. 1:1 port of
``packages/cli/src/commands/migrate/mark-outcome.ts``.
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

import typer

from chkit import __version__
from chkit.cli.commands.migrate_abandon import abandoned_error, read_abandonable_state
from chkit.cli.commands.migrate_async_apply import (
    BEFORE_START_EFFECTS_REASON,
    finished_record_of,
    iso_without_zone,
    resolve_recorded_attempt,
    stop_running_advice,
)
from chkit.cli.commands.migrate_errors import MigrateError, journal_changed_error
from chkit.cli.journal_store import JournalStore, MigrationRowState, OperationState
from chkit.clickhouse.client import ClickHouseClient

MarkedOutcome = Literal["applied", "not-applied"]


@dataclass(frozen=True, slots=True)
class MarkTarget:
    migration: str
    outcome: MarkedOutcome


def read_stopped_statement(
    client: ClickHouseClient,
    *,
    migration: str,
    applied_names: Collection[str],
    flag: str,
    # The migration file's statements by fingerprint, empty when the file is gone.
    sql_by_fingerprint: Mapping[str, str],
    journal_store: JournalStore,
    log: Callable[[str], None],
) -> tuple[MigrationRowState, OperationState]:
    """The async statement of ``migration`` whose attempt has no known outcome.

    Read on every replica as an apply reads it. Refuses while the attempt runs
    on any replica, when chkit can tell its outcome itself, and when more than
    one statement has no known outcome.
    """
    state = read_abandonable_state(
        migration=migration, applied_names=applied_names, journal_store=journal_store, action=flag
    )
    # The journal writer stamps this release on the state, after which apply no
    # longer checks the positions another release recorded without fingerprints
    # against this release's split (#562), so such a state is not marked.
    if state.chkit_version != __version__ and any(
        op.status != "failed" and op.fingerprint == "" for op in state.operations
    ):
        raise MigrateError(
            "mark_refused",
            f"Cannot {flag} {migration}: chkit {state.chkit_version} recorded its statements "
            "without their SQL fingerprints, so chkit cannot check that they are the statements "
            "this release splits the file into. Nothing was changed; reconcile every statement "
            f"of {migration} that already ran and run chkit migrate --apply --abandon "
            f"{migration}.",
        )
    unknown: list[OperationState] = []
    for op in state.operations:
        if op.status == "completed" or op.query_id == "":
            continue
        sql = sql_by_fingerprint.get(op.fingerprint) if op.fingerprint else None
        recorded = resolve_recorded_attempt(
            client,
            journal_store=journal_store,
            migration_name=migration,
            op=op,
            fingerprint=op.fingerprint,
            sql=sql,
            query_id=op.query_id,
            operation_type=op.operation_type,
            log=log,
        )
        if recorded.kind == "running":
            raise MigrateError(
                "async_outcome_unknown",
                f"Cannot {flag} {migration}: statement {op.operation_index + 1} "
                f"(query_id {op.query_id}) is still running on the server, so its outcome "
                f"is not known yet. Nothing was changed. {stop_running_advice(op.query_id)}",
            )
        # Only the statement's SQL tells whether a rejection before the start ran
        # nothing (a SELECT or an INSERT), which apply then retries itself.
        if (
            recorded.kind == "unknown"
            and recorded.reason == BEFORE_START_EFFECTS_REASON
            and sql is None
        ):
            raise MigrateError(
                "mark_refused",
                f"Cannot {flag} {migration}: the server rejected statement "
                f"{op.operation_index + 1} (query_id {op.query_id}) before it started, and "
                "without the statement's SQL in the migration file chkit cannot tell whether "
                "that rejection ran nothing. Nothing was changed; restore the file, or "
                "reconcile every statement that already ran and run chkit migrate --apply "
                f"--abandon {migration}.",
            )
        if recorded.kind == "unknown":
            unknown.append(op)
    if not unknown:
        raise MigrateError(
            "mark_refused",
            f"Cannot {flag} {migration}: no statement of it stopped with "
            "async_outcome_unknown, so chkit resolves its state itself. Nothing was "
            "changed; run chkit migrate --apply.",
        )
    if len(unknown) > 1:
        statements = ", ".join(str(item.operation_index + 1) for item in unknown)
        raise MigrateError(
            "mark_refused",
            f"Cannot {flag} {migration}: statements {statements} have no known outcome, "
            f"and {flag} acts on one. Nothing was changed; reconcile them and run chkit "
            f"migrate --apply --abandon {migration}.",
        )
    return state, unknown[0]


def mark_report(target: MarkTarget, op: OperationState) -> dict[str, Any]:
    """The ``mark`` object of the ``--json`` payload (camelCase keys)."""
    return {
        "migration": target.migration,
        "outcome": target.outcome,
        "operation": op.model_dump(by_alias=True),
    }


def mark_stopped_statement(
    state: MigrationRowState,
    op: OperationState,
    outcome: MarkedOutcome,
    *,
    journal_store: JournalStore,
) -> None:
    """Records the operator's outcome for the stopped statement only.

    Applied: it is completed, and the next apply continues after it. Not
    applied: it is failed as an abandon records it, so the next apply runs its
    before-retry SQL and submits it again. The other statements keep their
    records.
    """
    now = iso_without_zone(datetime.now(tz=UTC))
    marked = (
        finished_record_of(op)
        if outcome == "applied"
        else op.model_copy(
            update={
                "status": "failed",
                "finished_at": now,
                "last_error": abandoned_error(op.status),
            }
        )
    )
    operations = [
        marked if item.operation_index == op.operation_index else item for item in state.operations
    ]
    journal_store.write_migration_state(
        state.model_copy(
            update={"applied_at": now, "migration_completed": False, "operations": operations}
        )
    )


def mark_under_lock(
    client: ClickHouseClient,
    target: MarkTarget,
    shown: tuple[MigrationRowState, OperationState],
    *,
    applied_names: Collection[str],
    flag: str,
    sql_by_fingerprint: Mapping[str, str],
    journal_store: JournalStore,
    log: Callable[[str], None],
) -> None:
    """Re-reads and re-resolves the stopped statement under the lock, then marks it."""
    state, op = read_stopped_statement(
        client,
        migration=target.migration,
        applied_names=applied_names,
        flag=flag,
        sql_by_fingerprint=sql_by_fingerprint,
        journal_store=journal_store,
        log=log,
    )
    if state.applied_at != shown[0].applied_at or op.query_id != shown[1].query_id:
        raise journal_changed_error(
            f"the journal state of {target.migration} is no longer the one shown"
        )
    mark_stopped_statement(state, op, target.outcome, journal_store=journal_store)


def render_mark_text(report: dict[str, Any], *, performed: bool) -> None:
    operation = report["operation"]
    outcome = report["outcome"]
    statement = (
        f"statement {operation['operationIndex'] + 1} of {report['migration']} "
        f"({operation['operationType']}, query_id {operation['queryId']})"
    )
    following = (
        "the next chkit migrate --apply records it as completed and continues after it"
        if outcome == "applied"
        else "the next chkit migrate --apply runs its before-retry SQL, when it has one, "
        "and submits it again"
    )
    if performed:
        typer.echo(
            f"Marked {statement} as {outcome}: {following}. The statements recorded as "
            "completed do not run again."
        )
        return
    typer.echo(
        f"Marking {statement} as {outcome} means {following}. The statements recorded as "
        "completed do not run again. Nothing has changed yet."
    )
    typer.echo(f"\nPlan only. Re-run with --apply to mark it {outcome}.")
