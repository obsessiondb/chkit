"""click's other usage errors fail as in the TS CLI.

#563 aligned unknown flags and missing flag values. The rest of what click
rejects (an unexpected argument, a value that is not one of the choices) and
the usage errors the commands raised as ``typer.BadParameter`` printed click's
usage banner and exited 2. TS prints one line on stderr and exits 1, with an
error envelope under ``--json`` (``reportUsageError`` and the top-level catch
in ``packages/cli/src/bin/chkit.ts``, ``packages/cli/src/commands/plugin.ts``,
``packages/cli/src/commands/query.ts``).
"""

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
from chkit_plugin_codegen import codegen
from chkit_plugin_obsessiondb import obsessiondb

config = define_config(
    {"schema": "./schema.py", "outDir": "./chkit", "plugins": [codegen(), obsessiondb()]}
)
"""

NO_PLUGIN_CONFIG = """
from chkit import define_config

config = define_config({"schema": "./schema.py", "outDir": "./chkit"})
"""

OBSESSIONDB_COMMANDS = "login, signup, logout, whoami, service"


@pytest.fixture(autouse=True)
def _fresh_emit_flag() -> Iterator[None]:
    _reset_for_testing()
    yield
    _reset_for_testing()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text("")
    return tmp_path


# click's own errors: TS reports them with code `usage` (init has no --json).
CLICK_CASES = [
    (["status", "extra"], "Got unexpected extra argument(s) (extra)"),
    (["migrate", "a", "b"], "Got unexpected extra argument(s) (a b)"),
    (["generate", "extra"], "Got unexpected extra argument(s) (extra)"),
    (["check", "extra"], "Got unexpected extra argument(s) (extra)"),
    (["drift", "extra"], "Got unexpected extra argument(s) (extra)"),
    (["pull", "extra"], "Got unexpected extra argument(s) (extra)"),
]
INIT_CASES = [
    (["init", "--yes", "extra"], "Got unexpected extra argument(s) (extra)"),
    (
        ["init", "--connect", "bogus"],
        "Invalid value for '--connect': 'bogus' is not one of "
        "'claim', 'account', 'clickhouse', 'later'.",
    ),
]
# Errors TS throws from the command: the top-level catch reports code `error`.
COMMAND_CASES = [
    (
        ["query"],
        'query requires a SQL string as the first positional argument (e.g. `chkit query "SELECT 1"`)',
    ),
    (
        ["query", "  "],
        'query requires a SQL string as the first positional argument (e.g. `chkit query "SELECT 1"`)',
    ),
    (
        ["query", "SELECT", "1"],
        "query accepts a single SQL string. Wrap it in quotes if it contains spaces.",
    ),
    (["plugin", "nope"], 'Unknown plugin "nope". Available: codegen, obsessiondb.'),
    (["plugin", "nope", "run"], 'Unknown plugin "nope". Available: codegen, obsessiondb.'),
]


@pytest.mark.parametrize(
    ("args", "message"), [*CLICK_CASES, *INIT_CASES, *COMMAND_CASES]
)
@pytest.mark.usefixtures("project")
def test_a_usage_error_prints_one_line_and_exits_1(args: list[str], message: str) -> None:
    result = CliRunner().invoke(app, args)
    assert (result.exit_code, result.stdout, result.stderr) == (1, "", f"{message}\n")


@pytest.mark.usefixtures("project")
def test_init_rejects_an_invalid_choice_before_writing_anything(project: Path) -> None:
    result = CliRunner().invoke(app, ["init", "--connect", "bogus"])
    assert result.exit_code == 1
    assert sorted(path.name for path in project.iterdir()) == ["clickhouse.config.py", "schema.py"]


@pytest.mark.parametrize(
    ("args", "message", "code"),
    [
        *[(args, message, "usage") for args, message in CLICK_CASES],
        *[(args, message, "error") for args, message in COMMAND_CASES],
    ],
)
@pytest.mark.usefixtures("project")
def test_a_usage_error_under_json_writes_the_ts_envelope(
    args: list[str], message: str, code: str
) -> None:
    result = CliRunner().invoke(app, [*args, "--json"])

    assert result.exit_code == 1, result.output
    assert result.stderr == f"{message}\n"
    assert json.loads(result.stdout) == {
        "command": args[0],
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": code, "message": message},
    }


@pytest.mark.usefixtures("project")
def test_plugin_reports_an_unknown_command_on_stderr() -> None:
    result = CliRunner().invoke(app, ["plugin", "obsessiondb", "nope"])
    assert (result.exit_code, result.stdout, result.stderr) == (
        1,
        "",
        f'Unknown obsessiondb command "nope". Available: {OBSESSIONDB_COMMANDS}.\n',
    )


@pytest.mark.usefixtures("project")
def test_plugin_reports_an_unknown_command_under_json_as_its_string_error() -> None:
    result = CliRunner().invoke(app, ["plugin", "obsessiondb", "nope", "--json"])
    assert result.exit_code == 1, result.output
    assert result.stderr == ""
    assert json.loads(result.stdout) == {
        "command": "plugin",
        "schemaVersion": 1,
        "ok": False,
        "error": f'Unknown obsessiondb command "nope". Available: {OBSESSIONDB_COMMANDS}.',
    }


@pytest.mark.usefixtures("project")
def test_obsessiondb_reports_an_unknown_command_and_prints_its_help() -> None:
    result = CliRunner().invoke(app, ["obsessiondb", "nope"])
    assert result.exit_code == 1, result.output
    assert result.stderr == (
        f'Unknown obsessiondb command "nope". Available: {OBSESSIONDB_COMMANDS}.\n'
    )
    assert "chkit obsessiondb" in result.stdout


@pytest.mark.usefixtures("project")
def test_obsessiondb_reports_an_unknown_command_under_json_as_unknown_subcommand() -> None:
    result = CliRunner().invoke(app, ["obsessiondb", "nope", "--json"])
    message = f'Unknown obsessiondb command "nope". Available: {OBSESSIONDB_COMMANDS}.'
    assert result.exit_code == 1, result.output
    assert result.stderr == f"{message}\n"
    assert json.loads(result.stdout) == {
        "command": "obsessiondb",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "unknown_subcommand", "message": message},
    }


@pytest.mark.parametrize("args", [["obsessiondb"], ["obsessiondb", "--json"]])
@pytest.mark.usefixtures("project")
def test_obsessiondb_without_a_command_prints_its_help(args: list[str]) -> None:
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 0, result.output
    assert result.stderr == ""
    assert "chkit obsessiondb" in result.stdout


@pytest.mark.parametrize("json_mode", [False, True])
def test_codegen_without_its_plugin_is_not_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, json_mode: bool
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(NO_PLUGIN_CONFIG)
    (tmp_path / "schema.py").write_text("")
    message = "Codegen plugin is not configured. Add it to config.plugins first."

    result = CliRunner().invoke(app, ["codegen", *(["--json"] if json_mode else [])])

    assert result.exit_code == 1, result.output
    assert result.stderr == f"{message}\n"
    if json_mode:
        assert json.loads(result.stdout) == {
            "command": "codegen",
            "schemaVersion": 1,
            "ok": False,
            "error": {"code": "plugin_not_configured", "message": message},
        }
    else:
        assert result.stdout == ""
