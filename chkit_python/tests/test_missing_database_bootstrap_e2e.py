"""A new project whose ``clickhouse.database`` does not exist yet (#351).

``status``, ``check`` and ``migrate`` report the missing database instead of
failing at connect time, and ``migrate --apply`` runs the migration's
``CREATE DATABASE``, then creates the table and journals the migration in the
new database.
"""

from __future__ import annotations

import json
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


def test_migrate_apply_creates_a_missing_database(
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

        status = chkit_json("status")
        assert status["databaseMissing"] is True
        assert status["database"] == database
        assert status["pendingMigrations"] == [migration.name]

        check = chkit_json("check", exit_code=1)
        assert check["databaseMissing"] is True
        assert check["failedChecks"] == ["pending_migrations"]

        plan = chkit_json("migrate")
        assert plan["pending"] == [migration.name]

        applied = chkit_json("migrate", "--apply")
        assert [entry["name"] for entry in applied["applied"]] == [migration.name]

        wait_for_table_on_every_replica(live, database, "events")
        journal = live.query(
            "SELECT name, migration_completed FROM "
            f"{quote_ident(database)}.{quote_ident(journal_table)} FINAL"
        ).rows
        assert [(row["name"], bool(row["migration_completed"])) for row in journal] == [
            (migration.name, True)
        ]

        after = chkit_json("status")
        assert "databaseMissing" not in after
        assert after["applied"] == 1
        assert after["pending"] == 0
    finally:
        live.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
