"""A plugin command's flag error is reported before any plugin hook runs.

TS reports it before onInit and getContext on both ``chkit <plugin> <command>``
and ``chkit plugin <plugin> <command>``. A probe plugin records each hook call.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

PROBE_PLUGIN = '''
import json
from pathlib import Path

from chkit.plugins import ChxPlugin, ChxPluginCommand, ChxPluginManifest


def _record(name):
    path = Path("calls.json")
    calls = json.loads(path.read_text()) if path.exists() else []
    calls.append(name)
    path.write_text(json.dumps(calls))


class _Probe:
    def on_init(self, ctx):
        _record("on_init")

    def get_context(self, ctx):
        _record("get_context")

    def on_before_plugin_command(self, ctx):
        _record("on_before_plugin_command")
        return {"handled": False}

    def on_complete(self, ctx):
        _record("on_complete")


def _greet(ctx):
    _record("run " + str(ctx.flags.get("--name")))
    return 0


def watch():
    # Another plugin, so its on_before_plugin_command sees probe's commands.
    return ChxPlugin(manifest=ChxPluginManifest(name="watch"), hooks=_Probe())


def probe():
    return ChxPlugin(
        manifest=ChxPluginManifest(name="probe"),
        hooks=_Probe(),
        commands=[
            ChxPluginCommand(
                name="greet",
                run=_greet,
                flags=[{"name": "--name", "type": "string", "description": "Name"}],
            ),
            ChxPluginCommand(name="other", run=lambda ctx: 0),
        ],
    )
'''


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    (tmp_path / "probe_plugin.py").write_text(PROBE_PLUGIN, encoding="utf-8")
    (tmp_path / "schema.py").write_text(
        "from chkit import schema\n\ndefinitions = schema()\n", encoding="utf-8"
    )
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\nfrom probe_plugin import probe, watch\n\n"
        'config = define_config({"schema": "./schema.py", "outDir": "./chkit", '
        '"plugins": [probe(), watch()]})\n',
        encoding="utf-8",
    )
    return tmp_path


def _calls(root: Path) -> list[str]:
    path = root / "calls.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["greet", "--bogus"], "Unknown flag: --bogus"),
        (["greet", "--name"], "Missing value for --name"),
        (["other", "-x"], "Unknown flag: -x"),
    ],
)
def test_a_flag_error_is_reported_before_any_hook(
    project: Path, args: list[str], message: str
) -> None:
    result = CliRunner().invoke(app, ["plugin", "probe", *args])
    assert result.exit_code != 0
    assert message in result.output
    assert _calls(project) == []


def test_valid_flags_reach_the_command(project: Path) -> None:
    result = CliRunner().invoke(app, ["plugin", "probe", "greet", "--name", "ada"])
    assert result.exit_code == 0, result.output
    assert _calls(project) == ["on_before_plugin_command", "run ada"]
