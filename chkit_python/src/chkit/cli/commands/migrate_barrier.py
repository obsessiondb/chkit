"""Pending statements marked ``mode=barrier`` that are not a SELECT.

1:1 port of ``packages/cli/src/commands/migrate/barrier.ts``.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from chkit.cli.commands.migrate_apply import preview_statement
from chkit.cli.commands.migrate_errors import PendingNonSelectBarrier
from chkit.cli.safety_markers import find_non_select_barriers


def find_pending_non_select_barriers(
    migrations_dir: Path, pending: Sequence[str]
) -> list[PendingNonSelectBarrier]:
    """The statements of pending migration files marked ``mode=barrier`` that
    are not a SELECT (#634). Measured on the file, like the empty-migration
    check."""
    return [
        PendingNonSelectBarrier(
            migration=migration,
            statement=barrier.index + 1,
            total=barrier.total,
            operation=barrier.summary,
            preview=preview_statement(barrier.statement),
        )
        for migration in pending
        for barrier in find_non_select_barriers(
            (migrations_dir / migration).read_text(encoding="utf-8")
        )
    ]
