"""Unknown flags and missing flag values fail as in the TS CLI (#563).

The message goes to stderr, the exit code is 1 and ``--json`` adds an error
envelope with code ``usage`` (``parseFlagsOrReport`` in
``packages/cli/src/runtime/command-dispatch.ts``). ``chkit plugin <name>
<command>`` keeps its string error (``packages/cli/src/commands/plugin.ts``).
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

config = define_config(
    {"schema": "./schema.py", "outDir": "./chkit", "plugins": [codegen()]}
)
"""


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


CASES = [
    # Core commands.
    (["status", "--nope"], "Unknown flag: --nope"),
    (["status", "-x"], "Unknown flag: -x"),
    (["status", "--nope=1"], "Unknown flag: --nope"),
    (["status", "-x=1"], "Unknown flag: -x"),
    (["status", "--no-json"], "Unknown flag: --no-json"),
    (["status", "--json=1"], "Unknown flag: --json=1"),
    (["status", "-hx"], "Unknown flag: -hx"),
    (["status", "-h=1"], "Unknown flag: -h"),
    (["status", "--help=1"], "Unknown flag: --help"),
    (["migrate", "-ax"], "Unknown flag: -ax"),
    (["init", "-yx"], "Unknown flag: -yx"),
    (["init", "-y=1"], "Unknown flag: --yes=1"),
    (["drift", "--table"], "Missing value for --table"),
    (["status", "-t"], "Missing value for --table"),
    (["generate", "-n"], "Missing value for --name"),
    # A value flag followed by a `--` token has no value, as in TS.
    (["generate", "--name", "--dryrun"], "Missing value for --name"),
    (["generate", "-n", "--"], "Missing value for --name"),
    (["migrate", "--setting", "--apply"], "Missing value for --setting"),
    # The shortcut forwarders.
    (["codegen", "--nope"], "Unknown flag: --nope"),
    (["codegen", "-x"], "Unknown flag: -x"),
    (["codegen", "--check", "--out-file"], "Missing value for --out-file"),
    (["codegen", "--check", "-c"], "Missing value for --config"),
    (["codegen", "--config"], "Missing value for --config"),
    (["plugin", "codegen", "codegen", "--nope"], "Unknown flag: --nope"),
    (["plugin", "codegen", "codegen", "--out-file"], "Missing value for --out-file"),
    (["plugin", "codegen", "codegen", "-c"], "Missing value for --config"),
]


@pytest.mark.parametrize(("args", "message"), CASES)
@pytest.mark.usefixtures("project")
def test_a_flag_error_prints_the_ts_message_and_exits_1(
    args: list[str], message: str
) -> None:
    result = CliRunner().invoke(app, args)
    assert (result.exit_code, result.stdout, result.stderr) == (1, "", f"{message}\n")


@pytest.mark.parametrize(
    ("args", "message"), [case for case in CASES if case[0][0] != "init"]
)
@pytest.mark.usefixtures("project")
def test_a_flag_error_under_json_writes_the_ts_envelope(
    args: list[str], message: str
) -> None:
    command = args[0]
    words = 3 if command == "plugin" else 1
    result = CliRunner().invoke(app, [*args[:words], "--json", *args[words:]])

    assert result.exit_code == 1, result.output
    if command == "plugin":
        assert result.stderr == ""
        assert json.loads(result.stdout) == {
            "command": "plugin",
            "schemaVersion": 1,
            "ok": False,
            "error": message,
        }
    else:
        assert result.stderr == f"{message}\n"
        assert json.loads(result.stdout) == {
            "command": command,
            "schemaVersion": 1,
            "ok": False,
            "error": {"code": "usage", "message": message},
        }


@pytest.mark.usefixtures("project")
def test_init_has_no_json_flag_but_still_writes_the_envelope() -> None:
    result = CliRunner().invoke(app, ["init", "--json"])
    assert (result.exit_code, result.stderr) == (1, "Unknown flag: --json\n")
    assert json.loads(result.stdout)["error"] == {
        "code": "usage",
        "message": "Unknown flag: --json",
    }


def test_a_value_flag_followed_by_a_double_dash_token_does_not_take_it(
    project: Path,
) -> None:
    result = CliRunner().invoke(app, ["generate", "--name", "--json"])
    assert result.exit_code == 1
    assert not (project / "chkit").exists()


@pytest.mark.parametrize(
    "args",
    [
        ["status", "--help", "--nope"],
        ["status", "--nope", "-h"],
        ["generate", "--name", "--help"],
        ["drift", "--table", "-h"],
    ],
)
@pytest.mark.usefixtures("project")
def test_help_wins_over_a_flag_error_as_in_ts(args: list[str]) -> None:
    result = CliRunner().invoke(app, args)
    assert (result.exit_code, result.stderr) == (0, ""), result.output
    assert "Usage:" in result.stdout
