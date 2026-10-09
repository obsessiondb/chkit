"""Tests for async_apply (deterministic resume, polling, journal writes)."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import pytest

from chkit.cli.commands import migrate_async_apply
from chkit.cli.commands.migrate_async_apply import (
    AsyncApplyInput,
    apply_async_statement,
    fresh_migration_state,
    iso_without_zone,
    make_deterministic_query_id,
    upsert_operation,
)
from chkit.cli.journal_store import MigrationRowState, OperationState
from chkit.clickhouse.client import QueryStatus


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(migrate_async_apply.time, "sleep", lambda _: None)
    return


# ---------- pure helpers ----------


def test_make_deterministic_query_id_is_stable() -> None:
    a = make_deterministic_query_id("m1.sql", 0)
    b = make_deterministic_query_id("m1.sql", 0)
    assert a == b
    assert "-" in a
    assert len(a) == 36


def test_make_deterministic_query_id_varies_by_inputs() -> None:
    a = make_deterministic_query_id("m1.sql", 0)
    b = make_deterministic_query_id("m1.sql", 1)
    c = make_deterministic_query_id("m2.sql", 0)
    assert len({a, b, c}) == 3


def test_iso_without_zone_returns_3_digit_millis() -> None:
    value = iso_without_zone(datetime(2026, 1, 2, 3, 4, 5, 678901, tzinfo=UTC))
    assert value == "2026-01-02T03:04:05.678"


def test_upsert_operation_replaces_existing_index() -> None:
    state = MigrationRowState(
        name="m.sql",
        applied_at="2026-01-01 00:00:00.000",
        checksum="c",
        chkit_version="0.1",
        migration_completed=False,
        operations=[
            OperationState(
                operation_index=0,
                operation_key="k",
                operation_type="t",
                query_id="q",
                status="started",
                started_at="x",
                finished_at=None,
                last_error="",
            )
        ],
    )
    replacement = OperationState(
        operation_index=0,
        operation_key="k",
        operation_type="t",
        query_id="q",
        status="completed",
        started_at="x",
        finished_at="y",
        last_error="",
    )
    out = upsert_operation(state, replacement, "now")
    assert len(out.operations) == 1
    assert out.operations[0].status == "completed"


def test_upsert_operation_inserts_new_index() -> None:
    state = fresh_migration_state("m.sql", "c")
    new = OperationState(
        operation_index=1,
        operation_key="k",
        operation_type="t",
        query_id="q",
        status="started",
        started_at="x",
        finished_at=None,
        last_error="",
    )
    out = upsert_operation(state, new, "now")
    assert out.operations == [new]


def test_upsert_operation_sorts_by_index() -> None:
    state = fresh_migration_state("m.sql", "c")
    state = upsert_operation(
        state,
        OperationState(
            operation_index=2,
            operation_key="k",
            operation_type="t",
            query_id="q2",
            status="started",
            started_at="x",
            finished_at=None,
            last_error="",
        ),
        "now",
    )
    state = upsert_operation(
        state,
        OperationState(
            operation_index=0,
            operation_key="k",
            operation_type="t",
            query_id="q0",
            status="started",
            started_at="x",
            finished_at=None,
            last_error="",
        ),
        "now",
    )
    assert [op.operation_index for op in state.operations] == [0, 2]


# ---------- apply_async_statement with fake client / store ----------


@dataclass
class _FakeJournalStore:
    state: MigrationRowState | None = None
    writes: list[MigrationRowState] | None = None

    def __post_init__(self) -> None:
        if self.writes is None:
            self.writes = []

    def read_migration_state(self, _name: str) -> MigrationRowState | None:
        return self.state

    def write_migration_state(self, state: MigrationRowState) -> None:
        assert self.writes is not None
        self.writes.append(state)
        self.state = state


class _ScriptedClient:
    """Fake ClickHouseClient with scripted query_status responses."""

    def __init__(
        self,
        statuses: list[QueryStatus],
        *,
        submit_raises: BaseException | None = None,
    ) -> None:
        self._statuses = list(statuses)
        self.submitted: list[tuple[str, str | None]] = []
        self.executed: list[str] = []
        self._submit_raises = submit_raises

    def submit(self, statement: str, query_id: str | None = None) -> str:
        if self._submit_raises is not None:
            raise self._submit_raises
        self.submitted.append((statement, query_id))
        return query_id or "auto-id"

    def query_status(self, _query_id: str, *, after_time: str | None = None) -> QueryStatus:
        if not self._statuses:
            return QueryStatus(status="unknown")
        return self._statuses.pop(0)

    def execute(self, statement: str) -> None:
        self.executed.append(statement)


def _input(
    *, client: Any, journal: Any, **overrides: Any
) -> AsyncApplyInput:
    defaults: dict[str, Any] = {
        "client": client,
        "journal_store": journal,
        "sql": "ALTER TABLE db.t MODIFY COLUMN x UInt64",
        "migration_name": "20260101_000000_async.sql",
        "migration_checksum": "abc",
        "statement_index": 0,
        "operation_type": "alter_table_modify_column",
        "operation_key": "table:db.t:column:x",
        "before_retry": None,
        "log": lambda _msg: None,
        "poll_interval_seconds": 0.0,
    }
    defaults.update(overrides)
    return AsyncApplyInput(**defaults)


def test_apply_async_happy_path_writes_started_then_completed() -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),  # initial in-flight check (not running)
            QueryStatus(status="running", written_rows=5),  # first poll
            QueryStatus(status="finished", written_rows=10, duration_ms=2000),
        ]
    )
    journal = _FakeJournalStore()
    result = apply_async_statement(_input(client=client, journal=journal))
    assert result.kind == "completed"
    assert result.operation.status == "completed"
    assert len(client.submitted) == 1
    assert journal.writes is not None
    # Two writes: started + completed
    statuses = [w.operations[0].status for w in journal.writes]
    assert statuses == ["started", "completed"]


def test_apply_async_already_running_skips_submit() -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="running"),  # initial in-flight check returns running
            QueryStatus(status="finished", duration_ms=1000),  # next poll terminal
        ]
    )
    journal = _FakeJournalStore()
    apply_async_statement(_input(client=client, journal=journal))
    # No submit call — we attached to in-flight
    assert client.submitted == []


def test_apply_async_already_completed_skips_entirely() -> None:
    prior = OperationState(
        operation_index=0,
        operation_key="table:db.t:column:x",
        operation_type="alter_table_modify_column",
        query_id=make_deterministic_query_id("20260101_000000_async.sql", 0),
        status="completed",
        started_at="2026-01-01T00:00:00.000",
        finished_at="2026-01-01T00:00:10.000",
        last_error="",
    )
    state = MigrationRowState(
        name="20260101_000000_async.sql",
        applied_at="2026-01-01T00:00:10.000",
        checksum="abc",
        chkit_version="0.1",
        migration_completed=False,
        operations=[prior],
    )
    client = _ScriptedClient(statuses=[])
    journal = _FakeJournalStore(state=state)
    result = apply_async_statement(_input(client=client, journal=journal))
    assert result.kind == "skipped"
    assert result.operation == prior
    assert client.submitted == []


def test_apply_async_failed_status_raises_and_writes_failure() -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="failed", error="ALTER failed", duration_ms=500),
        ]
    )
    journal = _FakeJournalStore()
    with pytest.raises(RuntimeError, match="ALTER failed"):
        apply_async_statement(_input(client=client, journal=journal))
    assert journal.writes is not None
    assert any(
        w.operations and w.operations[0].status == "failed" for w in journal.writes
    )


def test_apply_async_resubmit_runs_before_retry() -> None:
    prior = OperationState(
        operation_index=0,
        operation_key="table:db.t:column:x",
        operation_type="alter_table_modify_column",
        query_id=make_deterministic_query_id("20260101_000000_async.sql", 0),
        status="failed",
        started_at="2026-01-01T00:00:00.000",
        finished_at="2026-01-01T00:00:01.000",
        last_error="connection lost",
    )
    state = MigrationRowState(
        name="20260101_000000_async.sql",
        applied_at="2026-01-01T00:00:01.000",
        checksum="abc",
        chkit_version="0.1",
        migration_completed=False,
        operations=[prior],
    )
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),  # not running anymore
            QueryStatus(status="finished", duration_ms=1000),
        ]
    )
    journal = _FakeJournalStore(state=state)
    apply_async_statement(
        _input(
            client=client,
            journal=journal,
            before_retry="TRUNCATE TABLE db.t",
        )
    )
    assert client.executed == ["TRUNCATE TABLE db.t"]


def test_apply_async_rejects_checksum_mismatch_on_in_progress_state() -> None:
    state = MigrationRowState(
        name="m.sql",
        applied_at="2026-01-01T00:00:00.000",
        checksum="OLD",
        chkit_version="0.1",
        migration_completed=False,
        operations=[],
    )
    journal = _FakeJournalStore(state=state)
    client = _ScriptedClient(statuses=[])
    with pytest.raises(RuntimeError, match="in-progress async journal state"):
        apply_async_statement(
            _input(
                client=client,
                journal=journal,
                migration_name="m.sql",
                migration_checksum="NEW",
            )
        )
