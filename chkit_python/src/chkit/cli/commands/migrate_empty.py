"""Pending migration files without an executable statement.

1:1 port of ``packages/cli/src/commands/migrate/empty.ts``.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from chkit.core.sql_splitter import extract_executable_statements


def find_empty_migrations(migrations_dir: Path, pending: Sequence[str]) -> list[str]:
    """Pending files made only of comments or whitespace.

    Such as a ``generate --empty`` stub that still waits for its SQL.
    Measured on the file, before plugins see it: a plugin that removes every
    statement does so on purpose.
    """
    return [
        file
        for file in pending
        if not extract_executable_statements(
            (migrations_dir / file).read_text(encoding="utf-8")
        )
    ]
