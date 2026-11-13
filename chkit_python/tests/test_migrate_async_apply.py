"""Tests for async_apply (deterministic resume, polling, journal writes)."""

from __future__ import annotations

import decimal
import re
import threading
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
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.journal_store import MigrationRowState, OperationState
from chkit.clickhouse.client import QueryResult, QueryStatus

# The server clock differs from the client clock on purpose: the query_log
# bound must come from the server.
SERVER_NOW_MS = 1_700_000_100_000
SERVER_DATABASE = "analytics"
# SERVER_NOW_MS minus the 2 s skew margin.
SUBMISSION_BOUND = "2023-11-14T22:14:58.000Z"
# How long the attempt an attach finds has been running.
RUNNING_ELAPSED_MS = 30_000
# SERVER_NOW_MS minus RUNNING_ELAPSED_MS and the 2 s skew margin.
ATTACH_BOUND = "2023-11-14T22:14:28.000Z"
# A retry's id is its own (#701): its polls count every query_log entry from
# an hour before SERVER_NOW_MS, a bound that only lets query_log prune.
RETRY_BOUND = "2023-11-14T21:15:00.000Z"
_UUID_SHAPE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _retry_query_id(submitted: list[tuple[str, str | None]]) -> str:
    """The id a retry submitted under: a random one, never the statement's first id (#701)."""
    assert len(submitted) == 1
    query_id = submitted[0][1] or ""
    assert _UUID_SHAPE.match(query_id), query_id
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
    ) -> str:
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
    assert client.submitted == [
        (
            "ALTER TABLE db.t MODIFY COLUMN x UInt64",
            make_deterministic_query_id(
                SERVER_DATABASE, "_chkit_migrations", "20260101_000000_async.sql", 0
            ),
        )
    ]
    # Without migrate --setting the submission carries no settings.
    assert client.sent_settings == [("submit", None)]
    assert journal.writes is not None
    # Two writes: started + completed
    statuses = [w.operations[0].status for w in journal.writes]
    assert statuses == ["started", "completed"]
    # The in-flight check looks for any running query with this id; the polls
    # after submitting only count queries started after the server-time bound.
    assert client.after_times == [None, SUBMISSION_BOUND, SUBMISSION_BOUND]
    # The server time is read before the in-flight check (an attach would
    # need it) and again right before the submission.
    assert client.events == [
        SERVER_TIME_QUERY, "status", SERVER_TIME_QUERY, "submit", "status", "status"
    ]


def test_apply_async_already_running_skips_submit() -> None:
    client = _ScriptedClient(
        statuses=[
            # initial in-flight check returns running
            QueryStatus(status="running", elapsed_ms=RUNNING_ELAPSED_MS),
            QueryStatus(status="finished", duration_ms=1000),  # next poll terminal
        ]
    )
    journal = _FakeJournalStore()
    apply_async_statement(_input(client=client, journal=journal))
    # No submit call — we attached to in-flight
    assert client.submitted == []
    # The poll only counts queries that started with the attached attempt.
    assert client.after_times == [None, ATTACH_BOUND]
    assert client.events == [SERVER_TIME_QUERY, "status", "status"]


def test_apply_async_attach_without_elapsed_keeps_unbounded_lookup() -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="running"),
            QueryStatus(status="finished", written_rows=1, duration_ms=100),
        ]
    )
    result = apply_async_statement(_input(client=client, journal=_FakeJournalStore()))
    assert result.kind == "completed"
    # Without its start, a bound could exclude the attempt's own entry.
    assert client.after_times == [None, "1970-01-01 00:00:00"]


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


def test_apply_async_keeps_the_journaled_query_id() -> None:
    # #463: an older chkit derived the id from the migration alone. A statement
    # it journaled keeps that id, so an upgrade mid-load still finds the attempt.
    legacy_id = "f2d1c4e0-1111-2222-3333-444455556666"
    prior = _op("started").model_copy(update={"query_id": legacy_id})
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="running", written_rows=5, elapsed_ms=RUNNING_ELAPSED_MS),
            QueryStatus(status="finished", written_rows=12, duration_ms=12_000),
        ]
    )
    journal = _FakeJournalStore(state=_state(prior, checksum="abc"))
    result = apply_async_statement(
        _input(
            client=client,
            journal=journal,
            migration_name="m.sql",
            before_retry="TRUNCATE TABLE db.t",
        )
    )
    assert result.kind == "completed"
    assert client.status_ids == [legacy_id, legacy_id]
    assert client.submitted == []
    assert client.executed == []
    assert journal.writes is not None
    # The attach journals the attempt started (#672), under its journaled id.
    assert [w.operations[0].query_id for w in journal.writes] == [legacy_id, legacy_id]


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


def test_apply_async_gives_up_after_poll_error_budget_with_ts_message() -> None:
    poll_error = RuntimeError("ClickHouse request failed: error code: 524")
    client = _ScriptedClient(
        statuses=[QueryStatus(status="unknown")]
        + [poll_error] * (migrate_async_apply.MAX_TRANSIENT_POLL_ERRORS + 1)
    )
    query_id = make_deterministic_query_id(
        SERVER_DATABASE, "_chkit_migrations", "20260101_000000_async.sql", 0
    )
    with pytest.raises(RuntimeError) as raised:
        apply_async_statement(_input(client=client, journal=_FakeJournalStore()))
    # Same text as the TS port, byte for byte: a multiplication sign, not "x".
    assert str(raised.value) == (
        f"Async migration step alter_table_modify_column (query_id {query_id}): "
        "polling failed 21\u00d7 (ClickHouse request failed: error code: 524). "
        "The load may still be running server-side — re-run "
        "`chkit migrate --apply` to re-attach."
    )


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
    retry_id = _retry_query_id(client.submitted)
    assert retry_id != prior.query_id
    assert client.status_ids == [prior.query_id, retry_id]
    assert client.submitted == [("ALTER TABLE db.t MODIFY COLUMN x UInt64", retry_id)]
    assert client.after_times == [None, RETRY_BOUND]
    # The retry submits right after the check, without waiting on the server clock.
    assert client.events == [SERVER_TIME_QUERY, "status", "submit", "status"]
    assert journal.writes is not None
    assert journal.writes[0].operations[0].query_id == retry_id
    assert journal.writes[0].operations[0].last_error == _ATTEMPT_MARKER
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
    journal = _FakeJournalStore(state=_state(_op("failed", last_error="Memory limit")))
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
    assert [w.checksum for w in journal.writes] == ["NEW", "NEW"]


# The id a statement with no journal row gets on SERVER_DATABASE.
_QUERY_ID = make_deterministic_query_id(
    SERVER_DATABASE, "_chkit_migrations", "20260101_000000_async.sql", 0
)


def test_apply_async_submit_rejected_before_start_is_recorded_failed() -> None:
    client = _ScriptedClient(
        statuses=[QueryStatus(status="unknown")] * 3,
        submit_raises=RuntimeError("Syntax error: failed at position 1"),
    )
    journal = _FakeJournalStore()
    lines: list[str] = []
    with pytest.raises(RuntimeError, match="Syntax error"):
        apply_async_statement(_input(client=client, journal=journal, log=lines.append))
    # The query never started, so the attempt is recorded as failed (#233):
    # an edited file can then run again without --retry.
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "failed"]
    assert journal.writes[1].operations[0].last_error == (
        "Syntax error: failed at position 1"
    )
    # The submit error is the command's error; no progress line repeats it (#561).
    assert lines == [f"  alter_table_modify_column: submitting async (query_id={_QUERY_ID})"]


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
    with pytest.raises(RuntimeError) as excinfo:
        apply_async_statement(_input(client=client, journal=journal))
    submit_tail = (
        " The submit request failed too (Authentication failed)." if submit_fails else ""
    )
    assert str(excinfo.value) == (
        f"Async migration step alter_table_modify_column (query_id {_QUERY_ID}): "
        f"polling failed 21\u00d7 (HTTP 502: bad gateway).{submit_tail} The load may still "
        "be running server-side — re-run `chkit migrate --apply` to re-attach."
    )
    # The outcome is unknown, so the attempt stays started for a re-run to re-attach.
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started"]


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
    assert [w.operations[0].status for w in journal.writes] == ["started", "completed"]
    assert lines == [
        f"  alter_table_modify_column: submitting async (query_id={_QUERY_ID})",
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
    assert [w.operations[0].status for w in journal.writes] == ["started", "completed"]
    assert lines == [
        f"  alter_table_modify_column: submitting async (query_id={_QUERY_ID})",
        "  alter_table_modify_column: written=9 rows (72 B), elapsed 0s",
        "  alter_table_modify_column: status unknown — still polling (elapsed 0s)",
        "  alter_table_modify_column: finished — written=16 rows (128 B) in 8s",
    ]


def test_apply_async_submit_failing_after_the_query_ran_gives_up_after_the_poll_budget() -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),  # initial in-flight check
            QueryStatus(status="running", written_rows=9, written_bytes=72),
            *[QueryStatus(status="unknown") for _ in range(21)],
        ],
        submit_raises=RuntimeError("error code: 524"),
    )
    journal = _FakeJournalStore()
    with pytest.raises(RuntimeError) as excinfo:
        apply_async_statement(_input(client=client, journal=journal))
    assert str(excinfo.value) == (
        f"Async migration step alter_table_modify_column (query_id {_QUERY_ID}): "
        "the submit request failed (error code: 524) and polling found no outcome 21\u00d7. "
        "A re-run of `chkit migrate --apply` attaches to the query if it still runs and runs "
        "the statement again if not."
    )
    # The outcome is unknown, so the attempt stays started.
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started"]


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
    in TS, and the step returns once the request has closed."""
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
        f"  alter_table_modify_column: submitting async (query_id={_QUERY_ID})",
        "  alter_table_modify_column: written=4 rows (32 B), elapsed 0s",
        "  alter_table_modify_column: written=9 rows (72 B), elapsed 0s",
        "  alter_table_modify_column: finished — written=25 rows (200 B) in 25s",
    ]
    assert client.events == [
        SERVER_TIME_QUERY,
        "status",
        SERVER_TIME_QUERY,
        "status",
        "status",
        "status",
        "submit returned",
    ]
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "completed"]


def test_apply_async_query_failing_while_the_submit_is_open_raises_the_polled_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The failure comes from query_log, as in TS; the submit error that
    follows it is waited for, not raised."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _: None)
    client = _OpenSubmitClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="running", written_rows=4, written_bytes=32),
            QueryStatus(status="failed", error="Memory limit exceeded"),
        ],
        submit_raises=RuntimeError("Memory limit exceeded (from the submit)"),
    )
    journal = _FakeJournalStore()
    with pytest.raises(RuntimeError) as excinfo:
        apply_async_statement(_input(client=client, journal=journal))
    assert str(excinfo.value) == (
        "Async migration step alter_table_modify_column failed "
        f"(query_id {_QUERY_ID}): Memory limit exceeded"
    )
    assert client.events[-1] == "submit returned"
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "failed"]


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
                 earlier_query_id: str | None = None) -> None:
        super().__init__(statuses=[], submit_raises=submit_raises)
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
    ) -> QueryStatus:
        self.after_times.append(after_time)
        self.status_ids.append(query_id)
        self.every_replica.append(every_replica)
        phase = self._phases.pop(0) if self._phases else "flushed"
        if phase == "running":
            return QueryStatus(status="running", written_rows=1, elapsed_ms=RUNNING_ELAPSED_MS)
        after_sec = _whole_seconds(after_time)
        if phase == "flushed" and self._attached_start >= after_sec:
            return QueryStatus(status="failed", error="Memory limit exceeded")
        earlier = self._earlier_query_id in (None, query_id)
        if earlier and self._earlier_start >= after_sec:
            return QueryStatus(status="finished", written_rows=2, duration_ms=10)
        return QueryStatus(status="unknown")


def test_apply_async_attach_ignores_earlier_attempt_query_log_entries() -> None:
    """query_log flush gap: an earlier attempt's QueryFinish must not count."""
    attached_start = (SERVER_NOW_MS - RUNNING_ELAPSED_MS) // 1000
    client = _QueryLogClient(
        ["running", "running", "flush gap", "flush gap", "flushed"],
        attached_start=attached_start,
        earlier_start=attached_start - 3_600,
    )
    journal = _FakeJournalStore(
        state=_state(_op("started"), checksum="abc").model_copy(
            update={"name": "20260101_000000_async.sql"}
        )
    )
    with pytest.raises(RuntimeError, match="Memory limit exceeded"):
        apply_async_statement(_input(client=client, journal=journal))
    assert client.after_times[1:] == [ATTACH_BOUND] * 4
    assert journal.writes is not None
    # Recorded as the attached attempt's failure, never as completed.
    assert [w.operations[0].status for w in journal.writes] == ["started", "failed"]


@pytest.mark.parametrize("prior", ["none", "abandoned"])
def test_apply_async_new_submission_ignores_earlier_attempt(
    prior: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After --abandon, query_log still holds the earlier attempt's QueryFinish."""
    # The earlier attempt started one 5 s poll interval before this submission.
    stale_start = (SERVER_NOW_MS - 5_000) // 1000
    earlier = _op("failed").model_copy(update={"query_id": _QUERY_ID})
    client = _QueryLogClient(
        ["flush gap"] * 30,
        attached_start=0,
        earlier_start=stale_start,
        submit_raises=RuntimeError("Unknown table expression identifier 'default.src_typo'"),
        earlier_query_id=_QUERY_ID,
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
    # A first attempt's polls are bounded by its start; a retry polls an id of its own (#701).
    poll = (
        (_QUERY_ID, SUBMISSION_BOUND)
        if prior == "none"
        else (client.status_ids[1], RETRY_BOUND)
    )
    assert _UUID_SHAPE.match(poll[0])
    assert all(
        call == poll for call in zip(client.status_ids[1:], client.after_times[1:], strict=True)
    )
    assert journal.writes is not None
    # Recorded as a failed attempt, never as completed.
    assert [w.operations[0].status for w in journal.writes] == ["started", "failed"]


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


def test_apply_async_attach_records_the_fingerprint_of_the_attempt() -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="running", elapsed_ms=RUNNING_ELAPSED_MS),
            QueryStatus(status="finished", written_rows=1, duration_ms=1000),
        ]
    )
    journal = _FakeJournalStore(state=_abandoned_running(""))
    apply_async_statement(_input(client=client, journal=journal, fingerprint="v1:new"))
    assert journal.writes
    last = journal.writes[-1].operations[0]
    assert (last.status, last.fingerprint) == ("completed", "")


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
# compensates and resubmits. Same cases as async-apply.test.ts.

_RERUN_QUERY_ID = make_deterministic_query_id(SERVER_DATABASE, "_chkit_migrations", "m.sql", 0)
_MARKER = migrate_async_apply.STARTED_RECORD_MARKER
_ATTEMPT_MARKER = migrate_async_apply.ATTEMPT_RECORD_MARKER
# The statement's first id is bounded by the record's start minus the skew margin.
_RECORD_BOUND = "2026-05-26T09:59:58.000Z"
# A started attempt without a query_log entry: the check, then 5 rechecks
# while query_log is flushed (#701).
_NO_ENTRY_CHECKS = [QueryStatus(status="unknown") for _ in range(6)]


def _iso_ms(ms: int) -> str:
    return iso_without_zone(datetime.fromtimestamp(ms / 1000, tz=UTC))


def _started_record(**overrides: Any) -> MigrationRowState:
    op = _op("started").model_copy(
        update={
            "started_at": "2026-05-26 10:00:00.000",
            "fingerprint": "v1:load",
            "last_error": _ATTEMPT_MARKER,
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
            *[QueryStatus(status="unknown") for _ in range(21)],
        ],
        submit_raises=RuntimeError("error code: 524"),
        strict=True,
    )
    with pytest.raises(RuntimeError, match="polling found no outcome 21\u00d7"):
        apply_async_statement(_rerun_input(first, journal))
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started"]
    # The attempt's start is recorded on the server clock, as this release's record.
    assert journal.writes[0].operations[0].started_at == _iso_ms(SERVER_NOW_MS)
    assert journal.writes[0].operations[0].last_error == _ATTEMPT_MARKER

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
    # One read of every replica, bounded by the start run 1 recorded.
    assert second.after_times == [SUBMISSION_BOUND]
    assert second.every_replica == [True]
    assert second.running_only == [False]
    assert [w.operations[0].status for w in journal.writes] == ["started", "completed"]
    completed = journal.writes[1].operations[0]
    assert completed.query_id == _RERUN_QUERY_ID
    assert completed.started_at == _iso_ms(SERVER_NOW_MS)
    assert completed.fingerprint == "v1:load"
    assert completed.last_error == ""
    assert lines == [
        f"  alter_table_modify_column: previous attempt of query_id={_RERUN_QUERY_ID} "
        "finished on the server — written=16 rows (128 B) in 8s, recording it as completed"
    ]


def test_rerun_of_a_started_attempt_that_failed_on_the_server_resubmits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(
                status="failed", error="Code: 241. DB::Exception: Memory limit exceeded\nstack"
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
    assert client.after_times[0] == _RECORD_BOUND
    assert client.running_only[0] is False
    assert client.executed == ["TRUNCATE TABLE db.t"]
    retry_id = _retry_query_id(client.submitted)
    assert retry_id != _RERUN_QUERY_ID
    assert lines[0] == (
        f"  alter_table_modify_column: previous attempt of query_id={_RERUN_QUERY_ID} is no "
        "longer running (status=failed: Code: 241. DB::Exception: Memory limit exceeded) — "
        f"running before-retry then resubmitting as query_id={retry_id}"
    )
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["failed", "started", "completed"]
    assert journal.writes[0].operations[0].last_error == (
        "Code: 241. DB::Exception: Memory limit exceeded\nstack"
    )


def test_rerun_of_a_started_attempt_without_a_query_log_entry_resubmits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _ScriptedClient(
        statuses=[
            *_NO_ENTRY_CHECKS,
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    sleeps = _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=_started_record())
    apply_async_statement(_rerun_input(client, journal))

    # Checked once, then 5 times 2 s apart while query_log is flushed (#701).
    assert client.status_ids[:6] == [_RERUN_QUERY_ID] * 6
    assert client.after_times[:6] == [_RECORD_BOUND] * 6
    assert client.every_replica[:6] == [True] * 6
    assert sleeps[:5] == [2.0] * 5
    assert client.executed == ["TRUNCATE TABLE db.t"]
    assert len(client.submitted) == 1
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["failed", "started", "completed"]
    assert journal.writes[0].operations[0].last_error == (
        "no longer running and no outcome in system.query_log; retried"
    )


def test_rerun_without_before_retry_keeps_the_attempt_started_until_resubmitted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _ScriptedClient(
        statuses=[
            *_NO_ENTRY_CHECKS,
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=_started_record())
    apply_async_statement(_rerun_input(client, journal, before_retry=None))

    # Nothing is compensated, so a re-run may still find its QueryFinish.
    assert len(client.submitted) == 1
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "completed"]


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
    # Run 1: no outcome yet; the TRUNCATE ran, but its response was lost.
    first = _LostResponseClient(statuses=list(_NO_ENTRY_CHECKS), strict=True)
    with pytest.raises(RuntimeError, match="socket hang up"):
        apply_async_statement(_rerun_input(first, journal))
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["failed"]
    assert journal.writes[0].operations[0].last_error == (
        "no longer running and no outcome in system.query_log; retried"
    )

    # Run 2: the first attempt's QueryFinish is in query_log by now.
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

    def read_migration_state(self, name: str) -> MigrationRowState | None:
        assert self.writes is not None
        if any(op.status == "started" for w in self.writes for op in w.operations):
            msg = "killed"
            raise KeyboardInterrupt(msg)
        return super().read_migration_state(name)


class _RunOneFinishClient(_ScriptedClient):
    """query_log holds run 1's QueryFinish only; other ids answer as scripted."""

    def __init__(self, run_one_query_id: str, statuses: list[QueryStatus | BaseException]) -> None:
        super().__init__(statuses=statuses, strict=True)
        self._run_one_query_id = run_one_query_id

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
    ) -> QueryStatus:
        answer = super().query_status(
            query_id, after_time=after_time, every_replica=every_replica, running_only=running_only
        )
        if query_id == self._run_one_query_id:
            return QueryStatus(status="finished", written_rows=0, duration_ms=10)
        return answer


def test_a_rerun_never_takes_an_earlier_attempts_finish_for_the_retry_that_followed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#701: every attempt submits under an id of its own, so a re-run never
    takes an earlier attempt's QueryFinish for a later attempt's outcome,
    however close together they started."""
    run_one_start = _iso_ms(SERVER_NOW_MS - 1_000)
    journal = _KilledBeforeSubmitJournal(state=_started_record(started_at=run_one_start))
    # Run 2, a second after run 1's attempt: no outcome yet; it compensates,
    # journals its own attempt, and stops before its submit leaves.
    second = _ScriptedClient(statuses=list(_NO_ENTRY_CHECKS), strict=True)
    _advance_clock(monkeypatch, second)
    with pytest.raises(KeyboardInterrupt, match="killed"):
        apply_async_statement(_rerun_input(second, journal))
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["failed", "started"]
    run_two_query_id = journal.writes[1].operations[0].query_id
    assert _UUID_SHAPE.match(run_two_query_id)
    assert journal.writes[1].operations[0].started_at == _iso_ms(SERVER_NOW_MS)
    assert journal.writes[1].operations[0].last_error == _ATTEMPT_MARKER

    assert second.submitted == []
    # Run 3: query_log now holds run 1's QueryFinish, and nothing of run 2's attempt.
    rerun_journal = _FakeJournalStore(state=journal.state)
    third = _RunOneFinishClient(
        _RERUN_QUERY_ID,
        [*_NO_ENTRY_CHECKS, QueryStatus(status="finished", written_rows=16, duration_ms=8000)],
    )
    _advance_clock(monkeypatch, third)
    result = apply_async_statement(_rerun_input(third, rerun_journal))

    # Every check reads run 2's id, from an hour before its recorded start.
    assert third.status_ids[:6] == [run_two_query_id] * 6
    assert third.after_times[:6] == [_iso_ms(SERVER_NOW_MS - 3_600_000) + "Z"] * 6
    assert third.executed == ["TRUNCATE TABLE db.t"]
    assert _retry_query_id(third.submitted) not in (_RERUN_QUERY_ID, run_two_query_id)
    assert result.operation.status == "completed"


class _RunAFinishClient(_ScriptedClient):
    """query_log holds run A's QueryFinish; other ids answer as scripted."""

    def __init__(self, run_a_query_id: str, statuses: list[QueryStatus | BaseException]) -> None:
        super().__init__(statuses=statuses, strict=True)
        self._run_a_query_id = run_a_query_id

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
    ) -> QueryStatus:
        answer = super().query_status(
            query_id, after_time=after_time, every_replica=every_replica, running_only=running_only
        )
        if query_id == self._run_a_query_id:
            return QueryStatus(status="finished", written_rows=16, duration_ms=8000)
        return answer


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
    run_a_query_id = _retry_query_id(run_a.submitted)
    # Run B read the same failed record.
    journal_b = _KilledBeforeSubmitJournal(state=failed)
    run_b = _ScriptedClient(statuses=[QueryStatus(status="unknown")], strict=True)
    _advance_clock(monkeypatch, run_b)
    with pytest.raises(KeyboardInterrupt, match="killed"):
        apply_async_statement(_rerun_input(run_b, journal_b))
    assert run_b.executed == ["TRUNCATE TABLE db.t"]
    assert journal_b.writes is not None
    run_b_record = journal_b.writes[-1].operations[0]
    assert run_b_record.status == "started"
    assert run_b_record.query_id != run_a_query_id

    # The re-run: query_log has run A's QueryFinish only.
    rerun = _RunAFinishClient(
        run_a_query_id,
        [*_NO_ENTRY_CHECKS, QueryStatus(status="finished", written_rows=16, duration_ms=8000)],
    )
    _advance_clock(monkeypatch, rerun)
    apply_async_statement(_rerun_input(rerun, _FakeJournalStore(state=journal_b.state)))

    assert rerun.executed == ["TRUNCATE TABLE db.t"]
    assert len(rerun.submitted) == 1


def test_a_started_record_of_the_release_before_701_keeps_the_bounded_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A record of the release before #701 names an id that earlier attempts
    may share, so it keeps that release's check: bounded by its recorded
    start, and a missing entry is not waited for. The retry gets an id of its own."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=_started_record(last_error=_MARKER))
    apply_async_statement(_rerun_input(client, journal))

    retry_id = _retry_query_id(client.submitted)
    assert client.status_ids == [_RERUN_QUERY_ID, retry_id]
    assert client.after_times == [_RECORD_BOUND, RETRY_BOUND]
    assert client.executed == ["TRUNCATE TABLE db.t"]
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["failed", "started", "completed"]
    assert journal.writes[1].operations[0].last_error == _ATTEMPT_MARKER


def test_a_started_attempt_that_a_recheck_finds_running_is_attached_to(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A started attempt of this release that is running by a recheck (its
    submit reached the server late) is attached to, not resubmitted."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="running", written_rows=5, elapsed_ms=1_000),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=_started_record())
    result = apply_async_statement(_rerun_input(client, journal))

    assert result.kind == "completed"
    assert client.executed == []
    assert client.submitted == []


@pytest.mark.parametrize("before_retry", ["TRUNCATE TABLE db.t", None], ids=["with", "without"])
def test_an_older_releases_started_record_is_checked_in_processes_only(
    before_retry: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An older release's started record has a client-clock start, and a retry
    by that release may have run before-retry SQL without journaling the
    attempt failed first, so its QueryFinish is not the statement's outcome."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=_started_record(last_error=""))
    apply_async_statement(_rerun_input(client, journal, before_retry=before_retry))

    assert client.after_times[0] is None
    assert client.running_only[0] is True
    assert client.executed == ([] if before_retry is None else [before_retry])
    assert len(client.submitted) == 1


# Only a started attempt of this statement's SQL can have finished unseen: a
# failed one has its outcome, a sync record never ran under this id, and an
# attempt of other SQL that finished did not run this statement.
@pytest.mark.parametrize(
    "overrides",
    [
        {"status": "failed", "finished_at": "2026-05-26 10:05:00.000", "last_error": "boom"},
        {"query_id": ""},
        {"fingerprint": "v1:other"},
    ],
    ids=["failed attempt", "started record without query id", "started attempt of other SQL"],
)
def test_rerun_reads_system_processes_only_for(
    overrides: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    _advance_clock(monkeypatch, client)
    journal = _FakeJournalStore(state=_started_record(**overrides))
    apply_async_statement(_rerun_input(client, journal, before_retry=None))

    assert client.after_times[0] is None
    assert client.every_replica[0] is True
    assert client.running_only[0] is True
    assert len(client.submitted) == 1


def test_an_attach_journals_the_attempt_started_and_a_rerun_records_its_finish() -> None:
    """An attach under a failed record (an attempt kept by --abandon, or one
    that a retry journaled failed) records the attempt started, so a run that
    stops while it polls leaves a record a re-run reads from query_log."""
    journal = _FakeJournalStore(
        state=_started_record(
            status="failed", finished_at="2026-05-26 10:05:00.000", last_error="boom"
        )
    )
    first = _ScriptedClient(
        statuses=[
            QueryStatus(status="running", written_rows=5, elapsed_ms=RUNNING_ELAPSED_MS),
            *[RuntimeError("HTTP 502: bad gateway") for _ in range(21)],
        ],
        strict=True,
    )
    with pytest.raises(RuntimeError, match="polling failed 21\u00d7"):
        apply_async_statement(_rerun_input(first, journal, before_retry=None))
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started"]
    started = journal.writes[0].operations[0]
    assert started.started_at == _iso_ms(SERVER_NOW_MS - RUNNING_ELAPSED_MS)
    assert started.last_error == _MARKER
    assert started.fingerprint == "v1:load"

    second = _ScriptedClient(
        statuses=[QueryStatus(status="finished", written_rows=16, duration_ms=8000)],
        strict=True,
    )
    result = apply_async_statement(_rerun_input(second, journal, before_retry=None))

    assert result.kind == "completed"
    assert second.after_times[0] == ATTACH_BOUND
    assert second.submitted == []


def test_an_attach_keeps_the_start_a_record_of_this_release_holds() -> None:
    """The elapsed time is observed after the server time the attach reads, so
    a start derived from both can lie earlier than the attempt's own."""
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="running", written_rows=5, elapsed_ms=RUNNING_ELAPSED_MS),
            QueryStatus(status="finished", written_rows=16, duration_ms=8000),
        ],
        strict=True,
    )
    journal = _FakeJournalStore(state=_started_record(started_at="2023-11-14 22:14:59.000"))
    apply_async_statement(_rerun_input(client, journal))

    assert journal.writes is not None
    assert journal.writes[0].operations[0].status == "started"
    assert journal.writes[0].operations[0].started_at == "2023-11-14 22:14:59.000"


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
    assert (
        "the ClickHouse user cannot read system.query_log, which tells whether the "
        "previous attempt finished (Code: 497." in message
    )
    assert message.endswith(
        "Nothing was resubmitted and no before-retry SQL ran. Grant SELECT ON "
        "system.query_log to the user; until then a re-run of `chkit migrate --apply` "
        "stops here too."
    )
    assert client.submitted == []
    assert client.executed == []
    assert journal.writes == []


@pytest.mark.parametrize(
    "started_at", ["2026-05-26T10:00:00.000Z", "2026-05-26T12:00:00.000+02:00"], ids=["Z", "+02:00"]
)
def test_rerun_reads_a_zoned_start_time_with_that_zone(started_at: str) -> None:
    client = _ScriptedClient(
        statuses=[QueryStatus(status="finished", written_rows=16, duration_ms=8000)],
        strict=True,
    )
    journal = _FakeJournalStore(state=_started_record(started_at=started_at))
    apply_async_statement(_rerun_input(client, journal))

    assert client.after_times[0] == "2026-05-26T09:59:58.000Z"


def test_a_rerun_before_query_log_has_the_finished_attempt_waits_for_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#701: query_log is flushed on a timer (7.5 s by default), so a re-run
    right after the attempt ended can find it neither running nor in query_log."""
    journal = _FakeJournalStore()
    first = _ScriptedClient(
        statuses=[
            QueryStatus(status="running", written_rows=9, written_bytes=72),
            *[RuntimeError("HTTP 502: bad gateway") for _ in range(21)],
        ],
        strict=True,
    )
    with pytest.raises(RuntimeError, match="polling failed 21\u00d7"):
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
    assert [w.operations[0].status for w in journal.writes] == ["started", "completed"]


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
    the one that gave its recorded start, more than the skew margin."""
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
    with pytest.raises(RuntimeError, match="polling failed 21\u00d7"):
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
    """query_log holds an earlier attempt's QueryFinish of the id; the submit is rejected."""

    def __init__(self, earlier_start_sec: int) -> None:
        super().__init__(
            statuses=[],
            submit_raises=RuntimeError("Code: 216. QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING"),
        )
        self._earlier_start_sec = earlier_start_sec

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
    ) -> QueryStatus:
        if running_only:
            return QueryStatus(status="unknown")
        if self._earlier_start_sec >= _whole_seconds(after_time):
            return QueryStatus(status="finished", written_rows=2, duration_ms=10)
        return QueryStatus(status="unknown")


class _SlowJournalStore(_FakeJournalStore):
    """Each write takes 6 s of the client's server clock."""

    client: Any = None

    def write_migration_state(self, state: MigrationRowState) -> None:
        self.client.now_ms += 6_000
        super().write_migration_state(state)


def test_a_first_attempts_polls_ignore_an_earlier_attempt_that_finished_during_the_writes() -> None:
    """Codex review of #701: the statement's first id is shared with an
    attempt whose record was lost. Its polls are bounded by the server time
    read after the journal writes, which can take long, so that attempt's
    QueryFinish is not taken for a rejected submission's."""
    client = _EarlierFinishClient((SERVER_NOW_MS - 1_000) // 1000)
    journal = _SlowJournalStore()
    journal.client = client
    with pytest.raises(RuntimeError, match="QUERY_WITH_SAME_ID"):
        apply_async_statement(_rerun_input(client, journal, before_retry=None))
    assert journal.writes is not None
    assert [w.operations[0].status for w in journal.writes] == ["started", "failed"]
