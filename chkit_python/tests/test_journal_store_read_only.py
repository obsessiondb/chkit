"""Reads of :class:`chkit.cli.journal_store.JournalStore` never write (#402).

A read-only user (``readonly = 1`` or ``2``, ``SELECT`` only) runs status,
check and migrate (plan): reading must not create or alter the journal, and a
missing journal reads as no applied migrations. Same as the TS
``reads never write the journal (#402)`` tests.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pytest

from chkit.cli.journal_store import JournalStore, MigrationRowState

pytestmark = pytest.mark.usefixtures("single_replica")

PROBE = "SELECT name, migration_completed, operations FROM _chkit_migrations LIMIT 0"


@dataclass
class _Result:
    rows: list[dict[str, Any]]


@dataclass
class _Client:
    """Answers every query with no rows, unless ``fail`` returns an error."""

    fail: Callable[[str, list[str]], Exception | None]
    queries: list[str] = field(default_factory=list[str])
    executed: list[str] = field(default_factory=list[str])

    def query(self, sql: str) -> _Result:
        self.queries.append(sql)
        error = self.fail(sql, self.executed)
        if error is not None:
            raise error
        return _Result([])

    def execute(self, sql: str) -> None:
        self.executed.append(sql)


def _clickhouse_error(code: int, name: str) -> Exception:
    return Exception(f"Code: {code}. DB::Exception: something. ({name})")


def _store(fail: Callable[[str, list[str]], Exception | None]) -> tuple[JournalStore, _Client]:
    client = _Client(fail)
    return JournalStore(client), client  # type: ignore[arg-type]


def test_a_missing_journal_reads_as_no_applied_migrations_and_is_not_created() -> None:
    store, client = _store(
        lambda sql, _: _clickhouse_error(60, "UNKNOWN_TABLE") if sql == PROBE else None
    )

    assert store.read_journal().applied == []
    assert store.read_migration_state("m.sql") is None
    assert client.executed == []


def test_a_missing_journal_behind_the_obsessiondb_console_api_reads_as_empty() -> None:
    # The console API sends ClickHouse's message without the code or the name.
    store, client = _store(
        lambda sql, _: (
            RuntimeError(
                "ClickHouse request failed: Unknown table expression identifier "
                f"'_chkit_migrations' in scope {sql}."
            )
            if sql == PROBE
            else None
        )
    )

    assert store.read_journal().applied == []
    assert client.executed == []


def test_the_first_write_creates_the_journal_that_reads_found_missing() -> None:
    def fail(sql: str, executed: list[str]) -> Exception | None:
        created = any(statement.startswith("CREATE TABLE") for statement in executed)
        return _clickhouse_error(60, "UNKNOWN_TABLE") if sql == PROBE and not created else None

    store, client = _store(fail)
    store.read_journal()
    assert client.executed == []

    store.write_migration_state(
        MigrationRowState.model_validate(
            {
                "name": "m.sql",
                "appliedAt": "2026-10-31T12:00:00.000Z",
                "checksum": "abc",
                "chkitVersion": "0.0.0",
                "migrationCompleted": True,
                "operations": [],
            }
        )
    )

    assert client.executed[0].startswith("CREATE TABLE IF NOT EXISTS _chkit_migrations")
    assert any(sql.startswith("INSERT INTO _chkit_migrations") for sql in client.executed)


def test_an_up_to_date_journal_is_read_without_alter() -> None:
    store, client = _store(lambda *_: None)

    store.read_journal()

    assert [sql for sql in client.executed if not sql.startswith("SYSTEM SYNC REPLICA")] == []


def test_a_journal_without_the_per_operation_columns_is_upgraded() -> None:
    store, client = _store(
        lambda sql, _: _clickhouse_error(47, "UNKNOWN_IDENTIFIER") if sql == PROBE else None
    )

    store.read_journal()

    assert len([sql for sql in client.executed if sql.startswith("ALTER TABLE")]) == 2


def test_a_read_fails_on_an_error_other_than_a_missing_journal() -> None:
    store, _ = _store(
        lambda sql, _: _clickhouse_error(497, "ACCESS_DENIED") if sql == PROBE else None
    )

    with pytest.raises(Exception, match="ACCESS_DENIED"):
        store.read_journal()


def test_a_readonly_1_user_reads_without_select_sequential_consistency() -> None:
    store, client = _store(
        lambda sql, _: (
            _clickhouse_error(164, "READONLY") if "select_sequential_consistency" in sql else None
        )
    )

    store.read_journal()

    reads = [sql for sql in client.queries if "migration_completed = true" in sql]
    assert len(reads) == 2
    assert "SETTINGS" not in reads[1]
