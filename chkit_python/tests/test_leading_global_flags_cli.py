"""Global flags before the command read as in the TS CLI (#597).

TS moves the leading ``--json``, ``-c``/``--config``, ``-t``/``--table`` and
``--help-plugins`` behind the command (``normalizeGlobalArgs`` in
``packages/cli/src/runtime/argv.ts``), so ``chkit --json status`` is ``chkit
status --json``. A first token that is not a command, ``-h``/``--help`` or
``-v``/``-V``/``--version`` is an unknown command (``packages/cli/src/bin/chkit.ts``).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit import __version__
from chkit.cli.argv import normalize_global_args
from chkit.cli.commands import codegen_shortcut
from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app
from chkit.core.flags import MissingFlagValueError

CONFIG = (
    'from chkit import define_config\n\nconfig = define_config({"schema": "./schema.py", '
    '"outDir": "./chkit"})\n'
)
SCHEMA = "".join(
    f"{name} = table(database='app', name='{name}', engine='MergeTree()', "
    "columns=[{'name': 'id', 'type': 'UInt64'}], primary_key=['id'], order_by=['id'])\n"
    for name in ("users", "events")
)


@pytest.fixture(autouse=True)
def _fresh_emit_flag() -> Iterator[None]:
    _reset_for_testing()
    yield
    _reset_for_testing()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text("from chkit import table\n\n" + SCHEMA)
    return tmp_path


def test_normalize_moves_leading_global_flags_behind_the_command() -> None:
    # The cases of packages/cli/src/test/runtime/argv.test.ts.
    assert normalize_global_args(
        ["--json", "--config", "custom.ts", "--table=events*", "query", "--", "SELECT 1"]
    ) == ["query", "--json", "--config", "custom.ts", "--table=events*", "--", "SELECT 1"]
    assert normalize_global_args(["query", "--", "--config", "literal SQL"]) == [
        "query",
        "--",
        "--config",
        "literal SQL",
    ]
    assert normalize_global_args(["status", "--config=custom.ts"]) == [
        "status",
        "--config=custom.ts",
    ]
    assert normalize_global_args(["--config=custom.ts"]) == ["--help", "--config=custom.ts"]
    # Short forms read as their long form.
    assert normalize_global_args(["-c", "a.py", "-tx", "-t=y", "generate"]) == [
        "generate",
        "--config",
        "a.py",
        "--table=x",
        "--table=y",
    ]
    # A value that looks like a short flag is still the value.
    assert normalize_global_args(["-c", "-x", "status"]) == ["status", "--config", "-x"]
    # The first other token is the command, whatever it is.
    assert normalize_global_args(["--json", "--nope", "status"]) == ["--nope", "--json", "status"]
    assert normalize_global_args(["--json", "--", "status"]) == ["--", "--json", "status"]


@pytest.mark.parametrize(
    "argv",
    [["--config"], ["-c"], ["--table", "--json", "status"], ["--json", "--config", "--json"]],
)
def test_normalize_rejects_a_leading_value_flag_without_its_value(argv: list[str]) -> None:
    with pytest.raises(MissingFlagValueError, match=r"^Missing value for --(config|table)$"):
        normalize_global_args(argv)


def test_leading_global_flags_run_the_command_as_trailing_ones(project: Path) -> None:
    config = str(project / "clickhouse.config.py")
    trailing = CliRunner().invoke(
        app, ["generate", "--dryrun", "--json", "--config", config, "--table", "app.users"]
    )
    assert trailing.exit_code == 0, trailing.output
    expected = json.loads(trailing.stdout)
    assert expected["scope"]["matchedTables"] == ["app.users"]

    for leading in (
        ["--json", "--config", config, "--table", "app.users"],
        ["-c", config, "--json", "-t", "app.users"],
        [f"--config={config}", "--table=app.users", "--json"],
        [f"-c={config}", "-t=app.users", "--json"],
        [f"-c{config}", "-tapp.users", "--json"],
    ):
        _reset_for_testing()
        result = CliRunner().invoke(app, [*leading, "generate", "--dryrun"])
        assert result.exit_code == 0, (leading, result.output)
        assert json.loads(result.stdout) == expected, leading


def test_a_leading_flag_the_command_does_not_take_is_its_flag_error(project: Path) -> None:
    for argv in (["--table", "x", "status"], ["-t", "x", "status"]):
        result = CliRunner().invoke(app, argv)
        assert (result.exit_code, result.stdout, result.stderr) == (
            1,
            "",
            "Unknown flag: --table\n",
        ), argv


def test_a_forwarder_reads_a_leading_config(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(codegen_shortcut, "dispatch_plugin_command", lambda **kw: calls.append(kw))
    result = CliRunner().invoke(app, ["-c", "cfg.py", "--json", "codegen", "--check"])
    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    assert calls[0]["tokens"] == ["--check"]
    assert calls[0]["config_path"] == Path("cfg.py")
    assert calls[0]["output_json"] is True


@pytest.mark.parametrize(
    "argv",
    [
        ["--json"],
        ["--config", "x.py"],
        ["--help-plugins"],
        ["--json", "-h"],
        ["-h", "--nope"],
        ["--help", "status", "--nope"],
    ],
)
def test_only_leading_global_flags_or_help_first_show_the_global_help(argv: list[str]) -> None:
    result = CliRunner().invoke(app, argv)
    assert result.exit_code == 0, (argv, result.output)
    assert "Usage:" in result.stdout
    assert result.stderr == ""


@pytest.mark.parametrize(
    "argv", [["--json", "--version"], ["--json", "-v"], ["-V", "--nope"], ["-v", "status"]]
)
def test_the_version_first_prints_the_version(argv: list[str]) -> None:
    result = CliRunner().invoke(app, argv)
    assert (result.exit_code, result.stdout, result.stderr) == (0, f"{__version__}\n", ""), argv


@pytest.mark.parametrize("argv", [["--config"], ["-c"], ["-c", "--", "--json"]])
def test_a_leading_value_flag_without_its_value_fails_as_in_ts(argv: list[str]) -> None:
    result = CliRunner().invoke(app, argv)
    assert (result.exit_code, result.stdout, result.stderr) == (
        1,
        "",
        "Missing value for --config\n",
    )


@pytest.mark.parametrize(
    ("argv", "command"),
    [
        (["--help", "--help-plugins", "--config"], None),
        (["--help-plugins", "-h", "-c"], None),
        (["--help", "--help-plugins", "--config", "--json"], "--help"),
        (["--help-plugins", "-h", "--config", "--json"], "-h"),
    ],
)
def test_the_global_help_with_plugins_reads_the_config_value_first(
    argv: list[str], command: str | None
) -> None:
    # TS printGlobalHelp: --help-plugins reads --config before the help.
    result = CliRunner().invoke(app, argv)
    assert (result.exit_code, result.stderr) == (1, "Missing value for --config\n")
    if command is None:
        assert result.stdout == ""
    else:
        assert json.loads(result.stdout)["command"] == command


@pytest.mark.parametrize(
    "argv", [["--json", "--config"], ["--config", "--json", "status"], ["-c", "--json"]]
)
def test_a_leading_value_flag_without_its_value_under_json_writes_the_ts_envelope(
    argv: list[str],
) -> None:
    result = CliRunner().invoke(app, argv)
    assert result.exit_code == 1
    assert result.stderr == "Missing value for --config\n"
    # The top-level catch of packages/cli/src/bin/chkit.ts: command "chkit", code "error".
    assert json.loads(result.stdout) == {
        "command": "chkit",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "error", "message": "Missing value for --config"},
    }


@pytest.mark.parametrize(
    ("argv", "token"),
    [
        (["nope"], "nope"),
        (["nope", "--help"], "nope"),
        (["--nope", "status"], "--nope"),
        (["-x", "status"], "-x"),
        (["-vx"], "-vx"),
        (["-hx"], "-hx"),
        (["--help=1"], "--help=1"),
        (["--version=1"], "--version=1"),
        (["-"], "-"),
        (["--", "status"], "--"),
        # After the move, --json is behind the `--`, so it is not an option.
        (["--json", "--", "status"], "--"),
        # TS reads the config path from the command on, and `--` ends it.
        (["--json", "--", "-c"], "--"),
        (["--help-plugins", "--", "--config"], "--"),
        (["--config", "x.py", "nope"], "nope"),
    ],
)
def test_an_unknown_first_token_is_an_unknown_command(argv: list[str], token: str) -> None:
    result = CliRunner().invoke(app, argv)
    assert result.exit_code == 1, (argv, result.output)
    assert result.stderr == f"Unknown command: {token}\n"
    assert "Usage:" in result.stdout


@pytest.mark.parametrize(
    ("argv", "token"),
    [
        (["--json", "nope"], "nope"),
        (["nope", "--json"], "nope"),
        (["--json", "--nope"], "--nope"),
        (["--json", "-x", "status"], "-x"),
    ],
)
def test_an_unknown_command_under_json_writes_the_ts_envelope(argv: list[str], token: str) -> None:
    result = CliRunner().invoke(app, argv)
    assert result.exit_code == 1, (argv, result.output)
    assert result.stderr == f"Unknown command: {token}\n"
    assert json.loads(result.stdout) == {
        "command": token,
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "unknown_command", "message": f"Unknown command: {token}"},
    }


@pytest.mark.parametrize(
    ("argv", "json_mode"),
    [
        (["nope", "-c"], False),
        (["nope", "--help", "--config"], False),
        (["nope", "-t", "-c"], False),
        (["nope", "--json", "--config"], True),
        # As TS: --json only before the `--` (`optionArgs`).
        (["nope", "-c", "--", "--json"], False),
        (["--json", "nope", "--config", "--json"], True),
    ],
)
def test_an_unknown_command_reads_its_config_value_first_as_in_ts(
    argv: list[str], json_mode: bool
) -> None:
    result = CliRunner().invoke(app, argv)
    assert result.exit_code == 1, (argv, result.output)
    assert result.stderr == "Missing value for --config\n"
    if json_mode:
        assert json.loads(result.stdout) == {
            "command": "nope",
            "schemaVersion": 1,
            "ok": False,
            "error": {"code": "usage", "message": "Missing value for --config"},
        }
    else:
        assert result.stdout == ""
