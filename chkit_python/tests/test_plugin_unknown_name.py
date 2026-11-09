"""An unknown plugin, or an unknown command of a configured plugin, fails as
in the TS CLI (``packages/cli/src/commands/plugin.ts`` and the shortcut
dispatch in ``packages/cli/src/bin/chkit.ts``): the message on stderr, exit 1,
and under ``--json`` the TS envelope on stdout, never click's usage banner and
exit 2."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app

CONFIG = """
from chkit import define_config
from chkit.plugins import ChxPlugin, ChxPluginCommand, ChxPluginManifest

echoer = ChxPlugin(
    manifest=ChxPluginManifest(name="echoer"),
    commands=[
        ChxPluginCommand(name="echo", run=lambda _ctx: 0),
        ChxPluginCommand(name="other", run=lambda _ctx: 0),
    ],
)
alpha = ChxPlugin(manifest=ChxPluginManifest(name="alpha"), commands=[])

config = define_config({"schema": "./schema.py", "plugins": [echoer, alpha]})
"""


@pytest.fixture(autouse=True)
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    # No user profile or ObsessionDB login: only the project's plugins load.
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text("")
    _reset_for_testing()
    yield tmp_path
    _reset_for_testing()


def _run(*args: str) -> tuple[int, str, str]:
    result = CliRunner().invoke(app, list(args))
    return result.exit_code, result.stdout, result.stderr


UNKNOWN_PLUGIN = 'Unknown plugin "x". Available: alpha, echoer.'


@pytest.mark.parametrize("args", [["plugin", "x"], ["plugin", "x", "cmd", "--flag"]])
def test_an_unknown_plugin_fails_with_exit_1_and_the_available_plugins(
    args: list[str],
) -> None:
    assert _run(*args) == (1, "", UNKNOWN_PLUGIN + "\n")


@pytest.mark.parametrize("args", [["plugin", "x"], ["plugin", "x", "cmd"]])
def test_an_unknown_plugin_under_json_prints_the_error_envelope(args: list[str]) -> None:
    exit_code, stdout, stderr = _run(*args, "--json")

    assert (exit_code, stderr) == (1, UNKNOWN_PLUGIN + "\n")
    assert json.loads(stdout) == {
        "command": "plugin",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "error", "message": UNKNOWN_PLUGIN},
    }


def test_a_json_flag_after_dash_dash_is_an_argument_not_json_mode() -> None:
    assert _run("plugin", "x", "--", "--json") == (1, "", UNKNOWN_PLUGIN + "\n")


def test_a_usage_error_with_json_after_dash_dash_still_prints_the_usage_envelope() -> None:
    # TS reports a core command's flag error under --json read from all of
    # argv: `status -- --json` prints a `usage` envelope.
    exit_code, stdout, _stderr = _run("status", "--", "--json")

    assert exit_code == 1
    assert json.loads(stdout)["error"]["code"] == "usage"


def test_an_unknown_command_lists_the_plugin_commands_in_their_order() -> None:
    assert _run("plugin", "echoer", "nope") == (
        1,
        "",
        'Unknown echoer command "nope". Available: echo, other.\n',
    )
    assert _run("plugin", "alpha", "nope") == (
        1,
        "",
        'Unknown alpha command "nope". Available: (none).\n',
    )


def test_an_unknown_command_under_json_keeps_the_plugin_string_error() -> None:
    exit_code, stdout, stderr = _run("plugin", "echoer", "nope", "--json")

    assert (exit_code, stderr) == (1, "")
    assert json.loads(stdout) == {
        "command": "plugin",
        "schemaVersion": 1,
        "ok": False,
        "error": 'Unknown echoer command "nope". Available: echo, other.',
    }


def test_the_codegen_shortcut_without_the_plugin_reports_it_is_not_configured() -> None:
    message = "Codegen plugin is not configured. Add it to config.plugins first."

    assert _run("codegen") == (1, "", message + "\n")
    _reset_for_testing()
    exit_code, stdout, stderr = _run("codegen", "--json")
    assert (exit_code, stderr) == (1, message + "\n")
    assert json.loads(stdout) == {
        "command": "codegen",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "plugin_not_configured", "message": message},
    }


def test_an_unknown_obsessiondb_command_is_an_unknown_subcommand() -> None:
    message = (
        'Unknown obsessiondb command "nope". Available: login, signup, logout, whoami, service.'
    )

    exit_code, _stdout, stderr = _run("obsessiondb", "nope")
    assert (exit_code, stderr) == (1, message + "\n")
    _reset_for_testing()
    exit_code, stdout, stderr = _run("obsessiondb", "nope", "--json")
    assert (exit_code, stderr) == (1, message + "\n")
    assert json.loads(stdout) == {
        "command": "obsessiondb",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "unknown_subcommand", "message": message},
    }
