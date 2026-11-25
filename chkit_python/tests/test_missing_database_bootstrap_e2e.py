"""A new project whose ``clickhouse.database`` does not exist yet (#351).

``status``, ``check`` and ``migrate`` report the missing database instead of
failing at connect time, and ``migrate --apply`` runs the migration's
``CREATE DATABASE``, then creates the table and journals the migration in the
new database.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
    wait_for_table_on_every_replica,
)


@pytest.fixture
def live() -> Iterator[ClickHouseClient]:
    env = resolve_live_env()
    with ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    ) as client:
        yield client


def _append_async_load(migration: Path, database: str) -> None:
    """#767: an async load in a run that takes no migrate lock."""
    with migration.open("a", encoding="utf-8") as handle:
        handle.write(
            f"\n-- operation: load_table_data key=table:{database}.events risk=safe "
            f"mode=async\nINSERT INTO {quote_ident(database)}.events "
            "SELECT number FROM numbers(3);\n"
        )


def _assert_async_load_journaled(live: ClickHouseClient, database: str, journal_table: str) -> None:
    """The async load completed under a random id of its own (#767)."""
    load = live.query(
        "SELECT op.query_id AS query_id, op.status AS status FROM "
        f"{quote_ident(database)}.{quote_ident(journal_table)} FINAL "
        "ARRAY JOIN operations AS op WHERE op.operation_type = 'load_table_data'"
    ).rows
    assert [row["status"] for row in load] == ["completed"]
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}", load[0]["query_id"]
    )
    count = live.query(f"SELECT toString(count()) AS n FROM {quote_ident(database)}.events")
    assert count.rows[0]["n"] == "3"


def test_migrate_apply_creates_a_missing_database(  # noqa: PLR0915
    live: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    database = f"{create_prefix('missing_db_py')}db"
    journal_table = create_journal_table_name("missing_db_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("CI", "1")
    clickhouse = json.dumps({
        "url": env.clickhouse_url,
        "username": env.clickhouse_user,
        "password": env.clickhouse_password,
        "database": database,
    })
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\n"
        "config = define_config({\n"
        '    "schema": "./schema.py",\n'
        '    "outDir": "./chkit",\n'
        '    "migrationsDir": "./chkit/migrations",\n'
        '    "metaDir": "./chkit/meta",\n'
        f'    "clickhouse": {clickhouse},\n'
        "})\n"
    )
    (tmp_path / "schema.py").write_text(
        "from chkit import ColumnDefinition, schema, table\n\n"
        f"events = table(database={database!r}, name='events', engine='MergeTree',\n"
        "    columns=[ColumnDefinition(name='id', type='UInt64')],\n"
        "    primary_key=['id'], order_by=['id'])\n\n"
        "definitions = schema(events)\n"
    )
    runner = CliRunner()

    def chkit(*args: str) -> Any:
        return runner.invoke(app, list(args))

    def chkit_json(*args: str, exit_code: int = 0) -> dict[str, Any]:
        result = chkit(*args, "--json")
        assert result.exit_code == exit_code, format_test_diagnostic(
            f"chkit {' '.join(args)} --json", result
        )
        return dict(json.loads(result.stdout))

    try:
        generated = chkit("generate")
        assert generated.exit_code == 0, format_test_diagnostic("chkit generate", generated)
        migration = next((tmp_path / "chkit" / "migrations").glob("*.sql"))
        assert f"CREATE DATABASE IF NOT EXISTS {database}" in migration.read_text()
        _append_async_load(migration, database)

        status = chkit_json("status")
        assert status["databaseMissing"] is True
        assert status["database"] == database
        assert status["pendingMigrations"] == [migration.name]

        check = chkit_json("check", exit_code=1)
        assert check["databaseMissing"] is True
        assert check["database"] == database
        check_text = chkit("check")
        assert f'Database "{database}" does not exist' in check_text.stdout
        # As in TS, check reads the live server: every snapshot object is missing.
        assert check["failedChecks"] == ["pending_migrations", "schema_drift"]

        plan = chkit_json("migrate")
        assert plan["pending"] == [migration.name]

        # #767: the run holds no migrate lock, so it stops before the async
        # load; the statements before it are recorded. The database exists
        # now: the next run takes the lock and submits the load.
        assert chkit_json("migrate", "--apply", exit_code=1)["error"]["code"] == (
            "async_needs_lock"
        )
        # #810: with the lock turned off the run holds none either.
        monkeypatch.setenv("CHKIT_MIGRATE_LOCK", "off")
        assert chkit_json("migrate", "--apply", exit_code=1)["error"]["code"] == (
            "async_needs_lock"
        )
        monkeypatch.delenv("CHKIT_MIGRATE_LOCK")
        applied = chkit_json("migrate", "--apply")
        assert [entry["name"] for entry in applied["applied"]] == [migration.name]

        wait_for_table_on_every_replica(live, database, "events")
        # The locked run also wrote its migrate lock claim to the journal (#716).
        journal = live.query(
            "SELECT name, migration_completed FROM "
            f"{quote_ident(database)}.{quote_ident(journal_table)} FINAL "
            f"WHERE name = '{migration.name}'"
        ).rows
        assert [(row["name"], bool(row["migration_completed"])) for row in journal] == [
            (migration.name, True)
        ]
        _assert_async_load_journaled(live, database, journal_table)
        # A statement that fails on the missing database is retried without
        # it, in the server's default database: no journal may land there (#493).
        stray = live.query(
            "SELECT count() AS tables FROM system.tables "
            f"WHERE database = 'default' AND name = '{journal_table}'"
        ).rows
        assert int(stray[0]["tables"]) == 0

        after = chkit_json("status")
        assert "databaseMissing" not in after
        assert after["applied"] == 1
        assert after["pending"] == 0
    finally:
        live.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        live.execute(f"DROP TABLE IF EXISTS default.{quote_ident(journal_table)} SYNC")
