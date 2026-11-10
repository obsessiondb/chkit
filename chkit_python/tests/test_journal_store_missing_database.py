"""A missing journal *database* skips the write; a missing journal *table* does not (#351).

``write_migration_state`` skips the INSERT only while the configured database
does not exist. The legacy analyzer reports a missing table as "Table x does
not exist. (UNKNOWN_TABLE)", which must not count as a missing database, or
the migration would apply without ever being journaled.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
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
    """Fails every query with ``probe_error`` until a CREATE ran, as a server
    does; ``create_error`` fails the CREATE."""

    probe_error: str
    create_error: str | None = None
    # How many CREATEs fail with ``create_error`` before one succeeds; ``None``
    # fails every one.
    create_failures: int | None = None
    executed: list[str] = field(default_factory=list[str])
    create_attempts: int = 0

    def query(self, sql: str) -> Any:
        if sql.startswith("SELECT currentDatabase()"):
            return SimpleNamespace(rows=[{"database": "app"}])
        if not any(executed.startswith("CREATE TABLE") for executed in self.executed):
            raise RuntimeError(self.probe_error)
        return SimpleNamespace(rows=[])

    def execute(self, sql: str) -> None:
        if sql.startswith("CREATE TABLE") and self.create_error is not None:
            self.create_attempts += 1
            if self.create_failures is None or self.create_attempts <= self.create_failures:
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
    assert client.executed[0].startswith("CREATE TABLE IF NOT EXISTS `app`._chkit_migrations")
    assert client.executed[1].startswith("INSERT INTO _chkit_migrations")


def test_unknown_database_skips_the_insert() -> None:
    client = _ProbeFailingClient(
        probe_error=_UNKNOWN_DATABASE, create_error=_UNKNOWN_DATABASE
    )
    store = JournalStore(client)  # type: ignore[arg-type]

    store.write_migration_state(_state())

    assert store.database_missing is True
    assert client.executed == []


def test_create_on_a_replica_without_the_database_yet_is_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The probe found the database, but the CREATE reached a replica that has
    not applied ``CREATE DATABASE`` yet (#493)."""
    monkeypatch.setattr("chkit.cli.journal_store.time.sleep", lambda _: None)
    client = _ProbeFailingClient(
        probe_error=_UNKNOWN_TABLE, create_error=_UNKNOWN_DATABASE, create_failures=2
    )
    store = JournalStore(client)  # type: ignore[arg-type]

    store.write_migration_state(_state())

    assert store.database_missing is False
    assert client.create_attempts == 3
    assert client.executed[0].startswith("CREATE TABLE IF NOT EXISTS `app`._chkit_migrations")
    assert client.executed[1].startswith("INSERT INTO _chkit_migrations")


def test_create_that_never_finds_the_database_stops_the_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The probe saw the database, so the state is never silently dropped."""
    monkeypatch.setattr("chkit.cli.journal_store.time.sleep", lambda _: None)
    client = _ProbeFailingClient(probe_error=_UNKNOWN_TABLE, create_error=_UNKNOWN_DATABASE)
    store = JournalStore(client)  # type: ignore[arg-type]

    with pytest.raises(RuntimeError, match="its database is still missing on the replica"):
        store.write_migration_state(_state())

    assert client.create_attempts == 21
    assert client.executed == []
