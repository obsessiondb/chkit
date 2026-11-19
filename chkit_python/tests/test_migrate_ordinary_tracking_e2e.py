"""Ordinary migrate with query tracking (#733).

Port of ``packages/cli/src/test/migrate-ordinary-tracking.e2e.test.ts``: query
tracking must not change what an ordinary migrate needs or does. A user
without the REMOTE grant applies as before, and a migrate with nothing pending
exits without taking the lock.

Runs against the server in ``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST``; an
unreachable server fails the test.
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

_CLI_TIMEOUT_SECONDS = 150.0
# The declared cluster: the local stack's one-node `cluster`, or ObsessionDB's `default`.
_CLUSTER = "default" if os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb" else "cluster"
_PASSWORD = "Restricted-e2e-Pw-733"


@dataclass(frozen=True)
class CliResult:
    exit_code: int
    stdout: str
    stderr: str


@dataclass
class Fixture:
    root: Path
    database: str
    journal_table: str
    user: str
    client: ClickHouseClient


@pytest.fixture
def make_fixture() -> Iterator[Fixture]:
    env = resolve_live_env()
    prefix = create_prefix("py_track")
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
        root=Path(tempfile.mkdtemp(prefix="chkit-py-track-e2e-")),
        database=f"{prefix}db",
        journal_table=create_journal_table_name("py_track"),
        user=f"{prefix}user",
        client=client,
    )
    db = quote_ident(fixture.database)
    try:
        client.execute(f"CREATE DATABASE {db}")
        client.execute(
            f"CREATE TABLE {db}.events (id UInt64) ENGINE = MergeTree ORDER BY id "
            "SETTINGS index_granularity = 1"
        )
        # A cluster journal is created ON CLUSTER with a replicated engine. The
        # test creates it first, as a plain table, so it does not depend on ON
        # CLUSTER DDL and runs the same on the local stack and on ObsessionDB.
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
        for table in ("events", fixture.journal_table):
            wait_for_table_on_every_replica(client, fixture.database, table)
        # Everything on its own database, and nothing else: no REMOTE grant.
        client.execute(
            f"CREATE USER {quote_ident(fixture.user)} IDENTIFIED WITH sha256_password "
            f"BY '{_PASSWORD}'"
        )
        client.execute(
            f"GRANT SELECT, INSERT, CREATE TABLE, DROP TABLE, ALTER ON {db}.* "
            f"TO {quote_ident(fixture.user)}"
        )
        yield fixture
    finally:
        client.execute(f"DROP USER IF EXISTS {quote_ident(fixture.user)}")
        client.execute(f"DROP DATABASE IF EXISTS {db} SYNC")
        client.close()
        shutil.rmtree(fixture.root, ignore_errors=True)


def _project(fixture: Fixture, name: str, statements: list[str]) -> Path:
    """A project directory with one migration per statement, against the fixture database."""
    env = resolve_live_env()
    dir_ = fixture.root / name
    migrations = dir_ / "chkit/migrations"
    migrations.mkdir(parents=True)
    for index, statement in enumerate(statements):
        (migrations / f"2099010100000{index}_{name}.sql").write_text(
            "-- operation: sql_statement key=statement:0 risk=safe\n"
            "-- before-retry: CREATE OR REPLACE TABLE events AS events\n"
            f"{statement}\n",
            encoding="utf-8",
        )
    # The user and password reach the CLI through its environment, not the file.
    (dir_ / "clickhouse.config.py").write_text(
        f"""
import os

from chkit import define_config

config = define_config(
    {{
        "schema": "{dir_}/schema.py",
        "outDir": "{dir_}/chkit",
        "migrationsDir": "{migrations}",
        "metaDir": "{dir_}/chkit/meta",
        "clickhouse": {{
            "url": "{env.clickhouse_url}",
            "username": os.environ["CHKIT_E2E_USER"],
            "password": os.environ["CHKIT_E2E_PASSWORD"],
            "database": "{fixture.database}",
            "cluster": "{_CLUSTER}",
        }},
    }}
)
""",
        encoding="utf-8",
    )
    return dir_


def _start(
    fixture: Fixture, project: Path, user: str, password: str,
    extra_env: dict[str, str] | None = None,
) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            sys.executable, "-m", "chkit.cli.main", "migrate",
            "--config", str(project / "clickhouse.config.py"), "--apply", "--json",
            "--setting", "max_block_size=1,min_insert_block_size_rows=1,min_insert_block_size_bytes=0",
        ],
        cwd=project,
        env={
            **os.environ,
            "CHKIT_JOURNAL_TABLE": fixture.journal_table,
            "CI": "1",
            "CHKIT_E2E_USER": user,
            "CHKIT_E2E_PASSWORD": password,
            # An empty config home, so a user profile config cannot change the run.
            "XDG_CONFIG_HOME": str(project / "xdg"),
            **(extra_env or {}),
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _wait(process: subprocess.Popen[str]) -> CliResult:
    stdout, stderr = process.communicate(timeout=_CLI_TIMEOUT_SECONDS)
    return CliResult(exit_code=process.returncode, stdout=stdout, stderr=stderr)


def _diagnostic(label: str, result: CliResult) -> str:
    return f"--- {label} (exit {result.exit_code}) ---\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"


def _count(fixture: Fixture) -> int:
    rows = fixture.client.query(
        f"SELECT toString(count()) AS n FROM {quote_ident(fixture.database)}.events"
    ).rows
    return int(rows[0]["n"])


def _lock_rows(fixture: Fixture) -> int:
    rows = fixture.client.query(
        "SELECT toString(count()) AS n FROM "
        f"{quote_ident(fixture.database)}.{quote_ident(fixture.journal_table)} "
        "WHERE startsWith(name, '__chkit_migrate_lock__/') "
        "SETTINGS select_sequential_consistency = 1"
    ).rows
    return int(rows[0]["n"])


def test_a_user_without_the_remote_grant_applies_reruns_and_runs_with_tracking_off(
    make_fixture: Fixture,
) -> None:
    fixture = make_fixture
    project = _project(fixture, "restricted", ["INSERT INTO events SELECT number FROM numbers(3);"])
    applied = _wait(_start(fixture, project, fixture.user, _PASSWORD))
    assert applied.exit_code == 0, _diagnostic("restricted apply", applied)
    assert _count(fixture) == 3

    noop = _wait(_start(fixture, project, fixture.user, _PASSWORD))
    assert noop.exit_code == 0, _diagnostic("restricted no-op", noop)
    off = _wait(_start(
        fixture, project, fixture.user, _PASSWORD, {"CHKIT_MIGRATE_QUERY_TRACKING": "off"},
    ))
    assert off.exit_code == 0, _diagnostic("tracking off", off)


def test_a_migrate_with_nothing_pending_exits_0_while_another_run_holds_the_lock(
    make_fixture: Fixture,
) -> None:
    fixture = make_fixture
    env = resolve_live_env()
    # About 8 s at 0.25 s per row: long enough to hold the lock.
    loading = _project(fixture, "loading", [
        "INSERT INTO events SELECT number FROM numbers(32) WHERE sleepEachRow(0.25) = 0;",
    ])
    empty = _project(fixture, "empty", [])
    holder = _start(fixture, loading, env.clickhouse_user, env.clickhouse_password)
    poll_until(lambda: _lock_rows(fixture), lambda n: n > 0, timeout=60.0, interval=0.2)
    claim = held_lock_claim(fixture.client, fixture.database, fixture.journal_table)

    noop = _wait(_start(fixture, empty, env.clickhouse_user, env.clickhouse_password))
    assert noop.exit_code == 0, _diagnostic("no-op beside a held lock", noop)
    # It wrote no claim of its own: the running load still holds the only one.
    assert held_lock_claim(fixture.client, fixture.database, fixture.journal_table) == claim

    held = _wait(holder)
    assert held.exit_code == 0, _diagnostic("lock holder", held)
