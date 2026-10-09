"""Text rendering of ``migrate --retry`` / ``--abandon`` and empty migrations.

Port of the recovery parts of ``packages/cli/src/commands/migrate/output.ts``.
"""

from __future__ import annotations

from collections.abc import Callable

import typer

from chkit.cli.commands.migrate_abandon import AbandonReport, status_before_abandon
from chkit.cli.commands.migrate_apply import preview_statement
from chkit.cli.commands.migrate_retry import RetryNoopReason, RetryResolution, RetryResume

# A regenerated migration plans the statements that completed again.
_REPEATED_STATEMENTS_HINT = (
    "The new migration may repeat statements that completed; remove those that "
    "cannot run twice, such as a REMOVE DEFAULT or REMOVE MATERIALIZED, before you "
    "apply it."
)

_RETRY_NOOP_REASONS: dict[RetryNoopReason, str] = {
    "already_applied": "already applied; --retry has no effect.",
    "not_in_scope": "outside the --table scope; --retry has no effect.",
    "empty_migration": "no executable statements; --retry has no effect.",
    "not_in_progress": "no in-progress journal state; it applies normally.",
    "checksum_unchanged": "unchanged since it failed; it resumes without --retry.",
}


def render_retry_notice(
    retry: RetryResolution | None, echo: Callable[[str], None] = typer.echo
) -> None:
    if retry is None:
        return
    for line in format_retry_notice(retry):
        echo(line)


def format_retry_notice(retry: RetryResolution) -> list[str]:
    migration = retry.migration
    if not isinstance(retry, RetryResume):
        return [f"Retry {migration}: {_RETRY_NOOP_REASONS[retry.reason]}"]
    progress = (
        f"All {retry.total_statements} statements already completed; the migration "
        "will be recorded as applied."
        if retry.resume_at_statement is None
        else (
            f"{retry.completed_statements} completed statement(s) will be skipped; "
            f"resuming at statement {retry.resume_at_statement} of "
            f"{retry.total_statements}."
        )
    )
    lines = [f"Retry {migration}: the file changed after a failed apply. {progress}"]
    if retry.unmarked_completed_statements > 0:
        lines.append(
            f"⚠ {retry.unmarked_completed_statements} completed statement(s) have no "
            '"-- operation:" marker and were matched by position only. Do not add, '
            "remove, or reorder statements above the first statement that did not "
            "complete."
        )
    return lines


def render_empty_migrations_warning(empty_migrations: list[str]) -> None:
    if not empty_migrations:
        return
    typer.echo(
        f"⚠ {len(empty_migrations)} pending migration(s) contain no executable "
        "statements. chkit migrate --apply refuses to run until each has SQL or is "
        "deleted."
    )


def render_abandon_text(
    report: AbandonReport,
    *,
    performed: bool,
    file_exists: bool,
    snapshot_file: str,
) -> None:
    """What stays applied in ClickHouse, what failed or was interrupted, what next.

    ``performed`` is False for the preview. A statement an earlier --abandon
    marked failed is reported by the status it had before, so a statement
    that completed still shows as applied.
    """
    migration = report.migration
    typer.echo(
        f"Abandoned in-progress migration {migration}: every recorded statement is "
        "now marked failed."
        if performed
        else (
            f"Abandoning in-progress migration {migration} marks every recorded "
            "statement failed. Nothing has changed yet."
        )
    )
    completed = [
        op for op in report.operations if status_before_abandon(op) == "completed"
    ]
    if not completed:
        typer.echo("No statement had completed.")
    else:
        typer.echo(
            f"{len(completed)} completed statement(s) remain applied in ClickHouse:"
        )
        for op in completed:
            typer.echo(
                f"  {op.operation_index + 1}. {op.operation_type} {op.operation_key}"
            )
    for op in report.operations:
        statement = op.operation_index + 1
        status = status_before_abandon(op)
        if status == "failed":
            reason = op.last_error.split("\n", 1)[0].strip()
            typer.echo(
                f"Statement {statement} failed."
                if reason == ""
                else f"Statement {statement} failed: {preview_statement(reason, 200)}"
            )
        if status == "started":
            query = "" if op.query_id == "" else f" (query_id {op.query_id})"
            typer.echo(f"Statement {statement} was interrupted{query}.")
            if op.query_id != "":
                typer.echo(
                    "  ⚠ If that query is still running on the server, wait for it to "
                    f"finish or run KILL QUERY WHERE query_id = '{op.query_id}' before "
                    f"you apply {migration} again."
                )
    typer.echo("")
    if not file_exists:
        typer.echo(
            f"{migration} is no longer in the migrations directory, so no apply runs "
            "it again. If you still need its changes, restore the file, or regenerate "
            f"them: restore {snapshot_file} from git to its state before {migration} "
            f"was generated and run chkit generate. {_REPEATED_STATEMENTS_HINT}"
        )
        return
    typer.echo(
        f"Next: edit {migration} if needed and run chkit migrate --apply. It runs "
        "again from statement 1, including the statements that completed, so they "
        "must be safe to run twice (for example CREATE ... IF NOT EXISTS), or remove "
        "them from the file. A column's MODIFY COLUMN ... REMOVE DEFAULT or REMOVE "
        "MATERIALIZED is not safe: it fails once the column has no such expression."
    )
    # chkit runs -- before-retry: only on the async path, and only for a record
    # whose operation type and key still match (rebase_in_progress_state).
    typer.echo(
        "A data load adds its rows again unless it is marked mode=async with a "
        "-- before-retry: line that undoes it. That line runs only for an async "
        "statement that keeps its position, operation type and key."
    )
    typer.echo(
        f"Or regenerate it: delete {migration}, restore {snapshot_file} from git to "
        f"its state before {migration} was generated, and run chkit generate. "
        f"{_REPEATED_STATEMENTS_HINT}"
    )


def render_abandon_plan_only_notice() -> None:
    typer.echo("")
    typer.echo("Plan only. Re-run with --apply to abandon the in-progress state.")
