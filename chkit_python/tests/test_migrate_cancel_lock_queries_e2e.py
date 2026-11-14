"""migrate --cancel-lock-queries (#732).

Port of ``packages/cli/src/test/migrate-cancel-lock-queries.e2e.test.ts``: a
run killed while its INSERT still loads on the server. The next run with
--cancel-lock-queries replaces the target (new UUID, empty) before it reloads,
so the stopped INSERT cannot add rows to the reloaded table.

The first run is killed, so the CLI runs in subprocesses. Runs against the
server in ``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST``; an unreachable server fails
the test.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
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

_ROWS = 32
_CLI_TIMEOUT_SECONDS = 150.0
# The declared cluster: the local stack's one-node `cluster`, or ObsessionDB's `default`.
_CLUSTER = "default" if os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb" else "cluster"


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
            "cluster": "{_CLUSTER}",
        }},
    }}
)
"""


@pytest.fixture
def make_fixture() -> Iterator[Fixture]:
    env = resolve_live_env()
    prefix = create_prefix("py_cancel_lock")
    dir_ = Path(tempfile.mkdtemp(prefix="chkit-py-cancel-lock-e2e-"))
    database = f"{prefix}db"
    migration = f"20990101000000_{prefix}load.sql"
    (dir_ / "chkit/migrations").mkdir(parents=True)
    # About 8 s at 0.25 s per row, one row per block and part.
    (dir_ / "chkit/migrations" / migration).write_text(
        "-- operation: sql_statement key=statement:0 risk=safe\n"
        "-- before-retry: CREATE OR REPLACE TABLE events AS events\n"
        "INSERT INTO events SELECT id FROM frozen WHERE sleepEachRow(0.25) = 0;\n",
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
        journal_table=create_journal_table_name("py_cancel_lock"),
        migration=migration,
        client=client,
    )
    try:
        db = quote_ident(database)
        client.execute(f"CREATE DATABASE {db}")
        # One-row granules keep the sleep per block below the server's limit.
        client.execute(
            f"CREATE TABLE {db}.frozen (id UInt64) ENGINE = MergeTree ORDER BY id "
            "SETTINGS index_granularity = 1"
        )
        client.execute(f"CREATE TABLE {db}.events (id UInt64) ENGINE = MergeTree ORDER BY id")
        # A cluster journal is created ON CLUSTER with a replicated engine; the
        # local stack has no Keeper, so the journal exists before the first run.
        client.execute(
            f"CREATE TABLE {db}.{quote_ident(fixture.journal_table)} (name String, "
            "applied_at DateTime64(3, 'UTC'), checksum String, chkit_version String, "
            "migration_completed Bool DEFAULT true, operations Array(Tuple(operation_index Int32, "
            "operation_key String, operation_type String, query_id String, "
            "status LowCardinality(String), started_at DateTime64(3, 'UTC'), "
            "finished_at Nullable(DateTime64(3, 'UTC')), last_error String)) DEFAULT [], "
            "operation_fingerprints Array(String) DEFAULT []) "
            "ENGINE = ReplacingMergeTree(applied_at) ORDER BY (name) SETTINGS index_granularity = 1"
        )
        for table in ("frozen", "events", fixture.journal_table):
            wait_for_table_on_every_replica(client, database, table)
        client.execute(f"INSERT INTO {db}.frozen SELECT number FROM numbers({_ROWS})")
        yield fixture
    finally:
        client.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        client.close()
        shutil.rmtree(dir_, ignore_errors=True)


def _start(fixture: Fixture, extra_args: tuple[str, ...] = ()) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            sys.executable, "-m", "chkit.cli.main", "migrate",
            "--config", str(fixture.dir / "clickhouse.config.py"), "--apply", "--json",
            "--setting", "max_block_size=1,min_insert_block_size_rows=1,min_insert_block_size_bytes=0",
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


def _count(fixture: Fixture) -> int:
    rows = fixture.client.query(
        f"SELECT toString(count()) AS n FROM {quote_ident(fixture.database)}.events"
    ).rows
    return int(rows[0]["n"])


def _target_uuid(fixture: Fixture) -> str:
    rows = fixture.client.query(
        "SELECT toString(uuid) AS uuid FROM system.tables "
        f"WHERE database = '{fixture.database}' AND name = 'events'"
    ).rows
    return str(rows[0]["uuid"]) if rows else ""


def _statuses(fixture: Fixture) -> str:
    rows = fixture.client.query(
        "SELECT arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses "
        f"FROM {quote_ident(fixture.database)}.{quote_ident(fixture.journal_table)} "
        f"FINAL WHERE name = '{fixture.migration}' SETTINGS select_sequential_consistency = 1"
    ).rows
    return str(rows[0]["statuses"]) if rows else ""


def test_recovery_replaces_the_target_of_a_killed_run_then_reloads_it_exactly_once(
    make_fixture: Fixture,
) -> None:
    fixture = make_fixture
    killed = _start(fixture)
    stored = poll_until(lambda: _count(fixture), lambda n: n > 0, timeout=60.0, interval=0.2)
    assert stored > 0
    killed.kill()
    assert _wait(killed).exit_code != 0
    before = _target_uuid(fixture)

    claim = held_lock_claim(fixture.client, fixture.database, fixture.journal_table)
    recovery = _wait(_start(fixture, ("--break-lock", claim, "--cancel-lock-queries")))
    assert recovery.exit_code == 0, _diagnostic("recovery", recovery)

    assert _target_uuid(fixture) != before
    assert _count(fixture) == _ROWS
    # The killed INSERT, if it still runs, writes to the replaced table only.
    time.sleep(5)
    assert _count(fixture) == _ROWS
    assert _statuses(fixture) == "completed"

    # The barrier is released: an ordinary run has nothing left to do.
    rerun = _wait(_start(fixture))
    assert rerun.exit_code == 0, _diagnostic("re-run", rerun)
    assert _count(fixture) == _ROWS
