"""A missing journal *database* skips the write; a missing journal *table* does not (#351).

``write_migration_state`` skips the INSERT only while the configured database
does not exist. The legacy analyzer reports a missing table as "Table x does
not exist. (UNKNOWN_TABLE)", which must not count as a missing database, or
the migration would apply without ever being journaled.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from chkit.cli.journal_store import JournalStore, MigrationRowState

pytestmark = pytest.mark.usefixtures("single_replica")

_UNKNOWN_TABLE = (
    "Code: 60. DB::Exception: Table default._chkit_migrations does not exist. "
    "(UNKNOWN_TABLE)"
)
_UNKNOWN_DATABASE = (
    "Code: 81. DB::Exception: Database chkit_x does not exist. (UNKNOWN_DATABASE)"
)


@dataclass
class _ProbeFailingClient:
    """Fails the journal probe with ``probe_error``; ``create_error`` fails the CREATE."""

    probe_error: str
    create_error: str | None = None
    executed: list[str] = field(default_factory=list[str])

    def query(self, sql: str) -> Any:
        raise RuntimeError(self.probe_error)

    def execute(self, sql: str) -> None:
        if sql.startswith("CREATE TABLE") and self.create_error is not None:
            raise RuntimeError(self.create_error)
        self.executed.append(sql)


def _state() -> MigrationRowState:
    return MigrationRowState.model_validate(
        {
            "name": "001_init.sql",
            "appliedAt": "2026-10-29T12:00:00.000",
            "checksum": "abc",
            "chkitVersion": "0.0.0",
            "migrationCompleted": True,
            "operations": [],
        }
    )


def test_unknown_table_probe_creates_the_journal_and_inserts() -> None:
    client = _ProbeFailingClient(probe_error=_UNKNOWN_TABLE)
    store = JournalStore(client)  # type: ignore[arg-type]

    store.write_migration_state(_state())

    assert store.database_missing is False
    assert client.executed[0].startswith("CREATE TABLE IF NOT EXISTS _chkit_migrations")
    assert client.executed[1].startswith("INSERT INTO _chkit_migrations")


def test_unknown_database_skips_the_insert() -> None:
    client = _ProbeFailingClient(
        probe_error=_UNKNOWN_DATABASE, create_error=_UNKNOWN_DATABASE
    )
    store = JournalStore(client)  # type: ignore[arg-type]

    store.write_migration_state(_state())

    assert store.database_missing is True
    assert client.executed == []
