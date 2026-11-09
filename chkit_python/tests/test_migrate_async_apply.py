"""Tests for async_apply (deterministic resume, polling, journal writes)."""

from __future__ import annotations

import decimal
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
SERVER_TIME_QUERY = (
    "query: SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms, currentDatabase() AS database"
)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _: None)


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
        statuses: list[QueryStatus | BaseException],
        *,
        submit_raises: BaseException | None = None,
    ) -> None:
        self._statuses = list(statuses)
        self.submitted: list[tuple[str, str | None]] = []
        self.executed: list[str] = []
        # The settings each submit / execute call received, in call order.
        self.sent_settings: list[tuple[str, dict[str, Any] | None]] = []
        self.after_times: list[str | None] = []
        self.status_ids: list[str] = []
        self.every_replica: list[bool] = []
        # Server-time reads, status checks and submissions, in call order.
        self.events: list[str] = []
        self._submit_raises = submit_raises

    def query(self, statement: str) -> QueryResult:
        self.events.append(f"query: {statement}")
        return QueryResult(
            column_names=["now_ms", "database"],
            rows=[{"now_ms": str(SERVER_NOW_MS), "database": SERVER_DATABASE}],
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
        if not self._statuses:
            return QueryStatus(status="unknown")
        status = self._statuses.pop(0)
        if isinstance(status, BaseException):
            raise status
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
    assert [w.operations[0].query_id for w in journal.writes] == [legacy_id]


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


def test_apply_async_resubmit_runs_before_retry() -> None:
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
            settings={"max_table_size_to_drop": "0"},
        )
    )
    assert client.executed == ["TRUNCATE TABLE db.t"]
    # migrate --setting reaches the before-retry SQL and the resubmission (#321).
    assert client.sent_settings == [
        ("execute", {"max_table_size_to_drop": "0"}),
        ("submit", {"max_table_size_to_drop": "0"}),
    ]
    assert client.after_times == [None, SUBMISSION_BOUND]
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


def test_apply_async_accepts_changed_checksum_without_progress() -> None:
    """No statement completed or started (#233): the edited file runs again."""
    journal = _FakeJournalStore(state=_state(_op("failed", last_error="Memory limit")))
    client = _ScriptedClient(
        statuses=[
            QueryStatus(status="unknown"),
            QueryStatus(status="finished", written_rows=1, duration_ms=100),
        ]
    )
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


def _whole_seconds(after_time: str | None) -> int:
    if after_time is None:
        return 0
    if after_time.startswith("1970"):
        return 0
    return int(datetime.fromisoformat(after_time).timestamp())


class _QueryLogClient(_ScriptedClient):
    """Status answers like system.query_log: query_start_time >= bound, in seconds."""

    def __init__(self, phases: list[str], *, attached_start: int, earlier_start: int,
                 submit_raises: BaseException | None = None) -> None:
        super().__init__(statuses=[], submit_raises=submit_raises)
        self._phases = phases
        self._attached_start = attached_start
        self._earlier_start = earlier_start

    def query_status(
        self,
        _query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
    ) -> QueryStatus:
        self.after_times.append(after_time)
        self.every_replica.append(every_replica)
        phase = self._phases.pop(0) if self._phases else "flushed"
        if phase == "running":
            return QueryStatus(status="running", written_rows=1, elapsed_ms=RUNNING_ELAPSED_MS)
        after_sec = _whole_seconds(after_time)
        if phase == "flushed" and self._attached_start >= after_sec:
            return QueryStatus(status="failed", error="Memory limit exceeded")
        if self._earlier_start >= after_sec:
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
    assert [w.operations[0].status for w in journal.writes] == ["failed"]


@pytest.mark.parametrize("prior", ["none", "abandoned"])
def test_apply_async_new_submission_ignores_earlier_attempt(prior: str) -> None:
    """After --abandon, query_log still holds the earlier attempt's QueryFinish."""
    # The earlier attempt started one 5 s poll interval before this submission.
    stale_start = (SERVER_NOW_MS - 5_000) // 1000
    client = _QueryLogClient(
        ["flush gap"] * 30,
        attached_start=0,
        earlier_start=stale_start,
        submit_raises=RuntimeError("Unknown table expression identifier 'default.src_typo'"),
    )
    state = (
        None
        if prior == "none"
        else _state(
            _op("failed", last_error="abandoned via chkit migrate --abandon (was completed)"),
            checksum="abc",
        ).model_copy(update={"name": "20260101_000000_async.sql"})
    )
    journal = _FakeJournalStore(state=state)
    with pytest.raises(RuntimeError, match="src_typo"):
        apply_async_statement(_input(client=client, journal=journal))
    assert all(after == SUBMISSION_BOUND for after in client.after_times[1:])
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
