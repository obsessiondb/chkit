"""A marker belongs to the statement after it (#831).

Port of ``packages/cli/src/test/migrate-marker-position.e2e.test.ts``. An
unmarked statement before an async load runs as itself, and the load runs
async.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    poll_until,
    quote_ident,
    resolve_live_env,
)

_CLI_TIMEOUT_SECONDS = 120.0
_UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$")


def test_an_unmarked_create_table_before_an_async_load_runs_sync_and_the_load_async() -> None:
    env = resolve_live_env()
    prefix = create_prefix("py_marker_pos")
    database = f"{prefix}db"
    journal_table = create_journal_table_name("py_marker_pos")
    migration = f"20990101000000_{prefix}load.sql"
    dir_ = Path(tempfile.mkdtemp(prefix="chkit-py-marker-pos-e2e-"))
    (dir_ / "chkit/migrations").mkdir(parents=True)
    (dir_ / "chkit/migrations" / migration).write_text(
        "CREATE TABLE events (id UInt64) ENGINE = MergeTree ORDER BY id;\n"
        "-- operation: load_table_data key=table:events risk=caution mode=async\n"
        "-- before-retry: TRUNCATE TABLE events\n"
        "INSERT INTO events SELECT number FROM numbers(3);\n",
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
    try:
        client.execute(f"CREATE DATABASE {db}")
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "chkit.cli.main",
                "migrate",
                "--config",
                str(dir_ / "chkit.config.py"),
                "--apply",
                "--json",
            ],
            cwd=dir_,
            env={
                **os.environ,
                "CHKIT_JOURNAL_TABLE": journal_table,
                "CI": "1",
                "CHKIT_E2E_PASSWORD": env.clickhouse_password,
                "XDG_CONFIG_HOME": str(dir_ / "xdg"),
            },
            capture_output=True,
            text=True,
            timeout=_CLI_TIMEOUT_SECONDS,
            check=False,
        )
        assert result.returncode == 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"

        operations = poll_until(
            lambda: client.query(
                "SELECT op.operation_index AS index, op.operation_type AS type, "
                "op.operation_key AS key, op.query_id AS query_id, op.status AS status "
                f"FROM {db}.{quote_ident(journal_table)} FINAL ARRAY JOIN operations AS op "
                f"WHERE name = '{migration}' AND migration_completed ORDER BY index "
                "SETTINGS select_sequential_consistency = 1"
            ).rows,
            lambda rows: len(rows) == 2,
            timeout=30.0,
        )
        assert [
            (int(row["index"]), row["type"], row["key"], row["status"]) for row in operations
        ] == [
            (0, "sql_statement", "statement:0", "completed"),
            (1, "load_table_data", "table:events", "completed"),
        ]
        # Only the load ran async, under a query id of its own.
        assert operations[0]["query_id"] == ""
        assert _UUID_V4.match(str(operations[1]["query_id"]))
        rows = client.query(f"SELECT toString(count()) AS n FROM {db}.events").rows
        assert rows[0]["n"] == "3"
    finally:
        client.execute(f"DROP DATABASE IF EXISTS {db} SYNC")
        client.close()
        shutil.rmtree(dir_, ignore_errors=True)
