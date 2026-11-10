"""An async load's submit does not block its polling.

``chkit migrate --apply`` sends an async statement without waiting for its
HTTP response and polls the server meanwhile, as the TS CLI does: progress
lines come while the load runs. The submit request holds its HTTP session
until the query ends, so it runs in a session of its own; sent in the session
the polls use, a poll would fail with ``Session ... is locked by a concurrent
client`` (or the driver's own concurrent-session error).

Runs against the server in ``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST``; an
unreachable server fails the test.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from chkit.clickhouse.client import ClickHouseClient, QueryStatus
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    poll_until,
    quote_ident,
    resolve_live_env,
    wait_for_table_on_every_replica,
)

_ROWS = 12
_CLI_TIMEOUT_SECONDS = 120.0


@dataclass
class Fixture:
    dir: Path
    database: str
    journal_table: str
    client: ClickHouseClient


def _connect(database: str) -> ClickHouseClient:
    env = resolve_live_env()
    return ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    )


def _load_sql(table: str, seconds_per_row: float) -> str:
    return (
        f"INSERT INTO {table} SELECT number FROM numbers({_ROWS}) "
        f"WHERE sleepEachRow({seconds_per_row}) = 0 SETTINGS max_block_size = 1"
    )


@pytest.fixture
def fixture() -> Iterator[Fixture]:
    env = resolve_live_env()
    prefix = create_prefix("py_async_submit")
    database = f"{prefix}db"
    dir_ = Path(tempfile.mkdtemp(prefix="chkit-py-async-submit-e2e-"))
    client = _connect(env.clickhouse_database)
    try:
        client.execute(f"CREATE DATABASE {quote_ident(database)}")
        client.execute(
            f"CREATE TABLE {quote_ident(database)}.events (id UInt64) "
            "ENGINE = MergeTree ORDER BY id"
        )
        wait_for_table_on_every_replica(client, database, "events")
        yield Fixture(
            dir=dir_,
            database=database,
            journal_table=create_journal_table_name("py_async_submit"),
            client=client,
        )
    finally:
        client.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        client.close()
        shutil.rmtree(dir_, ignore_errors=True)


def _count_events(fixture: Fixture) -> int:
    sql = f"SELECT count() AS n FROM {quote_ident(fixture.database)}.events"
    return poll_until(
        lambda: int(fixture.client.query(sql).rows[0]["n"]),
        lambda rows: rows == _ROWS,
        timeout=10.0,
    )


def test_a_client_polls_its_own_submitted_query_while_the_submit_is_open(
    fixture: Fixture,
) -> None:
    client = _connect(fixture.database)
    query_id = str(uuid.uuid4())
    errors: list[BaseException] = []

    def submit() -> None:
        try:
            client.submit(_load_sql("events", 0.5), query_id=query_id)
        except BaseException as error:  # reported by the assertion below
            errors.append(error)

    submitter = threading.Thread(target=submit)
    submitter.start()
    try:
        # Not poll_until: a poll error (a locked session) must fail the test.
        deadline = time.monotonic() + 10.0
        status = client.query_status(query_id)
        while status.status != "running" and time.monotonic() < deadline:
            time.sleep(0.2)
            status = client.query_status(query_id)
        assert status.status == "running", (status, errors)
        # The submit is still open: its query runs for about 6 s.
        assert submitter.is_alive(), errors
        finished: QueryStatus = poll_until(
            lambda: client.query_status(query_id),
            lambda found: found.status == "finished",
            timeout=60.0,
            interval=0.5,
        )
        assert finished.status == "finished", finished
    finally:
        submitter.join(timeout=60)
        client.close()
    assert errors == []
    assert _count_events(fixture) == _ROWS


def _config_source(dir_: Path, database: str) -> str:
    env = resolve_live_env()
    # The password reaches the CLI through its environment, not the file.
    return f"""
import os

from chkit import define_config

config = define_config(
    {{
        "schema": "{dir_}/schema.py",
        "outDir": "{dir_}/chkit",
        "migrationsDir": "{dir_}/chkit/migrations",
        "metaDir": "{dir_}/chkit/meta",
        "clickhouse": {{
            "url": "{env.clickhouse_url}",
            "username": "{env.clickhouse_user}",
            "password": os.environ["CHKIT_E2E_PASSWORD"],
            "database": "{database}",
        }},
    }}
)
"""


def test_migrate_prints_progress_while_the_load_runs(fixture: Fixture) -> None:
    migrations = fixture.dir / "chkit/migrations"
    migrations.mkdir(parents=True)
    # About 12 s, so the 5 s polls find it running.
    (migrations / "20990101000000_load.sql").write_text(
        "-- operation: load_table_data key=table:events risk=caution mode=async\n"
        f"{_load_sql('events', 1)};\n",
        encoding="utf-8",
    )
    config = fixture.dir / "clickhouse.config.py"
    config.write_text(_config_source(fixture.dir, fixture.database), encoding="utf-8")
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "chkit.cli.main",
            "migrate",
            "--config",
            str(config),
            "--apply",
            "--json",
        ],
        cwd=fixture.dir,
        env={
            **os.environ,
            "CHKIT_JOURNAL_TABLE": fixture.journal_table,
            "CI": "1",
            "CHKIT_E2E_PASSWORD": resolve_live_env().clickhouse_password,
            "XDG_CONFIG_HOME": str(fixture.dir / "xdg"),
        },
        capture_output=True,
        text=True,
        timeout=_CLI_TIMEOUT_SECONDS,
        check=False,
    )
    diagnostic = f"exit {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert result.returncode == 0, diagnostic
    lines = result.stderr.splitlines()
    progress = [line for line in lines if "load_table_data: written=" in line]
    finished = [i for i, line in enumerate(lines) if "load_table_data: finished" in line]
    assert progress, diagnostic
    assert finished, diagnostic
    assert lines.index(progress[0]) < finished[0], diagnostic
    assert "poll request failed" not in result.stderr, diagnostic
    assert _count_events(fixture) == _ROWS
