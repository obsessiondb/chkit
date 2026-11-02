"""generate, migrate and pull hand every plugin hook the parsed flags, as in TS (#456).

The TS CLI passes each hook the flags its parser saw, keyed by long name: a
boolean flag as ``True``, a string flag as its value, a repeatable flag as a
list. A probe plugin records what each hook got.
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
    seen = json.loads(path.read_text()) if path.exists() else {}
    seen[hook] = flags
    path.write_text(json.dumps(seen))


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
'''

SCHEMA = """
from chkit import ColumnDefinition, schema, table

events = table(database="app", name="events", engine="MergeTree()",
    columns=[ColumnDefinition(name="id", type="UInt64")], primary_key=["id"], order_by=["id"])
definitions = schema(events)
"""


def _write_project(root: Path, clickhouse: dict[str, Any]) -> None:
    (root / "probe_plugin.py").write_text(PROBE_PLUGIN, encoding="utf-8")
    (root / "schema.py").write_text(SCHEMA, encoding="utf-8")
    (root / "clickhouse.config.py").write_text(
        "from chkit import define_config\nfrom probe_plugin import probe\n\n"
        "config = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "outDir": "./chkit",
            "migrationsDir": "./chkit/migrations",
            "metaDir": "./chkit/meta",
            "clickhouse": clickhouse,
        })[:-1]
        + ', "plugins": [probe()]})\n',
        encoding="utf-8",
    )


def _recorded(root: Path) -> dict[str, Any]:
    flags: dict[str, Any] = json.loads((root / "flags.json").read_text(encoding="utf-8"))
    return flags


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
        "on_config_loaded": expected,
        "on_schema_loaded": expected,
        "on_plan_created": expected,
    }


def test_generate_without_flags_hands_the_hooks_none(project: Path) -> None:
    result = CliRunner().invoke(app, ["generate", "--dryrun"])

    assert result.exit_code == 0, result.output
    assert _recorded(project) == {
        "on_config_loaded": {"--dryrun": True},
        "on_schema_loaded": {"--dryrun": True},
        "on_plan_created": {"--dryrun": True},
    }


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
        "on_pull_introspect": expected,
    }
    assert (project / "out.py").exists()


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
        "on_before_apply": expected,
        "on_after_apply": expected,
    }
