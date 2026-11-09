"""``migrate --apply`` prints the same text as TS (#486, point 3).

For each migration TS prints the optional ``-- log:`` line and ``Applied:
<file>``, nothing else (``packages/cli/src/commands/migrate/output.ts``). The
whole stdout of a two-migration run is pinned, and ``--json`` keeps stdout to
one JSON document.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
)

FIRST = "20990101000000_create.sql"
SECOND = "20990101000001_add_column.sql"


def _write_project(root: Path, db: str, table: str) -> None:
    env = resolve_live_env()
    (root / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "outDir": "./chkit",
            "migrationsDir": "./chkit/migrations",
            "metaDir": "./chkit/meta",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": env.clickhouse_user,
                "password": env.clickhouse_password,
                "database": db,
            },
        })
        + ")\n"
    )
    fqn = f"{quote_ident(db)}.{quote_ident(table)}"
    key = f"table:{db}.{table}"
    migrations = root / "chkit" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / FIRST).write_text(
        "-- chkit-migration-format: v1\n"
        "-- log: Creating the events table\n"
        f"-- operation: create_table key={key} risk=safe\n"
        f"CREATE TABLE IF NOT EXISTS {fqn} (id UInt32) ENGINE = MergeTree() ORDER BY id;\n"
    )
    (migrations / SECOND).write_text(
        "-- chkit-migration-format: v1\n"
        f"-- operation: alter_table_add_column key={key}:column:x risk=safe\n"
        f"ALTER TABLE {fqn} ADD COLUMN IF NOT EXISTS x UInt32;\n"
    )


@pytest.fixture
def project(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Any:
    client = ch_client._client
    db = client.database
    table = f"{create_prefix('apply_out_py')}t"
    journal_table = create_journal_table_name("apply_out_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")
    _write_project(tmp_path, db, table)
    yield journal_table
    client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(table)} SYNC")
    client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)} SYNC")


def test_apply_text_output_matches_ts(project: str) -> None:
    result = CliRunner().invoke(app, ["migrate", "--apply"])
    assert result.exit_code == 0, format_test_diagnostic("migrate --apply failed", result)
    assert result.stdout == (
        "Pending migrations: 2\n"
        f"- {FIRST}\n"
        "    Creating the events table\n"
        f"- {SECOND}\n"
        "  Creating the events table\n"
        f"Applied: {FIRST}\n"
        f"Applied: {SECOND}\n"
        "\n"
        f"Migrations recorded in ClickHouse {project} table.\n"
    )


def test_apply_json_output_is_one_document(project: str) -> None:
    result = CliRunner().invoke(app, ["migrate", "--apply", "--json"])
    assert result.exit_code == 0, format_test_diagnostic("migrate --apply --json failed", result)
    payload = json.loads(result.stdout)
    assert [entry["name"] for entry in payload["applied"]] == [FIRST, SECOND]
    assert "Applying" not in result.output
