"""``chkit status`` prints the migrations directory absolute, as TS does (#458)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from tests.e2e_testkit import create_journal_table_name, resolve_live_env

CONFIG_TEMPLATE = """
from chkit import define_config

config = define_config(
    {{
        "schema": "./schema.py",
        "outDir": "./chkit",
        "clickhouse": {{
            "url": {url!r},
            "username": {user!r},
            "password": {password!r},
            "database": {database!r},
        }},
    }}
)
"""


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    # status only reads the journal: a fresh name that is never created.
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", create_journal_table_name("py_status_paths"))
    env = resolve_live_env()
    config = CONFIG_TEMPLATE.format(
        url=env.clickhouse_url,
        user=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
    )
    (tmp_path / "clickhouse.config.py").write_text(config, encoding="utf-8")
    (tmp_path / "schema.py").write_text("", encoding="utf-8")
    return tmp_path


def test_status_prints_the_absolute_migrations_directory(project: Path) -> None:
    migrations_dir = project / "chkit" / "migrations"

    text = CliRunner().invoke(app, ["status"])
    assert text.exit_code == 0, text.output
    assert text.stdout.splitlines()[0] == f"Migrations directory: {migrations_dir}"

    as_json = CliRunner().invoke(app, ["status", "--json"])
    assert as_json.exit_code == 0, as_json.output
    assert json.loads(as_json.stdout)["migrationsDir"] == str(migrations_dir)
