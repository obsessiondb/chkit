"""A plugin command that declares ``--table`` gets the resolved table scope,
as in the TS CLI (#565): the selector is matched against the schema's tables."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app

# CI forces rich to colour usage errors.
ANSI_STYLE = re.compile(r"\x1b\[[0-9;]*m")

CONFIG = '''
from chkit import define_config
from chkit.plugins import ChxPlugin, ChxPluginCommand, ChxPluginManifest


def _show(ctx):
    scope = ctx.table_scope
    ctx.print({
        "enabled": scope.enabled,
        "selector": scope.selector,
        "matchedTables": list(scope.matched_tables),
        "matchCount": scope.match_count,
    })
    return 0


plugin = ChxPlugin(
    manifest=ChxPluginManifest(name="probe"),
    commands=[
        ChxPluginCommand(
            name="show",
            run=_show,
            flags=[{"name": "--table", "short": "-t", "type": "string", "description": "Tables"}],
        ),
        ChxPluginCommand(name="other", run=lambda _ctx: 0),
    ],
)

config = define_config({"schema": "./schema.py", "outDir": "./chkit", "plugins": [plugin]})
'''

SCHEMA = "\n".join(
    [
        "from chkit import table",
        *(
            f"{name} = table(database={database!r}, name={name!r}, engine='MergeTree()', "
            "columns=[{'name': 'id', 'type': 'UInt64'}], primary_key=['id'], order_by=['id'])"
            for database, name in (("app", "users"), ("app", "events_a"), ("ops", "events_b"))
        ),
    ]
)


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text(SCHEMA)
    return tmp_path


def _scope(*args: str) -> dict[str, Any]:
    result = CliRunner().invoke(app, ["plugin", "--json", "probe", "show", *args])
    assert result.exit_code == 0, result.output
    payload: dict[str, Any] = json.loads(result.stdout)
    return payload


@pytest.mark.usefixtures("project")
def test_a_declared_table_flag_resolves_against_the_schema() -> None:
    assert _scope("--table", "app.users") == {
        "enabled": True,
        "selector": "app.users",
        "matchedTables": ["app.users"],
        "matchCount": 1,
    }
    assert _scope("-t", "events_*") == {
        "enabled": True,
        "selector": "events_*",
        "matchedTables": ["app.events_a", "ops.events_b"],
        "matchCount": 2,
    }
    assert _scope("--table=ops.events_*")["matchedTables"] == ["ops.events_b"]


@pytest.mark.usefixtures("project")
def test_a_table_flag_before_the_names_moves_behind_them() -> None:
    # As in TS, a leading --table is never read as the plugin or command name.
    for args in (
        ["--table", "app.users", "probe", "show"],
        ["-t=app.users", "probe", "show"],
        ["probe", "-t", "app.users", "show"],
    ):
        result = CliRunner().invoke(app, ["plugin", "--json", *args])
        assert result.exit_code == 0, (args, result.output)
        assert json.loads(result.stdout)["matchedTables"] == ["app.users"], args

    # Without a value it does not take the next flag as its value.
    _reset_for_testing()
    missing = CliRunner().invoke(app, ["plugin", "--table", "--json", "probe", "show"])
    assert missing.exit_code == 1, missing.output
    assert json.loads(missing.stdout)["error"] == "Missing value for --table"

    # A command that does not declare it rejects it.
    other = CliRunner().invoke(app, ["plugin", "--table", "app.users", "probe", "other"])
    assert other.exit_code == 1, other.output
    assert "Unknown flag: --table" in ANSI_STYLE.sub("", other.output)


@pytest.mark.usefixtures("project")
def test_an_unmatched_selector_is_an_empty_scope_and_no_selector_is_unscoped() -> None:
    assert _scope("--table", "missing") == {
        "enabled": True,
        "selector": "missing",
        "matchedTables": [],
        "matchCount": 0,
    }
    unscoped = {"enabled": False, "selector": None, "matchedTables": [], "matchCount": 0}
    assert _scope() == unscoped
    assert _scope("--table", "") == unscoped


def test_a_schema_that_fails_to_load_leaves_the_selector_unmatched(project: Path) -> None:
    (project / "schema.py").write_text("raise RuntimeError('broken schema')\n")
    assert _scope("--table", "app.users") == {
        "enabled": True,
        "selector": "app.users",
        "matchedTables": [],
        "matchCount": 0,
    }


@pytest.mark.usefixtures("project")
def test_an_invalid_selector_fails_the_command() -> None:
    message = (
        'Invalid --table selector "a*b". "*" is only allowed as a trailing suffix '
        "(for example, events_*)."
    )
    text = CliRunner().invoke(app, ["plugin", "probe", "show", "--table", "a*b"])
    assert text.exit_code == 1, text.output
    assert text.stdout == ""
    assert message in ANSI_STYLE.sub("", text.output)

    # The emit flag is process-wide; earlier invocations in this process set it.
    _reset_for_testing()
    as_json = CliRunner().invoke(app, ["plugin", "--json", "probe", "show", "--table", "a*b"])
    assert as_json.exit_code == 1, as_json.output
    assert json.loads(as_json.stdout) == {
        "command": "plugin",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "error", "message": message},
    }
