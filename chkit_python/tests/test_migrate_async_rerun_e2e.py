"""Async migrate re-run of a started step (#672).

Port of ``packages/cli/src/test/migrate-async-rerun.e2e.test.ts``: a run can
leave an async step started although its load finished on the server. A
re-run reads the attempt's outcome from ``system.query_log`` instead of
submitting the load again.

The first run is killed, so the CLI runs in subprocesses (``python -m
chkit.cli.main``) instead of ``CliRunner``. Runs against the server in
``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST``; an unreachable server fails the test.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    held_lock_claim,
    poll_until,
    quote_ident,
    resolve_live_env,
    wait_for_table_on_every_replica,
)

_ROWS = 16
_CLI_TIMEOUT_SECONDS = 120.0
_POLL_TIMEOUT_SECONDS = 90.0


@dataclass(frozen=True)
class CliResult:
    exit_code: int
    stdout: str
    stderr: str


@dataclass
class Fixture:
    dir: Path
    database: str
    journal_table: str
    migration: str
    client: ClickHouseClient


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


@pytest.fixture
def make_fixture() -> Iterator[Fixture]:
    env = resolve_live_env()
    prefix = create_prefix("py_rerun")
    dir_ = Path(tempfile.mkdtemp(prefix="chkit-py-rerun-e2e-"))
    database = f"{prefix}db"
    migration = f"20990101000000_{prefix}load.sql"
    (dir_ / "chkit/migrations").mkdir(parents=True)
    # About 4 s at 0.25 s per row. No before-retry SQL, so a resubmission
    # would load the rows a second time.
    (dir_ / "chkit/migrations" / migration).write_text(
        "-- operation: load_table_data key=table:events risk=caution mode=async\n"
        f"INSERT INTO events SELECT number FROM numbers({_ROWS}) "
        "WHERE sleepEachRow(0.25) = 0 SETTINGS max_block_size = 1;\n",
        encoding="utf-8",
    )
    (dir_ / "clickhouse.config.py").write_text(_config_source(dir_, database), encoding="utf-8")
    client = ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    )
    fixture = Fixture(
        dir=dir_,
        database=database,
        journal_table=create_journal_table_name("py_rerun"),
        migration=migration,
        client=client,
    )
    try:
        db = quote_ident(database)
        client.execute(f"CREATE DATABASE {db}")
        client.execute(f"CREATE TABLE {db}.events (id UInt64) ENGINE = MergeTree ORDER BY id")
        wait_for_table_on_every_replica(client, database, "events")
        yield fixture
    finally:
        client.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        client.close()
        shutil.rmtree(dir_, ignore_errors=True)


def _start(fixture: Fixture, extra_args: tuple[str, ...] = ()) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "chkit.cli.main",
            "migrate",
            "--config",
            str(fixture.dir / "clickhouse.config.py"),
            "--execute",
            "--json",
            *extra_args,
        ],
        cwd=fixture.dir,
        env={
            **os.environ,
            "CHKIT_JOURNAL_TABLE": fixture.journal_table,
            "CI": "1",
            "CHKIT_E2E_PASSWORD": resolve_live_env().clickhouse_password,
            # An empty config home, so a user profile config cannot change the run.
            "XDG_CONFIG_HOME": str(fixture.dir / "xdg"),
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _wait(process: subprocess.Popen[str]) -> CliResult:
    stdout, stderr = process.communicate(timeout=_CLI_TIMEOUT_SECONDS)
    return CliResult(exit_code=process.returncode, stdout=stdout, stderr=stderr)


def _diagnostic(label: str, result: CliResult) -> str:
    return (
        f"--- {label} (exit {result.exit_code}) ---\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )


def _journal(fixture: Fixture) -> tuple[str, str]:
    rows = fixture.client.query(
        "SELECT arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses, "
        "operations[1].query_id AS query_id "
        f"FROM {quote_ident(fixture.database)}.{quote_ident(fixture.journal_table)} "
        f"FINAL WHERE name = '{fixture.migration}' SETTINGS select_sequential_consistency = 1"
    ).rows
    if not rows:
        return "", ""
    return str(rows[0]["statuses"]), str(rows[0]["query_id"])


def test_a_rerun_records_the_finished_load_of_its_killed_run_without_loading_it_again(
    make_fixture: Fixture,
) -> None:
    fixture = make_fixture
    killed = _start(fixture)
    started = poll_until(
        lambda: _journal(fixture),
        lambda value: value[0] == "started",
        timeout=_POLL_TIMEOUT_SECONDS,
        interval=0.25,
    )
    assert started[0] == "started", started
    query_id = started[1]
    running = poll_until(
        lambda: fixture.client.query_status(query_id, every_replica=True),
        lambda found: found.status == "running",
        timeout=10.0,
        interval=0.1,
    )
    assert running.status == "running"
    killed.kill()
    assert _wait(killed).exit_code != 0
    # The load goes on without the run and ends; query_log has its QueryFinish.
    finished = poll_until(
        lambda: fixture.client.query_status(query_id, every_replica=True),
        lambda found: found.status == "finished",
        timeout=60.0,
        interval=0.5,
    )
    assert finished.status == "finished"
    assert _journal(fixture)[0] == "started"

    # The killed run still holds the migrate lock (#716).
    claim = held_lock_claim(fixture.client, fixture.database, fixture.journal_table)
    rerun = _wait(_start(fixture, ("--break-lock", claim)))
    assert rerun.exit_code == 0, _diagnostic("re-run", rerun)
    assert f"previous attempt of query_id={query_id} finished on the server" in rerun.stderr
    assert "resubmitting" not in rerun.stderr
    assert _journal(fixture)[0] == "completed"
    count = fixture.client.query(
        f"SELECT count() AS n FROM {quote_ident(fixture.database)}.events"
    ).rows[0]["n"]
    assert int(count) == _ROWS


def test_a_rerun_right_after_the_load_of_its_killed_run_ended_waits_for_its_query_log_entry(
    make_fixture: Fixture,
) -> None:
    """#701: query_log is flushed on a timer (7.5 s by default), so right after
    the load ends it is neither running nor in query_log. The re-run checks
    again while query_log is flushed instead of loading the rows again."""
    fixture = make_fixture
    killed = _start(fixture)
    started = poll_until(
        lambda: _journal(fixture),
        lambda value: value[0] == "started",
        timeout=_POLL_TIMEOUT_SECONDS,
        interval=0.25,
    )
    assert started[0] == "started", started
    query_id = started[1]
    running = poll_until(
        lambda: fixture.client.query_status(query_id, every_replica=True, running_only=True),
        lambda found: found.status == "running",
        timeout=10.0,
        interval=0.1,
    )
    assert running.status == "running"
    killed.kill()
    assert _wait(killed).exit_code != 0
    # The load ends; re-run as soon as no replica runs it.
    ended = poll_until(
        lambda: fixture.client.query_status(query_id, every_replica=True, running_only=True),
        lambda found: found.status != "running",
        timeout=60.0,
        interval=0.1,
    )
    assert ended.status != "running"

    claim = held_lock_claim(fixture.client, fixture.database, fixture.journal_table)
    rerun = _wait(_start(fixture, ("--break-lock", claim)))
    assert rerun.exit_code == 0, _diagnostic("re-run", rerun)
    assert f"previous attempt of query_id={query_id} finished on the server" in rerun.stderr
    assert "resubmitting" not in rerun.stderr
    assert _journal(fixture)[0] == "completed"
    count = fixture.client.query(
        f"SELECT count() AS n FROM {quote_ident(fixture.database)}.events"
    ).rows[0]["n"]
    assert int(count) == _ROWS
