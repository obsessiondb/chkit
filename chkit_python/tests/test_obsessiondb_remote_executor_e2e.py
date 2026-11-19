"""Live coverage of ``RemoteClickHouseClient.query_status`` and async migrate (#233).

Ports of ``packages/plugin-obsessiondb/src/query/remote-executor.e2e.test.ts``
and ``packages/cli/src/test/migrate-async-remote.e2e.test.ts``.

chkit migrate polls an async statement through ``query_status``. It only
counts query_log entries of queries that started at or after a bound taken
from the server clock, and it bounds an attach by the running attempt's
elapsed time. A stand-in for the ObsessionDB workbench API runs each query on
the live ClickHouse and returns every cell as a string, as the API does, so
the SQL the remote executor builds meets a real server.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import replace
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, TypeVar

import httpx
import pytest

from chkit.cli.commands.migrate_async_apply import (
    ATTEMPT_RECORD_MARKER,
    AsyncApplyInput,
    apply_async_statement,
    make_deterministic_query_id,
)
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.journal_store import MigrationRowState, OperationState
from chkit.clickhouse.client import ClickHouseClient, QueryStatus
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.remote_executor import RemoteClickHouseClient
from tests.e2e_testkit import LiveEnv, create_prefix, quote_ident, resolve_live_env

T = TypeVar("T")

_MIGRATION_CHECKSUM = "c1"


def _poll_until(
    read: Callable[[], T],
    done: Callable[[T], bool],
    *,
    timeout: float = 60.0,
    interval: float = 0.5,
) -> T:
    deadline = time.monotonic() + timeout
    last = read()
    while not done(last):
        if time.monotonic() > deadline:
            msg = f"timed out polling; last value: {last!r}"
            raise AssertionError(msg)
        time.sleep(interval)
        last = read()
    return last


def _run_on_live(env: LiveEnv, payload: dict[str, Any]) -> dict[str, Any]:
    params: dict[str, str] = {"default_format": "JSONCompactStrings"}
    # Like the real API: the query runs under the top-level queryId, and a
    # query_id setting is ignored.
    for key, value in (payload.get("settings") or {}).items():
        if key != "query_id":
            params[key] = str(value)
    if payload.get("queryId"):
        params["query_id"] = payload["queryId"]
    response = httpx.post(
        env.clickhouse_url,
        params=params,
        content=payload["query"].encode(),
        auth=(env.clickhouse_user, env.clickhouse_password),
        timeout=120.0,
    )
    body = response.text
    if response.status_code >= httpx.codes.BAD_REQUEST:
        return {"data": [], "meta": [], "rows": 0, "error": body.strip()}
    if body.strip() == "":
        return {"data": [], "meta": [], "rows": 0}
    parsed = json.loads(body)
    return {"data": parsed["data"], "meta": parsed["meta"], "rows": parsed["rows"]}


def _start_workbench(
    env: LiveEnv, *, query_log_after_submit: bool = False
) -> ThreadingHTTPServer:
    """Stand in for the workbench API: run each query on the live ClickHouse.

    ``query_log_after_submit`` fails ``system.query_log`` reads until a
    statement is submitted, as on a fresh server, which creates the table on
    its first log flush.
    """
    submitted = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length))["json"]
            if payload.get("queryId"):
                submitted.set()
            if (
                query_log_after_submit
                and not submitted.is_set()
                and "system.query_log" in payload["query"]
            ):
                error = (
                    "Code: 60. DB::Exception: Unknown table expression identifier "
                    "'system.query_log'. (UNKNOWN_TABLE)"
                )
                result: dict[str, Any] = {"data": [], "meta": [], "rows": 0, "error": error}
            else:
                result = _run_on_live(env, payload)
            encoded = json.dumps({"json": result}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: Any) -> None:
            _ = (format, args)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    return server


@pytest.fixture
def live_env() -> LiveEnv:
    return resolve_live_env()


@pytest.fixture
def remote(live_env: LiveEnv) -> Iterator[RemoteClickHouseClient]:
    yield from _serve_remote(live_env)


@pytest.fixture
def fresh_remote(live_env: LiveEnv) -> Iterator[RemoteClickHouseClient]:
    yield from _serve_remote(live_env, query_log_after_submit=True)


def _serve_remote(
    env: LiveEnv, *, query_log_after_submit: bool = False
) -> Iterator[RemoteClickHouseClient]:
    server = _start_workbench(env, query_log_after_submit=query_log_after_submit)
    host, port = server.server_address[0], server.server_address[1]
    try:
        yield RemoteClickHouseClient(
            credentials=Credentials(access_token="test", base_url=f"http://{host!s}:{port}"),
            service_slug="test",
        )
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def live(live_env: LiveEnv) -> Iterator[ClickHouseClient]:
    with ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=live_env.clickhouse_url,
            username=live_env.clickhouse_user,
            password=live_env.clickhouse_password,
            database=live_env.clickhouse_database,
            secure=live_env.clickhouse_url.startswith("https:"),
        )
    ) as client:
        yield client


def _read_server_now_ms(client: RemoteClickHouseClient | ClickHouseClient) -> int:
    rows = client.query("SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms").rows
    return int(rows[0]["now_ms"])


def _iso(ms: int) -> str:
    return (
        datetime.fromtimestamp(ms / 1000, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _create_table(live: ClickHouseClient, database: str, name: str) -> str:
    table = f"{quote_ident(database)}.{quote_ident(name)}"
    live.execute(f"CREATE TABLE {table} (n UInt64) ENGINE = MergeTree ORDER BY n")
    wait_for_table(live, database, name)
    return table


def test_query_status_reads_iso_bounds_and_counts_only_later_queries(
    live_env: LiveEnv, remote: RemoteClickHouseClient, live: ClickHouseClient
) -> None:
    name = f"{create_prefix('py_remote_status')}t"
    query_id = str(uuid.uuid4())
    table = _create_table(live, live_env.clickhouse_database, name)
    try:
        submitted_at_ms = _read_server_now_ms(remote)
        remote.submit(f"INSERT INTO {table} SELECT number FROM numbers(3)", query_id=query_id)

        # A new submission's bound: the server time before it, minus a margin.
        submission_bound = _iso(submitted_at_ms - 2_000)
        finished = _poll_until(
            lambda: remote.query_status(query_id, after_time=submission_bound),
            lambda status: status.status == "finished",
        )
        assert (finished.status, finished.written_rows) == ("finished", 3)

        # The query started before this bound, so its entry does not count.
        later_bound = _iso(submitted_at_ms + 60_000)
        assert remote.query_status(query_id, after_time=later_bound) == QueryStatus(
            status="unknown"
        )
        # The unbounded lookup of an attach that has no elapsed time. Poll like
        # migrate does: query_log is per replica, and on a multi-replica service
        # a single request can land on a replica that never ran the query.
        unbounded = _poll_until(
            lambda: remote.query_status(query_id, after_time="1970-01-01 00:00:00"),
            lambda status: status.status == "finished",
        )
        assert (unbounded.status, unbounded.written_rows) == ("finished", 3)
    finally:
        live.execute(f"DROP TABLE IF EXISTS {table}")


def test_query_status_reports_running_elapsed_ms(remote: RemoteClickHouseClient) -> None:
    query_id = str(uuid.uuid4())
    submitted_at = time.monotonic()
    # About 3 s: one row per block, 0.3 s per row.
    worker = threading.Thread(
        target=remote.submit,
        args=("SELECT sleepEachRow(0.3) FROM numbers(10) SETTINGS max_block_size = 1",),
        kwargs={"query_id": query_id},
    )
    worker.start()
    try:
        running = _poll_until(
            lambda: remote.query_status(query_id),
            lambda status: status.status == "running" and (status.elapsed_ms or 0) >= 1_000,
            interval=0.1,
        )
        wall_ms = (time.monotonic() - submitted_at) * 1000
        assert running.status == "running"
        assert running.elapsed_ms is not None
        assert 1_000 <= running.elapsed_ms <= wall_ms
    finally:
        worker.join(timeout=60)


class _MemoryJournal:
    def __init__(self, initial: MigrationRowState | None) -> None:
        self.state = initial
        self.writes: list[MigrationRowState] = []

    def read_migration_state(self, _name: str) -> MigrationRowState | None:
        return self.state

    def read_stored_operation(self, _name: str, index: int) -> OperationState | None:
        if self.state is None:
            return None
        return next((op for op in self.state.operations if op.operation_index == index), None)

    def write_migration_state(self, state: MigrationRowState) -> None:
        self.writes.append(state)
        self.state = state

    def statuses(self) -> list[str]:
        return [w.operations[0].status for w in self.writes]


def _statement(
    *,
    client: Any,
    journal: _MemoryJournal,
    migration_name: str,
    sql: str,
    operation_key: str,
    log: Callable[[str], None] = lambda _line: None,
) -> AsyncApplyInput:
    return AsyncApplyInput(
        client=client,
        journal_store=journal,  # type: ignore[arg-type]
        sql=sql,
        migration_name=migration_name,
        migration_checksum=_MIGRATION_CHECKSUM,
        statement_index=0,
        operation_type="load_table_data",
        operation_key=operation_key,
        fingerprint="",
        before_retry=None,
        log=log,
        poll_interval_seconds=0.25,
    )


def test_async_submission_completes_and_rerun_skips(
    live_env: LiveEnv, remote: RemoteClickHouseClient, live: ClickHouseClient
) -> None:
    prefix = create_prefix("py_remote_submit")
    name = f"{prefix}dst"
    table = _create_table(live, live_env.clickhouse_database, name)
    journal = _MemoryJournal(None)
    statement = _statement(
        client=remote,
        journal=journal,
        migration_name=f"20990101000000_{prefix}load.sql",
        operation_key=f"table:{live_env.clickhouse_database}.{name}",
        # About 1.5 s.
        sql=(
            f"INSERT INTO {table} SELECT number FROM numbers(30) "
            "WHERE sleepEachRow(0.05) = 0 SETTINGS max_block_size = 1"
        ),
    )
    try:
        assert apply_async_statement(statement).kind == "completed"
        assert journal.statuses() == ["started", "started", "completed"]
        assert apply_async_statement(statement).kind == "skipped"
        rows = _poll_until(
            lambda: int(live.query(f"SELECT toString(count()) AS n FROM {table}").rows[0]["n"]),
            lambda n: n >= 30,
        )
        assert rows == 30
    finally:
        live.execute(f"DROP TABLE IF EXISTS {table}")


def test_first_submission_completes_without_query_log(
    live_env: LiveEnv, fresh_remote: RemoteClickHouseClient, live: ClickHouseClient
) -> None:
    """The in-flight check runs before the first submission, when a fresh
    server can still lack system.query_log (OBS-176)."""
    prefix = create_prefix("py_remote_fresh")
    name = f"{prefix}dst"
    table = _create_table(live, live_env.clickhouse_database, name)
    journal = _MemoryJournal(None)
    statement = _statement(
        client=fresh_remote,
        journal=journal,
        migration_name=f"20990101000000_{prefix}fresh.sql",
        operation_key=f"table:{live_env.clickhouse_database}.{name}",
        sql=f"INSERT INTO {table} SELECT number FROM numbers(3)",
    )
    try:
        assert apply_async_statement(statement).kind == "completed"
        assert journal.statuses() == ["started", "started", "completed"]
        rows = _poll_until(
            lambda: int(live.query(f"SELECT toString(count()) AS n FROM {table}").rows[0]["n"]),
            lambda n: n >= 3,
        )
        assert rows == 3
    finally:
        live.execute(f"DROP TABLE IF EXISTS {table}")


def test_a_statement_the_server_rejects_is_recorded_failed_from_its_query_log_entry(
    live_env: LiveEnv, remote: RemoteClickHouseClient, live: ClickHouseClient
) -> None:
    """#767: a statement the server rejects before it starts has no
    QueryFinish; query_log records its ExceptionBeforeStart under the
    attempt's id, which is the failure that lets a re-run run it again."""
    prefix = create_prefix("py_remote_rejected")
    name = f"{prefix}dst"
    table = _create_table(live, live_env.clickhouse_database, name)
    journal = _MemoryJournal(None)
    statement = _statement(
        client=remote,
        journal=journal,
        migration_name=f"20990101000000_{prefix}rejected.sql",
        operation_key=f"table:{live_env.clickhouse_database}.{name}",
        # A syntax error: the server rejects it before it starts.
        sql=f"INSERT INTO {table} SELEC number FROM numbers(3)",
    )
    try:
        with pytest.raises(RuntimeError, match="SYNTAX_ERROR"):
            apply_async_statement(statement)
        assert journal.statuses() == ["started", "started", "failed"]
    finally:
        live.execute(f"DROP TABLE IF EXISTS {table}")


class _RecordingRemote:
    """Delegates to the remote client and records each status call."""

    def __init__(self, inner: RemoteClickHouseClient) -> None:
        self._inner = inner
        self.after_times: list[str | None] = []
        self.status_ids: list[str] = []

    def query(self, statement: str) -> Any:
        return self._inner.query(statement)

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        self._inner.execute(statement, settings=settings)

    def submit(
        self,
        statement: str,
        query_id: str | None = None,
        settings: dict[str, Any] | None = None,
        *,
        before_send: Any = None,
    ) -> str:
        return self._inner.submit(statement, query_id=query_id, settings=settings)

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
        return self._inner.query_status(
            query_id,
            after_time=after_time,
            every_replica=every_replica,
            running_only=running_only,
        )


def _started_journal(
    migration_name: str,
    query_id: str,
    operation_key: str,
    *,
    started_at: str = "2026-10-02 00:00:00.000",
    fenced: bool = False,
) -> _MemoryJournal:
    """What a run that lost its connection while the statement ran leaves
    behind: by default, a record an earlier release wrote."""
    started = OperationState.model_validate(
        {
            "operationIndex": 0,
            "operationKey": operation_key,
            "operationType": "load_table_data",
            "queryId": query_id,
            "status": "started",
            "startedAt": started_at,
            "finishedAt": None,
            "lastError": ATTEMPT_RECORD_MARKER if fenced else "",
            "fingerprint": "",
            "attemptFenced": fenced,
        }
    )
    return _MemoryJournal(
        MigrationRowState.model_validate(
            {
                "name": migration_name,
                "appliedAt": "1970-01-01 00:00:00.000",
                "checksum": _MIGRATION_CHECKSUM,
                "chkitVersion": "",
                "migrationCompleted": False,
                "operations": [started],
            }
        )
    )


def test_an_attach_polls_only_the_id_its_fenced_record_names(
    live_env: LiveEnv, remote: RemoteClickHouseClient, live: ClickHouseClient
) -> None:
    """A re-run attaches to a still-running attempt. An earlier attempt
    finished before under the id earlier releases gave a first attempt. The
    attached attempt's id is its own, recorded fenced before its submit
    (#767), so its polls read that id only and the earlier QueryFinish never
    counts."""
    prefix = create_prefix("py_remote_attach")
    name = f"{prefix}dst"
    table = _create_table(live, live_env.clickhouse_database, name)
    migration_name = f"20990101000000_{prefix}attach.sql"
    earlier_id = make_deterministic_query_id(
        live_env.clickhouse_database, "_chkit_migrations", migration_name, 0
    )
    attached_id = str(uuid.uuid4())
    operation_key = f"table:{live_env.clickhouse_database}.{name}"
    attached_outcome: list[str] = []

    def run_attached() -> None:
        try:
            remote.submit(
                f"INSERT INTO {table} SELECT number + throwIf(number = 12, "
                "'attached attempt failed') + sleepEachRow(0.5) FROM numbers(20) "
                "SETTINGS max_block_size = 1",
                query_id=attached_id,
            )
            attached_outcome.append("finished")
        except Exception as error:
            attached_outcome.append(str(error))

    worker = threading.Thread(target=run_attached)
    try:
        remote.submit(f"INSERT INTO {table} SELECT number FROM numbers(2)", query_id=earlier_id)
        earlier = _poll_until(
            lambda: remote.query_status(earlier_id),
            lambda status: status.status == "finished",
        )
        assert earlier.status == "finished"
        attached_start_ms = _read_server_now_ms(live)
        # Fails after about 6 s: one row per block, 0.5 s per row.
        worker.start()
        _poll_until(
            lambda: remote.query_status(attached_id),
            lambda status: status.status == "running",
            interval=0.1,
        )

        recording = _RecordingRemote(remote)
        started_at = datetime.fromtimestamp(attached_start_ms / 1000, tz=UTC).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3]
        journal = _started_journal(
            migration_name, attached_id, operation_key, started_at=started_at, fenced=True
        )
        lines: list[str] = []
        statement = _statement(
            client=recording,
            journal=journal,
            migration_name=migration_name,
            operation_key=operation_key,
            # Never submitted: chkit attaches to the running attempt.
            sql="SELECT 1",
            log=lines.append,
        )
        # It failed while it ran (#767): a re-run stops until a reconcile.
        with pytest.raises(MigrateError, match="attached attempt failed") as info:
            apply_async_statement(statement)
        assert info.value.code == "async_outcome_unknown"
        assert any("attaching to in-flight query" in line for line in lines)
        # The attach writes nothing, and a failure while it ran (#767) writes
        # nothing either: the fenced started record keeps the attempt.
        assert journal.statuses() == []
        worker.join(timeout=60)
        assert "attached attempt failed" in attached_outcome[0]

        # Every check and poll reads the attached attempt's id, from an hour
        # before its recorded start, which only lets query_log prune.
        assert len(recording.status_ids) > 1
        assert set(recording.status_ids) == {attached_id}
        assert set(recording.after_times) == {_iso(attached_start_ms - 3_600_000)}
    finally:
        if worker.is_alive():
            worker.join(timeout=60)
        live.execute(f"DROP TABLE IF EXISTS {table}")


def test_a_running_attempt_under_a_record_an_earlier_release_wrote_stops_the_run(
    live_env: LiveEnv, remote: RemoteClickHouseClient, live: ClickHouseClient
) -> None:
    """#767: a record an earlier release wrote names an id that earlier
    attempts may share, so chkit cannot tell the running attempt's outcome
    from query_log once it ends. The run stops instead of attaching."""
    prefix = create_prefix("py_remote_legacy")
    name = f"{prefix}dst"
    table = _create_table(live, live_env.clickhouse_database, name)
    migration_name = f"20990101000000_{prefix}legacy.sql"
    legacy_id = make_deterministic_query_id(
        live_env.clickhouse_database, "_chkit_migrations", migration_name, 0
    )
    operation_key = f"table:{live_env.clickhouse_database}.{name}"
    # About 5 s: one row per block, 0.5 s per row.
    worker = threading.Thread(
        target=lambda: remote.submit(
            f"INSERT INTO {table} SELECT number + sleepEachRow(0.5) FROM numbers(10) "
            "SETTINGS max_block_size = 1",
            query_id=legacy_id,
        )
    )
    try:
        worker.start()
        _poll_until(
            lambda: remote.query_status(legacy_id),
            lambda status: status.status == "running",
            interval=0.1,
        )
        journal = _started_journal(migration_name, legacy_id, operation_key)
        statement = _statement(
            client=remote,
            journal=journal,
            migration_name=migration_name,
            operation_key=operation_key,
            sql="SELECT 1",
        )
        with pytest.raises(MigrateError) as info:
            apply_async_statement(statement)
        assert info.value.code == "async_outcome_unknown"
        assert f"query_id {legacy_id}) is still running on the server" in info.value.message
        assert journal.statuses() == []
    finally:
        worker.join(timeout=60)
        live.execute(f"DROP TABLE IF EXISTS {table}")


# ObsessionDB users have no CREATE USER (or any access-management) grant
# (#430), so this test runs in verify, against the local stack, only.
_ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"


@pytest.mark.skipif(_ON_OBSESSIONDB, reason="ObsessionDB users have no CREATE USER grant (#430)")
def test_no_write_is_an_asynchronous_insert_under_a_fire_and_forget_profile(
    live_env: LiveEnv, live: ClickHouseClient
) -> None:
    """Port of the TS write-settings test in ``remote-executor.e2e.test.ts``.

    A write through the console API is stored when it returns, also for a
    service whose profile turns on fire-and-forget async inserts, as with a
    direct connection (``test_clickhouse_write_settings_e2e.py``).
    """
    prefix = create_prefix("remote_write_settings_py")
    user = f"{prefix}user"
    password = "Pw-remote-write-settings"
    name = f"{prefix}t"
    table = _create_table(live, live_env.clickhouse_database, name)
    try:
        live.execute(
            f"CREATE USER {quote_ident(user)} IDENTIFIED BY '{password}' SETTINGS "
            "async_insert = 1, wait_for_async_insert = 0, "
            "async_insert_use_adaptive_busy_timeout = 0, async_insert_busy_timeout_max_ms = 30000"
        )
        live.execute(f"GRANT SELECT, INSERT ON {table} TO {quote_ident(user)}")
        as_user = replace(live_env, clickhouse_user=user, clickhouse_password=password)

        def count() -> str:
            return str(live.query(f"SELECT toString(count()) AS n FROM {table}").rows[0]["n"])

        counts: list[str] = []
        for remote in _serve_remote(as_user):
            # Each write is counted right after it returns: a buffered insert
            # would wait out the profile's 30 s flush timeout.
            remote.execute(f"INSERT INTO {table} VALUES (1)")
            counts.append(count())
            remote.insert(f"{live_env.clickhouse_database}.{name}", [{"n": 2}])
            counts.append(count())
            remote.execute_tracked(
                f"INSERT INTO {table} VALUES (3)", lambda: None, lambda: str(uuid.uuid4())
            )
            counts.append(count())
            remote.submit(f"INSERT INTO {table} VALUES (4)", str(uuid.uuid4()))
            counts.append(count())
        assert counts == ["1", "2", "3", "4"]
    finally:
        live.execute(f"DROP USER IF EXISTS {quote_ident(user)}")
        live.execute(f"DROP TABLE IF EXISTS {table} SYNC")
