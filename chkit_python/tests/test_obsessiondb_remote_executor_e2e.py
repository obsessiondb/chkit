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
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, TypeVar

import httpx
import pytest

from chkit.cli.commands.migrate_async_apply import (
    AsyncApplyInput,
    apply_async_statement,
    make_deterministic_query_id,
)
from chkit.cli.journal_store import MigrationRowState, OperationState
from chkit.clickhouse.client import ClickHouseClient, QueryStatus
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.remote_executor import RemoteClickHouseClient
from tests.e2e_testkit import LiveEnv, create_prefix, get_required_env, quote_ident

T = TypeVar("T")

# migrate's in-flight check reads system.processes on whichever replica
# answers, so on ObsessionDB it can miss the attempt the attach test attaches
# to (#246); the verify job runs it against open-source ClickHouse.
_ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"
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


def _start_workbench(env: LiveEnv) -> ThreadingHTTPServer:
    """Stand in for the workbench API: run each query on the live ClickHouse."""
    auth = (env.clickhouse_user, env.clickhouse_password)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length))["input"]
            params: dict[str, str] = {"default_format": "JSONCompactStrings"}
            for key, value in (payload.get("settings") or {}).items():
                params[key] = str(value)
            response = httpx.post(
                env.clickhouse_url,
                params=params,
                content=payload["query"].encode(),
                auth=auth,
                timeout=120.0,
            )
            body = response.text
            if response.status_code >= httpx.codes.BAD_REQUEST:
                result: dict[str, Any] = {
                    "data": [],
                    "meta": [],
                    "rows": 0,
                    "error": body.strip(),
                }
            elif body.strip() == "":
                result = {"data": [], "meta": [], "rows": 0}
            else:
                parsed = json.loads(body)
                result = {"data": parsed["data"], "meta": parsed["meta"], "rows": parsed["rows"]}
            encoded = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: Any) -> None:
            _ = (format, args)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture
def live_env() -> LiveEnv:
    return get_required_env()


@pytest.fixture
def remote(live_env: LiveEnv) -> Iterator[RemoteClickHouseClient]:
    server = _start_workbench(live_env)
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
        assert journal.statuses() == ["started", "completed"]
        assert apply_async_statement(statement).kind == "skipped"
        rows = _poll_until(
            lambda: int(live.query(f"SELECT toString(count()) AS n FROM {table}").rows[0]["n"]),
            lambda n: n >= 30,
        )
        assert rows == 30
    finally:
        live.execute(f"DROP TABLE IF EXISTS {table}")


class _RecordingRemote:
    """Delegates to the remote client and records each ``after_time``."""

    def __init__(self, inner: RemoteClickHouseClient) -> None:
        self._inner = inner
        self.after_times: list[str | None] = []

    def query(self, statement: str) -> Any:
        return self._inner.query(statement)

    def execute(self, statement: str) -> None:
        self._inner.execute(statement)

    def submit(self, statement: str, query_id: str | None = None) -> str:
        return self._inner.submit(statement, query_id=query_id)

    def query_status(self, query_id: str, *, after_time: str | None = None) -> QueryStatus:
        self.after_times.append(after_time)
        return self._inner.query_status(query_id, after_time=after_time)


@pytest.mark.skipif(
    _ON_OBSESSIONDB,
    reason="system.processes is per replica on ObsessionDB (#246); runs in verify",
)
def test_attach_counts_only_query_log_entries_of_attached_attempt(
    live_env: LiveEnv, remote: RemoteClickHouseClient, live: ClickHouseClient
) -> None:
    """A re-run attaches to a still-running attempt; an earlier attempt finished."""
    prefix = create_prefix("py_remote_attach")
    name = f"{prefix}dst"
    table = _create_table(live, live_env.clickhouse_database, name)
    migration_name = f"20990101000000_{prefix}attach.sql"
    query_id = make_deterministic_query_id(migration_name, 0)
    operation_key = f"table:{live_env.clickhouse_database}.{name}"
    attached_outcome: list[str] = []

    def run_attached() -> None:
        try:
            remote.submit(
                f"INSERT INTO {table} SELECT number + throwIf(number = 12, "
                "'attached attempt failed') + sleepEachRow(0.5) FROM numbers(20) "
                "SETTINGS max_block_size = 1",
                query_id=query_id,
            )
            attached_outcome.append("finished")
        except Exception as error:
            attached_outcome.append(str(error))

    worker = threading.Thread(target=run_attached)
    try:
        remote.submit(f"INSERT INTO {table} SELECT number FROM numbers(2)", query_id=query_id)
        earlier_ended_ms = _read_server_now_ms(live)
        earlier = _poll_until(
            lambda: remote.query_status(query_id),
            lambda status: status.status == "finished",
        )
        assert earlier.status == "finished"
        # Start the attached attempt well past the bound's 2 s margin.
        time.sleep(4)
        # Fails after about 6 s: one row per block, 0.5 s per row.
        worker.start()
        _poll_until(
            lambda: remote.query_status(query_id),
            lambda status: status.status == "running",
            interval=0.1,
        )

        recording = _RecordingRemote(remote)
        started = OperationState.model_validate(
            {
                "operationIndex": 0,
                "operationKey": operation_key,
                "operationType": "load_table_data",
                "queryId": query_id,
                "status": "started",
                "startedAt": "2026-10-02 00:00:00.000",
                "finishedAt": None,
                "lastError": "",
            }
        )
        journal = _MemoryJournal(
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
        with pytest.raises(RuntimeError, match="attached attempt failed"):
            apply_async_statement(statement)
        assert any("attaching to in-flight query" in line for line in lines)
        assert journal.statuses() == ["failed"]
        worker.join(timeout=60)
        assert "attached attempt failed" in attached_outcome[0]

        # The in-flight check looks for any running query with the id. Every
        # poll after it counts only queries that started after the earlier
        # attempt had ended.
        in_flight_check, *polls = recording.after_times
        assert in_flight_check is None
        assert polls
        assert len(set(polls)) == 1
        assert polls[0] is not None
        bound_ms = datetime.fromisoformat(polls[0]).timestamp() * 1000
        assert bound_ms > earlier_ended_ms
    finally:
        if worker.is_alive():
            worker.join(timeout=60)
        live.execute(f"DROP TABLE IF EXISTS {table}")
