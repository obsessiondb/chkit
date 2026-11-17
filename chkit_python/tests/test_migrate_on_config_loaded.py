"""`migrate` runs the plugins' ``on_config_loaded`` hooks as TS does (#455).

TS ``packages/cli/src/commands/migrate/command.ts`` calls ``onConfigLoaded``
(command ``migrate``, the resolved ``--table`` scope) after resolving the
scope and before listing the migrations, in plan and apply mode.
"""

from __future__ import annotations

import json
from contextlib import nullcontext
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands import migrate
from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app
from chkit.cli.migration_store import MigrationJournal

# The probe records each call in hook-calls.json, including whether the
# migrations directory exists yet (migrate creates it when it lists them).
CONFIG = """
import json
from pathlib import Path

from chkit import define_config
from chkit.plugins import ChxPlugin, ChxPluginManifest


class _Hooks:
    def on_config_loaded(self, ctx):
        scope = ctx.table_scope
        log = Path("hook-calls.json")
        calls = json.loads(log.read_text()) if log.exists() else []
        listed = Path("chkit/migrations").exists()
        calls.append([ctx.command, scope.selector, scope.matched_tables, listed])
        log.write_text(json.dumps(calls))
        if FAIL:
            raise RuntimeError("boom")


config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {"url": "http://localhost:8123", "database": "app"},
        "plugins": [ChxPlugin(manifest=ChxPluginManifest(name="probe"), hooks=_Hooks())],
    }
)
"""

SNAPSHOT = {
    "version": 1,
    "generatedAt": "2026-11-01T00:00:00.000Z",
    "definitions": [
        {
            "kind": "table",
            "database": "app",
            "name": "events",
            "engine": "MergeTree()",
            "columns": [{"name": "id", "type": "UInt64"}],
            "primaryKey": ["id"],
            "orderBy": ["id"],
        }
    ],
}


class _EmptyJournalStore:
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    def read_journal(self, **_kwargs: Any) -> MigrationJournal:
        return MigrationJournal(applied=[])

    def lock_target(self) -> None:
        # The isolated hook test has no database; even an empty apply now
        # enters the lock path to check for interrupted cancellation.
        return None


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "chkit/meta").mkdir(parents=True)
    (tmp_path / "chkit/meta/snapshot.json").write_text(json.dumps(SNAPSHOT), encoding="utf-8")
    monkeypatch.setattr(migrate, "open_client", lambda *_args: nullcontext(None))
    monkeypatch.setattr(migrate, "JournalStore", _EmptyJournalStore)
    _reset_for_testing()  # an earlier --json run in this process marks JSON as written
    return tmp_path


def _write_config(project: Path, *, fail: bool) -> None:
    (project / "clickhouse.config.py").write_text(
        f"FAIL = {fail}\n{CONFIG}", encoding="utf-8"
    )


def _hook_calls(project: Path) -> Any:
    return json.loads((project / "hook-calls.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("mode", [[], ["--apply"]])
def test_on_config_loaded_runs_with_the_table_scope_before_listing(
    project: Path, mode: list[str]
) -> None:
    _write_config(project, fail=False)

    result = CliRunner().invoke(app, ["migrate", "--json", "--table", "events", *mode])

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["mode"] == ("execute" if mode else "plan")
    assert _hook_calls(project) == [["migrate", "events", ["app.events"], False]]


def test_an_on_config_loaded_error_fails_migrate_as_in_ts(project: Path) -> None:
    _write_config(project, fail=True)

    result = CliRunner().invoke(app, ["migrate", "--json"])

    assert result.exit_code == 1
    assert json.loads(result.stdout) == {
        "command": "migrate",
        "schemaVersion": 1,
        "ok": False,
        "error": {
            "code": "error",
            "message": 'Plugin "probe" failed in onConfigLoaded: boom',
        },
    }
    assert result.stderr == 'Plugin "probe" failed in onConfigLoaded: boom\n'
    assert _hook_calls(project) == [["migrate", None, [], False]]
