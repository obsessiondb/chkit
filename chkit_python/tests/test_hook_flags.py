"""Each command hands every plugin hook it runs the parsed flags, as in TS (#456, #488).

The TS CLI passes each hook the flags its parser saw, keyed by long name: a
boolean flag as ``True``, a string flag as its value, a repeatable flag as a
list. A probe plugin records each hook call and the flags it got.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner, Result

from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
)

PROBE_PLUGIN = '''
import json
from pathlib import Path

from chkit import ColumnDefinition, table
from chkit.plugins import ChxPlugin, ChxPluginManifest


def _record(hook, flags):
    path = Path("flags.json")
    calls = json.loads(path.read_text()) if path.exists() else []
    calls.append([hook, flags])
    path.write_text(json.dumps(calls))


class _Probe:
    def on_init(self, ctx):
        _record("on_init", ctx.flags)

    def get_context(self, ctx):
        _record("get_context", ctx.flags)

    def on_config_loaded(self, ctx):
        _record("on_config_loaded", ctx.flags)

    def on_schema_loaded(self, ctx):
        _record("on_schema_loaded", ctx.flags)

    def on_plan_created(self, ctx):
        _record("on_plan_created", ctx.flags)

    def on_before_apply(self, ctx):
        _record("on_before_apply", ctx.flags)

    def on_after_apply(self, ctx):
        _record("on_after_apply", ctx.flags)

    def on_pull_introspect(self, ctx):
        _record("on_pull_introspect", ctx.flags)
        return [table(database="app", name="pulled", engine="MergeTree()",
            columns=[ColumnDefinition(name="id", type="UInt64")], primary_key=["id"], order_by=["id"])]


def probe():
    return ChxPlugin(manifest=ChxPluginManifest(name="probe"), hooks=_Probe())


class _Boom:
    def on_config_loaded(self, ctx):
        raise RuntimeError("boom in on_config_loaded")


def boom():
    return ChxPlugin(manifest=ChxPluginManifest(name="boom"), hooks=_Boom())
'''

SCHEMA = """
from chkit import ColumnDefinition, schema, table

events = table(database="app", name="events", engine="MergeTree()",
    columns=[ColumnDefinition(name="id", type="UInt64")], primary_key=["id"], order_by=["id"])
definitions = schema(events)
"""


def _write_project(root: Path, clickhouse: dict[str, Any], plugin: str = "probe") -> None:
    (root / "probe_plugin.py").write_text(PROBE_PLUGIN, encoding="utf-8")
    (root / "schema.py").write_text(SCHEMA, encoding="utf-8")
    (root / "clickhouse.config.py").write_text(
        f"from chkit import define_config\nfrom probe_plugin import {plugin}\n\n"
        "config = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "outDir": "./chkit",
            "migrationsDir": "./chkit/migrations",
            "metaDir": "./chkit/meta",
            "clickhouse": clickhouse,
        })[:-1]
        + f', "plugins": [{plugin}()]}})\n',
        encoding="utf-8",
    )


def _recorded(root: Path) -> dict[str, Any]:
    """Map each hook to the flags it got, in call order. Fail when a hook ran twice."""
    calls: list[list[Any]] = json.loads((root / "flags.json").read_text(encoding="utf-8"))
    hooks = [hook for hook, _ in calls]
    assert len(hooks) == len(set(hooks)), hooks
    return dict(calls)


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    # Nothing listens here: generate and the introspecting pull send no SQL.
    _write_project(
        tmp_path,
        {"url": "http://127.0.0.1:9", "username": "default", "password": "", "database": "app"},
    )
    return tmp_path


def test_generate_hands_every_hook_the_parsed_flags(project: Path) -> None:
    result = CliRunner().invoke(
        app,
        [
            "generate", "--dryrun", "--json", "-t", "events", "-n", "probe",
            "--migration-id", "20990101000000", "--force-shared-engines",
            "--config", "clickhouse.config.py",
        ],
    )

    assert result.exit_code == 0, result.output
    expected = {
        "--config": "clickhouse.config.py",
        "--name": "probe",
        "--migration-id": "20990101000000",
        "--table": "events",
        "--dryrun": True,
        "--json": True,
        "--force-shared-engines": True,
    }
    assert _recorded(project) == {
        "on_init": expected,
        "get_context": expected,
        "on_config_loaded": expected,
        "on_schema_loaded": expected,
        "on_plan_created": expected,
    }


def test_generate_without_flags_hands_the_hooks_none(project: Path) -> None:
    result = CliRunner().invoke(app, ["generate", "--dryrun"])

    assert result.exit_code == 0, result.output
    assert _recorded(project) == {
        "on_init": {"--dryrun": True},
        "get_context": {"--dryrun": True},
        "on_config_loaded": {"--dryrun": True},
        "on_schema_loaded": {"--dryrun": True},
        "on_plan_created": {"--dryrun": True},
    }


def test_generate_empty_runs_on_init_and_get_context_only(project: Path) -> None:
    result = CliRunner().invoke(app, ["generate", "--empty", "-n", "stub", "--json"])

    assert result.exit_code == 0, result.output
    expected = {"--name": "stub", "--json": True, "--empty": True}
    assert _recorded(project) == {"on_init": expected, "get_context": expected}


def test_pull_hands_its_hooks_the_parsed_flags(project: Path) -> None:
    result = CliRunner().invoke(
        app,
        ["pull", "-o", "out.py", "-d", "app", "--force", "--overwrite", "--json"],
    )

    assert result.exit_code == 0, result.output
    expected = {
        "--out-file": "out.py",
        "--database": ["app"],
        "--force": True,
        "--overwrite": True,
        "--json": True,
    }
    assert _recorded(project) == {
        "on_init": expected,
        "get_context": expected,
        "on_config_loaded": expected,
        "on_pull_introspect": expected,
    }
    # As in TS, where the dispatcher runs on_config_loaded before get_context.
    assert list(_recorded(project)) == [
        "on_init", "on_config_loaded", "get_context", "on_pull_introspect",
    ]
    assert (project / "out.py").exists()


# TS runs pull as a plugin command. Its dispatcher (command-dispatch.ts) reports
# an on_config_loaded error with this message and exits 2.
BOOM_MESSAGE = 'Plugin "boom" failed in onConfigLoaded: boom in on_config_loaded'


def _pull_with_boom(root: Path, monkeypatch: pytest.MonkeyPatch, *args: str) -> Result:
    monkeypatch.chdir(root)
    monkeypatch.syspath_prepend(str(root))
    _write_project(
        root,
        {"url": "http://127.0.0.1:9", "username": "default", "password": "", "database": "app"},
        plugin="boom",
    )
    return CliRunner().invoke(app, ["pull", "--dryrun", *args])


def test_pull_reports_an_on_config_loaded_error_like_ts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = _pull_with_boom(tmp_path, monkeypatch)

    assert result.exit_code == 2, result.output
    assert result.stdout == ""
    assert result.stderr == f"{BOOM_MESSAGE}\n"


def test_pull_json_reports_an_on_config_loaded_error_like_ts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = _pull_with_boom(tmp_path, monkeypatch, "--json")

    assert result.exit_code == 2, result.output
    assert json.loads(result.stdout) == {"ok": False, "error": BOOM_MESSAGE}
    assert result.stderr == ""


def test_snapshot_rebuild_hands_every_hook_the_parsed_flags(project: Path) -> None:
    result = CliRunner().invoke(
        app, ["snapshot", "rebuild", "--dryrun", "--json", "--force-shared-engines"]
    )

    assert result.exit_code == 0, result.output
    expected = {"--dryrun": True, "--json": True, "--force-shared-engines": True}
    assert _recorded(project) == {
        "on_init": expected,
        "get_context": expected,
        "on_config_loaded": expected,
        "on_schema_loaded": expected,
    }


def test_pull_writes_the_default_out_file_and_needs_force_to_overwrite(project: Path) -> None:
    default_out = project / "src" / "db" / "schema" / "pulled.py"

    assert CliRunner().invoke(app, ["pull"]).exit_code == 0
    assert default_out.exists()
    assert _recorded(project)["on_pull_introspect"] == {}

    refused = CliRunner().invoke(app, ["pull"])
    assert refused.exit_code != 0
    assert "Output file already exists" in refused.output
    for flag in ("--force", "-f", "--overwrite"):
        assert CliRunner().invoke(app, ["pull", flag]).exit_code == 0, flag


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


def test_migrate_hands_every_hook_the_parsed_flags(
    live: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    journal_table = create_journal_table_name("hook_flags_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    _write_project(
        tmp_path,
        {
            "url": env.clickhouse_url,
            "username": env.clickhouse_user,
            "password": env.clickhouse_password,
            "database": live.database,
        },
    )
    migrations = tmp_path / "chkit" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "20990101000000_select.sql").write_text("SELECT 1;\n", encoding="utf-8")

    try:
        result = CliRunner().invoke(
            app,
            [
                "migrate", "--apply", "--allow-destructive", "--json",
                "--setting", "max_execution_time=60", "--no-shared-engines",
            ],
        )
        assert result.exit_code == 0, format_test_diagnostic("migrate --apply failed", result)
    finally:
        live.execute(
            f"DROP TABLE IF EXISTS {quote_ident(live.database)}.{quote_ident(journal_table)} SYNC"
        )

    expected = {
        "--apply": True,
        "--allow-destructive": True,
        "--setting": ["max_execution_time=60"],
        "--json": True,
        "--no-shared-engines": True,
    }
    assert _recorded(tmp_path) == {
        "on_init": expected,
        "get_context": expected,
        "on_config_loaded": expected,
        "on_before_apply": expected,
        "on_after_apply": expected,
    }


@pytest.mark.parametrize(
    ("argv", "expected", "exit_code"),
    [
        (
            ["status", "--json", "--no-shared-engines", "--service", "probe"],
            {"--json": True, "--no-shared-engines": True, "--service": "probe"},
            0,
        ),
        (
            ["check", "--strict", "--json", "--service", "probe"],
            {"--strict": True, "--json": True, "--service": "probe"},
            1,  # The migration that generate wrote is pending.
        ),
        (
            ["drift", "--json", "--table", "events", "--service", "probe"],
            {"--json": True, "--table": "events", "--service": "probe"},
            0,
        ),
        (
            ["query", "SELECT 1", "--json", "--service", "probe"],
            {"--json": True, "--service": "probe"},
            0,
        ),
    ],
    ids=["status", "check", "drift", "query"],
)
def test_status_check_drift_and_query_hand_their_hooks_the_parsed_flags(  # noqa: PLR0917
    live: ClickHouseClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    argv: list[str],
    expected: dict[str, Any],
    exit_code: int,
) -> None:
    env = resolve_live_env()
    journal_table = create_journal_table_name("hook_flags_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    _write_project(
        tmp_path,
        {
            "url": env.clickhouse_url,
            "username": env.clickhouse_user,
            "password": env.clickhouse_password,
            "database": live.database,
        },
    )
    # drift needs a snapshot; generate writes one.
    assert CliRunner().invoke(app, ["generate", "-n", "init"]).exit_code == 0
    (tmp_path / "flags.json").unlink()

    try:
        result = CliRunner().invoke(app, argv)
    finally:
        live.execute(
            f"DROP TABLE IF EXISTS {quote_ident(live.database)}.{quote_ident(journal_table)} SYNC"
        )

    assert result.exit_code == exit_code, format_test_diagnostic(" ".join(argv), result)
    recorded = _recorded(tmp_path)
    assert recorded["on_init"] == expected
    assert recorded["get_context"] == expected
