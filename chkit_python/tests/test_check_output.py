"""`check` prints the same JSON and text as the TS command (#435).

The expected values follow ``packages/cli/src/commands/check/output.ts``: the
TS keys in TS order (``plugins`` always written), the TS text lines, no schema
validation, and a plugin fails only with an evaluated, not-ok result that has
an error-severity finding.
"""

from __future__ import annotations

import json
from contextlib import nullcontext
from pathlib import Path
from typing import Any, ClassVar

import pytest
from typer.testing import CliRunner

from chkit.cli.commands import check
from chkit.cli.commands.drift_payload import DriftPayload
from chkit.cli.main import app
from chkit.cli.migration_store import MigrationJournal, MigrationJournalEntry

CONFIG = """
from chkit import define_config
from chkit.plugins import ChxCheckFinding, ChxOnCheckResult, ChxPlugin, ChxPluginManifest


class _Hooks:
    def __init__(self, name, evaluated, severity):
        self.name, self.evaluated, self.severity = name, evaluated, severity

    def on_check(self, ctx):
        return ChxOnCheckResult(
            plugin=self.name,
            evaluated=self.evaluated,
            ok=False,
            findings=[ChxCheckFinding(code=self.name + "_code", message="m", severity=self.severity)],
            metadata={"extra": 1},
        )

    def on_check_report(self, ctx):
        ctx.print(self.name + " report")


def _plugin(name, evaluated, severity):
    return ChxPlugin(manifest=ChxPluginManifest(name=name), hooks=_Hooks(name, evaluated, severity))


config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {
            "url": "http://localhost:8123",
            "username": "default",
            "password": "",
            "database": "app",
        },
        "plugins": PLUGINS,
    }
)
"""

SCHEMA = """
from chkit import ColumnDefinition, schema, table

events = table(database="app", name="events", engine="MergeTree()",
    columns=[ColumnDefinition(name="id", type="UInt64")], primary_key=["id"], order_by=["id"])
users = table(database="app", name="users", engine="MergeTree()",
    columns=[ColumnDefinition(name="id", type="UInt64")], primary_key=["PRIMARY_KEY"], order_by=["id"])
definitions = schema(events, users)
"""

EVENTS_ONLY_MIGRATION = """-- operation: add_column key=table:app.events:column:extra risk=safe
ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `extra` String;
"""


class _FakeJournalStore:
    applied: ClassVar[list[str]] = []
    database_missing = False

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    def read_journal(self, **_kwargs: Any) -> MigrationJournal:
        return MigrationJournal(
            applied=[
                MigrationJournalEntry(name=name, applied_at="", checksum="")
                for name in self.applied
            ]
        )


def _drift_payload(*, drifted: bool) -> DriftPayload:
    return DriftPayload(
        snapshot_file="",
        expected_count=2,
        actual_count=2,
        drifted=drifted,
        missing=["table:app.users"] if drifted else [],
        extra=[],
        kind_mismatches=[],
        object_drift=[],
        table_drift=[],
    )


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "schema.py").write_text(SCHEMA.replace("PRIMARY_KEY", "id"), encoding="utf-8")
    _write_config(tmp_path, "[]")
    generated = CliRunner().invoke(app, ["generate", "--name", "init"])
    assert generated.exit_code == 0, generated.output
    monkeypatch.setattr(check, "open_client", lambda *_args: nullcontext(None))
    monkeypatch.setattr(check, "JournalStore", _FakeJournalStore)
    monkeypatch.setattr(_FakeJournalStore, "applied", _migration_files(tmp_path))
    monkeypatch.setattr(_FakeJournalStore, "database_missing", False)
    monkeypatch.setattr(check, "find_checksum_mismatches", lambda *_args: [])
    monkeypatch.setattr(
        check, "build_drift_payload", lambda **_kwargs: _drift_payload(drifted=False)
    )
    return tmp_path


def _write_config(project: Path, plugins: str) -> None:
    (project / "clickhouse.config.py").write_text(
        CONFIG.replace("PLUGINS", plugins), encoding="utf-8"
    )


def _migration_files(project: Path) -> list[str]:
    return sorted(p.name for p in (project / "chkit" / "migrations").glob("*.sql"))


def _check(*args: str) -> Any:
    return CliRunner().invoke(app, ["check", *args])


def test_json_has_the_ts_keys_in_ts_order(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(_FakeJournalStore, "applied", [])
    monkeypatch.setattr(_FakeJournalStore, "database_missing", True)
    monkeypatch.setattr(
        check, "build_drift_payload", lambda **_kwargs: _drift_payload(drifted=True)
    )

    result = _check("--json")

    assert result.exit_code == 1, result.output
    payload = json.loads(result.stdout)
    assert list(payload) == [
        "command", "schemaVersion", "strict", "policy", "ok", "failedChecks", "pendingCount",
        "checksumMismatchCount", "drifted", "driftEvaluated", "driftReasonCounts",
        "driftReasonTotals", "plugins", "scope", "databaseMissing", "database",
    ]
    assert payload["failedChecks"] == ["pending_migrations", "schema_drift"]
    assert payload["pendingCount"] == 1
    assert payload["plugins"] == {}
    assert payload["database"] == "app"


def test_text_matches_the_ts_lines(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_FakeJournalStore, "applied", [])
    monkeypatch.setattr(_FakeJournalStore, "database_missing", True)

    result = _check("--table", "events")

    assert result.exit_code == 1, result.output
    assert result.stdout == (
        '⚠ Database "app" does not exist on the target server.\n'
        "  It will be created when you run: chkit migrate --apply\n"
        "\n"
        "Check status: failed\n"
        "Policy: pending=on, checksum=on, drift=on\n"
        "Pending migrations: 1\n"
        "Checksum mismatches: 0\n"
        "Table scope: events (1 matched)\n"
        "- app.events\n"
        "Schema drift: no\n"
        "Drift reasons: total=0, object=0, table=0\n"
        "Failed checks: pending_migrations\n"
    )


def test_table_scope_keeps_pending_migrations_of_other_tables(project: Path) -> None:
    """As in TS, ``--table`` scopes only the drift and plugin checks."""
    (project / "chkit" / "migrations" / "20990101000000_events_only.sql").write_text(
        EVENTS_ONLY_MIGRATION, encoding="utf-8"
    )

    payload = json.loads(_check("--json", "--table", "users").stdout)

    assert payload["pendingCount"] == 1
    assert payload["failedChecks"] == ["pending_migrations"]


def test_only_an_evaluated_result_with_an_error_finding_fails(project: Path) -> None:
    _write_config(
        project,
        '[_plugin("errp", True, "error"), _plugin("warnp", True, "warn"), '
        '_plugin("unevalp", False, "error")]',
    )

    payload = json.loads(_check("--json").stdout)
    assert payload["failedChecks"] == ["plugin:errp"]
    assert payload["plugins"]["warnp"] == {
        "evaluated": True, "ok": False, "findingCodes": ["warnp_code"], "extra": 1,
    }
    assert list(payload["plugins"]) == ["errp", "warnp", "unevalp"]

    result = _check()
    assert result.exit_code == 1, result.output
    assert result.stdout == (
        "Check status: failed\n"
        "Policy: pending=on, checksum=on, drift=on\n"
        "Pending migrations: 0\n"
        "Checksum mismatches: 0\n"
        "Schema drift: no\n"
        "Drift reasons: total=0, object=0, table=0\n"
        "Plugin checks:\n"
        "- errp: failed (errp_code)\n"
        "- warnp: failed (warnp_code)\n"
        "- unevalp: failed (unevalp_code)\n"
        "Failed checks: plugin:errp\n"
        "errp report\n"
        "warnp report\n"
        "unevalp report\n"
    )


def test_schema_validation_is_left_to_generate(project: Path) -> None:
    (project / "schema.py").write_text(SCHEMA.replace("PRIMARY_KEY", "missing"), encoding="utf-8")

    result = _check("--json")
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["failedChecks"] == []

    generated = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])
    assert generated.exit_code == 1
    assert json.loads(generated.stdout)["error"] == "validation_failed"
