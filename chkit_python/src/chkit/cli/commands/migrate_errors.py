"""Migrate failures with stable ``--json`` error codes.

1:1 port of ``packages/cli/src/commands/migrate/errors.ts``.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

MigrateErrorCode = Literal[
    "invalid_usage",
    "migration_not_found",
    "migration_not_in_progress",
    "migration_already_applied",
    "retry_mismatch",
    "in_progress_checksum_mismatch",
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
