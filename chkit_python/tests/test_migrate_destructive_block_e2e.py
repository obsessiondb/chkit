"""Port of ``packages/cli/src/test/destructive-block.e2e.test.ts``.

A hand-written DROP COLUMN with no markers is blocked in text mode with exit
code 3, and the CLI prints the same lines as the TS CLI (#486).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands import migrate
from chkit.cli.main import app
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    quote_ident,
    resolve_live_env,
)

MIGRATION = "20990101000000_drop_email.sql"


@pytest.fixture
def project(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[str]:
    """A project with one pending DROP COLUMN migration; yields the journal table name."""
    client = ch_client._client
    env = resolve_live_env()
    db = client.database
    table = f"{create_prefix('destructive_py')}users"
    journal_table = create_journal_table_name("destructive_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")

    (tmp_path / "clickhouse.config.py").write_text(
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
    client.command(f"CREATE TABLE {fqn} (id UInt64, email String) ENGINE = MergeTree ORDER BY id")
    migrations = tmp_path / "chkit" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / MIGRATION).write_text(f"ALTER TABLE {fqn} DROP COLUMN email;\n")
    try:
        yield journal_table
    finally:
        client.command(f"DROP TABLE IF EXISTS {fqn} SYNC")
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)} SYNC")


def test_blocked_in_ci_exits_3(project: str) -> None:
    result = CliRunner().invoke(app, ["migrate", "--apply"])

    assert result.exit_code == 3
    assert result.stderr.splitlines() == [
        "Blocked destructive migration execution. Re-run with --allow-destructive "
        "or set safety.allowDestructive=true after review.",
        f"Destructive migrations: {MIGRATION}",
        "Non-interactive run detected. Pass --allow-destructive to proceed.",
    ]


def test_cancelled_by_user_exits_3(project: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(migrate, "is_background_or_ci", lambda: False)
    monkeypatch.setattr(migrate, "confirm_destructive_execution", lambda _markers: False)

    result = CliRunner().invoke(app, ["migrate", "--apply"])

    assert result.exit_code == 3
    assert result.stderr.splitlines() == [
        "Destructive migration cancelled by user.",
        f"Destructive migrations: {MIGRATION}",
    ]


def test_allowed_prints_only_the_applied_line(project: str) -> None:
    result = CliRunner().invoke(app, ["migrate", "--apply", "--allow-destructive"])

    assert result.exit_code == 0, result.output
    assert result.stdout.splitlines() == [
        "Pending migrations: 1",
        f"- {MIGRATION}",
        f"Applied: {MIGRATION}",
        "",
        f"Migrations recorded in ClickHouse {project} table.",
    ]
