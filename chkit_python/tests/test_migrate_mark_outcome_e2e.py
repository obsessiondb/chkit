"""migrate --mark-applied / --mark-not-applied.

Port of ``packages/cli/src/test/migrate-mark-outcome.e2e.test.ts``: after
async_outcome_unknown, the flags record the outcome of the stopped statement
only, so the statements the journal records as completed do not run again, as
they do after --abandon.

The CLI runs in subprocesses (``python -m chkit.cli.main``), so a run can be
killed. Runs against the server in ``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST``; an
unreachable server fails the test.
"""

from __future__ import annotations

import json
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

_ROWS = 8
# The load fails on this row while the database's fail_marker has a row.
_FAIL_AT = 3
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
    prefix = create_prefix("py_mark")
    dir_ = Path(tempfile.mkdtemp(prefix="chkit-py-mark-e2e-"))
    database = f"{prefix}db"
    migration = f"20990101000000_{prefix}load.sql"
    (dir_ / "chkit/migrations").mkdir(parents=True)
    (dir_ / "chkit/migrations" / migration).write_text(
        # Not safe to run twice: an abandon would insert it again.
        "-- operation: load_table_data key=table:audit risk=caution mode=sync\n"
        "INSERT INTO audit VALUES (1);\n"
        "-- operation: load_table_data key=table:events risk=caution mode=async\n"
        "-- before-retry: TRUNCATE TABLE events\n"
        f"INSERT INTO events SELECT number + throwIf(number = {_FAIL_AT} AND "
        "(SELECT count() FROM fail_marker) > 0, 'failure in this database') "
        f"FROM numbers({_ROWS}) WHERE sleepEachRow(1) = 0 SETTINGS max_block_size = 1;\n",
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
        journal_table=create_journal_table_name("py_mark"),
        migration=migration,
        client=client,
    )
    try:
        db = quote_ident(database)
        client.execute(f"CREATE DATABASE {db}")
        for name in ("events", "audit", "fail_marker"):
            client.execute(f"CREATE TABLE {db}.{name} (x UInt64) ENGINE = MergeTree ORDER BY x")
            wait_for_table_on_every_replica(client, database, name)
        client.execute(f"INSERT INTO {db}.fail_marker VALUES (1)")
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


def _migrate(fixture: Fixture, extra_args: tuple[str, ...] = ()) -> CliResult:
    return _wait(_start(fixture, extra_args))


def _diagnostic(label: str, result: CliResult) -> str:
    return (
        f"--- {label} (exit {result.exit_code}) ---\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )


def _table(fixture: Fixture, name: str) -> str:
    return f"{quote_ident(fixture.database)}.{quote_ident(name)}"


def _journal(fixture: Fixture) -> tuple[str, str]:
    rows = fixture.client.query(
        "SELECT arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses, "
        "operations[2].query_id AS query_id "
        f"FROM {_table(fixture, fixture.journal_table)} "
        f"FINAL WHERE name = '{fixture.migration}' SETTINGS select_sequential_consistency = 1"
    ).rows
    if not rows:
        return "", ""
    return str(rows[0]["statuses"]), str(rows[0]["query_id"])


def _count(fixture: Fixture, name: str, expected: int | None = None) -> int:
    sql = f"SELECT count() AS n FROM {_table(fixture, name)}"
    if expected is None:
        return int(fixture.client.query(sql).rows[0]["n"])
    return poll_until(
        lambda: int(fixture.client.query(sql).rows[0]["n"]),
        lambda rows: rows == expected,
        timeout=10.0,
    )


def _stop_on_unknown_outcome(fixture: Fixture) -> None:
    # The first run completes the audit insert, then its load fails while it runs.
    failed = _migrate(fixture)
    assert failed.exit_code == 1, _diagnostic("first run", failed)
    assert json.loads(failed.stdout)["error"]["code"] == "async_outcome_unknown"
    assert _journal(fixture)[0] == "completed,started"


def test_mark_not_applied_runs_the_stopped_load_again_and_not_the_statement_before_it(
    make_fixture: Fixture,
) -> None:
    fixture = make_fixture
    _stop_on_unknown_outcome(fixture)

    fixture.client.execute(f"TRUNCATE TABLE {_table(fixture, 'fail_marker')}")
    marked = _migrate(fixture, ("--mark-not-applied", fixture.migration))
    assert marked.exit_code == 0, _diagnostic("mark", marked)
    report = json.loads(marked.stdout)["mark"]
    assert report["outcome"] == "not-applied"
    assert report["operation"]["operationIndex"] == 1

    resumed = _migrate(fixture)
    assert resumed.exit_code == 0, _diagnostic("resume", resumed)
    assert "load_table_data: running before-retry SQL" in resumed.stderr
    assert _count(fixture, "events", _ROWS) == _ROWS
    assert _count(fixture, "audit", 1) == 1


def test_mark_applied_records_the_stopped_load_as_completed_and_runs_nothing_again(
    make_fixture: Fixture,
) -> None:
    fixture = make_fixture
    _stop_on_unknown_outcome(fixture)
    partial = _count(fixture, "events")

    marked = _migrate(fixture, ("--mark-applied", fixture.migration))
    assert marked.exit_code == 0, _diagnostic("mark", marked)

    resumed = _migrate(fixture)
    assert resumed.exit_code == 0, _diagnostic("resume", resumed)
    assert "submitting async" not in resumed.stderr
    assert _count(fixture, "events") == partial
    assert _count(fixture, "audit", 1) == 1
    assert _journal(fixture)[0] == "completed,completed"


def test_mark_refuses_while_the_stopped_attempt_still_runs_and_changes_nothing(
    make_fixture: Fixture,
) -> None:
    fixture = make_fixture
    # No failure: the killed run's load keeps running.
    fixture.client.execute(f"TRUNCATE TABLE {_table(fixture, 'fail_marker')}")
    killed = _start(fixture)
    found = poll_until(
        lambda: _journal(fixture),
        lambda value: value[0] == "completed,started",
        timeout=_POLL_TIMEOUT_SECONDS,
        interval=0.25,
    )
    query_id = found[1]
    status = poll_until(
        lambda: fixture.client.query_status(query_id, every_replica=True),
        lambda value: value.status == "running",
        timeout=10.0,
        interval=0.1,
    )
    assert status.status == "running"
    killed.kill()
    assert _wait(killed).exit_code != 0

    claim = held_lock_claim(fixture.client, fixture.database, fixture.journal_table)
    marked = _migrate(fixture, ("--mark-applied", fixture.migration, "--break-lock", claim))
    assert marked.exit_code == 1, _diagnostic("mark", marked)
    assert json.loads(marked.stdout)["error"]["code"] == "async_outcome_unknown"
    assert "is still running on the server" in marked.stdout
    assert _journal(fixture)[0] == "completed,started"
    fixture.client.execute(f"KILL QUERY WHERE query_id = '{query_id}' SYNC")
