"""Async migrate statements across databases (#463).

Port of ``packages/cli/src/test/migrate-async-query-id.e2e.test.ts``: one
migrations folder applied to two databases on one server. Each run's async
load must run its own query: a run never attaches to, or takes the result of,
the other database's query of the same statement.

The runs overlap, so the CLI runs in subprocesses (``python -m
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
from typing import Literal

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
# About 8 s at 0.5 s per row, so the other run starts while it still runs.
# It fails on row _FAIL_AT in a database whose fail_marker has a row.
_FAIL_AT = 12
_CLI_TIMEOUT_SECONDS = 120.0
_POLL_TIMEOUT_SECONDS = 90.0

Target = Literal["staging", "prod"]


@dataclass(frozen=True)
class CliResult:
    exit_code: int
    stdout: str
    stderr: str


@dataclass
class Fixture:
    dir: Path
    databases: dict[Target, str]
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
    prefix = create_prefix("py_qid")
    dir_ = Path(tempfile.mkdtemp(prefix="chkit-py-qid-e2e-"))
    databases: dict[Target, str] = {"staging": f"{prefix}staging", "prod": f"{prefix}prod"}
    # One file name for both databases, unique to this run.
    migration = f"20990101000000_{prefix}load.sql"
    (dir_ / "chkit/migrations").mkdir(parents=True)
    (dir_ / "chkit/migrations" / migration).write_text(
        "-- operation: load_table_data key=table:events risk=caution mode=async\n"
        "-- before-retry: TRUNCATE TABLE events\n"
        f"INSERT INTO events SELECT number + throwIf(number = {_FAIL_AT} AND "
        "(SELECT count() FROM fail_marker) > 0, 'failure in this database') "
        f"FROM numbers({_ROWS}) WHERE sleepEachRow(0.5) = 0 SETTINGS max_block_size = 1;\n",
        encoding="utf-8",
    )
    for target, database in databases.items():
        (dir_ / f"{target}.config.py").write_text(
            _config_source(dir_, database), encoding="utf-8"
        )
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
        databases=databases,
        journal_table=create_journal_table_name("py_qid"),
        migration=migration,
        client=client,
    )
    try:
        for database in databases.values():
            db = quote_ident(database)
            client.execute(f"CREATE DATABASE {db}")
            client.execute(f"CREATE TABLE {db}.events (id UInt64) ENGINE = MergeTree ORDER BY id")
            client.execute(
                f"CREATE TABLE {db}.fail_marker (x UInt8) ENGINE = MergeTree ORDER BY x"
            )
            wait_for_table_on_every_replica(client, database, "events")
            wait_for_table_on_every_replica(client, database, "fail_marker")
        yield fixture
    finally:
        for database in databases.values():
            client.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        client.close()
        shutil.rmtree(dir_, ignore_errors=True)


def _start(
    fixture: Fixture, target: Target, extra_args: tuple[str, ...] = ()
) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "chkit.cli.main",
            "migrate",
            "--config",
            str(fixture.dir / f"{target}.config.py"),
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


def _migrate(fixture: Fixture, target: Target, extra_args: tuple[str, ...] = ()) -> CliResult:
    return _wait(_start(fixture, target, extra_args))


def _diagnostic(label: str, result: CliResult) -> str:
    return (
        f"--- {label} (exit {result.exit_code}) ---\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )


def _journal(fixture: Fixture, target: Target) -> tuple[str, str]:
    rows = fixture.client.query(
        "SELECT arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses, "
        "operations[1].query_id AS query_id "
        f"FROM {quote_ident(fixture.databases[target])}.{quote_ident(fixture.journal_table)} "
        f"FINAL WHERE name = '{fixture.migration}' SETTINGS select_sequential_consistency = 1"
    ).rows
    if not rows:
        return "", ""
    return str(rows[0]["statuses"]), str(rows[0]["query_id"])


def _wait_for_statuses(fixture: Fixture, target: Target, statuses: str) -> str:
    found = poll_until(
        lambda: _journal(fixture, target),
        lambda value: value[0] == statuses,
        timeout=_POLL_TIMEOUT_SECONDS,
        interval=0.25,
    )
    assert found[0] == statuses, f"journal of {target}: {found}"
    return found[1]


def _wait_for_running_load(fixture: Fixture, target: Target) -> None:
    # The journal says 'started' just before the load is submitted.
    query_id = _wait_for_statuses(fixture, target, "started")
    status = poll_until(
        lambda: fixture.client.query_status(query_id, every_replica=True),
        lambda found: found.status == "running",
        timeout=10.0,
        interval=0.1,
    )
    assert status.status == "running"


def _count_events(fixture: Fixture, target: Target) -> int:
    sql = f"SELECT count() AS n FROM {quote_ident(fixture.databases[target])}.events"
    return poll_until(
        lambda: int(fixture.client.query(sql).rows[0]["n"]),
        lambda rows: rows == _ROWS,
        timeout=10.0,
    )


def test_a_run_never_takes_the_other_databases_failure_and_the_failed_run_retries(
    make_fixture: Fixture,
) -> None:
    fixture = make_fixture
    staging_db = quote_ident(fixture.databases["staging"])
    fixture.client.execute(f"INSERT INTO {staging_db}.fail_marker VALUES (1)")
    staging = _start(fixture, "staging")
    _wait_for_running_load(fixture, "staging")
    prod = _migrate(fixture, "prod")
    failed = _wait(staging)

    assert prod.exit_code == 0, _diagnostic("prod", prod)
    assert "attaching to in-flight query" not in prod.stderr
    assert _count_events(fixture, "prod") == _ROWS
    assert failed.exit_code == 1, _diagnostic("staging", failed)
    assert "failure in this database" in failed.stdout
    _wait_for_statuses(fixture, "staging", "failed")

    # The retry finds its own failed attempt: it runs the before-retry SQL
    # and loads once.
    fixture.client.execute(f"TRUNCATE TABLE {staging_db}.fail_marker")
    retried = _migrate(fixture, "staging")
    assert retried.exit_code == 0, _diagnostic("staging retry", retried)
    assert "load_table_data: running before-retry SQL" in retried.stderr
    assert _count_events(fixture, "staging") == _ROWS


def test_a_rerun_attaches_to_the_load_its_killed_run_left_running(
    make_fixture: Fixture,
) -> None:
    fixture = make_fixture
    killed = _start(fixture, "staging")
    _wait_for_running_load(fixture, "staging")
    killed.kill()
    assert _wait(killed).exit_code != 0

    # The killed run still holds the migrate lock (#716).
    claim = held_lock_claim(
        fixture.client, fixture.databases["staging"], fixture.journal_table
    )
    resumed = _migrate(fixture, "staging", ("--break-lock", claim))
    assert resumed.exit_code == 0, _diagnostic("staging re-run", resumed)
    assert "attaching to in-flight query" in resumed.stderr
    assert "running before-retry SQL" not in resumed.stderr
    assert _count_events(fixture, "staging") == _ROWS
