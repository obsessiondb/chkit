"""A plugin target with no configured database: ``database`` is left out (#452).

Without a ``clickhouse`` block no database is configured, so when the target's
database is missing, ``check`` and ``status`` write ``databaseMissing`` alone
under ``--json`` (TS drops the undefined key) and print an empty name in text.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands import check, status
from chkit.cli.main import app
from chkit.cli.migration_store import MigrationJournal

CONFIG = """
from contextlib import nullcontext

from chkit import define_config
from chkit.cli.plugin_runtime import make_plugin_context
from chkit.plugins import ChxPlugin, ChxPluginManifest


class _Hooks:
    def get_context(self, ctx):
        return make_plugin_context(nullcontext())


config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "plugins": [ChxPlugin(manifest=ChxPluginManifest(name="target"), hooks=_Hooks())],
    }
)
"""


class _MissingDatabaseJournalStore:
    database_missing = True

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    def read_journal(self, **_kwargs: Any) -> MigrationJournal:
        return MigrationJournal(applied=[])


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    for module in (check, status):
        monkeypatch.setattr(module, "JournalStore", _MissingDatabaseJournalStore)
    return tmp_path


@pytest.mark.parametrize("command", ["check", "status"])
@pytest.mark.usefixtures("project")
def test_json_leaves_the_database_out(command: str) -> None:
    result = CliRunner().invoke(app, [command, "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["databaseMissing"] is True
    assert "database" not in payload


@pytest.mark.parametrize("command", ["check", "status"])
@pytest.mark.usefixtures("project")
def test_text_prints_an_empty_database_name(command: str) -> None:
    result = CliRunner().invoke(app, [command])

    assert result.exit_code == 0, result.output
    assert result.stdout.startswith(
        '⚠ Database "" does not exist on the target server.\n'
        "  It will be created when you run: chkit migrate --apply\n"
    )
