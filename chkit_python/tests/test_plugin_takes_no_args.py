"""A plugin command with ``takes_args=False`` rejects any argument, before or
after ``--``, as core commands do, and does not run; the others keep getting
theirs, as in the TS CLI (#659)."""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app

# The real obsessiondb and codegen command definitions, with a run that prints
# the call instead of logging in or writing files, beside a third-party
# command that keeps the default.
CONFIG = """
import dataclasses
import json
import sys

from chkit import define_config
from chkit.plugins import ChxPlugin, ChxPluginCommand, ChxPluginManifest
from chkit_plugin_codegen import codegen
from chkit_plugin_obsessiondb import obsessiondb


def _stub(name):
    def run(ctx):
        print("RAN " + name + " " + json.dumps(ctx.args, separators=(",", ":")))
        return 0
    return run


class _Hooks:
    def on_init(self, ctx):
        print("onInit " + ctx.command, file=sys.stderr)

    def on_complete(self, ctx):
        print("onComplete " + ctx.command, file=sys.stderr)


def _stubbed(real, hooks):
    commands = [dataclasses.replace(c, run=_stub(c.name)) for c in real.commands]
    return dataclasses.replace(real, hooks=hooks, commands=commands)


def _boom(_ctx):
    raise RuntimeError("kaput")


echoer = ChxPlugin(
    manifest=ChxPluginManifest(name="echoer"),
    commands=[
        ChxPluginCommand(name="echo", run=_stub("echo")),
        ChxPluginCommand(name="boom", run=_boom),
    ],
)

config = define_config({
    "schema": "./schema.py",
    "outDir": "./chkit",
    "plugins": [_stubbed(obsessiondb(), _Hooks()), _stubbed(codegen(), None), echoer],
})
"""


@pytest.fixture(autouse=True)
def _fresh_emit_flag() -> Iterator[None]:
    _reset_for_testing()
    yield
    _reset_for_testing()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # Offline even if a command ran: no profile, and an API nothing listens on.
    for name in list(os.environ):
        if name.upper().startswith(("OBSESSIONDB", "CHKIT", "CLICKHOUSE")):
            monkeypatch.delenv(name)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    monkeypatch.setenv("OBSESSIONDB_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("BROWSER", "/usr/bin/false")
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    monkeypatch.chdir(project_dir)
    (project_dir / "clickhouse.config.py").write_text(CONFIG)
    (project_dir / "schema.py").write_text("")
    return project_dir


def _extra_args(args: str) -> str:
    return f"Got unexpected extra argument(s) ({args})"


REJECTED = [
    (["plugin", "--", "obsessiondb", "login", "-h"], "-h"),
    (["plugin", "obsessiondb", "--", "login", "-h"], "-h"),
    (["obsessiondb", "--", "login", "-h"], "-h"),
    (["obsessiondb", "login", "--", "-h"], "-h"),
    (["obsessiondb", "login", "extra"], "extra"),
    (["plugin", "obsessiondb", "login", "extra"], "extra"),
    (["obsessiondb", "login", "--", "-h", "--json"], "-h --json"),
    (["obsessiondb", "signup", "--", "-h"], "-h"),
    (["obsessiondb", "signup", "x"], "x"),
    (["obsessiondb", "whoami", "--", "-h"], "-h"),
    (["obsessiondb", "whoami", "whoami"], "whoami"),
    (["obsessiondb", "logout", "--", "-h"], "-h"),
    (["plugin", "obsessiondb", "logout", "--", "--help"], "--help"),
    (["codegen", "--", "-h"], "-h"),
    (["codegen", "codegen"], "codegen"),
    (["plugin", "--", "codegen", "codegen", "-h"], "-h"),
]


@pytest.mark.usefixtures("project")
@pytest.mark.parametrize(("args", "rest"), REJECTED)
def test_a_command_that_takes_no_arguments_rejects_them_before_it_runs(
    args: list[str], rest: str
) -> None:
    result = CliRunner().invoke(app, args)
    # Nothing on stdout and no hook on stderr: neither the command nor on_init ran.
    assert (result.exit_code, result.stdout, result.stderr.strip()) == (
        1,
        "",
        _extra_args(rest),
    )


JSON_REJECTED = [
    (["--json", "plugin", "--", "obsessiondb", "login", "-h"], "plugin", "-h"),
    (["plugin", "--json", "obsessiondb", "--", "login", "-h"], "plugin", "-h"),
    (["plugin", "obsessiondb", "login", "--json", "extra"], "plugin", "extra"),
    (["--json", "obsessiondb", "--", "login", "-h"], "obsessiondb", "-h"),
    (["obsessiondb", "login", "--json", "--", "-h"], "obsessiondb", "-h"),
    (["obsessiondb", "signup", "--json", "--", "-h"], "obsessiondb", "-h"),
    (["obsessiondb", "whoami", "--json", "extra"], "obsessiondb", "extra"),
    (["codegen", "--json", "--", "-h"], "codegen", "-h"),
]


@pytest.mark.usefixtures("project")
@pytest.mark.parametrize(("args", "command", "rest"), JSON_REJECTED)
def test_under_json_the_usage_envelope_names_the_command_typed(
    args: list[str], command: str, rest: str
) -> None:
    result = CliRunner().invoke(app, args)
    assert (result.exit_code, result.stderr.strip()) == (1, _extra_args(rest))
    assert json.loads(result.stdout) == {
        "command": command,
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "usage", "message": _extra_args(rest)},
    }


@pytest.mark.usefixtures("project")
@pytest.mark.parametrize(
    ("args", "command", "stdout"),
    [
        (["obsessiondb", "--", "login"], "obsessiondb", "RAN login []"),
        (["obsessiondb", "login", "--"], "obsessiondb", "RAN login []"),
        (["plugin", "obsessiondb", "--", "login"], "plugin", "RAN login []"),
        (["plugin", "--", "obsessiondb", "whoami"], "plugin", "RAN whoami []"),
        (["codegen"], "codegen", "RAN codegen []"),
    ],
)
def test_without_arguments_the_command_runs(
    args: list[str], command: str, stdout: str
) -> None:
    result = CliRunner().invoke(app, args)
    assert (result.exit_code, result.stdout.strip()) == (0, stdout), result.output
    assert result.stderr.strip().splitlines() == [f"onInit {command}", f"onComplete {command}"]


@pytest.mark.usefixtures("project")
@pytest.mark.parametrize(
    ("args", "stdout"),
    [
        (["plugin", "echoer", "echo", "x", "--", "-h"], 'RAN echo ["x","-h"]'),
        (["plugin", "--", "echoer", "echo", "x", "-h"], 'RAN echo ["x","-h"]'),
        # The obsessiondb service command reads its arguments.
        (["obsessiondb", "service", "alias", "list"], 'RAN service ["alias","list"]'),
    ],
)
def test_a_command_that_keeps_the_default_gets_its_arguments(
    args: list[str], stdout: str
) -> None:
    result = CliRunner().invoke(app, args)
    assert (result.exit_code, result.stdout.strip()) == (0, stdout), result.output


@pytest.mark.usefixtures("project")
def test_a_failing_plugin_command_is_named_in_the_error_as_in_ts() -> None:
    result = CliRunner().invoke(app, ["plugin", "echoer", "boom"])
    assert result.exit_code == 1
    assert result.stderr.strip().splitlines()[-1] == (
        'Plugin "echoer" failed in command:boom: kaput'
    )
