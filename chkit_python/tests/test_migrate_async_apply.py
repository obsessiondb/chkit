"""Tests for async_apply (deterministic resume, polling, journal writes)."""

from __future__ import annotations

import decimal
import re
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock

import pytest

from chkit.cli.commands import migrate_async_apply
from chkit.cli.commands.migrate_abandon import abandon_migration_state
from chkit.cli.commands.migrate_async_apply import (
    AsyncApplyInput,
    apply_async_statement,
    fresh_migration_state,
    iso_without_zone,
    make_deterministic_query_id,
    upsert_operation,
)
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_query_intents import QueryContext
from chkit.cli.journal_store import (
    EveryCopyRead,
    MigrationRowState,
    OperationState,
    operation_as_stored,
)
from chkit.clickhouse.client import QueryResult, QueryStatus

# The server clock differs from the client clock on purpose: the query_log
# bound must come from the server.
SERVER_NOW_MS = 1_700_000_100_000
SERVER_DATABASE = "analytics"
# How long the attempt an attach finds has been running.
RUNNING_ELAPSED_MS = 30_000
# Every attempt's id is its own (#701, #767): its polls count every query_log
# entry from an hour before SERVER_NOW_MS, a bound that only lets query_log prune.
RETRY_BOUND = "2023-11-14T21:15:00.000Z"
_UUID_SHAPE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# The id an earlier release gave a statement's first attempt on SERVER_DATABASE.
_QUERY_ID = make_deterministic_query_id(
    SERVER_DATABASE, "_chkit_migrations", "20260101_000000_async.sql", 0
)
_ATTEMPT_MARKER = migrate_async_apply.ATTEMPT_RECORD_MARKER
_PREPARED_MARKER = migrate_async_apply.PREPARED_RECORD_MARKER


def _submitted_query_id(submitted: list[tuple[str, str | None]]) -> str:
    """The id an attempt submitted under: a random one, never the statement's
    earlier first id (#701, #767)."""
    assert len(submitted) == 1
    query_id = submitted[0][1] or ""
    assert _UUID_SHAPE.match(query_id), query_id
    assert query_id != make_deterministic_query_id(
        SERVER_DATABASE, "_chkit_migrations", "20260101_000000_async.sql", 0
    )
    return query_id
SERVER_TIME_QUERY = (
    "query: SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms, currentDatabase() AS database"
)


def _wait_for_submit(_seconds: float) -> None:
    # A poll interval outlasts these fakes' submit requests, so a submit error
    # is known by the first poll, which keeps the call order deterministic.
    for thread in threading.enumerate():
        if thread.name == migrate_async_apply.SUBMIT_THREAD_NAME:
            thread.join(timeout=5)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", _wait_for_submit)


# ---------- pure helpers ----------


def test_make_deterministic_query_id_is_stable() -> None:
    a = make_deterministic_query_id("staging", "_chkit_migrations", "20260526_load.sql", 0)
    b = make_deterministic_query_id("staging", "_chkit_migrations", "20260526_load.sql", 0)
    assert a == b
    # The TS CLI builds the same id (async-apply.test.ts).
    assert a == "ff8138de-dce9-96af-69dc-cd30f8f4a7bb"


def test_make_deterministic_query_id_varies_by_inputs() -> None:
    a = make_deterministic_query_id("staging", "_chkit_migrations", "m1.sql", 0)
    b = make_deterministic_query_id("staging", "_chkit_migrations", "m1.sql", 1)
    c = make_deterministic_query_id("staging", "_chkit_migrations", "m2.sql", 0)
    # #463: another database, or another project's journal in the same database.
    d = make_deterministic_query_id("prod", "_chkit_migrations", "m1.sql", 0)
    e = make_deterministic_query_id("staging", "_chkit_migrations_b", "m1.sql", 0)
    assert len({a, b, c, d, e}) == 5


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
                fingerprint="",
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
        fingerprint="",
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
        fingerprint="",
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
            fingerprint="",
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
            fingerprint="",
        ),
        "now",
    )
    assert [op.operation_index for op in state.operations] == [0, 2]


# ---------- apply_async_statement with fake client / store ----------


@dataclass
class _FakeJournalStore:
    state: MigrationRowState | None = None
    writes: list[MigrationRowState] | None = None
    # False is a journal without the operation_fingerprints column, which
    # stores no fence (#767).
    fingerprints: bool = True
    # Whether a journal read covers every copy of the journal (#767).
    every_copy: bool = True

    def __post_init__(self) -> None:
        if self.writes is None:
            self.writes = []

    def read_migration_state(self, _name: str) -> MigrationRowState | None:
        return self.state

    def read_stored_operation(self, _name: str, index: int) -> OperationState | None:
        if self.state is None:
            return None
        return next((op for op in self.state.operations if op.operation_index == index), None)

    def stores_attempt_fences(self) -> bool:
        return self.fingerprints

    def read_operation_on_every_copy(self, name: str, index: int) -> EveryCopyRead:
        if not self.every_copy:
            return EveryCopyRead(covered=False, op=None)
        return EveryCopyRead(covered=True, op=self.read_stored_operation(name, index))

    def write_migration_state(self, state: MigrationRowState) -> None:
        assert self.writes is not None
        self.writes.append(state)
        # As the journal returns it.
        self.state = state.model_copy(
            update={
                "operations": [
                    operation_as_stored(op, self.fingerprints) for op in state.operations
                ]
            }
        )


class _ScriptedClient:
    """Fake ClickHouseClient with scripted query_status responses."""

    def __init__(
        self,
        statuses: list[QueryStatus | BaseException],
        *,
        submit_raises: BaseException | None = None,
        strict: bool = False,
    ) -> None:
        self._statuses = list(statuses)
        # The server clock, which a test can advance.
        self.now_ms = SERVER_NOW_MS
        # Raise, as the TS fake does, instead of answering unknown once the
        # scripted answers run out.
        self._strict = strict
        self.submitted: list[tuple[str, str | None]] = []
        self.executed: list[str] = []
        # The settings each submit / execute call received, in call order.
        self.sent_settings: list[tuple[str, dict[str, Any] | None]] = []
        self.after_times: list[str | None] = []
        self.status_ids: list[str] = []
        self.every_replica: list[bool] = []
        self.running_only: list[bool] = []
        # Server-time reads, status checks and submissions, in call order.
        self.events: list[str] = []
        self._submit_raises = submit_raises

    def query(self, statement: str) -> QueryResult:
        self.events.append(f"query: {statement}")
        return QueryResult(
            column_names=["now_ms", "database"],
            rows=[{"now_ms": str(self.now_ms), "database": SERVER_DATABASE}],
        )

    def submit(
        self,
        statement: str,
        query_id: str | None = None,
        settings: dict[str, Any] | None = None,
        *,
        before_send: Any = None,
    ) -> str:
        if before_send is not None:
            before_send()
            before_send.commit()
        self.events.append("submit")
        self.submitted.append((statement, query_id))
        self.sent_settings.append(("submit", settings))
        if self._submit_raises is not None:
            raise self._submit_raises
        return query_id or "auto-id"

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        self.events.append("status")
        self.status_ids.append(query_id)
        self.after_times.append(after_time)
        self.every_replica.append(every_replica)
        self.running_only.append(running_only)
        if not self._statuses:
            if self._strict:
                msg = "query_status called more times than the fake has answers for"
                raise RuntimeError(msg)
            return QueryStatus(status="unknown")
        status = self._statuses.pop(0)
        if isinstance(status, BaseException):
            raise status
        # A read of system.processes alone, as the server answers it, never
        # finds a query that ended.
        if running_only and status.status != "running":
            return QueryStatus(status="unknown")
        return status

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        self.executed.append(statement)
        self.sent_settings.append(("execute", settings))


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
        "fingerprint": "",
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
    # A first attempt gets a random id of its own too (#767).
    query_id = _submitted_query_id(client.submitted)
    assert client.submitted == [("ALTER TABLE db.t MODIFY COLUMN x UInt64", query_id)]
    # Without migrate --setting the submission carries no settings.
    assert client.sent_settings == [("submit", None)]
    assert journal.writes is not None
    # Two writes: started + completed
    statuses = [w.operations[0].status for w in journal.writes]
    assert statuses == ["started", "started", "completed"]
    # The started record names the id and is fenced before the submit (#767).
    prepared, started = journal.writes[0].operations[0], journal.writes[1].operations[0]
    assert (prepared.query_id, prepared.last_error, prepared.attempt_fenced) == (
        query_id, _PREPARED_MARKER, True
    )
    assert (started.query_id, started.last_error, started.attempt_fenced) == (
        query_id, _ATTEMPT_MARKER, True
    )
    # The in-flight check looks for a running query under the id an earlier
    # release would have used; the polls read the attempt's own id.
    assert client.status_ids == [_QUERY_ID, query_id, query_id]
    assert client.after_times == [None, RETRY_BOUND, RETRY_BOUND]
    assert client.events == [SERVER_TIME_QUERY, "status", "submit", "status", "status"]


_LEGACY_ID = "f2d1c4e0-1111-2222-3333-444455556666"


def _running_prior(kind: str) -> MigrationRowState | None:
    if kind == "none":
        return None
    op = _op("started" if kind == "started" else "failed").model_copy(
        update={"query_id": _LEGACY_ID, "last_error": "" if kind == "started" else "boom"}
    )
    return _state(op, checksum="abc").model_copy(update={"name": "20260101_000000_async.sql"})


@pytest.mark.parametrize("kind", ["none", "started", "failed"])
def test_apply_async_running_query_without_a_fenced_record_stops_instead_of_attaching(
    kind: str,
) -> None:
    """#767: only a fenced record's id names the running attempt alone. Any
    other id an earlier release may have reused, so polls could take an
    earlier attempt's QueryFinish for this one's outcome. The run stops and
    writes nothing. #463: a statement an older chkit journaled is still
    checked under its journaled id."""
    client = _ScriptedClient(
        statuses=[QueryStatus(status="running", written_rows=50, elapsed_ms=RUNNING_ELAPSED_MS)]
    )
    journal = _FakeJournalStore(state=_running_prior(kind))
    checked_id = _QUERY_ID if kind == "none" else _LEGACY_ID
    with pytest.raises(MigrateError) as info:
        apply_async_statement(
            _input(client=client, journal=journal, before_retry="TRUNCATE TABLE db.t")
        )
    assert info.value.code == "async_outcome_unknown"
    reason = (
        "but the journal records that attempt as failed, so chkit does not attach to it, and "
        "the next chkit migrate --apply runs the statement again (after its before-retry SQL, "
        "when it has one)"
        if kind == "failed"
        else "but its query id was not recorded by this chkit release for that attempt alone, "
        "so chkit cannot tell its outcome from system.query_log once it ends"
    )
    assert info.value.message == (
        "Async migration step alter_table_modify_column (statement 1 of "
        f"20260101_000000_async.sql, query_id {checked_id}) is still running on the server, "
        f"{reason}. Nothing was submitted and no before-retry SQL ran. Wait for it to finish "
        f"or run KILL QUERY WHERE query_id = '{checked_id}', then run chkit migrate --apply "
        "again."
    )
    assert client.status_ids == [checked_id]
    assert client.after_times == [None]
    assert client.running_only == [True]
    assert client.every_replica == [True]
    assert client.submitted == []
    assert client.executed == []
    assert journal.writes == []


def test_apply_async_already_completed_skips_entirely() -> None:
    prior = OperationState(
        operation_index=0,
        operation_key="table:db.t:column:x",
        operation_type="alter_table_modify_column",
        query_id=make_deterministic_query_id(
            SERVER_DATABASE, "_chkit_migrations", "20260101_000000_async.sql", 0
        ),
        status="completed",
        started_at="2026-01-01T00:00:00.000",
        finished_at="2026-01-01T00:00:10.000",
        last_error="",
        fingerprint="",
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


def test_apply_async_a_failure_while_it_runs_keeps_the_fenced_record_and_stops() -> None:
    """#767 (rounds 3 and 4): a statement that fails while it runs can leave
    some of its writes applied, so the run stops with async_outcome_unknown
    and writes nothing: the fenced started record keeps the attempt's
    identity for the operator to reconcile."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="failed", error="ALTER failed", duration_ms=500),
        ]
    )
    journal = _FakeJournalStore()
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_input(client=client, journal=journal))
    assert info.value.code == "async_outcome_unknown"
    assert "failed while it ran: ALTER failed. A statement that fails while it runs" in (
        info.value.message
    )
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started"]
    assert journal.state is not None
    recorded = journal.state.operations[0]
    assert (recorded.last_error, recorded.attempt_fenced) == (_ATTEMPT_MARKER, True)


def test_apply_async_gives_up_after_poll_error_budget_with_ts_message() -> None:
    poll_error = RuntimeError("ClickHouse request failed: error code: 524")
    client = _ScriptedClient(
        statuses=[QueryStatus(status="unknown")]
        + [poll_error] * (migrate_async_apply.MAX_TRANSIENT_POLL_ERRORS + 1)
    )
    with pytest.raises(MigrateError) as raised:
        apply_async_statement(_input(client=client, journal=_FakeJournalStore()))
    query_id = _submitted_query_id(client.submitted)
    # #767 (round 4): the poll budget ends without an outcome, as in TS. Same
    # text as the TS port: a multiplication sign, not "x".
    assert raised.value.code == "async_outcome_unknown"
    assert (
        f"(statement 1 of 20260101_000000_async.sql, query_id {query_id}): the journal "
        "records an attempt of it and no replica runs it, but chkit cannot tell whether it "
        "finished: polling failed 21\u00d7 in a row (ClickHouse request failed: error code: "
        "524). Nothing was submitted"
    ) in raised.value.message


def test_apply_async_resubmit_runs_before_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    prior = OperationState(
        operation_index=0,
        operation_key="table:db.t:column:x",
        operation_type="alter_table_modify_column",
        query_id=make_deterministic_query_id(
            SERVER_DATABASE, "_chkit_migrations", "20260101_000000_async.sql", 0
        ),
        status="failed",
        started_at="2026-01-01T00:00:00.000",
        finished_at="2026-01-01T00:00:01.000",
        last_error="connection lost",
        fingerprint="",
        # A failure the server recorded for the id (#767).
        attempt_fenced=True,
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
    _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=state)
    apply_async_statement(
        _input(
            client=client,
            journal=journal,
            before_retry="TRUNCATE TABLE db.t",
            settings={"max_table_size_to_drop": "0"},
        )
    )
    assert client.executed == ["TRUNCATE TABLE db.t"]
    # migrate --setting reaches the before-retry SQL and the resubmission (#321).
    assert client.sent_settings == [
        ("execute", {"max_table_size_to_drop": "0"}),
        ("submit", {"max_table_size_to_drop": "0"}),
    ]
    # The check reads the recorded attempt's id; the retry submits and polls
    # under an id of its own, so every query_log entry of it counts (#701).
    retry_id = _submitted_query_id(client.submitted)
    assert retry_id != prior.query_id
    assert client.status_ids == [prior.query_id, retry_id]
    assert client.submitted == [("ALTER TABLE db.t MODIFY COLUMN x UInt64", retry_id)]
    assert client.after_times == [None, RETRY_BOUND]
    # The retry submits right after the check, without waiting on the server clock.
    assert client.events == [SERVER_TIME_QUERY, "status", "submit", "status"]
    assert journal.writes is not None
    assert journal.writes[0].operations[0].last_error == _PREPARED_MARKER
    assert journal.writes[1].operations[0].query_id == retry_id
    assert journal.writes[1].operations[0].last_error == _ATTEMPT_MARKER
    assert journal.writes[1].operations[0].attempt_fenced is True
    # #246: only the in-flight check, which decides on the retry, must read
    # every replica; a poll skips a replica it cannot reach.
    assert client.every_replica == [True, False]


@pytest.mark.parametrize("prior_status", ["started", "failed"])
def test_apply_async_inconclusive_in_flight_check_never_compensates(
    prior_status: str,
) -> None:
    # #246: the attempt may still run on a replica the check could not read.
    # Running the before-retry SQL (a TRUNCATE) or resubmitting then would race
    # it, so a failed check stops before either and leaves the journal as is.
    state = _state(_op(prior_status), checksum="abc")
    client = _ScriptedClient(
        statuses=[RuntimeError("ALL_CONNECTION_TRIES_FAILED: clickhouse-1")]
    )
    journal = _FakeJournalStore(state=state)
    with pytest.raises(RuntimeError) as raised:
        apply_async_statement(
            _input(
                client=client,
                journal=journal,
                migration_name="m.sql",
                before_retry="TRUNCATE TABLE db.t",
            )
        )
    message = str(raised.value)
    assert "could not check whether a previous attempt is still running" in message
    assert "ALL_CONNECTION_TRIES_FAILED: clickhouse-1" in message
    assert "no before-retry SQL ran" in message
    assert client.executed == []
    assert client.submitted == []
    assert journal.writes == []
    assert journal.state == state
    assert client.every_replica == [True]
    # A started record an older chkit wrote, with before-retry SQL, is
    # checked in system.processes only (#672).
    assert client.after_times == [None]
    assert client.running_only == [True]


def _op(status: str, *, last_error: str = "", index: int = 0) -> OperationState:
    return OperationState(
        operation_index=index,
        operation_key="table:db.t:column:x",
        operation_type="alter_table_modify_column",
        query_id=make_deterministic_query_id(
            SERVER_DATABASE, "_chkit_migrations", "m.sql", index
        ),
        status=status,  # type: ignore[arg-type]
        started_at="2023-11-14 22:14:00.000",
        finished_at=None if status == "started" else "2023-11-14 22:14:01.000",
        last_error=last_error,
        fingerprint="",
    )


def _state(*ops: OperationState, checksum: str = "OLD") -> MigrationRowState:
    return MigrationRowState(
        name="m.sql",
        applied_at="2026-01-01T00:00:00.000",
        checksum=checksum,
        chkit_version="0.1",
        migration_completed=False,
        operations=list(ops),
    )


def test_apply_async_rejects_checksum_mismatch_on_in_progress_state() -> None:
    journal = _FakeJournalStore(state=_state(_op("completed", index=1)))
    client = _ScriptedClient(statuses=[])
    with pytest.raises(MigrateError, match="in-progress async journal state") as info:
        apply_async_statement(
            _input(
                client=client,
                journal=journal,
                migration_name="m.sql",
                migration_checksum="NEW",
            )
        )
    assert info.value.code == "in_progress_checksum_mismatch"
    assert "chkit migrate --apply --retry m.sql" in info.value.message
    assert client.submitted == []
    assert client.after_times == []


def test_apply_async_accepts_changed_checksum_without_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No statement completed or started (#233): the edited file runs again."""
    journal = _FakeJournalStore(
        state=_state(
            _op("failed", last_error="Memory limit").model_copy(update={"attempt_fenced": True})
        )
    )
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="finished", written_rows=1, duration_ms=100),
        ]
    )
    _advance_clock(monkeypatch, client)
    result = apply_async_statement(
        _input(
            client=client,
            journal=journal,
            migration_name="m.sql",
            migration_checksum="NEW",
            before_retry="TRUNCATE TABLE t",
        )
    )
    assert result.kind == "completed"
    # The failed attempt is still compensated before the edited statement runs.
    assert client.executed == ["TRUNCATE TABLE t"]
    assert len(client.submitted) == 1
    assert journal.writes is not None
    assert [w.checksum for w in journal.writes] == ["NEW", "NEW", "NEW"]




def test_apply_async_submit_rejected_before_start_is_recorded_failed() -> None:
    """The server logs a statement it rejects before it starts as
    ExceptionBeforeStart under the attempt's id: its recorded failure (#767)."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="unknown"),
            QueryStatus(
                status="failed", error="Syntax error: failed at position 1", before_start=True
            ),
        ],
        submit_raises=RuntimeError("Syntax error: failed at position 1"),
    )
    journal = _FakeJournalStore()
    lines: list[str] = []
    with pytest.raises(RuntimeError, match="Syntax error"):
        apply_async_statement(_input(client=client, journal=journal, log=lines.append))
    # The server recorded the failure, so the attempt is recorded failed
    # (#233): an edited file can then run again without --retry.
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "failed"]
    failed = journal.writes[2].operations[0]
    assert (failed.last_error, failed.attempt_fenced) == ("Syntax error: failed at position 1", True)
    # The submit error is the command's error; no progress line repeats it (#561).
    query_id = _submitted_query_id(client.submitted)
    assert lines == [
        f"  alter_table_modify_column: submitting async (query_id={query_id})",
        "  alter_table_modify_column: status unknown — still polling (elapsed 0s)",
    ]


@pytest.mark.parametrize("intent_fails", [False, True])
def test_async_intent_follows_started_write_and_precedes_unchanged_submit_id(
    intent_fails: bool,
) -> None:
    client = _ScriptedClient([
        QueryStatus(status="unknown"), QueryStatus(status="finished"),
    ])
    journal = _FakeJournalStore()
    tracker = MagicMock()
    recorded_ids: list[str] = []

    def record(_context: QueryContext, query_id: str) -> None:
        assert journal.state is not None
        assert journal.state.operations[0].status == "started"
        assert journal.state.operations[0].query_id == query_id
        assert client.submitted == []
        recorded_ids.append(query_id)
        if intent_fails:
            raise RuntimeError("intent unavailable")

    tracker.record_async.side_effect = record
    input_ = _input(client=client, journal=journal, query_tracker=tracker)
    if intent_fails:
        with pytest.raises(RuntimeError, match="intent unavailable"):
            apply_async_statement(input_)
        assert client.submitted == []
        assert journal.state is not None
        assert journal.state.operations[0].status == "started"
    else:
        apply_async_statement(input_)
        assert [query_id for _sql, query_id in client.submitted] == recorded_ids
    assert len(recorded_ids) == 1
    assert _UUID_SHAPE.match(recorded_ids[0])
    assert recorded_ids[0] != _QUERY_ID


@pytest.mark.parametrize("submit_fails", [True, False])
def test_apply_async_poll_budget_exhausted_names_submit_error(submit_fails: bool) -> None:
    """When polling gives up, the submit error is the only trace of e.g. a
    rejected statement, so the error names it (#561)."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),  # initial in-flight check
            *[RuntimeError("HTTP 502: bad gateway") for _ in range(21)],
        ],
        submit_raises=RuntimeError("Authentication failed") if submit_fails else None,
    )
    journal = _FakeJournalStore()
    with pytest.raises(MigrateError) as excinfo:
        apply_async_statement(_input(client=client, journal=journal))
    submit_tail = ", and the submit request failed (Authentication failed)" if submit_fails else ""
    assert excinfo.value.code == "async_outcome_unknown"
    assert (
        f"polling failed 21\u00d7 in a row (HTTP 502: bad gateway){submit_tail}. Nothing was "
        "submitted"
    ) in excinfo.value.message
    # The outcome is unknown, so the attempt stays started for a re-run to re-attach.
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started"]


def test_apply_async_submit_failing_while_query_runs_logs_poller_lines_only() -> None:
    """A gateway can fail the submit (e.g. HTTP 524) while the query keeps running.

    The poller decides the outcome, and the progress lines are the poller's
    only, as in TS (#561).
    """
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),  # initial in-flight check
            QueryStatus(status="running", written_rows=9, written_bytes=72),
            QueryStatus(status="finished", written_rows=16, written_bytes=128, duration_ms=8000),
        ],
        submit_raises=RuntimeError("HTTP 524: error code: 524"),
    )
    journal = _FakeJournalStore()
    lines: list[str] = []
    result = apply_async_statement(_input(client=client, journal=journal, log=lines.append))
    assert result.kind == "completed"
    assert len(client.submitted) == 1
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "completed"]
    assert lines == [
        f"  alter_table_modify_column: submitting async "
        f"(query_id={_submitted_query_id(client.submitted)})",
        "  alter_table_modify_column: written=9 rows (72 B), elapsed 0s",
        "  alter_table_modify_column: finished — written=16 rows (128 B) in 8s",
    ]


def test_apply_async_submit_failing_after_the_query_ran_waits_for_query_log() -> None:
    """After the 524, the query can end between two polls. A poll then finds it
    neither running nor yet in query_log (flushed on a timer). The server ran
    the query, so the submit error does not mean it failed (#657)."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),  # initial in-flight check
            QueryStatus(status="running", written_rows=9, written_bytes=72),
            QueryStatus(status="unknown"),
            QueryStatus(status="finished", written_rows=16, written_bytes=128, duration_ms=8000),
        ],
        submit_raises=RuntimeError("error code: 524"),
    )
    journal = _FakeJournalStore()
    lines: list[str] = []
    result = apply_async_statement(_input(client=client, journal=journal, log=lines.append))
    assert result.kind == "completed"
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "completed"]
    assert lines == [
        f"  alter_table_modify_column: submitting async "
        f"(query_id={_submitted_query_id(client.submitted)})",
        "  alter_table_modify_column: written=9 rows (72 B), elapsed 0s",
        "  alter_table_modify_column: status unknown — still polling (elapsed 0s)",
        "  alter_table_modify_column: finished — written=16 rows (128 B) in 8s",
    ]


@pytest.mark.parametrize("submit_fails", [True, False], ids=["524", "acknowledged"])
def test_apply_async_unknown_polls_past_the_budget_stop_with_async_outcome_unknown(
    submit_fails: bool,
) -> None:
    """#767 (round 2): a lost submit response is no evidence of failure. The
    poller keeps the fenced started record, reads every replica once more
    through a query_log flush, then stops with async_outcome_unknown."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),  # initial in-flight check
            QueryStatus(status="running", written_rows=9, written_bytes=72),
            *[QueryStatus(status="unknown") for _ in range(21)],
            # The final check of every replica, then 5 rechecks while query_log is flushed.
            *[QueryStatus(status="unknown") for _ in range(6)],
        ],
        submit_raises=RuntimeError("error code: 524") if submit_fails else None,
        strict=True,
    )
    journal = _FakeJournalStore()
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_input(client=client, journal=journal))
    tail = ", and the submit request failed (error code: 524)" if submit_fails else ""
    assert info.value.code == "async_outcome_unknown"
    assert (
        "chkit cannot tell whether it finished: polling found it neither running nor in "
        f"system.query_log 20\u00d7 in a row{tail}. Nothing was submitted"
    ) in info.value.message
    assert client.every_replica[-6:] == [True] * 6
    assert client.executed == []
    # The outcome is unknown, so the attempt stays started, fenced.
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started"]


def test_apply_async_an_attach_that_polls_unknown_past_the_budget_stops() -> None:
    """#767 (round 2): an attached attempt that disappears from
    system.processes without a query_log entry stops the run too, instead of
    polling forever."""
    attempt = _op("started").model_copy(
        update={
            "query_id": "0b7f9a52-3c1d-4e8f-9a6b-2d4c8e1f7a30",
            "last_error": _ATTEMPT_MARKER,
            "fingerprint": "v1:load",
            "attempt_fenced": True,
        }
    )
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="running", written_rows=1),
            *[QueryStatus(status="unknown") for _ in range(21 + 6)],
        ],
        strict=True,
    )
    journal = _FakeJournalStore(state=_state(attempt, checksum="abc"))
    with pytest.raises(MigrateError) as info:
        apply_async_statement(
            _input(client=client, journal=journal, migration_name="m.sql", fingerprint="v1:load")
        )
    assert info.value.code == "async_outcome_unknown"
    assert client.submitted == []
    assert journal.writes == []


class _OpenSubmitClient(_ScriptedClient):
    """Its submit request stays open until a poll sees the query end, as the
    HTTP request of a long load does. A submit that blocks the poller is never
    released and times out instead."""

    def __init__(
        self,
        statuses: list[QueryStatus | BaseException],
        *,
        submit_raises: BaseException | None = None,
    ) -> None:
        super().__init__(statuses, submit_raises=submit_raises)
        self.query_ended = threading.Event()
        self.submit_returned = threading.Event()

    def submit(
        self,
        statement: str,
        query_id: str | None = None,
        settings: dict[str, Any] | None = None,
        *,
        before_send: Any = None,
    ) -> str:
        self.submitted.append((statement, query_id))
        ended = self.query_ended.wait(timeout=5)
        self.events.append("submit returned" if ended else "submit timed out")
        self.submit_returned.set()
        if self._submit_raises is not None:
            raise self._submit_raises
        return query_id or "auto-id"

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        status = super().query_status(
            query_id,
            after_time=after_time,
            every_replica=every_replica,
            running_only=running_only,
        )
        if status.status in ("finished", "failed"):
            self.query_ended.set()
        return status


def test_apply_async_polls_while_the_submit_request_is_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The submit does not block: progress lines come while the load runs, as
    in TS, and the step returns once the outcome is journaled, without waiting
    for the request to close (#767, round 6)."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _: None)
    client = _OpenSubmitClient(
        statuses=[
            QueryStatus(status="unknown"),  # initial in-flight check
            QueryStatus(status="running", written_rows=4, written_bytes=32),
            QueryStatus(status="running", written_rows=9, written_bytes=72),
            QueryStatus(status="finished", written_rows=25, written_bytes=200, duration_ms=25000),
        ]
    )
    journal = _FakeJournalStore()
    lines: list[str] = []
    result = apply_async_statement(_input(client=client, journal=journal, log=lines.append))
    assert result.kind == "completed"
    assert lines == [
        f"  alter_table_modify_column: submitting async "
        f"(query_id={_submitted_query_id(client.submitted)})",
        "  alter_table_modify_column: written=4 rows (32 B), elapsed 0s",
        "  alter_table_modify_column: written=9 rows (72 B), elapsed 0s",
        "  alter_table_modify_column: finished — written=25 rows (200 B) in 25s",
    ]
    assert [event for event in client.events if event != "submit returned"] == [
        SERVER_TIME_QUERY,
        "status",
        "status",
        "status",
        "status",
    ]
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "completed"]


def test_apply_async_query_failing_while_the_submit_is_open_raises_the_polled_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The failure comes from query_log, as in TS; the submit error that
    follows it is not waited for (#767, round 6), nor raised."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _: None)
    client = _OpenSubmitClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="running", written_rows=4, written_bytes=32),
            QueryStatus(status="failed", error="Memory limit exceeded", before_start=True),
        ],
        submit_raises=RuntimeError("Memory limit exceeded (from the submit)"),
    )
    journal = _FakeJournalStore()
    with pytest.raises(RuntimeError) as excinfo:
        apply_async_statement(_input(client=client, journal=journal))
    assert str(excinfo.value) == (
        "Async migration step alter_table_modify_column failed "
        f"(query_id {_submitted_query_id(client.submitted)}): Memory limit exceeded"
    )
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "failed"]


def test_apply_async_interrupt_does_not_wait_for_the_open_submit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ctrl-C stops the poller at once; the load keeps running on the server
    and a re-run attaches to it."""
    sleeps: list[float] = []

    def interrupt_on_second_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise KeyboardInterrupt

    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", interrupt_on_second_sleep)
    client = _OpenSubmitClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="running", written_rows=4, written_bytes=32),
        ]
    )
    with pytest.raises(KeyboardInterrupt):
        apply_async_statement(_input(client=client, journal=_FakeJournalStore()))
    assert not client.submit_returned.is_set()
    client.query_ended.set()
    assert client.submit_returned.wait(timeout=5)


def _whole_seconds(after_time: str | None) -> int:
    if after_time is None:
        return 0
    if after_time.startswith("1970"):
        return 0
    return int(datetime.fromisoformat(after_time).timestamp())


class _QueryLogClient(_ScriptedClient):
    """Status answers like system.query_log: query_start_time >= bound, in seconds."""

    def __init__(self, phases: list[str], *, attached_start: int, earlier_start: int,
                 submit_raises: BaseException | None = None,
                 earlier_query_id: str | None = None,
                 rejected: str | None = None) -> None:
        super().__init__(statuses=[], submit_raises=submit_raises)
        # The ExceptionBeforeStart of a rejected submission under its own id.
        self._rejected = rejected
        self._phases = phases
        self._attached_start = attached_start
        self._earlier_start = earlier_start
        # The earlier attempt's id; any id when None.
        self._earlier_query_id = earlier_query_id

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        self.after_times.append(after_time)
        self.status_ids.append(query_id)
        self.every_replica.append(every_replica)
        phase = self._phases.pop(0) if self._phases else "flushed"
        if (
            self._rejected is not None
            and not running_only
            and query_id != self._earlier_query_id
        ):
            return QueryStatus(status="failed", error=self._rejected, before_start=True)
        if phase == "running":
            return QueryStatus(status="running", written_rows=1, elapsed_ms=RUNNING_ELAPSED_MS)
        after_sec = _whole_seconds(after_time)
        if phase == "flushed" and self._attached_start >= after_sec:
            return QueryStatus(status="failed", error="Memory limit exceeded")
        earlier = self._earlier_query_id in (None, query_id)
        if earlier and self._earlier_start >= after_sec:
            return QueryStatus(status="finished", written_rows=2, duration_ms=10)
        return QueryStatus(status="unknown")


@pytest.mark.parametrize("prior", ["none", "abandoned"])
def test_apply_async_new_submission_ignores_earlier_attempt(
    prior: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """query_log still holds an earlier attempt's QueryFinish under the id an
    earlier release gave a statement's first attempt, also after --abandon
    (#233). A submission that fails before it starts must not inherit it: its
    id is its own (#767)."""
    # The earlier attempt started one 5 s poll interval before this submission.
    stale_start = (SERVER_NOW_MS - 5_000) // 1000
    earlier = _op("failed").model_copy(update={"query_id": _QUERY_ID})
    client = _QueryLogClient(
        ["flush gap"] * 30,
        attached_start=0,
        earlier_start=stale_start,
        submit_raises=RuntimeError("Unknown table expression identifier 'default.src_typo'"),
        earlier_query_id=_QUERY_ID,
        rejected="Unknown table expression identifier 'default.src_typo'",
    )
    _advance_clock(monkeypatch, client)
    state = (
        None
        if prior == "none"
        else _state(
            earlier.model_copy(
                update={"last_error": "abandoned via chkit migrate --abandon (was completed)"}
            ),
            checksum="abc",
        ).model_copy(update={"name": "20260101_000000_async.sql"})
    )
    journal = _FakeJournalStore(state=state)
    with pytest.raises(RuntimeError, match="src_typo"):
        apply_async_statement(_input(client=client, journal=journal))
    # Every attempt polls an id of its own (#701, #767).
    poll = (client.status_ids[1], RETRY_BOUND)
    assert _UUID_SHAPE.match(poll[0])
    assert poll[0] != _QUERY_ID
    assert all(
        call == poll for call in zip(client.status_ids[1:], client.after_times[1:], strict=True)
    )
    assert journal.writes is not None
    # Recorded as a failed attempt, never as completed.
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "failed"]


# #556: TS prints the same lines for the same statuses (async-apply.test.ts
# has this table). JS toFixed rounds the double's exact value and takes the
# larger candidate on a tie; Math.round takes the one closer to +inf. Exact
# ties: 1.25, 1.125, 2.5, 0.5. Just below a decimal tie in binary: 1.15,
# 1.005, 2.675. Just above: 1.35.
_ROUNDING_CASES = [
    (999, 1000, 0, "999 rows (1000 B)", "999 rows (1000 B) in 0s"),
    (1000, 1024, 499, "1.0K rows (1.0 KiB)", "1.0K rows (1.0 KiB) in 0s"),
    (1005, 1029, 500, "1.0K rows (1.0 KiB)", "1.0K rows (1.0 KiB) in 1s"),
    (1050, 1075, 1499, "1.1K rows (1.0 KiB)", "1.1K rows (1.0 KiB) in 1s"),
    (1150, 1177, 1500, "1.1K rows (1.1 KiB)", "1.1K rows (1.1 KiB) in 2s"),
    (1250, 1280, 2500, "1.3K rows (1.3 KiB)", "1.3K rows (1.3 KiB) in 3s"),
    (1350, 3584, 3500, "1.4K rows (3.5 KiB)", "1.4K rows (3.5 KiB) in 4s"),
    (
        999_950, 1_048_575, 123_456_500,
        "1000.0K rows (1024.0 KiB)", "1000.0K rows (1024.0 KiB) in 123457s",
    ),
    (1_005_000, 1_310_720, 4500, "1.00M rows (1.3 MiB)", "1.00M rows (1.3 MiB) in 5s"),
    (
        1_125_000, 1_079_194_419, 5500,
        "1.13M rows (1.01 GiB)", "1.13M rows (1.01 GiB) in 6s",
    ),
    (
        2_675_000, 1_207_959_552, 6500,
        "2.67M rows (1.13 GiB)", "2.67M rows (1.13 GiB) in 7s",
    ),
    (1, 1, 1_000_000_500, "1 rows (1 B)", "1 rows (1 B) in 1000001s"),
    # UInt64 max: TS reads it as the nearest double, and String() prints the
    # rounded seconds in shortest form.
    (
        18_446_744_073_709_551_615, 18_446_744_073_709_551_615, 18_446_744_073_709_551_615,
        "18446744073709.55M rows (17179869184.00 GiB)",
        "18446744073709.55M rows (17179869184.00 GiB) in 18446744073709550s",
    ),
    # A tie only after the exact integer division; as a double it is just below.
    (1, 1, 36_028_797_018_964_500, "1 rows (1 B)", "1 rows (1 B) in 36028797018964s"),
]


@pytest.mark.parametrize(
    ("rows", "byte_count", "duration_ms", "progress", "finished"), _ROUNDING_CASES
)
def test_apply_async_progress_rounds_like_ts(
    rows: int, byte_count: int, duration_ms: int, progress: str, finished: str
) -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="running", written_rows=rows, written_bytes=byte_count),
            QueryStatus(
                status="finished",
                written_rows=rows,
                written_bytes=byte_count,
                duration_ms=duration_ms,
            ),
        ]
    )
    lines: list[str] = []
    apply_async_statement(
        _input(
            client=client,
            journal=_FakeJournalStore(),
            operation_type="load_table_data",
            log=lines.append,
        )
    )
    assert [line for line in lines if "written=" in line] == [
        f"  load_table_data: written={progress}, elapsed 0s",
        f"  load_table_data: finished — written={finished}",
    ]


def test_apply_async_progress_ignores_the_ambient_decimal_context() -> None:
    """User code may lower the precision or trap float conversions."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="running", written_rows=1_125_000, written_bytes=1280),
            QueryStatus(
                status="finished", written_rows=1_125_000, written_bytes=1280, duration_ms=2500
            ),
        ]
    )
    lines: list[str] = []
    with decimal.localcontext() as context:
        context.prec = 2
        context.traps[decimal.FloatOperation] = True
        context.traps[decimal.Inexact] = True
        apply_async_statement(
            _input(
                client=client,
                journal=_FakeJournalStore(),
                operation_type="load_table_data",
                log=lines.append,
            )
        )
    assert [line for line in lines if "written=" in line] == [
        "  load_table_data: written=1.13M rows (1.3 KiB), elapsed 0s",
        "  load_table_data: finished — written=1.13M rows (1.3 KiB) in 3s",
    ]


# ---------- recorded fingerprints (#599) ----------


def _abandoned_running(fingerprint: str) -> MigrationRowState:
    op = OperationState(
        operation_index=0,
        operation_key="table:db.t:column:x",
        operation_type="alter_table_modify_column",
        query_id=_QUERY_ID,
        status="failed",
        started_at="2026-05-26 11:00:00.000",
        finished_at="2026-05-26 11:00:01.000",
        last_error="abandoned via chkit migrate --abandon (was started)",
        fingerprint=fingerprint,
    )
    return MigrationRowState(
        name="20260101_000000_async.sql",
        applied_at="2026-01-01T00:00:10.000",
        checksum="abc",
        chkit_version="0.1",
        migration_completed=False,
        operations=[op],
    )


def test_apply_async_refuses_to_attach_to_a_running_attempt_of_other_sql() -> None:
    client = _ScriptedClient(
        statuses=[QueryStatus(status="running", elapsed_ms=RUNNING_ELAPSED_MS)]
    )
    journal = _FakeJournalStore(state=_abandoned_running("v1:old"))
    with pytest.raises(RuntimeError) as info:
        apply_async_statement(_input(client=client, journal=journal, fingerprint="v1:new"))
    assert (
        "an earlier attempt with different SQL is still running on the server. Wait for "
        f"it to finish or run KILL QUERY WHERE query_id = '{_QUERY_ID}'"
    ) in str(info.value)
    assert client.submitted == []
    assert journal.writes == []


def test_apply_async_refuses_to_skip_a_completed_record_of_other_sql() -> None:
    state = _abandoned_running("v1:old")
    completed = state.operations[0].model_copy(update={"status": "completed", "last_error": ""})
    journal = _FakeJournalStore(state=state.model_copy(update={"operations": [completed]}))
    with pytest.raises(MigrateError) as info:
        apply_async_statement(
            _input(client=_ScriptedClient(statuses=[]), journal=journal, fingerprint="v1:new")
        )
    assert info.value.code == "statement_split_changed"


# ---------- #672: re-run of a step left started ----------
#
# A run can leave a step started after its load finished on the server: the
# poll budget ran out after a failed submit, or the run was killed before it
# journaled the outcome. A re-run reads that attempt's outcome before it
# compensates and resubmits, when the record is fenced (#767). Same cases as
# async-apply.test.ts.

_RERUN_QUERY_ID = make_deterministic_query_id(SERVER_DATABASE, "_chkit_migrations", "m.sql", 0)
# The random id this release recorded for an attempt before its submit.
_OWN_ID = "0b7f9a52-3c1d-4e8f-9a6b-2d4c8e1f7a30"
# The record's start minus the hour that only lets query_log prune.
_RECORD_BOUND = "2026-05-26T09:00:00.000Z"
# A started attempt without a query_log entry: the check, then 5 rechecks
# while query_log is flushed (#701).
_NO_ENTRY_CHECKS = [QueryStatus(status="unknown") for _ in range(6)]
_NO_ENTRY_REASON = (
    "system.query_log has no entry for its query id (query logging is off for the user, "
    "query_log is flushed later than chkit waits, or the run stopped before it submitted "
    "the statement)"
)
_UNVERIFIED_REASON = (
    "the journal records it as failed, but not from a rejection the server recorded before "
    "it started (an earlier chkit release recorded it, it failed while it ran, or a run lost "
    "its submit response), so some of its writes may have been applied"
)
_WHILE_PROCESSING_REASON = (
    "the server reports it failed while it ran (ExceptionWhileProcessing), and a statement "
    "that fails while it runs can leave some of its writes applied (parts of an INSERT ... "
    "SELECT, a DDL that ran on some hosts)"
)
_STALE_PREPARED_REASON = (
    "the journal records it as prepared, not sent, but chkit cannot read every copy of the "
    "journal to rule out a newer record of it (one that may have been sent)"
)
_UNFENCED_REASON = (
    "an earlier chkit release recorded it, or the journal could not store the record's "
    "fence (it has no operation_fingerprints column), so its query id may name earlier "
    "attempts too"
)


def _outcome_unknown(query_id: str, reason: str) -> str:
    return (
        "Async migration step alter_table_modify_column (statement 1 of m.sql, query_id "
        f"{query_id}): the journal records an attempt of it and no replica runs it, but "
        f"chkit cannot tell whether it finished: {reason}. Nothing was submitted and no "
        "before-retry SQL ran. Check in ClickHouse whether the statement's rows reached its "
        "target. Then reconcile every statement of m.sql that already ran, since an abandon "
        "runs the migration again from statement 1, run chkit migrate --apply --abandon "
        "m.sql, and apply again."
    )


def _iso_ms(ms: int) -> str:
    return iso_without_zone(datetime.fromtimestamp(ms / 1000, tz=UTC))


def _started_record(**overrides: Any) -> MigrationRowState:
    op = _op("started").model_copy(
        update={
            "query_id": _OWN_ID,
            "started_at": "2026-05-26 10:00:00.000",
            "fingerprint": "v1:load",
            "last_error": _ATTEMPT_MARKER,
            "attempt_fenced": True,
            **overrides,
        }
    )
    return _state(op, checksum="abc")


def _rerun_input(client: Any, journal: Any, **overrides: Any) -> AsyncApplyInput:
    values: dict[str, Any] = {
        "migration_name": "m.sql",
        "fingerprint": "v1:load",
        "before_retry": "TRUNCATE TABLE db.t",
        **overrides,
    }
    return _input(client=client, journal=journal, **values)


def _advance_clock(monkeypatch: pytest.MonkeyPatch, client: Any) -> list[float]:
    """The run's sleeps advance the client's server clock, as the real one does."""
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        _wait_for_submit(seconds)
        sleeps.append(seconds)
        client.now_ms += round(seconds * 1000)

    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", sleep)
    return sleeps


def test_rerun_after_the_poll_budget_finds_the_finished_attempt() -> None:
    journal = _FakeJournalStore()
    # Run 1: the submit fails with a gateway timeout, a poll sees the load
    # running, then query_log has no outcome for 21 polls.
    first = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="running", written_rows=9, written_bytes=72),
            *[QueryStatus(status="unknown") for _ in range(21 + 6)],
        ],
        submit_raises=RuntimeError("error code: 524"),
    )
    with pytest.raises(MigrateError, match=r"cannot tell whether it finished"):
        apply_async_statement(_rerun_input(first, journal))
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started"]
    query_id = _submitted_query_id(first.submitted)
    started = journal.writes[1].operations[0]
    # The attempt's start is recorded on the server clock, fenced, under the submitted id.
    assert (started.query_id, started.started_at, started.last_error, started.attempt_fenced) == (
        query_id, _iso_ms(SERVER_NOW_MS), _ATTEMPT_MARKER, True
    )

    # Run 2: the load is no longer running and query_log has its QueryFinish.
    second = _ScriptedClient(
        statuses=[
            QueryStatus(status="finished", written_rows=16, written_bytes=128, duration_ms=8000)
        ],
        strict=True,
    )
    lines: list[str] = []
    result = apply_async_statement(_rerun_input(second, journal, log=lines.append))

    assert result.kind == "completed"
    assert second.executed == []
    assert second.submitted == []
    # One read of every replica, of the recorded id only.
    assert second.status_ids == [query_id]
    assert second.after_times == [RETRY_BOUND]
    assert second.every_replica == [True]
    assert second.running_only == [False]
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "completed"]
    completed = journal.writes[2].operations[0]
    assert (completed.query_id, completed.started_at, completed.fingerprint) == (
        query_id, _iso_ms(SERVER_NOW_MS), "v1:load"
    )
    assert completed.last_error == ""
    assert lines == [
        f"  alter_table_modify_column: previous attempt of query_id={query_id} finished on "
        "the server — written=16 rows (128 B) in 8s, recording it as completed"
    ]


def test_rerun_of_a_started_attempt_that_failed_on_the_server_resubmits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(
                status="failed",
                error="Code: 60. DB::Exception: Unknown table\nstack",
                before_start=True,
            ),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=_started_record())
    lines: list[str] = []
    result = apply_async_statement(_rerun_input(client, journal, log=lines.append))

    assert result.kind == "completed"
    assert (client.status_ids[0], client.after_times[0], client.every_replica[0]) == (
        _OWN_ID, _RECORD_BOUND, True
    )
    assert client.executed == ["TRUNCATE TABLE db.t"]
    retry_id = _submitted_query_id(client.submitted)
    assert retry_id != _OWN_ID
    assert lines[0] == (
        f"  alter_table_modify_column: previous attempt of query_id={_OWN_ID} is no longer "
        "running (status=failed: Code: 60. DB::Exception: Unknown table) — running "
        f"before-retry then resubmitting as query_id={retry_id}"
    )
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["failed", "started", "started", "completed"]
    failed = journal.writes[0].operations[0]
    assert (failed.last_error, failed.attempt_fenced) == (
        "Code: 60. DB::Exception: Unknown table\nstack", True
    )


def test_rerun_of_a_started_attempt_that_failed_while_it_ran_stops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#767 (round 3): a failure while it ran (ExceptionWhileProcessing) can
    leave rows applied, so it stops the re-run like a missing outcome."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="failed", error="Code: 241. DB::Exception: Memory limit exceeded")
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=_started_record())
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_rerun_input(client, journal))
    assert info.value.code == "async_outcome_unknown"
    assert info.value.message == _outcome_unknown(_OWN_ID, _WHILE_PROCESSING_REASON)
    assert client.executed == []
    assert client.submitted == []
    assert journal.writes == []


@pytest.mark.parametrize("before_retry", ["TRUNCATE TABLE db.t", None], ids=["with", "without"])
def test_a_fenced_started_attempt_without_a_query_log_entry_stops(
    before_retry: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (Codex review of #770, 770b): an attempt with no evidence may have
    finished (query logging off, a late flush) or never been submitted. Its
    record stays as it is, and nothing is compensated or submitted, with or
    without before-retry SQL."""
    client = _ScriptedClient(statuses=list(_NO_ENTRY_CHECKS), strict=True)
    sleeps = _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=_started_record())
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_rerun_input(client, journal, before_retry=before_retry))
    assert info.value.code == "async_outcome_unknown"
    assert info.value.message == _outcome_unknown(_OWN_ID, _NO_ENTRY_REASON)
    # Checked once, then 5 times 2 s apart while query_log is flushed (#701).
    assert client.status_ids == [_OWN_ID] * 6
    assert client.after_times == [_RECORD_BOUND] * 6
    assert client.every_replica == [True] * 6
    assert sleeps == [2.0] * 5
    assert client.executed == []
    assert client.submitted == []
    assert journal.writes == []


def test_after_async_outcome_unknown_an_abandon_lets_the_next_apply_submit_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The stop leaves a way out: abandon, then apply, which compensates and submits once."""
    journal = _FakeJournalStore(state=_started_record())
    with pytest.raises(MigrateError) as info:
        apply_async_statement(
            _rerun_input(_ScriptedClient(statuses=list(_NO_ENTRY_CHECKS), strict=True), journal)
        )
    assert info.value.code == "async_outcome_unknown"
    assert journal.state is not None
    abandon_migration_state(journal.state, journal_store=journal)

    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    result = apply_async_statement(_rerun_input(client, journal))

    assert result.kind == "completed"
    assert (client.status_ids[0], client.after_times[0], client.running_only[0]) == (
        _OWN_ID, None, True
    )
    assert client.executed == ["TRUNCATE TABLE db.t"]
    assert len(client.submitted) == 1


class _LostResponseClient(_ScriptedClient):
    """Its before-retry SQL runs on the server, but the response is lost."""

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        super().execute(statement, settings)
        msg = "socket hang up"
        raise RuntimeError(msg)


def test_rerun_after_a_compensation_that_stopped_the_run_compensates_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The attempt's QueryFinish can reach query_log only after the check (it
    is flushed on a timer). A run that stops after the compensation, before it
    journals the new attempt, must leave a record whose QueryFinish a re-run
    does not take for the outcome: the rows it loaded were truncated."""
    journal = _FakeJournalStore(state=_started_record())
    # Run 1: the attempt failed; the TRUNCATE ran, but its response was lost.
    first = _LostResponseClient(
        statuses=[QueryStatus(status="failed", error="boom", before_start=True)], strict=True
    )
    with pytest.raises(RuntimeError, match="socket hang up"):
        apply_async_statement(_rerun_input(first, journal))
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["failed"]

    # Run 2: query_log would now answer for the id, but a failed record is
    # checked in system.processes only.
    second = _ScriptedClient(
        statuses=[
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, second)
    apply_async_statement(_rerun_input(second, journal))

    assert second.every_replica[0] is True
    assert second.running_only[0] is True
    assert second.executed == ["TRUNCATE TABLE db.t"]
    assert len(second.submitted) == 1


class _KilledBeforeSubmitJournal(_FakeJournalStore):
    """The run stops after it journaled its attempt, before the submit leaves."""

    def read_stored_operation(self, name: str, index: int) -> OperationState | None:
        assert self.writes is not None
        # Once the attempt moved to "may have been sent", before its submit.
        if any(
            op.last_error == _ATTEMPT_MARKER for w in self.writes for op in w.operations
        ):
            msg = "killed"
            raise KeyboardInterrupt(msg)
        return super().read_stored_operation(name, index)


class _FinishedIdClient(_ScriptedClient):
    """query_log holds a QueryFinish of one id only; other ids answer as scripted."""

    def __init__(self, finished_query_id: str, statuses: list[QueryStatus | BaseException]) -> None:
        super().__init__(statuses=statuses, strict=True)
        self._finished_query_id = finished_query_id

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        answer = super().query_status(
            query_id, after_time=after_time, every_replica=every_replica, running_only=running_only
        )
        if query_id == self._finished_query_id:
            return QueryStatus(status="finished", written_rows=0, duration_ms=10)
        return answer


def test_a_rerun_never_takes_an_earlier_attempts_finish_for_an_attempt_killed_before_submit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#701, #767: every attempt submits under an id of its own, so a re-run
    never takes an earlier attempt's QueryFinish for a later attempt's
    outcome. A run killed between its journal write and its submit leaves an
    attempt without evidence, which stops the re-run."""
    journal = _KilledBeforeSubmitJournal()
    first = _ScriptedClient(statuses=[QueryStatus(status="unknown")], strict=True)
    with pytest.raises(KeyboardInterrupt, match="killed"):
        apply_async_statement(_rerun_input(first, journal))
    assert first.submitted == []
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started"]
    recorded_id = journal.writes[0].operations[0].query_id
    assert _UUID_SHAPE.match(recorded_id)
    assert recorded_id != _RERUN_QUERY_ID

    # query_log holds an earlier attempt's QueryFinish under the statement's
    # earlier first id, and nothing of the recorded id.
    rerun = _FinishedIdClient(_RERUN_QUERY_ID, list(_NO_ENTRY_CHECKS))
    _advance_clock(monkeypatch, rerun)
    plain = _FakeJournalStore(state=journal.state)
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_rerun_input(rerun, plain))
    assert info.value.code == "async_outcome_unknown"
    assert info.value.message == _outcome_unknown(recorded_id, _NO_ENTRY_REASON)
    assert set(rerun.status_ids) == {recorded_id}
    assert rerun.executed == []
    assert rerun.submitted == []
    assert plain.writes == []


def test_a_rerun_never_takes_a_concurrent_runs_finished_retry_for_its_own_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Codex review of #701: two runs that read the same failed record. Run A
    retries and records its attempt completed; run B, delayed after its check,
    compensates (deleting A's rows), journals its own attempt and stops before
    its submit. A re-run must not take A's QueryFinish for B's attempt: each
    run's retry has an id no other run submits."""
    failed = _started_record(
        status="failed", finished_at="2026-05-26 10:05:00.000", last_error="boom"
    )
    run_a = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, run_a)
    apply_async_statement(_rerun_input(run_a, _FakeJournalStore(state=failed)))
    run_a_query_id = _submitted_query_id(run_a.submitted)
    # Run B read the same failed record.
    journal_b = _KilledBeforeSubmitJournal(state=failed)
    run_b = _ScriptedClient(statuses=[QueryStatus(status="unknown")], strict=True)
    with pytest.raises(KeyboardInterrupt, match="killed"):
        apply_async_statement(_rerun_input(run_b, journal_b))
    assert run_b.executed == ["TRUNCATE TABLE db.t"]
    assert journal_b.writes is not None
    run_b_record = journal_b.writes[-1].operations[0]
    assert run_b_record.status == "started"
    assert run_b_record.query_id != run_a_query_id

    # The re-run: query_log has run A's QueryFinish only.
    rerun = _FinishedIdClient(run_a_query_id, list(_NO_ENTRY_CHECKS))
    _advance_clock(monkeypatch, rerun)
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_rerun_input(rerun, _FakeJournalStore(state=journal_b.state)))
    assert info.value.code == "async_outcome_unknown"
    assert rerun.executed == []
    assert rerun.submitted == []


# #767: a started record without the fence names an id that earlier attempts
# may share (a first attempt's deterministic id, or an id an older release
# reused for every attempt), or one an older release may have compensated
# without recording it (a #701 retry id, then a TRUNCATE by a release that did
# not know the marker). Its QueryFinish is never taken for the outcome, and
# before-retry SQL cannot tell whether the rows landed either, so the run stops
# before it writes or runs anything.
_LEGACY_RECORDS: list[tuple[str, dict[str, Any], bool]] = [
    (
        "before-672",
        {"query_id": _RERUN_QUERY_ID, "last_error": "", "fingerprint": "", "attempt_fenced": False},
        True,
    ),
    ("672", {"query_id": _RERUN_QUERY_ID, "last_error": "submitted; a retry reads its outcome from system.query_log", "attempt_fenced": False}, True),
    ("701-first-id", {"query_id": _RERUN_QUERY_ID, "attempt_fenced": False}, True),
    ("701-retry-id", {"attempt_fenced": False}, True),
    ("no-fingerprint-column", {"fingerprint": ""}, False),
]


@pytest.mark.parametrize("before_retry", ["TRUNCATE TABLE db.t", None], ids=["with", "without"])
@pytest.mark.parametrize(
    ("overrides", "fingerprints"),
    [(overrides, fingerprints) for _label, overrides, fingerprints in _LEGACY_RECORDS],
    ids=[label for label, _overrides, _fingerprints in _LEGACY_RECORDS],
)
def test_an_unfenced_started_record_is_checked_in_processes_only_and_stops(
    overrides: dict[str, Any], fingerprints: bool, before_retry: str | None
) -> None:
    # query_log would answer QueryFinish for any id.
    client = _ScriptedClient(
        statuses=[QueryStatus(status="finished", written_rows=16, duration_ms=8000)], strict=True
    )
    journal = _FakeJournalStore(fingerprints=fingerprints)
    journal.write_migration_state(_started_record(**overrides))
    assert journal.writes is not None
    journal.writes.clear()
    assert journal.state is not None
    query_id = journal.state.operations[0].query_id
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_rerun_input(client, journal, before_retry=before_retry))
    assert info.value.code == "async_outcome_unknown"
    assert info.value.message == _outcome_unknown(query_id, _UNFENCED_REASON)
    assert client.status_ids == [query_id]
    assert client.after_times == [None]
    assert client.running_only == [True]
    assert client.every_replica == [True]
    assert client.executed == []
    assert client.submitted == []
    assert journal.writes == []


def test_a_started_attempt_that_a_recheck_finds_running_is_attached_to(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fenced attempt that a recheck finds running (its submit reached the
    server late) is attached to, not resubmitted."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="running", written_rows=5, elapsed_ms=1_000),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    result = apply_async_statement(
        _rerun_input(client, _FakeJournalStore(state=_started_record()))
    )
    assert result.kind == "completed"
    assert client.executed == []
    assert client.submitted == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"status": "failed", "finished_at": "2026-05-26 10:05:00.000", "last_error": "boom"},
        {"query_id": ""},
    ],
    ids=["failed-attempt", "no-query-id"],
)
def test_rerun_reads_system_processes_only_for(overrides: dict[str, Any]) -> None:
    """Only a started attempt can have finished unseen: a failed one has its
    outcome, and a sync record never ran under this id."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    apply_async_statement(
        _rerun_input(
            client, _FakeJournalStore(state=_started_record(**overrides)), before_retry=None
        )
    )
    assert client.after_times[0] is None
    assert client.running_only[0] is True
    assert len(client.submitted) == 1


def test_an_attach_leaves_the_fenced_record_and_a_rerun_records_its_finish() -> None:
    """#767 (770b): an attach writes nothing before the outcome, so a run
    killed while it polls leaves the fenced record as it was, and a re-run
    reads the same id with the same bound."""
    journal = _FakeJournalStore(state=_started_record())
    first = _ScriptedClient(
        statuses=[
            QueryStatus(status="running", written_rows=5),
            *[RuntimeError("HTTP 502: bad gateway") for _ in range(21)],
        ]
    )
    with pytest.raises(MigrateError, match="polling failed 21\u00d7"):
        apply_async_statement(_rerun_input(first, journal, before_retry=None))
    assert journal.writes == []
    assert set(first.status_ids[1:]) == {_OWN_ID}
    assert set(first.after_times[1:]) == {_RECORD_BOUND}

    second = _ScriptedClient(
        statuses=[QueryStatus(status="finished", written_rows=16, duration_ms=8000)], strict=True
    )
    result = apply_async_statement(_rerun_input(second, journal, before_retry=None))
    assert result.kind == "completed"
    assert second.status_ids == [_OWN_ID]
    assert second.after_times == [_RECORD_BOUND]
    assert second.submitted == []


def test_a_user_that_cannot_read_query_log_is_told_which_grant_it_lacks() -> None:
    client = _ScriptedClient(
        statuses=[
            RuntimeError(
                "Code: 497. DB::Exception: default: Not enough privileges. To execute this "
                "query, it's necessary to have the grant SELECT(type, query_id) ON "
                "system.query_log. (ACCESS_DENIED)"
            )
        ]
    )
    journal = _FakeJournalStore(state=_started_record())
    with pytest.raises(RuntimeError) as raised:
        apply_async_statement(_rerun_input(client, journal))
    message = str(raised.value)
    assert message.startswith(
        "Async migration step alter_table_modify_column (query_id "
        f"{_OWN_ID}): the ClickHouse user cannot read system.query_log, which tells whether "
        "the previous attempt finished (Code: 497."
    )
    assert message.endswith(
        "). Nothing was resubmitted and no before-retry SQL ran. Grant SELECT ON "
        "system.query_log to the user; until then a re-run of `chkit migrate --apply` stops "
        "here too."
    )
    assert client.submitted == []
    assert client.executed == []
    assert journal.writes == []


@pytest.mark.parametrize(
    "started_at", ["2026-05-26T10:00:00.000Z", "2026-05-26T12:00:00.000+02:00"], ids=["Z", "+02:00"]
)
def test_rerun_reads_a_zoned_start_time_with_that_zone(started_at: str) -> None:
    client = _ScriptedClient(
        statuses=[QueryStatus(status="finished", written_rows=16, duration_ms=8000)]
    )
    apply_async_statement(
        _rerun_input(client, _FakeJournalStore(state=_started_record(started_at=started_at)))
    )
    assert client.after_times[0] == _RECORD_BOUND


def test_a_rerun_before_query_log_has_the_finished_attempt_waits_for_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#701: query_log is flushed on a timer (7.5 s by default), so a re-run
    right after the attempt ended can find it neither running nor in query_log."""
    journal = _FakeJournalStore()
    first = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="running", written_rows=9, written_bytes=72),
            *[RuntimeError("HTTP 502: bad gateway") for _ in range(21)],
        ]
    )
    with pytest.raises(MigrateError, match="polling failed 21\u00d7"):
        apply_async_statement(_rerun_input(first, journal))

    # Run 2: the load ended; its QueryFinish reaches query_log on the third check.
    second = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="unknown"),
            QueryStatus(status="finished", written_rows=16, written_bytes=128, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, second)
    result = apply_async_statement(_rerun_input(second, journal))

    assert result.kind == "completed"
    assert second.executed == []
    assert second.submitted == []
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "completed"]


class _SkewedReplicaClient(_ScriptedClient):
    """query_log holds the attempt's QueryFinish, stamped 3 s behind its recorded start."""

    def __init__(self, attempt_query_id: str, entry_start_sec: int) -> None:
        super().__init__(statuses=[])
        self._attempt_query_id = attempt_query_id
        self._entry_start_sec = entry_start_sec

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        # A resubmission's own load finishes at once.
        if self.submitted:
            return QueryStatus(status="finished", written_rows=16, duration_ms=1)
        if running_only or query_id != self._attempt_query_id:
            return QueryStatus(status="unknown")
        if self._entry_start_sec >= _whole_seconds(after_time):
            return QueryStatus(status="finished", written_rows=16, duration_ms=8000)
        return QueryStatus(status="unknown")


def test_a_rerun_finds_a_retried_attempt_that_ran_on_a_replica_3s_behind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#701: a retried attempt that ran on a replica whose clock is 3 s behind
    the one that gave its recorded start."""
    journal = _FakeJournalStore(
        state=_started_record(
            status="failed", finished_at="2026-05-26 10:05:00.000", last_error="boom"
        )
    )
    # Run 1 retries and stops while it polls.
    first = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            *[RuntimeError("HTTP 502: bad gateway") for _ in range(21)],
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, first)
    with pytest.raises(MigrateError, match="polling failed 21\u00d7"):
        apply_async_statement(_rerun_input(first, journal))
    assert journal.writes is not None
    retried = journal.writes[-1].operations[0]
    assert retried.status == "started"
    started = datetime.fromisoformat(retried.started_at).replace(tzinfo=UTC)
    entry_start_sec = int(started.timestamp()) - 3

    # Run 2: query_log has the attempt's QueryFinish, stamped 3 s behind.
    second = _SkewedReplicaClient(retried.query_id, entry_start_sec)
    second.now_ms = SERVER_NOW_MS + 60_000
    _advance_clock(monkeypatch, second)
    result = apply_async_statement(_rerun_input(second, journal))

    assert second.submitted == []
    assert result.kind == "completed"
    assert journal.writes[-1].operations[0].status == "completed"
    assert journal.writes[-1].operations[0].query_id == retried.query_id


class _EarlierFinishClient(_ScriptedClient):
    """query_log holds an earlier attempt's QueryFinish of the deterministic id; the submit is rejected."""

    def __init__(self) -> None:
        super().__init__(statuses=[], submit_raises=RuntimeError("Code: 60. UNKNOWN_TABLE"))
        self.polled: list[str] = []

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        if running_only:
            return QueryStatus(status="unknown")
        self.polled.append(query_id)
        if query_id == _RERUN_QUERY_ID:
            return QueryStatus(status="finished", written_rows=2, duration_ms=10)
        # The rejected submission's ExceptionBeforeStart under its own id.
        return QueryStatus(status="failed", error="Code: 60. UNKNOWN_TABLE", before_start=True)


class _SlowJournalStore(_FakeJournalStore):
    """Each write and read takes 6 s of the client's server clock."""

    client: Any = None

    def write_migration_state(self, state: MigrationRowState) -> None:
        self.client.now_ms += 6_000
        super().write_migration_state(state)

    def read_migration_state(self, name: str) -> MigrationRowState | None:
        self.client.now_ms += 6_000
        return super().read_migration_state(name)

    def read_stored_operation(self, name: str, index: int) -> OperationState | None:
        self.client.now_ms += 6_000
        return super().read_stored_operation(name, index)


def test_a_first_attempts_polls_ignore_an_earlier_attempt_of_the_deterministic_id() -> None:
    """#767 (Codex review of #770, 770d): an earlier attempt finished under the
    statement's deterministic first id, and the journal writes before this
    submission were slow. The submission is rejected; its polls read its own
    id only, so the earlier QueryFinish is never taken for its outcome."""
    client = _EarlierFinishClient()
    journal = _SlowJournalStore()
    journal.client = client
    with pytest.raises(RuntimeError, match="UNKNOWN_TABLE"):
        apply_async_statement(_rerun_input(client, journal, before_retry=None))
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "failed"]
    assert client.polled
    assert _RERUN_QUERY_ID not in client.polled


class _DroppingJournalStore(_FakeJournalStore):
    """A journal whose writes do not reach it."""

    def write_migration_state(self, state: MigrationRowState) -> None:
        pass


def test_an_attempt_the_journal_does_not_return_after_its_started_write_is_not_submitted() -> None:
    """The random id is known only to the journal, so it is never submitted
    when the journal does not return the started record (#767)."""
    client = _ScriptedClient(statuses=[QueryStatus(status="unknown")], strict=True)
    with pytest.raises(
        RuntimeError,
        match="the journal did not return the attempt's record, so it was not submitted",
    ):
        apply_async_statement(_rerun_input(client, _DroppingJournalStore()))
    assert client.submitted == []


@pytest.mark.parametrize(
    "last_error",
    ["no longer running and no outcome in system.query_log; retried", "error code: 524"],
    ids=["721-no-outcome", "lost-response"],
)
def test_an_unverified_failed_record_stops_with_async_outcome_unknown(last_error: str) -> None:
    """#767 (round 2): a failed record that no server rejection or abandon
    recorded may have finished. It is checked in system.processes only and
    stops the run before anything is written or run."""
    client = _ScriptedClient(
        statuses=[QueryStatus(status="finished", written_rows=16, duration_ms=8000)], strict=True
    )
    journal = _FakeJournalStore(
        state=_started_record(
            status="failed",
            finished_at="2026-05-26 10:05:00.000",
            last_error=last_error,
            attempt_fenced=False,
        )
    )
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_rerun_input(client, journal))
    assert info.value.code == "async_outcome_unknown"
    assert info.value.message == _outcome_unknown(_OWN_ID, _UNVERIFIED_REASON)
    assert (client.status_ids, client.running_only) == ([_OWN_ID], [True])
    assert client.executed == []
    assert client.submitted == []
    assert journal.writes == []


def test_a_lost_submit_response_is_no_failure_the_polls_find_the_committed_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#767 (round 2): the submit's response is lost after the INSERT
    committed, and the first polls run before query_log has its QueryFinish.
    The attempt is never journaled failed, so nothing is compensated or
    submitted again: the polls find the QueryFinish."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="unknown"),
            QueryStatus(status="unknown"),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        submit_raises=RuntimeError("HTTP 524 after commit"),
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore()
    result = apply_async_statement(_rerun_input(client, journal))
    assert result.kind == "completed"
    assert len(client.submitted) == 1
    assert client.executed == []
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started", "completed"]


def test_an_attempt_the_journal_stores_without_its_fence_is_not_submitted() -> None:
    """#767 (round 2): a journal that cannot store the fence gets no submit."""
    client = _ScriptedClient(statuses=[QueryStatus(status="unknown")], strict=True)
    journal = _FakeJournalStore(fingerprints=False)
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_rerun_input(client, journal))
    assert info.value.code == "async_attempt_unfenced"
    assert "ADD COLUMN IF NOT EXISTS operation_fingerprints Array(String)" in info.value.message
    assert client.submitted == []


class _NeverSettlingSubmitClient(_ScriptedClient):
    """Its submit request never settles, as a proxy holding the socket open."""

    def __init__(self, statuses: list[QueryStatus | BaseException]) -> None:
        super().__init__(statuses=statuses, strict=True)
        self.release = threading.Event()

    def submit(
        self,
        statement: str,
        query_id: str | None = None,
        settings: dict[str, Any] | None = None,
        *,
        before_send: Any = None,
    ) -> str:
        if before_send is not None:
            before_send()
            before_send.commit()
        self.submitted.append((statement, query_id))
        self.release.wait(timeout=30)
        return query_id or "auto-id"


def test_a_submit_that_never_settles_does_not_keep_the_run_waiting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#767 (round 3): after the final check the run stops with
    async_outcome_unknown without waiting for the submit, so the migrate lock
    is released; the check starts at the 20th unknown poll."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _s: None)
    client = _NeverSettlingSubmitClient(
        [QueryStatus(status="unknown") for _ in range(1 + 20 + 6)]
    )
    journal = _FakeJournalStore()
    started = time.monotonic()
    try:
        with pytest.raises(MigrateError) as info:
            apply_async_statement(_input(client=client, journal=journal))
    finally:
        client.release.set()
    assert time.monotonic() - started < 10
    assert info.value.code == "async_outcome_unknown"
    assert "20\u00d7 in a row" in info.value.message
    # The check before the submit, 20 polls, then the final check and 5 rechecks.
    assert len(client.status_ids) == 1 + 20 + 6
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "started"]


def test_a_submission_given_up_before_it_is_sent_never_starts() -> None:
    """#767 (round 3): a request not sent when the run gave up never starts."""
    sent: list[str] = []

    def submit(before_send: Any) -> None:
        release.wait(timeout=5)
        before_send()
        sent.append("sent")

    release = threading.Event()
    submission = migrate_async_apply._Submission(submit)
    submission.abandon()
    release.set()
    assert submission.wait() is not None
    assert sent == []


def test_a_failed_poll_request_resets_the_unknown_poll_count() -> None:
    """#767 (round 3): only unknown polls in a row count; a failed poll
    request starts the count again."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            *[QueryStatus(status="unknown") for _ in range(19)],
            RuntimeError("HTTP 502: bad gateway"),
            *[QueryStatus(status="unknown") for _ in range(19)],
            QueryStatus(status="finished", written_rows=1, duration_ms=10),
        ],
        strict=True,
    )
    result = apply_async_statement(_input(client=client, journal=_FakeJournalStore()))
    assert result.kind == "completed"
    # No final check of every replica: the in-flight check alone reads them all.
    assert client.every_replica.count(True) == 1


def test_a_run_without_the_migrate_lock_stops_before_an_async_statement() -> None:
    """#767 (round 3): a run that holds no migrate lock (the target database
    did not exist when it started) never submits an async statement."""
    client = _ScriptedClient(statuses=[QueryStatus(status="unknown")], strict=True)
    journal = _FakeJournalStore()
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_input(client=client, journal=journal, lockless_bootstrap=True))
    assert info.value.code == "async_needs_lock"
    assert "Run chkit migrate --apply again" in info.value.message
    assert client.submitted == []
    assert journal.writes == []


class _LaggingJournal(_FakeJournalStore):
    """Its server read-back misses the record until ``lag`` is cleared."""

    lag: bool = True

    def read_stored_operation(self, name: str, index: int) -> OperationState | None:
        return None if self.lag else super().read_stored_operation(name, index)


def test_an_attempt_whose_read_back_lags_stays_prepared_and_the_next_run_submits_it_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#767 (round 3): a read-back that lags keeps the attempt prepared, never
    sent, so the next run runs it again without an abandon."""
    first = _ScriptedClient(statuses=[QueryStatus(status="unknown")], strict=True)
    sleeps = _advance_clock(monkeypatch, first)
    journal = _LaggingJournal()
    with pytest.raises(RuntimeError, match="an attempt that was never sent runs again"):
        apply_async_statement(_rerun_input(first, journal))
    assert first.submitted == []
    assert sleeps == [1.0] * 4
    assert journal.writes is not None
    assert [w.operations[0].last_error for w in journal.writes] == [_PREPARED_MARKER]
    prepared_id = journal.writes[0].operations[0].query_id

    journal.lag = False
    second = _ScriptedClient(
        statuses=[
            *_NO_ENTRY_CHECKS,
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, second)
    result = apply_async_statement(_rerun_input(second, journal))
    assert result.kind == "completed"
    # The prepared id is looked up on every replica first: nothing of it.
    assert set(second.status_ids[:6]) == {prepared_id}
    assert second.every_replica[:6] == [True] * 6
    assert len(second.submitted) == 1
    assert second.submitted[0][1] != prepared_id
    # #767 (round 4): it ran nothing, so no before-retry SQL runs.
    assert second.executed == []


class _FlakyReadJournal(_FakeJournalStore):
    """Its first read-backs fail as a gateway error."""

    failures: int = 2

    def read_stored_operation(self, name: str, index: int) -> OperationState | None:
        if self.failures > 0:
            self.failures -= 1
            msg = "HTTP 502: bad gateway"
            raise RuntimeError(msg)
        return super().read_stored_operation(name, index)


def test_a_read_back_that_fails_is_tried_again(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="finished", written_rows=1, duration_ms=10),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    result = apply_async_statement(_rerun_input(client, _FlakyReadJournal()))
    assert result.kind == "completed"
    assert len(client.submitted) == 1


class _SecondReadLagsJournal(_FakeJournalStore):
    """The move to "may have been sent" never reads back."""

    def read_stored_operation(self, name: str, index: int) -> OperationState | None:
        op = super().read_stored_operation(name, index)
        return None if op is not None and op.last_error == _ATTEMPT_MARKER else op


def test_an_attempt_whose_second_read_back_fails_goes_back_to_prepared(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _ScriptedClient(statuses=[QueryStatus(status="unknown")], strict=True)
    _advance_clock(monkeypatch, client)
    journal = _SecondReadLagsJournal()
    with pytest.raises(RuntimeError, match="was not submitted"):
        apply_async_statement(_rerun_input(client, journal))
    assert client.submitted == []
    assert journal.writes is not None
    assert [w.operations[0].last_error for w in journal.writes] == [
        _PREPARED_MARKER, _ATTEMPT_MARKER, _PREPARED_MARKER
    ]


class _StalePreparedJournal(_FakeJournalStore):
    """A replica read returns the prepared row; the journal's newest record is
    the move to "may have been sent"."""

    def read_stored_operation(self, name: str, index: int) -> OperationState | None:
        op = super().read_stored_operation(name, index)
        if op is None:
            return None
        return op.model_copy(update={"last_error": _ATTEMPT_MARKER})


@pytest.mark.parametrize("every_copy", [False, True], ids=["one-copy-read", "newer-record"])
def test_a_prepared_record_that_a_fresh_read_does_not_confirm_stops(
    every_copy: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 4): a prepared row read from a lagging replica is no proof
    the attempt was never sent. Unless a read of every copy of the journal
    still holds it prepared, the run stops and keeps the record."""
    client = _ScriptedClient(statuses=list(_NO_ENTRY_CHECKS), strict=True)
    _advance_clock(monkeypatch, client)
    journal_cls = _StalePreparedJournal if every_copy else _FakeJournalStore
    journal = journal_cls(
        state=_started_record(last_error=_PREPARED_MARKER), every_copy=every_copy
    )
    with pytest.raises(MigrateError) as info:
        apply_async_statement(_rerun_input(client, journal))
    assert info.value.code == "async_outcome_unknown"
    assert info.value.message == _outcome_unknown(_OWN_ID, _STALE_PREPARED_REASON)
    assert client.executed == []
    assert client.submitted == []
    assert journal.writes == []


@pytest.mark.parametrize("failure", ["polls", "final-check"])
def test_a_poll_budget_exit_with_a_submit_that_never_settles_stops_at_once(
    failure: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 4): every exit of the poll budget (failed polls, a failed
    final check) gives up on the submit and stops with async_outcome_unknown,
    without waiting for a submit that never settles."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _s: None)
    statuses: list[QueryStatus | BaseException] = (
        [QueryStatus(status="unknown"), *[RuntimeError("HTTP 502") for _ in range(21)]]
        if failure == "polls"
        else [
            QueryStatus(status="unknown"),
            *[QueryStatus(status="unknown") for _ in range(20)],
            RuntimeError("ALL_CONNECTION_TRIES_FAILED"),
        ]
    )
    client = _NeverSettlingSubmitClient(statuses)
    started = time.monotonic()
    try:
        with pytest.raises(MigrateError) as info:
            apply_async_statement(_input(client=client, journal=_FakeJournalStore()))
    finally:
        client.release.set()
    assert time.monotonic() - started < 10
    assert info.value.code == "async_outcome_unknown"
    expected = (
        "polling failed 21\u00d7 in a row (HTTP 502)"
        if failure == "polls"
        else "the final check of every replica failed (ALL_CONNECTION_TRIES_FAILED)."
    )
    assert expected in info.value.message



def test_a_failure_while_it_runs_does_not_wait_for_a_submit_that_never_settles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#767 (round 5): a statement that fails while it runs stops the run with
    async_outcome_unknown at once, as every stop without an outcome does,
    without waiting for a submit a proxy holds open; the fenced started
    record stays."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _s: None)
    client = _NeverSettlingSubmitClient(
        [
            QueryStatus(status="unknown"),
            QueryStatus(status="failed", error="Code: 395. throwIf", before_start=False),
        ]
    )
    journal = _FakeJournalStore()
    started = time.monotonic()
    try:
        with pytest.raises(MigrateError) as info:
            apply_async_statement(_input(client=client, journal=journal))
    finally:
        client.release.set()
    assert time.monotonic() - started < 10
    assert info.value.code == "async_outcome_unknown"
    assert "failed while it ran" in info.value.message
    assert [state.operations[0].status for state in journal.writes or []] == ["started", "started"]


@pytest.mark.parametrize("outcome", ["QueryFinish", "ExceptionBeforeStart"])
def test_a_settled_outcome_does_not_wait_for_a_submit_that_never_settles(
    outcome: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 6): a settled outcome is journaled, then the run ends
    without waiting for a submit a proxy holds open."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _s: None)
    settled = (
        QueryStatus(status="finished", written_rows=1, duration_ms=10)
        if outcome == "QueryFinish"
        else QueryStatus(status="failed", error="Code: 60. UNKNOWN_TABLE", before_start=True)
    )
    client = _NeverSettlingSubmitClient([QueryStatus(status="unknown"), settled])
    journal = _FakeJournalStore()
    started = time.monotonic()
    try:
        if outcome == "QueryFinish":
            assert apply_async_statement(_input(client=client, journal=journal)).kind == "completed"
        else:
            with pytest.raises(RuntimeError, match="UNKNOWN_TABLE"):
                apply_async_statement(_input(client=client, journal=journal))
    finally:
        client.release.set()
    assert time.monotonic() - started < 10
    writes = journal.writes or []
    assert writes[-1].operations[0].status == (
        "completed" if outcome == "QueryFinish" else "failed"
    )
