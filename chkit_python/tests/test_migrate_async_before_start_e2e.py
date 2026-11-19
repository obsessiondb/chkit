"""Async ALTER rejected before it started (#767, Opus review).

Port of ``packages/cli/src/test/migrate-async-before-start.e2e.test.ts``.
ExceptionBeforeStart shows nothing ran only for a SELECT or an INSERT. A
killed ALTER ... UPDATE with mutations_sync logs it while its mutation still
completes, and a mutation that fails on one partition logs it after it changed
the others. Neither may be compensated and run again: the run, and the next
one, stop with async_outcome_unknown.
"""

from __future__ import annotations

import contextlib
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
    poll_until,
    quote_ident,
    resolve_live_env,
    wait_for_table_on_every_replica,
)

_CLI_TIMEOUT_SECONDS = 120.0


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
    client: ClickHouseClient


def _setup(label: str, layout: str, assignment: str) -> Fixture:
    env = resolve_live_env()
    prefix = create_prefix(label)
    dir_ = Path(tempfile.mkdtemp(prefix=f"chkit-{label}-e2e-"))
    database = f"{prefix}db"
    (dir_ / "chkit/migrations").mkdir(parents=True)
    (dir_ / "chkit/migrations" / f"20990101000000_{prefix}update.sql").write_text(
        "-- operation: alter_table_update key=table:t risk=caution mode=async\n"
        "-- before-retry: SELECT 1\n"
        f"ALTER TABLE t UPDATE {assignment} WHERE 1 "
        "SETTINGS mutations_sync = 1, allow_nondeterministic_mutations = 1;\n",
        encoding="utf-8",
    )
    (dir_ / "chkit.config.py").write_text(
        f"""
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
""",
        encoding="utf-8",
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
    db = quote_ident(database)
    client.execute(f"CREATE DATABASE {db}")
    client.execute(f"CREATE TABLE {db}.t (k UInt32, v UInt32) ENGINE = MergeTree {layout}")
    wait_for_table_on_every_replica(client, database, "t")
    client.execute(f"INSERT INTO {db}.t SELECT number, number FROM numbers(5)")
    return Fixture(
        dir=dir_, database=database, journal_table=create_journal_table_name(label), client=client
    )


def _teardown(fixture: Fixture) -> None:
    with contextlib.suppress(Exception):
        fixture.client.execute(f"KILL MUTATION WHERE database = '{fixture.database}'")
    fixture.client.execute(f"DROP DATABASE IF EXISTS {quote_ident(fixture.database)} SYNC")
    fixture.client.close()
    shutil.rmtree(fixture.dir, ignore_errors=True)


@pytest.fixture
def killed() -> Iterator[Fixture]:
    fixture = _setup("py_bskill", "ORDER BY k", "v = v + 100 + sleepEachRow(0.5) * 0")
    try:
        yield fixture
    finally:
        _teardown(fixture)


@pytest.fixture
def partial() -> Iterator[Fixture]:
    fixture = _setup("py_bspart", "PARTITION BY k ORDER BY k", "v = v + 100 + throwIf(k = 4)")
    try:
        yield fixture
    finally:
        _teardown(fixture)


def _start(fixture: Fixture) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "chkit.cli.main",
            "migrate",
            "--config",
            str(fixture.dir / "chkit.config.py"),
            "--execute",
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


def _values(fixture: Fixture) -> list[int]:
    rows = fixture.client.query(
        f"SELECT v FROM {quote_ident(fixture.database)}.t ORDER BY k"
    ).rows
    return [int(row["v"]) for row in rows]


def test_a_killed_alter_update_whose_mutation_completed_is_not_run_again(
    killed: Fixture,
) -> None:
    first = _start(killed)
    running = poll_until(
        lambda: killed.client.query(
            "SELECT query_id FROM system.processes WHERE current_database = "
            f"'{killed.database}' AND query LIKE 'ALTER TABLE t UPDATE%'"
        ).rows,
        lambda rows: len(rows) > 0,
        timeout=60.0,
        interval=0.2,
    )
    killed.client.execute(f"KILL QUERY WHERE query_id = '{running[0]['query_id']}' SYNC")
    _wait(first)
    expected = [100, 101, 102, 103, 104]
    assert poll_until(lambda: _values(killed), lambda rows: rows == expected, timeout=60.0) == (
        expected
    )
    again = _wait(_start(killed))
    assert again.exit_code == 1, _diagnostic("re-run", again)
    assert json.loads(again.stdout)["error"]["code"] == "async_outcome_unknown"
    # Never applied twice.
    assert _values(killed) == expected


def test_an_alter_update_that_failed_on_one_partition_is_not_run_again(
    partial: Fixture,
) -> None:
    first = _wait(_start(partial))
    assert first.exit_code == 1, _diagnostic("first run", first)
    assert json.loads(first.stdout)["error"]["code"] == "async_outcome_unknown"
    again = _wait(_start(partial))
    assert again.exit_code == 1, _diagnostic("re-run", again)
    assert json.loads(again.stdout)["error"]["code"] == "async_outcome_unknown"
    # The partitions the mutation changed before it failed are never changed again.
    assert [v for v in _values(partial) if v >= 200] == []
