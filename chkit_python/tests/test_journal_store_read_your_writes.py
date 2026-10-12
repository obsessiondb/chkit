"""Read-your-writes in :class:`chkit.cli.journal_store.JournalStore`.

On a replicated service each request can land on a different replica, so a
read right after a write may return the previous row version. Every apply step
is a read-modify-write, so a stale read would drop the progress written in
between (a migration marked completed while a statement still reads "started").
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from chkit.cli.journal_store import JournalStore, MigrationRowState, OperationState

pytestmark = pytest.mark.usefixtures("single_replica")


@dataclass
class _Result:
    rows: list[dict[str, Any]]


@dataclass
class _LaggingClient:
    """Answers every journal read with a fixed (stale) row."""

    stale_rows: list[dict[str, Any]]
    executed: list[str] = field(default_factory=list[str])

    def query(self, sql: str) -> _Result:
        return _Result(self.stale_rows)

    def execute(self, sql: str) -> None:
        self.executed.append(sql)


def _op(index: int, status: str) -> OperationState:
    return OperationState.model_validate(
        {
            "operationIndex": index,
            "operationKey": f"view:db.v{index}",
            "operationType": "create_view",
            "queryId": "",
            "status": status,
            "startedAt": "2026-10-09T12:00:00.000",
            "finishedAt": None,
            "lastError": "",
        }
    )


def _state(applied_at: str, statuses: list[str]) -> MigrationRowState:
    return MigrationRowState.model_validate(
        {
            "name": "001_init.sql",
            "appliedAt": applied_at,
            "checksum": "abc",
            "chkitVersion": "0.0.0",
            "migrationCompleted": False,
            "operations": [_op(i, s) for i, s in enumerate(statuses)],
        }
    )


def _stale_row(applied_at: str) -> dict[str, Any]:
    return {
        "name": "001_init.sql",
        "applied_at": applied_at,
        "checksum": "abc",
        "chkit_version": "0.0.0",
        "migration_completed": 0,
        "operations": '[{"operation_index":0,"operation_key":"view:db.v0",'
        '"operation_type":"create_view","query_id":"","status":"started",'
        '"started_at":"2026-10-09 12:00:00.000","finished_at":null,"last_error":""}]',
    }


def _store(client: _LaggingClient) -> JournalStore:
    store = JournalStore(client)  # type: ignore[arg-type]
    store._bootstrapped = True  # pyright: ignore[reportPrivateUsage]
    return store


def test_read_after_write_never_returns_an_older_replica_version() -> None:
    client = _LaggingClient([_stale_row("2026-10-09 12:00:00.100000+00:00")])
    store = _store(client)
    written = _state("2026-10-09T12:00:00.200", ["completed"])
    store.write_migration_state(written)

    state = store.read_migration_state("001_init.sql")

    assert state == written


def test_read_returns_the_server_row_when_it_is_newer_than_our_write() -> None:
    client = _LaggingClient([_stale_row("2026-10-09 12:00:00.300000+00:00")])
    store = _store(client)
    store.write_migration_state(_state("2026-10-09T12:00:00.200", ["completed"]))

    state = store.read_migration_state("001_init.sql")

    assert state is not None
    assert [op.status for op in state.operations] == ["started"]


def test_read_returns_our_write_when_the_replica_has_no_row_yet() -> None:
    client = _LaggingClient([])
    store = _store(client)
    written = _state("2026-10-09T12:00:00.200", ["started"])
    store.write_migration_state(written)

    assert store.read_migration_state("001_init.sql") == written
