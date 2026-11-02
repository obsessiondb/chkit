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
from chkit.cli.json_output import _reset_for_testing
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


class _ConfigLoadedHooks:
    def __init__(self, fail):
        self.fail, self.calls = fail, []

    def on_config_loaded(self, ctx):
        scope = ctx.table_scope
        self.calls.append(["on_config_loaded", ctx.command, scope.selector, scope.matched_tables])
        if self.fail:
            raise RuntimeError("boom")

    def on_check(self, ctx):
        self.calls.append(["on_check", ctx.command])
        return ChxOnCheckResult(plugin="probe", evaluated=True, ok=True, findings=[], metadata={"calls": self.calls})


def _config_loaded_probe(fail):
    return ChxPlugin(manifest=ChxPluginManifest(name="probe"), hooks=_ConfigLoadedHooks(fail))


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

FLAG_PROBE = """
import json


class _Probe:
    def on_check(self, ctx):
        with open("flags.json", "w") as f:
            json.dump(ctx.flags, f)


_probe = ChxPlugin(manifest=ChxPluginManifest(name="probe"), hooks=_Probe())
"""

DISTRIBUTED_SCHEMA = """
from chkit import ColumnDefinition, schema, table

events_local = table(database="app", name="events_local", engine="MergeTree()",
    columns=[ColumnDefinition(name="id", type="UInt64")], primary_key=["id"], order_by=["id"])
events = table(database="app", name="events",
    engine="Distributed('cluster', 'app', 'events_local', rand())",
    columns=[ColumnDefinition(name="id", type="UInt64")])
definitions = schema(events_local, events)
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


def test_on_config_loaded_runs_before_on_check_with_the_table_scope(project: Path) -> None:
    """TS check runs ``onConfigLoaded`` (command, table scope) right before ``onCheck`` (#449)."""
    _write_config(project, "[_config_loaded_probe(False)]")

    result = _check("--json", "--table", "events")

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["plugins"]["probe"]["calls"] == [
        ["on_config_loaded", "check", "events", ["app.events"]],
        ["on_check", "check"],
    ]


def test_an_on_config_loaded_error_fails_check_as_in_ts(project: Path) -> None:
    _write_config(project, "[_config_loaded_probe(True)]")
    _reset_for_testing()  # an earlier --json run in this process marks JSON as written

    result = _check("--json")

    assert result.exit_code == 1
    assert json.loads(result.stdout) == {
        "command": "check",
        "schemaVersion": 1,
        "ok": False,
        "error": {
            "code": "error",
            "message": 'Plugin "probe" failed in onConfigLoaded: boom',
        },
    }
    assert result.stderr == 'Plugin "probe" failed in onConfigLoaded: boom\n'


def test_schema_validation_is_left_to_generate(project: Path) -> None:
    (project / "schema.py").write_text(SCHEMA.replace("PRIMARY_KEY", "missing"), encoding="utf-8")

    result = _check("--json")
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["failedChecks"] == []

    generated = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])
    assert generated.exit_code == 1
    assert json.loads(generated.stdout)["error"] == "validation_failed"


def test_on_check_gets_the_passed_flags_keyed_as_in_ts(project: Path) -> None:
    """As in TS, on_check gets only the flags that were passed, by long name (#450)."""
    config = project / "clickhouse.config.py"
    config.write_text(
        CONFIG.replace("config = define_config", FLAG_PROBE + "\nconfig = define_config")
        .replace("PLUGINS", "[_probe]"),
        encoding="utf-8",
    )

    _check()
    assert json.loads((project / "flags.json").read_text(encoding="utf-8")) == {}

    _check(
        "--config", "clickhouse.config.py", "--json", "--strict", "-t", "events",
        "--force-shared-engines", "--no-shared-engines",
    )
    assert json.loads((project / "flags.json").read_text(encoding="utf-8")) == {
        "--config": "clickhouse.config.py",
        "--json": True,
        "--table": "events",
        "--strict": True,
        "--force-shared-engines": True,
        "--no-shared-engines": True,
    }


def test_force_shared_engines_fails_a_distributed_table(project: Path) -> None:
    """As in TS, the ObsessionDB check reads --force-shared-engines (#450)."""
    (project / "schema.py").write_text(DISTRIBUTED_SCHEMA, encoding="utf-8")
    (project / "clickhouse.config.py").write_text(
        "from chkit_plugin_obsessiondb import obsessiondb\n"
        + CONFIG.replace("PLUGINS", "[obsessiondb()]"),
        encoding="utf-8",
    )

    assert json.loads(_check("--json").stdout)["plugins"] == {}

    result = _check("--json", "--force-shared-engines")
    assert result.exit_code == 1, result.output
    payload = json.loads(result.stdout)
    assert payload["failedChecks"] == ["plugin:obsessiondb"]
    assert payload["plugins"] == {
        "obsessiondb": {
            "evaluated": True,
            "ok": False,
            "findingCodes": ["obsessiondb_distributed_unsupported"],
        }
    }
