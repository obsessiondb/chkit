"""--mark-applied / --mark-not-applied act only on an unknown outcome (#824).

Port of ``packages/cli/src/test/commands/migrate/mark-outcome.test.ts``.
"""

from __future__ import annotations

from typing import Any, cast

import pytest

from chkit import __version__
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_mark_outcome import (
    mark_stopped_statement,
    read_stopped_statement,
)
from chkit.cli.journal_store import JournalStore, MigrationRowState, OperationState
from chkit.clickhouse.client import ClickHouseClient, QueryStatus
from chkit.core.sql_fingerprint import statement_fingerprint

_INSERT = "INSERT INTO events SELECT number FROM numbers(8)"
_ALTER = "ALTER TABLE events UPDATE x = 1 WHERE 1"
_REJECTED = QueryStatus(status="failed", before_start=True, error="Code: 60. UNKNOWN_TABLE")


def _op(index: int, **overrides: Any) -> OperationState:
    fields: dict[str, Any] = {
        "operation_index": index,
        "operation_key": f"table:db.t{index}",
        "operation_type": "load_table_data",
        "query_id": "",
        "status": "completed",
        "started_at": "2026-11-19 10:00:00.000",
        "finished_at": "2026-11-19 10:00:01.000",
        "last_error": "",
        "fingerprint": f"fp{index}",
    }
    fields.update(overrides)
    return OperationState(**fields)


def _stopped(sql: str) -> OperationState:
    return _op(
        1,
        query_id="q-1",
        status="started",
        finished_at=None,
        last_error=(
            "submitted under its own query id; a retry reads its outcome from system.query_log"
        ),
        fingerprint=statement_fingerprint(sql),
        attempt_fenced=True,
    )


def _state(operations: list[OperationState], chkit_version: str = __version__) -> MigrationRowState:
    return MigrationRowState(
        name="m.sql",
        applied_at="2026-11-19 10:00:02.000",
        checksum="c",
        chkit_version=chkit_version,
        migration_completed=False,
        operations=operations,
    )


class _Store:
    def __init__(self, state: MigrationRowState) -> None:
        self.state = state
        self.writes: list[MigrationRowState] = []

    def read_migration_state(self, _name: str) -> MigrationRowState:
        return self.state

    def write_migration_state(self, state: MigrationRowState) -> None:
        self.writes.append(state)


class _Client:
    def __init__(self, status: QueryStatus) -> None:
        self.status = status
        self.calls: list[str] = []

    def query_status(self, query_id: str, **_kwargs: Any) -> QueryStatus:
        self.calls.append(query_id)
        return self.status


def _read(
    state: MigrationRowState, status: QueryStatus, sql: str | None
) -> tuple[OperationState, _Store, _Client]:
    store = _Store(state)
    client = _Client(status)
    _, op = read_stopped_statement(
        cast(ClickHouseClient, client),
        migration="m.sql",
        applied_names=set(),
        flag="mark-applied",
        sql_by_fingerprint={} if sql is None else {statement_fingerprint(sql): sql},
        journal_store=cast(JournalStore, store),
        log=lambda _line: None,
    )
    return op, store, client


def test_returns_the_one_statement_whose_attempt_failed_while_it_ran() -> None:
    state = _state([_op(0), _stopped(_INSERT)])
    op, _, _ = _read(state, QueryStatus(status="failed", error="boom"), _INSERT)
    assert op.operation_index == 1


def test_refuses_while_the_attempt_still_runs() -> None:
    state = _state([_op(0), _stopped(_INSERT)])
    with pytest.raises(MigrateError) as info:
        _read(state, QueryStatus(status="running"), _INSERT)
    assert info.value.code == "async_outcome_unknown"


def test_refuses_an_insert_the_server_rejected_before_it_started() -> None:
    state = _state([_op(0), _stopped(_INSERT)])
    with pytest.raises(MigrateError) as info:
        _read(state, _REJECTED, _INSERT)
    assert info.value.code == "mark_refused"
    assert "no statement of it stopped with async_outcome_unknown" in str(info.value)


def test_refuses_a_rejection_before_the_start_without_the_statement_in_the_file() -> None:
    state = _state([_op(0), _stopped(_INSERT)])
    with pytest.raises(MigrateError) as info:
        _read(state, _REJECTED, None)
    assert info.value.code == "mark_refused"
    assert "rejected statement 2 (query_id q-1) before it started" in str(info.value)


def test_accepts_a_rejection_before_the_start_of_an_alter() -> None:
    state = _state([_op(0), _stopped(_ALTER)])
    op, _, _ = _read(state, _REJECTED, _ALTER)
    assert op.query_id == "q-1"


def test_refuses_a_state_another_release_recorded_without_fingerprints() -> None:
    state = _state([_op(0, fingerprint=""), _stopped(_INSERT)], chkit_version="0.1.0")
    store = _Store(state)
    client = _Client(QueryStatus(status="failed", error="boom"))
    with pytest.raises(MigrateError) as info:
        read_stopped_statement(
            cast(ClickHouseClient, client),
            migration="m.sql",
            applied_names=set(),
            flag="mark-applied",
            sql_by_fingerprint={},
            journal_store=cast(JournalStore, store),
            log=lambda _line: None,
        )
    assert info.value.code == "mark_refused"
    assert "chkit 0.1.0 recorded its statements without their SQL fingerprints" in str(info.value)
    assert client.calls == []


@pytest.mark.parametrize(
    ("outcome", "status", "last_error"),
    [
        ("applied", "completed", ""),
        ("not-applied", "failed", "abandoned via chkit migrate --abandon (was started)"),
    ],
)
def test_mark_rewrites_only_the_stopped_statement(
    outcome: Any, status: str, last_error: str
) -> None:
    state = _state([_op(0), _stopped(_INSERT)])
    store = _Store(state)
    mark_stopped_statement(
        state, _stopped(_INSERT), outcome, journal_store=cast(JournalStore, store)
    )
    assert len(store.writes) == 1
    written = store.writes[0]
    assert written.operations[0] == _op(0)
    assert written.operations[1].status == status
    assert written.operations[1].last_error == last_error
    assert written.operations[1].query_id == "q-1"
    assert written.migration_completed is False
