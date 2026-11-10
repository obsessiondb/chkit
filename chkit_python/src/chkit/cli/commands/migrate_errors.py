"""Migrate failures with stable ``--json`` error codes.

1:1 port of ``packages/cli/src/commands/migrate/errors.ts``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

MigrateErrorCode = Literal[
    "invalid_usage",
    "migration_not_found",
    "migration_not_in_progress",
    "migration_already_applied",
    "retry_mismatch",
    "in_progress_checksum_mismatch",
    "statement_split_changed",
    "barrier_not_select",
]

EMPTY_MIGRATIONS_SUMMARY = (
    "Pending migrations contain no executable statements. "
    "Add SQL statements to each file or delete it."
)


class MigrateError(Exception):
    """A migrate failure with a stable ``code`` for ``--json`` consumers."""

    def __init__(self, code: MigrateErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: MigrateErrorCode = code
        self.message: str = message


def in_progress_checksum_mismatch_error(
    *,
    migration: str,
    journal_checksum: str,
    file_checksum: str,
    is_async: bool,
) -> MigrateError:
    """An in-progress migration whose file changed after statements ran.

    Without ``--retry``, chkit cannot tell whether the statements that ran
    still match the file.
    """
    state_label = (
        "in-progress async journal state" if is_async else "in-progress journal state"
    )
    return MigrateError(
        "in_progress_checksum_mismatch",
        f"Migration {migration} has {state_label} for checksum {journal_checksum}, "
        f"but the current file checksum is {file_checksum}: the file changed after "
        "some of its statements had run.\n"
        "  Resume with the edited file (completed statements are skipped): "
        f"chkit migrate --apply --retry {migration}\n"
        "  Or discard the partial run, so the next apply starts the file over: "
        f"chkit migrate --apply --abandon {migration}\n"
        "  Or restore the original file content and re-run chkit migrate --apply.",
    )


def statement_split_changed_error(
    *,
    migration: str,
    statements: Sequence[int],
    recorded_by: str,
    cli_version: str,
) -> MigrateError:
    """An in-progress migration that another chkit release recorded, whose
    statements completed or started where the split before #562 and this
    split differ.

    Resuming by position could skip a statement that never ran or run one
    again. ``statements`` are 1-based; ``recorded_by`` is empty when the state
    has no release.
    """
    recorder = "an earlier chkit release" if recorded_by == "" else f"chkit {recorded_by}"
    label = "statement" if len(statements) == 1 else "statements"
    verb = "is" if len(statements) == 1 else "are"
    numbers = ", ".join(str(statement) for statement in statements)
    return MigrateError(
        "statement_split_changed",
        f"Cannot resume {migration}: {recorder} recorded its partial run, and this chkit "
        f"({cli_version}) splits the file into different statements. "
        "It reads `//`, `# ` and `#!` comments as ClickHouse does, so a `;`, quote or "
        "`/*` inside one no longer ends or opens anything (#562). "
        f"The journal recorded {label} {numbers} as completed or started, which {verb} "
        "not the same in this split.\n"
        "  Finish the partial run with the chkit release that recorded it, then upgrade.\n"
        "  Or discard the partial run, so the next apply starts the file over (statements "
        f"that ran stay applied and run again): chkit migrate --apply --abandon {migration}",
    )


def recorded_statements_changed_error(
    *,
    migration: str,
    statements: Sequence[int],
    recorded_by: str,
    cli_version: str,
) -> MigrateError:
    """An in-progress migration whose file is unchanged, but whose statements
    as this run gets them differ from those the journal recorded as completed
    or running (#599).

    The release that recorded the state split the file differently, or a
    plugin's on_before_apply now returns other statements. ``statements`` are
    1-based; ``recorded_by`` is empty when the state has no release.
    """
    recorder = "an earlier chkit release" if recorded_by == "" else f"chkit {recorded_by}"
    label = "statement" if len(statements) == 1 else "statements"
    where = "that position" if len(statements) == 1 else "those positions"
    numbers = ", ".join(str(statement) for statement in statements)
    return MigrateError(
        "statement_split_changed",
        f"Cannot resume {migration}: the journal recorded {label} {numbers} as completed "
        f"or started, but this run gets different SQL from the file at {where}. "
        f"{recorder} recorded the partial run and this chkit is {cli_version}; a change "
        "in how chkit splits the file, or in what a plugin's onBeforeApply returns, moves "
        "statements. Resuming by position could skip a statement that never ran or run "
        "one again.\n"
        "  Finish the partial run with the chkit release and plugins that recorded it, "
        "then upgrade.\n"
        "  Or discard the partial run, so the next apply starts the file over (statements "
        f"that ran stay applied and run again): chkit migrate --apply --abandon {migration}",
    )


@dataclass(frozen=True, slots=True)
class PendingNonSelectBarrier:
    """A pending migration's statement marked ``mode=barrier`` that is not a SELECT."""

    migration: str
    # 1-based position among the migration's executable statements.
    statement: int
    total: int
    # The ``-- operation:`` marker text after the prefix.
    operation: str
    # One-line, length-capped preview of the statement.
    preview: str


def non_select_barrier_error(barriers: Sequence[PendingNonSelectBarrier]) -> MigrateError:
    """Refusal of pending migrations that mark a statement other than a SELECT
    ``mode=barrier`` (#634): the barrier read would run it, maybe more than
    once, and nothing would wait for its change to reach every replica."""
    lines = "\n".join(
        f"  - {barrier.migration}, statement {barrier.statement} of {barrier.total} "
        f"(-- operation: {barrier.operation}):\n"
        f"      {barrier.preview}"
        for barrier in barriers
    )
    return MigrateError(
        "barrier_not_select",
        "Cannot apply: a statement marked mode=barrier is not a SELECT:\n"
        f"{lines}\n"
        "chkit runs a barrier statement as a read of the running INSERTs, once and then "
        "every second, and waits for no change it makes to reach every replica.\n"
        "Make each statement a SELECT (or WITH ... SELECT) that returns a query_id column, "
        "or remove mode=barrier from its -- operation: marker, then re-run chkit migrate "
        "--apply. No statement of these migrations ran.",
    )


def empty_migrations_error(files: Sequence[str]) -> RuntimeError:
    """Text-mode refusal of pending files without executable statements."""
    listed = "\n".join(f"  - {file}" for file in files)
    return RuntimeError(
        "Cannot apply: these pending migrations contain no executable statements "
        "(only comments or whitespace):\n"
        f"{listed}\n"
        "An empty migration would be recorded as applied, and SQL added to it later "
        "would fail the checksum check.\n"
        "Add SQL statements to each file or delete it, then re-run chkit migrate --apply."
    )
