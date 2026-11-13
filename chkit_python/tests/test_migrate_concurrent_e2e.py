"""Concurrent migrate runs (#716).

Port of ``packages/cli/src/test/migrate-concurrent.e2e.test.ts``: two
``migrate --apply`` runs at once against one target both applied the same
pending migration. The migrate lock lets one of them apply it.

The runs go at once, so the CLI runs in subprocesses (``python -m
chkit.cli.main``) instead of ``CliRunner``. Runs against the server in
``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST``; an unreachable server fails the test.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    quote_ident,
    resolve_live_env,
    wait_for_table_on_every_replica,
)

_ROWS = 16
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
def make_fixture() -> Iterator[Callable[[str], Fixture]]:
    made: list[Fixture] = []

    def make(mode: str) -> Fixture:
        fixture = _create_fixture(mode)
        made.append(fixture)
        return fixture

    try:
        yield make
    finally:
        for fixture in made:
            fixture.client.execute(f"DROP DATABASE IF EXISTS {quote_ident(fixture.database)} SYNC")
            fixture.client.close()
            shutil.rmtree(fixture.dir, ignore_errors=True)


def _create_fixture(mode: str) -> Fixture:
    env = resolve_live_env()
    prefix = create_prefix(f"py_concurrent_{mode}")
    dir_ = Path(tempfile.mkdtemp(prefix="chkit-py-concurrent-e2e-"))
    database = f"{prefix}db"
    migration = f"20990101000000_{prefix}load.sql"
    (dir_ / "chkit/migrations").mkdir(parents=True)
    # About 4 s at 0.25 s per row, so both runs read the journal before
    # either records the migration applied. Random rows, so a replicated
    # target's insert deduplication cannot hide a second load.
    marker = " mode=async" if mode == "async" else ""
    (dir_ / "chkit/migrations" / migration).write_text(
        f"-- operation: load_table_data key=table:events risk=caution{marker}\n"
        f"INSERT INTO events SELECT rand64() FROM numbers({_ROWS}) "
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
        journal_table=create_journal_table_name(f"py_concurrent_{mode}"),
        migration=migration,
        client=client,
    )
    db = quote_ident(database)
    client.execute(f"CREATE DATABASE {db}")
    client.execute(f"CREATE TABLE {db}.events (id UInt64) ENGINE = MergeTree ORDER BY id")
    wait_for_table_on_every_replica(client, database, "events")
    return fixture


def _start(fixture: Fixture) -> subprocess.Popen[str]:
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


def _error_code(result: CliResult) -> str | None:
    """The ``--json`` error code of a failed run."""
    payload = json.loads(result.stdout)
    error = payload.get("error")
    return error.get("code") if isinstance(error, dict) else None


@pytest.mark.parametrize("mode", ["sync", "async"])
def test_two_runs_at_once_apply_a_pending_load_once(
    make_fixture: Callable[[str], Fixture], mode: str
) -> None:
    fixture = make_fixture(mode)
    first, second = _start(fixture), _start(fixture)
    runs = [_wait(first), _wait(second)]
    for run in runs:
        if run.exit_code != 0:
            assert _error_code(run) == "migrate_locked", _diagnostic("concurrent run", run)
    assert any(run.exit_code == 0 for run in runs), "\n".join(
        _diagnostic("run", run) for run in runs
    )
    count = fixture.client.query(
        f"SELECT count() AS n FROM {quote_ident(fixture.database)}.events"
    ).rows[0]["n"]
    assert int(count) == _ROWS
