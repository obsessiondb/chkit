"""on_init, on_config_loaded, get_context and on_complete run around every
command, in the order and with the flags TS runs them (#488).

TS (``packages/cli/src/bin/chkit.ts``, ``runtime/command-dispatch.ts``) runs
on_init before the command and on_complete after it, with the exit code, on
success and on error. A plugin command gets on_config_loaded when it runs
through its shortcut (``chkit codegen``, ``chkit obsessiondb ...``), and
get_context right before it runs. ``chkit plugin`` is itself a command, so it
also gets get_context with its own flags first. A probe plugin records each
hook call, the command it names and the flags it got.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
import typer
from typer.testing import CliRunner

from chkit.cli.commands import generate
from chkit.cli.main import app

# CI forces rich to colour usage errors.
ANSI_STYLE = re.compile(r"\x1b\[[0-9;]*m")

PROBE_PLUGIN = '''
import json
import os
from pathlib import Path

from chkit.plugins import ChxPlugin, ChxPluginCommand, ChxPluginManifest, PluginContext


def _record(*call):
    path = Path("calls.json")
    calls = json.loads(path.read_text()) if path.exists() else []
    calls.append(list(call))
    path.write_text(json.dumps(calls))
    if os.environ.get("PROBE_FAIL") == call[0]:
        raise RuntimeError(call[0] + " failed")


class _Closer:
    def __init__(self, command):
        self.command = command

    def close(self):
        _record("close", self.command)


class _Probe:
    def on_init(self, ctx):
        _record("on_init", ctx.command, ctx.flags, ctx.json_mode)

    def on_config_loaded(self, ctx):
        _record("on_config_loaded", ctx.command, ctx.flags)
        if ctx.table_scope.enabled:
            _record("table_scope", ctx.table_scope.selector)

    def get_context(self, ctx):
        _record("get_context", ctx.command, ctx.flags)
        if os.environ.get("PROBE_CONTEXT"):
            return PluginContext(executor=_Closer(ctx.command), has_executor=True)
        return None

    def on_complete(self, ctx):
        _record("on_complete", ctx.command, ctx.exit_code, ctx.json_mode)


class _Watch:
    def on_before_plugin_command(self, ctx):
        _record("on_before_plugin_command", ctx.target_plugin + ":" + ctx.command, ctx.flags)
        return None


def _greet(ctx):
    _record("run", "greet", ctx.flags)


def _boom(ctx):
    _record("run", "boom", ctx.flags)
    raise RuntimeError("boom failed")


def _two(ctx):
    _record("run", "two", ctx.flags)
    return 2


def _hello(ctx):
    _record("run", "hello", ctx.flags, ctx.args)


def probe():
    return ChxPlugin(
        manifest=ChxPluginManifest(name="probe"),
        hooks=_Probe(),
        commands=[
            ChxPluginCommand(
                name="greet",
                run=_greet,
                flags=[
                    {"name": "--name", "type": "string", "description": "Name"},
                    {"name": "--table", "type": "string", "description": "Table"},
                ],
            ),
            ChxPluginCommand(name="boom", run=_boom),
            ChxPluginCommand(name="two", run=_two),
        ],
    )


def watch():
    # Another plugin, so its on_before_plugin_command sees probe's commands.
    return ChxPlugin(manifest=ChxPluginManifest(name="watch"), hooks=_Watch())


def obsessiondb():
    # Stands in for the ObsessionDB plugin, to run its `chkit obsessiondb` shortcut.
    return ChxPlugin(
        manifest=ChxPluginManifest(name="obsessiondb"),
        commands=[
            ChxPluginCommand(
                name="hello",
                run=_hello,
                flags=[
                    {"name": "--who", "type": "string", "description": "Who"},
                    {"name": "--table", "type": "string", "description": "Table"},
                ],
            ),
            ChxPluginCommand(name="other", run=_hello),
        ],
    )
'''

CONFIG = """
from chkit import define_config
from chkit_plugin_codegen import codegen
from lifecycle_probe import obsessiondb, probe, watch

config = define_config({
    "schema": "./schema.py",
    "outDir": "./chkit",
    # Nothing listens here: no command in this file sends SQL.
    "clickhouse": {"url": "http://127.0.0.1:9", "username": "default", "password": "", "database": "default"},
    "plugins": [probe(), watch(), obsessiondb(), codegen({"outFile": "./gen/models.py"})],
})
"""


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delenv("PROBE_FAIL", raising=False)
    monkeypatch.delenv("PROBE_CONTEXT", raising=False)
    # Its own module name: other tests import other probe modules.
    (tmp_path / "lifecycle_probe.py").write_text(PROBE_PLUGIN, encoding="utf-8")
    (tmp_path / "schema.py").write_text(
        "from chkit import schema\n\ndefinitions = schema()\n", encoding="utf-8"
    )
    (tmp_path / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    return tmp_path


def _calls(root: Path) -> list[list[Any]]:
    path = root / "calls.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def _invoke(args: list[str]) -> Any:
    return CliRunner().invoke(app, args)


def test_plugin_command_runs_every_hook_in_order(project: Path) -> None:
    result = _invoke(["plugin", "probe", "greet", "--name", "ada", "--json"])

    assert result.exit_code == 0, result.output
    flags = {"--json": True, "--name": "ada"}
    assert _calls(project) == [
        ["on_init", "plugin", flags, True],
        ["get_context", "plugin", {"--json": True}],
        ["on_before_plugin_command", "probe:greet", flags],
        ["get_context", "greet", flags],
        ["run", "greet", flags],
        ["on_complete", "plugin", 0, True],
    ]


def test_plugin_command_without_flags(project: Path) -> None:
    result = _invoke(["plugin", "probe", "greet"])

    assert result.exit_code == 0, result.output
    assert _calls(project) == [
        ["on_init", "plugin", {}, False],
        ["get_context", "plugin", {}],
        ["on_before_plugin_command", "probe:greet", {}],
        ["get_context", "greet", {}],
        ["run", "greet", {}],
        ["on_complete", "plugin", 0, False],
    ]


def test_obsessiondb_shortcut_runs_on_config_loaded(project: Path) -> None:
    result = _invoke(["obsessiondb", "hello", "--who", "me", "pos", "--json"])

    assert result.exit_code == 0, result.output
    flags = {"--json": True, "--who": "me"}
    assert _calls(project) == [
        ["on_init", "obsessiondb", flags, True],
        ["on_config_loaded", "obsessiondb", flags],
        ["on_before_plugin_command", "obsessiondb:hello", flags],
        ["get_context", "hello", flags],
        ["run", "hello", flags, ["pos"]],
        ["on_complete", "obsessiondb", 0, True],
    ]


def test_codegen_shortcut_runs_every_hook_in_order(project: Path) -> None:
    result = _invoke(["codegen", "--config", "clickhouse.config.py"])

    assert result.exit_code == 0, result.output
    # As in TS, the shortcut's flags include --config; `chkit plugin` drops it.
    flags = {"--config": "clickhouse.config.py"}
    assert _calls(project) == [
        ["on_init", "codegen", flags, False],
        ["on_config_loaded", "codegen", flags],
        ["on_before_plugin_command", "codegen:codegen", flags],
        ["get_context", "codegen", flags],
        ["on_complete", "codegen", 0, False],
    ]


@pytest.mark.parametrize(("command", "exit_code"), [("boom", 1), ("two", 2)])
def test_failing_plugin_command_still_runs_on_complete(
    project: Path, command: str, exit_code: int
) -> None:
    result = _invoke(["plugin", "probe", command])

    assert result.exit_code == exit_code, result.output
    assert _calls(project) == [
        ["on_init", "plugin", {}, False],
        ["get_context", "plugin", {}],
        ["on_before_plugin_command", f"probe:{command}", {}],
        ["get_context", command, {}],
        ["run", command, {}],
        ["on_complete", "plugin", exit_code, False],
    ]


def test_plugin_listing_runs_on_init_and_on_complete(project: Path) -> None:
    result = _invoke(["plugin"])

    assert result.exit_code == 0, result.output
    assert _calls(project) == [
        ["on_init", "plugin", {}, False],
        ["get_context", "plugin", {}],
        ["on_complete", "plugin", 0, False],
    ]


def test_unknown_plugin_runs_on_complete_with_the_exit_code(project: Path) -> None:
    result = _invoke(["plugin", "nope", "cmd"])

    assert result.exit_code == 1, result.output
    assert _calls(project) == [
        ["on_init", "plugin", {}, False],
        ["get_context", "plugin", {}],
        ["on_complete", "plugin", result.exit_code, False],
    ]


@pytest.mark.parametrize(
    ("args", "inner"),
    [
        (
            ["plugin", "probe", "greet"],
            [
                ["on_before_plugin_command", "probe:greet", {}],
                ["get_context", "greet", {}],
                ["run", "greet", {}],
                ["close", "greet"],
            ],
        ),
        (["plugin"], []),
    ],
)
def test_forwarder_context_lives_until_the_command_ends(
    project: Path, monkeypatch: pytest.MonkeyPatch, args: list[str], inner: list[list[Any]]
) -> None:
    # As TS runPluginCommand, `chkit plugin` disposes its own context only
    # after the target command (or the listing) ran.
    monkeypatch.setenv("PROBE_CONTEXT", "1")

    result = _invoke(args)

    assert result.exit_code == 0, result.output
    assert _calls(project) == [
        ["on_init", "plugin", {}, False],
        ["get_context", "plugin", {}],
        *inner,
        ["close", "plugin"],
        ["on_complete", "plugin", 0, False],
    ]


@pytest.mark.parametrize("json_mode", [False, True])
def test_shortcut_without_a_command_runs_on_init_and_on_complete(
    project: Path, *, json_mode: bool
) -> None:
    # TS runs on_init (with no flags) before it prints the command's help.
    result = _invoke(["obsessiondb", *(["--json"] if json_mode else [])])

    assert result.exit_code == 0, result.output
    assert "chkit obsessiondb" in result.stdout
    assert _calls(project) == [
        ["on_init", "obsessiondb", {}, json_mode],
        ["on_complete", "obsessiondb", 0, json_mode],
    ]


def test_unknown_shortcut_command_runs_on_complete(project: Path) -> None:
    result = _invoke(["obsessiondb", "nope"])

    assert result.exit_code == 1, result.output
    assert _calls(project) == [
        ["on_init", "obsessiondb", {}, False],
        ["on_complete", "obsessiondb", 1, False],
    ]


def test_shortcut_table_scope_reaches_on_config_loaded(project: Path) -> None:
    result = _invoke(["obsessiondb", "hello", "--table", "events"])

    assert result.exit_code == 0, result.output
    flags = {"--table": "events"}
    assert _calls(project)[:3] == [
        ["on_init", "obsessiondb", flags, False],
        ["on_config_loaded", "obsessiondb", flags],
        ["table_scope", "events"],
    ]


@pytest.mark.parametrize(
    ("args", "before_error"),
    [
        (
            ["obsessiondb", "hello", "--table", "*"],
            [["on_init", "obsessiondb", {"--table": "*"}, False]],
        ),
        (
            ["plugin", "probe", "greet", "--table", "*"],
            [["on_init", "plugin", {"--table": "*"}, False], ["get_context", "plugin", {}]],
        ),
    ],
)
def test_invalid_table_selector_runs_on_complete(
    project: Path, args: list[str], before_error: list[list[Any]]
) -> None:
    # As in TS, the selector is resolved after on_init, before on_config_loaded.
    result = _invoke(args)

    assert result.exit_code == 1, result.output
    assert 'Invalid --table selector "*"' in result.stderr
    command = args[0]
    assert _calls(project) == [*before_error, ["on_complete", command, 1, False]]


def test_usage_error_after_on_init_runs_on_complete_with_exit_1(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A click usage error the command raises after on_init is reported as TS
    # reports one (exit 1), and on_complete gets that exit code.
    def _raise_usage_error(*_args: Any, **_kwargs: Any) -> Any:
        msg = "late"
        raise typer.BadParameter(msg)

    monkeypatch.setattr(generate, "load_schema_definitions_with_hooks", _raise_usage_error)

    result = _invoke(["generate", "--dryrun"])

    assert result.exit_code == 1, result.output
    assert result.stderr == "Invalid value: late\n"
    assert _calls(project)[-1] == ["on_complete", "generate", 1, False]


def test_core_command_runs_on_complete(project: Path) -> None:
    result = _invoke(["generate", "--dryrun", "--json"])

    assert result.exit_code == 0, result.output
    flags = {"--dryrun": True, "--json": True}
    assert _calls(project) == [
        ["on_init", "generate", flags, True],
        ["get_context", "generate", flags],
        ["on_config_loaded", "generate", flags],
        ["on_complete", "generate", 0, True],
    ]


def test_failing_core_command_runs_on_complete(project: Path) -> None:
    (project / "schema.py").write_text("raise RuntimeError('broken schema')\n", encoding="utf-8")

    result = _invoke(["generate", "--dryrun"])

    assert result.exit_code == 1, result.output
    assert "broken schema" in result.output
    assert _calls(project) == [
        ["on_init", "generate", {"--dryrun": True}, False],
        ["get_context", "generate", {"--dryrun": True}],
        ["on_config_loaded", "generate", {"--dryrun": True}],
        ["on_complete", "generate", 1, False],
    ]


@pytest.mark.parametrize(
    "args",
    [
        ["plugin", "probe", "greet", "--bogus"],
        ["obsessiondb", "hello", "--bogus"],
        ["codegen", "--bogus"],
        ["generate", "--bogus"],
    ],
)
def test_flag_error_runs_no_hook(project: Path, args: list[str]) -> None:
    result = _invoke(args)

    assert result.exit_code != 0
    assert "--bogus" in ANSI_STYLE.sub("", result.output)
    assert _calls(project) == []


def test_on_config_loaded_error_exits_2_after_on_complete(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PROBE_FAIL", "on_config_loaded")

    result = _invoke(["codegen", "--json"])

    assert result.exit_code == 2, result.output
    assert json.loads(result.stdout) == {
        "ok": False,
        "error": 'Plugin "probe" failed in onConfigLoaded: on_config_loaded failed',
    }
    assert _calls(project) == [
        ["on_init", "codegen", {"--json": True}, True],
        ["on_config_loaded", "codegen", {"--json": True}],
        ["on_complete", "codegen", 2, True],
    ]


def test_on_config_loaded_error_text_mode(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PROBE_FAIL", "on_config_loaded")

    result = _invoke(["obsessiondb", "hello"])

    assert result.exit_code == 2, result.output
    assert result.stdout == ""
    assert result.stderr.strip() == (
        'Plugin "probe" failed in onConfigLoaded: on_config_loaded failed'
    )


def test_on_init_error_skips_on_complete(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PROBE_FAIL", "on_init")

    result = _invoke(["plugin", "probe", "greet"])

    assert result.exit_code == 1, result.output
    assert result.stderr.strip() == 'Plugin "probe" failed in onInit: on_init failed'
    assert _calls(project) == [["on_init", "plugin", {}, False]]


def test_get_context_error_runs_on_complete(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PROBE_FAIL", "get_context")

    result = _invoke(["plugin", "probe", "greet"])

    assert result.exit_code == 1, result.output
    assert result.stderr.strip() == 'Plugin "probe" failed in getContext: get_context failed'
    assert _calls(project) == [
        ["on_init", "plugin", {}, False],
        ["get_context", "plugin", {}],
        ["on_complete", "plugin", 1, False],
    ]


def test_on_complete_error_after_success_fails_the_command(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PROBE_FAIL", "on_complete")

    result = _invoke(["plugin", "probe", "greet", "--json"])

    assert result.exit_code == 1, result.output
    assert result.stderr.strip() == 'Plugin "probe" failed in onComplete: on_complete failed'
    assert _calls(project)[-1] == ["on_complete", "plugin", 0, True]


def test_on_complete_error_after_a_failure_keeps_the_original_error(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PROBE_FAIL", "on_complete")

    result = _invoke(["plugin", "probe", "boom"])

    assert result.exit_code == 1, result.output
    assert result.stderr.strip() == 'Plugin "probe" failed in command:boom: boom failed'
    assert _calls(project)[-1] == ["on_complete", "plugin", 1, False]
