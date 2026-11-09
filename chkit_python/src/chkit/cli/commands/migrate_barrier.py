"""Pending statements marked ``mode=barrier`` that are not a SELECT.

1:1 port of ``packages/cli/src/commands/migrate/barrier.ts``.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from chkit.cli.commands.migrate_apply import non_select_barriers
from chkit.cli.commands.migrate_errors import PendingNonSelectBarrier
from chkit.cli.safety_markers import extract_migration_operation_summaries
from chkit.core.sql_splitter import extract_executable_statements


def find_pending_non_select_barriers(
    migrations_dir: Path, pending: Sequence[str]
) -> list[PendingNonSelectBarrier]:
    """The statements of pending migration files marked ``mode=barrier`` that
    are not a SELECT (#634). Measured on the file, like the empty-migration
    check; apply checks the statements again after the plugins."""
    found: list[PendingNonSelectBarrier] = []
    for migration in pending:
        sql = (migrations_dir / migration).read_text(encoding="utf-8")
        found.extend(
            non_select_barriers(
                migration,
                extract_executable_statements(sql),
                extract_migration_operation_summaries(sql),
            )
        )
    return found
