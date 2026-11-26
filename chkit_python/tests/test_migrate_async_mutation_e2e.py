"""Async mutations (#812).

Port of ``packages/cli/src/test/migrate-async-mutation.e2e.test.ts``. An async
statement is journaled complete at its QueryFinish. Without mutations_sync an
ALTER ... UPDATE finishes once its mutation is queued (a lightweight DELETE
likewise without lightweight_deletes_sync), so the next statement read the
table before the mutation ran, and a mutation that failed was journaled
complete.
"""

from __future__ import annotations

import contextlib
import json
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
    poll_until,
    quote_ident,
    resolve_live_env,
    run_on_every_replica,
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
    migration: str
    client: ClickHouseClient


def _setup(label: str, statement: str) -> Fixture:
    env = resolve_live_env()
    prefix = create_prefix(label)
    dir_ = Path(tempfile.mkdtemp(prefix=f"chkit-{label}-e2e-"))
    database = f"{prefix}db"
    migration = f"20990101000000_{prefix}update.sql"
    (dir_ / "chkit/migrations").mkdir(parents=True)
    (dir_ / "chkit/migrations" / migration).write_text(
        "-- operation: alter_table_update key=table:t risk=caution mode=async\n"
        f"{statement};\n"
        "\n"
        "-- operation: load_table_data key=table:seen risk=caution\n"
        "INSERT INTO seen SELECT sum(v) FROM t;\n",
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
    client.execute(f"CREATE TABLE {db}.t (k UInt32, v UInt32) ENGINE = MergeTree ORDER BY k")
    client.execute(f"CREATE TABLE {db}.seen (s UInt64) ENGINE = MergeTree ORDER BY s")
    wait_for_table_on_every_replica(client, database, "t")
    wait_for_table_on_every_replica(client, database, "seen")
    client.execute(f"INSERT INTO {db}.t SELECT number, 1 FROM numbers(5)")
    return Fixture(
        dir=dir_,
        database=database,
        journal_table=create_journal_table_name(label),
        migration=migration,
        client=client,
    )


def _teardown(fixture: Fixture) -> None:
    with contextlib.suppress(Exception):
        fixture.client.execute(f"KILL MUTATION WHERE database = '{fixture.database}'")
    fixture.client.execute(f"DROP DATABASE IF EXISTS {quote_ident(fixture.database)} SYNC")
    fixture.client.close()
    shutil.rmtree(fixture.dir, ignore_errors=True)


@pytest.fixture
def failing() -> Iterator[Fixture]:
    fixture = _setup(
        "py_mutfail", "ALTER TABLE t UPDATE v = v + throwIf(k = 4, 'mutation failure') WHERE 1"
    )
    try:
        yield fixture
    finally:
        _teardown(fixture)


def _start(fixture: Fixture, args: tuple[str, ...] = ()) -> subprocess.Popen[str]:
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
            *args,
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


def _journal(fixture: Fixture) -> list[dict[str, object]]:
    return fixture.client.query(
        "SELECT operations[1].status AS status, operations[1].query_id AS queryId "
        f"FROM {quote_ident(fixture.database)}.{quote_ident(fixture.journal_table)} FINAL "
        f"WHERE name = '{fixture.migration}' SETTINGS select_sequential_consistency = 1"
    ).rows


def _statuses_during(fixture: Fixture, duration: float) -> list[str]:
    """Every status the journal records for the statement over ``duration``:
    the check that it does not complete needs a span of time, not a state."""
    seen: list[str] = []
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        rows = _journal(fixture)
        status = str(rows[0]["status"]) if rows else "missing"
        if status not in seen:
            seen.append(status)
        time.sleep(0.25)
    return seen


@pytest.mark.parametrize(
    ("label", "statement", "args", "expected"),
    [
        ("py_mutwait", "ALTER TABLE t UPDATE v = v + 1 WHERE 1", (), 10),
        # A lightweight DELETE run with lightweight_deletes_sync = 0.
        ("py_lwdwait", "DELETE FROM t WHERE k = 4", ("--setting", "lightweight_deletes_sync=0"), 4),
    ],
    ids=["alter-update", "lightweight-delete"],
)
def test_the_next_statement_runs_only_once_the_mutation_is_done(
    label: str, statement: str, args: tuple[str, ...], expected: int
) -> None:
    waiting = _setup(label, statement)
    db = quote_ident(waiting.database)
    process: subprocess.Popen[str] | None = None
    env = resolve_live_env()
    # SYSTEM STOP MERGES acts on one replica, and any replica may run the
    # mutation, so merges stop on every replica.
    merges_stopped = False
    try:
        # The mutation stays queued until merges start again.
        merges_stopped = True
        run_on_every_replica(waiting.client, env, f"SYSTEM STOP MERGES {db}.t")
        process = _start(waiting, args)
        rows = poll_until(
            lambda: _journal(waiting),
            lambda rows: bool(rows) and rows[0]["status"] == "started" and rows[0]["queryId"] != "",
            timeout=60.0,
            interval=0.2,
        )
        query_id = str(rows[0]["queryId"])
        status = poll_until(
            lambda: waiting.client.query_status(query_id, every_replica=True),
            lambda found: found.status == "running",
            timeout=30.0,
            interval=0.1,
        )
        assert status.status == "running"
        poll_until(
            lambda: (
                waiting.client.query(
                    "SELECT 1 FROM system.mutations WHERE database = "
                    f"'{waiting.database}' AND table = 't' AND NOT is_done"
                ).rows
            ),
            lambda rows: len(rows) == 1,
        )
        # Polls run every 5 s: across two of them, the statement stays started.
        assert _statuses_during(waiting, 11.0) == ["started"]
        run_on_every_replica(waiting.client, env, f"SYSTEM START MERGES {db}.t")
        merges_stopped = False

        result = _wait(process)
        assert result.exit_code == 0, _diagnostic("migrate", result)
        seen = waiting.client.query(f"SELECT s FROM {db}.seen").rows
        assert [int(row["s"]) for row in seen] == [expected]
    finally:
        try:
            if merges_stopped:
                run_on_every_replica(waiting.client, env, f"SYSTEM START MERGES {db}.t")
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
            _teardown(waiting)


def test_a_failed_mutation_is_not_journaled_complete(failing: Fixture) -> None:
    result = _wait(_start(failing))
    assert result.exit_code == 1, _diagnostic("migrate", result)
    assert json.loads(result.stdout)["error"]["code"] == "async_outcome_unknown"
    db = quote_ident(failing.database)
    assert failing.client.query(f"SELECT s FROM {db}.seen").rows == []
