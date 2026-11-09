"""A plugin command's ``flags`` hold the global flags given, as in TS: ``--json``
on every path, and ``--config`` on the shortcuts (``chkit codegen``,
``chkit obsessiondb <command>``), whose flags TS parses with the global ones.
``chkit plugin`` strips ``--config`` before the command parses its flags.
A flag that was not given has no key."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

CONFIG = '''
import json

import typer

from chkit import define_config
from chkit.plugins import ChxPlugin, ChxPluginCommand, ChxPluginManifest


def _probe(ctx):
    typer.echo("FLAGS " + json.dumps(ctx.flags, sort_keys=True))
    return 0


FLAGS = [
    {"name": "--name", "type": "string", "description": "Name"},
    {"name": "--table", "short": "-t", "type": "string", "description": "Table"},
]


def _plugin(name, command):
    return ChxPlugin(
        manifest=ChxPluginManifest(name=name),
        commands=[ChxPluginCommand(name=command, run=_probe, flags=FLAGS)],
    )


config = define_config({
    "schema": "./schema.py",
    "outDir": "./chkit",
    "plugins": [
        _plugin("probe", "p"),
        _plugin("codegen", "codegen"),
        _plugin("obsessiondb", "whoami"),
    ],
})
'''


@pytest.fixture(autouse=True)
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "alt.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text("")
    return tmp_path


def _flags(*argv: str) -> dict[str, Any]:
    result = CliRunner().invoke(app, list(argv))
    assert result.exit_code == 0, result.output
    line = next(ln for ln in result.stdout.splitlines() if ln.startswith("FLAGS "))
    payload: dict[str, Any] = json.loads(line.removeprefix("FLAGS "))
    return payload


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (["plugin", "probe", "p"], {}),
        (["plugin", "--json", "probe", "p"], {"--json": True}),
        (["plugin", "probe", "p", "--json", "--name", "x"], {"--json": True, "--name": "x"}),
        (["plugin", "probe", "p", "-t", "foo", "--json"], {"--json": True, "--table": "foo"}),
        # The forwarder strips --config, so the command never sees it.
        (["plugin", "--config", "./alt.config.py", "--json", "probe", "p"], {"--json": True}),
        (["plugin", "-c", "./alt.config.py", "probe", "p"], {}),
        # After --, --json is a positional, not a flag.
        (["plugin", "probe", "p", "--", "--json"], {}),
    ],
)
def test_the_plugin_forwarder_passes_json_to_the_command(
    argv: list[str], expected: dict[str, Any]
) -> None:
    assert _flags(*argv) == expected


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (["codegen"], {}),
        (["codegen", "--json"], {"--json": True}),
        (["codegen", "--name", "x", "--json"], {"--json": True, "--name": "x"}),
        (["codegen", "-t", "foo", "--json"], {"--json": True, "--table": "foo"}),
        # The raw value, as given: no path normalisation.
        (["codegen", "--config", "./alt.config.py"], {"--config": "./alt.config.py"}),
        (["codegen", "--config=./alt.config.py"], {"--config": "./alt.config.py"}),
        (
            ["codegen", "-c", "./alt.config.py", "--json"],
            {"--config": "./alt.config.py", "--json": True},
        ),
        (["obsessiondb", "whoami"], {}),
        (["obsessiondb", "--json", "whoami"], {"--json": True}),
        (
            ["obsessiondb", "whoami", "--config", "./alt.config.py", "--name", "y"],
            {"--config": "./alt.config.py", "--name": "y"},
        ),
        (["obsessiondb", "whoami", "-c", "./alt.config.py"], {"--config": "./alt.config.py"}),
    ],
)
def test_a_shortcut_passes_json_and_config_to_the_command(
    argv: list[str], expected: dict[str, Any]
) -> None:
    assert _flags(*argv) == expected
