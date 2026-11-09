"""Statement fingerprints in :class:`chkit.cli.journal_store.JournalStore` (#599).

Fingerprints live in a column of their own, which older releases never name:
their writes leave it ``[]``. Same as the TS ``statement fingerprints (#599)``
journal-store tests.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pytest

from chkit.cli.journal_store import JournalStore, MigrationRowState, OperationState

pytestmark = pytest.mark.usefixtures("single_replica")

FINGERPRINT_PROBE = "SELECT operation_fingerprints FROM _chkit_migrations LIMIT 0"


@dataclass
class _Result:
    rows: list[dict[str, Any]]


@dataclass
class _Client:
    rows: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    query_error: Callable[[str, list[str]], Exception | None] = lambda _sql, _executed: None
    execute_error: Callable[[str], Exception | None] = lambda _sql: None
    queries: list[str] = field(default_factory=list[str])
    executed: list[str] = field(default_factory=list[str])

    def query(self, sql: str) -> _Result:
        self.queries.append(sql)
        error = self.query_error(sql, self.executed)
        if error is not None:
            raise error
        if "WHERE name = 'm.sql'" not in sql:
            return _Result([])
        # A read that does not select the column does not get it.
        if "operation_fingerprints" in sql:
            return _Result(self.rows)
        return _Result(
            [{k: v for k, v in row.items() if k != "operation_fingerprints"} for row in self.rows]
        )

    def execute(self, sql: str) -> None:
        self.executed.append(sql)
        error = self.execute_error(sql)
        if error is not None:
            raise error


def _clickhouse_error(code: int, name: str) -> Exception:
    return Exception(f"Code: {code}. DB::Exception: something. ({name})")


def _row(operations: list[dict[str, Any]], fingerprints: Any) -> dict[str, Any]:
    return {
        "name": "m.sql",
        "applied_at": "2026-11-09 12:00:00.000",
        "checksum": "abc",
        "chkit_version": "0.0.0",
        "migration_completed": False,
        "operations": json.dumps(operations),
        "operation_fingerprints": json.dumps(fingerprints),
    }


def _tuple(index: int) -> dict[str, Any]:
    return {
        "operation_index": index,
        "operation_key": f"statement:{index}",
        "operation_type": "sql_statement",
        "query_id": "",
        "status": "completed",
        "started_at": "2026-11-09 12:00:00.000",
        "finished_at": "2026-11-09 12:00:00.000",
        "last_error": "",
    }


def _state(fingerprints: list[str]) -> MigrationRowState:
    return MigrationRowState(
        name="m.sql",
        applied_at="2026-11-09T12:00:01.000",
        checksum="abc",
        chkit_version="0.0.0",
        migration_completed=False,
        operations=[
            OperationState(
                operation_index=index,
                operation_key=f"statement:{index}",
                operation_type="sql_statement",
                query_id="",
                status="completed",
                started_at="2026-11-09T12:00:00.000",
                finished_at="2026-11-09T12:00:00.000",
                last_error="",
                fingerprint=fingerprint,
            )
            for index, fingerprint in enumerate(fingerprints)
        ],
    )


def _store(client: _Client) -> JournalStore:
    return JournalStore(client)  # type: ignore[arg-type]


def _no_column(sql: str, _executed: list[str]) -> Exception | None:
    return _clickhouse_error(47, "UNKNOWN_IDENTIFIER") if sql == FINGERPRINT_PROBE else None


def test_reads_one_fingerprint_per_operation_in_order() -> None:
    client = _Client(rows=[_row([_tuple(0), _tuple(1)], ["v1:a", "v1:b"])])
    state = _store(client).read_migration_state("m.sql")
    assert state is not None
    assert [op.fingerprint for op in state.operations] == ["v1:a", "v1:b"]
    read = next(sql for sql in client.queries if "name = 'm.sql'" in sql)
    assert "toJSONString(operation_fingerprints) AS operation_fingerprints" in read


def test_a_row_an_older_release_wrote_has_no_fingerprints() -> None:
    client = _Client(rows=[_row([_tuple(0), _tuple(1)], [])])
    state = _store(client).read_migration_state("m.sql")
    assert state is not None
    assert [op.fingerprint for op in state.operations] == ["", ""]


def test_writes_the_fingerprints_next_to_the_operations() -> None:
    client = _Client()
    _store(client).write_migration_state(_state(["v1:a", "v1:'b"]))
    insert = next(sql for sql in client.executed if sql.startswith("INSERT INTO"))
    assert "migration_completed, operations, operation_fingerprints) VALUES" in insert
    assert insert.endswith(", ['v1:a','v1:\\'b'])")
    assert not any(sql.startswith("ALTER TABLE") for sql in client.executed)


def test_a_journal_without_the_column_is_read_without_fingerprints_and_not_altered() -> None:
    client = _Client(rows=[_row([_tuple(0)], ["v1:a"])], query_error=_no_column)
    state = _store(client).read_migration_state("m.sql")
    assert state is not None
    assert [op.fingerprint for op in state.operations] == [""]
    read = next(sql for sql in client.queries if "name = 'm.sql'" in sql)
    assert "operation_fingerprints" not in read
    assert [sql for sql in client.executed if not sql.startswith("SYSTEM SYNC REPLICA")] == []


def test_the_first_write_adds_the_column_to_a_journal_an_older_release_created() -> None:
    client = _Client(
        query_error=lambda sql, executed: (
            _clickhouse_error(47, "UNKNOWN_IDENTIFIER")
            if sql == FINGERPRINT_PROBE
            and not any(command.startswith("ALTER TABLE") for command in executed)
            else None
        )
    )
    store = _store(client)
    store.read_journal()
    store.write_migration_state(_state(["v1:a"]))
    writes = [sql for sql in client.executed if not sql.startswith("SYSTEM SYNC REPLICA")]
    assert writes[0] == (
        "ALTER TABLE _chkit_migrations ADD COLUMN IF NOT EXISTS "
        "operation_fingerprints Array(String) DEFAULT []"
    )
    assert writes[1].endswith(", ['v1:a'])")


def test_a_user_that_cannot_alter_the_journal_still_writes_without_fingerprints() -> None:
    client = _Client(
        query_error=_no_column,
        execute_error=lambda sql: (
            _clickhouse_error(497, "ACCESS_DENIED") if sql.startswith("ALTER TABLE") else None
        ),
    )
    store = _store(client)
    store.write_migration_state(_state(["v1:a"]))
    store.write_migration_state(_state(["v1:a"]))
    inserts = [sql for sql in client.executed if sql.startswith("INSERT INTO")]
    assert len(inserts) == 2
    assert all("operation_fingerprints" not in sql for sql in inserts)
    # The ALTER is tried once per run.
    assert len([sql for sql in client.executed if sql.startswith("ALTER TABLE")]) == 1


def test_an_insert_on_a_replica_without_the_column_is_written_again_without_fingerprints() -> None:
    client = _Client(
        execute_error=lambda sql: (
            _clickhouse_error(16, "NO_SUCH_COLUMN_IN_TABLE")
            if "operation_fingerprints) VALUES" in sql
            else None
        )
    )
    _store(client).write_migration_state(_state(["v1:a"]))
    inserts = [sql for sql in client.executed if sql.startswith("INSERT INTO")]
    assert len(inserts) == 2
    assert "operation_fingerprints" not in inserts[1]


def test_a_read_on_a_replica_without_the_column_reads_again_without_fingerprints() -> None:
    client = _Client(
        rows=[_row([_tuple(0)], ["v1:a"])],
        query_error=lambda sql, _executed: (
            _clickhouse_error(47, "UNKNOWN_IDENTIFIER")
            if "name = 'm.sql'" in sql and "operation_fingerprints" in sql
            else None
        ),
    )
    state = _store(client).read_migration_state("m.sql")
    assert state is not None
    assert [op.fingerprint for op in state.operations] == [""]
    assert len([sql for sql in client.queries if "name = 'm.sql'" in sql]) == 2


def test_the_abandon_report_leaves_fingerprints_out() -> None:
    state = _state(["v1:a"])
    assert "fingerprint" not in state.operations[0].model_dump(by_alias=True)
