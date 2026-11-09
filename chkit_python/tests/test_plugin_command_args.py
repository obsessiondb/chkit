"""A plugin command gets its flags in ``flags`` and only its positionals in
``args``, and ``--`` ends its flags, as in the TS CLI (#568)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands import codegen_shortcut
from chkit.cli.main import app

# CI forces rich to colour usage errors.
ANSI_STYLE = re.compile(r"\x1b\[[0-9;]*m")

CONFIG = '''
from chkit import define_config
from chkit.plugins import ChxPlugin, ChxPluginCommand, ChxPluginManifest


def _echo(ctx):
    ctx.print({
        "args": ctx.args,
        "name": ctx.flags.get("--name"),
        "loud": ctx.flags.get("--loud"),
    })
    return 0


plugin = ChxPlugin(
    manifest=ChxPluginManifest(name="echoer"),
    commands=[
        ChxPluginCommand(
            name="echo",
            run=_echo,
            flags=[
                {"name": "--name", "type": "string", "description": "Name"},
                {"name": "--loud", "type": "boolean", "description": "Loud"},
            ],
        ),
        ChxPluginCommand(name="other", run=lambda _ctx: 0),
    ],
)

config = define_config({"schema": "./schema.py", "outDir": "./chkit", "plugins": [plugin]})
'''


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text("")
    return tmp_path


def _echo(*args: str) -> dict[str, Any]:
    # --json goes first: after --, it would be a positional.
    result = CliRunner().invoke(app, ["plugin", "--json", "echoer", "echo", *args])
    assert result.exit_code == 0, result.output
    payload: dict[str, Any] = json.loads(result.stdout)
    return payload


@pytest.mark.usefixtures("project")
def test_args_hold_the_positionals_and_dash_dash_ends_the_flags() -> None:
    assert _echo("alpha", "--name", "ada", "beta", "--loud") == {
        "args": ["alpha", "beta"],
        "name": "ada",
        "loud": True,
    }
    # After --, every token is a positional, global flags included.
    assert _echo("alpha", "--loud", "--", "--name", "x", "-z", "--json", "--") == {
        "args": ["alpha", "--name", "x", "-z", "--json", "--"],
        "name": None,
        "loud": True,
    }


@pytest.mark.usefixtures("project")
def test_a_flag_never_takes_dash_dash_as_its_value() -> None:
    result = CliRunner().invoke(app, ["plugin", "echoer", "echo", "--name", "--", "beta"])
    assert result.exit_code == 2, result.output
    assert "Missing value for --name" in ANSI_STYLE.sub("", result.output)


@pytest.mark.usefixtures("project")
def test_an_unknown_flag_before_dash_dash_is_still_rejected() -> None:
    result = CliRunner().invoke(app, ["plugin", "echoer", "other", "-z", "--", "x"])
    assert result.exit_code == 2, result.output
    assert "Unknown flag: -z" in ANSI_STYLE.sub("", result.output)


def test_a_shortcut_passes_dash_dash_on_to_the_plugin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        codegen_shortcut, "dispatch_plugin_command", lambda **kw: calls.append(kw)
    )
    result = CliRunner().invoke(app, ["codegen", "--check", "--", "-c", "x"])
    assert result.exit_code == 0, result.output
    assert calls[0]["tokens"] == ["--check", "--", "-c", "x"]
