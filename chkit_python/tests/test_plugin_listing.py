"""`chkit plugin` and `chkit plugin <name>` list plugins with the same text and
``--json`` output as the TS CLI, byte for byte
(packages/cli/src/test/plugin-listing.test.ts, #613)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

NO_PLUGINS_MESSAGE = "No plugins configured. Add entries to config.plugins first."

CONFIG = '''
from chkit import define_config
from chkit.plugins import ChxPlugin, ChxPluginCommand, ChxPluginManifest

alpha = ChxPlugin(
    manifest=ChxPluginManifest(name="alpha", version="1.2.3"),
    commands=[
        ChxPluginCommand(name="go", description="Go somewhere", run=lambda _ctx: 0),
        ChxPluginCommand(name="stay", run=lambda _ctx: 0),
    ],
)
empty = ChxPlugin(manifest=ChxPluginManifest(name="empty"))

config = define_config({"schema": "./schema.py", "plugins": PLUGINS})
'''


def _project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, plugins: str) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG.replace("PLUGINS", plugins))
    (tmp_path / "schema.py").write_text("")


def _run(*args: str) -> tuple[int, str, str]:
    result = CliRunner().invoke(app, ["plugin", *args])
    return result.exit_code, result.stdout, result.stderr


def _json(payload: object) -> str:
    return json.dumps(payload, indent=2) + "\n"


def test_lists_the_configured_plugins_in_config_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _project(tmp_path, monkeypatch, "[alpha, empty]")
    assert _run() == (
        0,
        "Configured plugins:\n- alpha (v1.2.3)\n  - go: Go somewhere\n  - stay\n"
        "- empty\n  (no commands)\n",
        "",
    )
    assert _run("--json") == (
        0,
        _json(
            {
                "command": "plugin",
                "schemaVersion": 1,
                "plugins": [
                    {
                        "name": "alpha",
                        "version": "1.2.3",
                        "commands": [
                            {"name": "go", "description": "Go somewhere"},
                            {"name": "stay", "description": ""},
                        ],
                    },
                    {"name": "empty", "version": None, "commands": []},
                ],
            }
        ),
        "",
    )


def test_lists_one_plugins_commands(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _project(tmp_path, monkeypatch, "[alpha, empty]")
    assert _run("alpha") == (
        0,
        'Plugin commands for "alpha":\n- go: Go somewhere\n- stay\n',
        "",
    )
    assert _run("alpha", "--json") == (
        0,
        _json(
            {
                "command": "plugin",
                "schemaVersion": 1,
                "plugin": "alpha",
                "commands": [
                    {"name": "go", "description": "Go somewhere"},
                    {"name": "stay", "description": ""},
                ],
            }
        ),
        "",
    )
    assert _run("empty") == (0, 'Plugin "empty" has no registered commands.\n', "")
    assert _run("empty", "--json") == (
        0,
        _json({"command": "plugin", "schemaVersion": 1, "plugin": "empty", "commands": []}),
        "",
    )


@pytest.mark.parametrize(
    "args", [(), ("alpha",), ("alpha", "go"), ("core", "status", "--bogus")]
)
def test_fails_with_exit_1_when_no_plugins_are_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, args: tuple[str, ...]
) -> None:
    _project(tmp_path, monkeypatch, "[]")
    assert _run(*args) == (1, "", NO_PLUGINS_MESSAGE + "\n")
    assert _run(*args, "--json") == (
        1,
        _json(
            {
                "command": "plugin",
                "schemaVersion": 1,
                "error": NO_PLUGINS_MESSAGE,
                "plugins": [],
            }
        ),
        "",
    )
