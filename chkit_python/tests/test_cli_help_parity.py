"""chkit-py prints the help the TS CLI prints.

``test/fixtures/cli-help.json`` holds the TS help of every command, written by
``bun run scripts/update-cli-help-fixture.ts`` and checked against the TS CLI
by ``packages/cli/src/test/cli-help-fixture.test.ts``. Where both CLIs have the
same command and flags the Python help is the same text, byte for byte; where
they differ, the test names each line only one port prints.
"""

from __future__ import annotations

import difflib
import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit import __version__
from chkit.cli.main import app

FIXTURE: dict[str, str] = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/cli-help.json").read_text(
        encoding="utf-8"
    )
)


def _help(args: list[str]) -> str:
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 0, result.output
    assert result.stderr == ""
    return result.stdout.replace(f"chkit v{__version__} ", "chkit v{version} ")


def _only_in_each(ts: str, py: str) -> tuple[list[str], list[str]]:
    """The lines only TS prints and the lines only chkit-py prints."""
    diff = list(difflib.ndiff(ts.splitlines(), py.splitlines()))
    return (
        [line[2:] for line in diff if line.startswith("- ")],
        [line[2:] for line in diff if line.startswith("+ ")],
    )


SAME_COMMANDS = ["generate", "migrate", "status", "snapshot", "query", "plugin"]


@pytest.mark.parametrize("command", SAME_COMMANDS)
@pytest.mark.parametrize("flag", ["--help", "-h"])
def test_command_help_is_the_ts_help(command: str, flag: str) -> None:
    assert _help([command, flag]) == FIXTURE[f"{command} --help"]


@pytest.mark.parametrize("command", SAME_COMMANDS)
def test_help_plugins_adds_the_obsessiondb_flags_as_ts_does(command: str) -> None:
    expected = FIXTURE[f"{command} --help-plugins"]
    assert _help([command, "--help-plugins"]) == expected
    # Before the command too, as in TS.
    assert _help(["--help-plugins", command]) == expected


@pytest.mark.parametrize("value_flag", ["--name", "-n", "--table", "-t"])
def test_a_c_that_is_a_flag_value_is_not_a_valueless_config(value_flag: str) -> None:
    """As TS ``expandShortFlags``: ``--name -c`` gives --name the value ``-c``,
    so the --help-plugins help shows instead of a missing --config (#619)."""
    args = ["generate", value_flag, "-c", "--help-plugins"]
    assert _help(args) == FIXTURE["generate --help-plugins"]


@pytest.mark.parametrize("args", [["--help", "--config"], ["-c", "-h"], ["-h", "-c"]])
def test_a_builtin_command_shows_its_help_before_reading_config(args: list[str]) -> None:
    # As TS, which shows the help of its built-in commands without the config.
    assert _help(["status", *args]) == FIXTURE["status --help"]


@pytest.mark.parametrize(
    "args",
    [
        ["obsessiondb", "--help"],
        ["obsessiondb", "-h"],
        ["obsessiondb", "logout", "--help"],
        ["obsessiondb", "whoami", "-h"],
        ["obsessiondb", "service", "--help"],
        ["obsessiondb", "service", "--json", "--help-plugins"],
    ],
)
def test_obsessiondb_help_is_the_ts_help(args: list[str]) -> None:
    key = " ".join(arg for arg in args if arg not in ("-h", "--help", "--json", "--help-plugins"))
    assert _help(args) == FIXTURE[f"{key} --help"]


@pytest.mark.parametrize("args", [[], ["-h"], ["--help"], ["--help-plugins"]])
def test_top_level_help_lists_the_python_commands_in_the_ts_layout(args: list[str]) -> None:
    assert _only_in_each(FIXTURE["--help"], _help(args)) == (
        [
            "  add            Add an app's editable schema and ingestion code to the project",
            "  registry       Browse apps and integration guides, inspect sync coverage, "
            "or build templates",
            "  skills         Manage agent skills (proxies to the `skills` CLI)",
        ],
        [
            "  pull           Introspect live ClickHouse and emit a Python schema file",
            "",
            "Plugin commands:",
            "  codegen        Generate Pydantic models from chkit schema definitions",
            "  obsessiondb    Plugin: obsessiondb",
            "    login        Authenticate with ObsessionDB",
            "    signup       Sign up or log in with a one-time email code (passwordless)",
            "    logout       Remove stored ObsessionDB credentials",
            "    whoami       Show current ObsessionDB user",
            "    service      Manage ObsessionDB services",
        ],
    )


def test_init_help_describes_the_python_scaffold() -> None:
    assert _only_in_each(FIXTURE["init --help"], _help(["init", "-h"])) == (
        ["Create a TypeScript config and example schema; install project dependencies."],
        ["Create a Python config and example schema."],
    )


@pytest.mark.parametrize("command", ["drift", "check"])
@pytest.mark.parametrize("flag", ["--help", "--help-plugins"])
def test_drift_and_check_also_list_the_python_live_flag(command: str, flag: str) -> None:
    assert _only_in_each(FIXTURE[f"{command} {flag}"], _help([command, flag])) == (
        [],
        [
            f"  --live                 No-op, kept for existing scripts: {command} "
            "always reads the live server"
        ],
    )


def test_codegen_help_lists_the_python_codegen_flags() -> None:
    assert _only_in_each(FIXTURE["codegen --help"], _help(["codegen", "--help"])) == (
        [
            "  Generate TypeScript artifacts from chkit schema definitions",
            "  --emit-zod             Emit Zod schemas alongside TypeScript types",
            "  --emit-ingest          Emit ingest helper functions",
            "  --ingest-out-file <path>",
            "                        Ingest output file path",
            "  --bigint-mode <mode>   How to represent large integers (string or bigint)",
            "  --emit-migrations      Emit runtime migration module",
            "  --migrations-out-file <path>",
            "                        Migration module output file path",
        ],
        [
            "  Generate Pydantic models from chkit schema definitions",
            "  --bigint-mode <mode>   How to represent 64-bit integers (int or str)",
            "  --table-name-style <style>",
            "                        Class naming convention (pascal / camel / raw)",
        ],
    )


def test_pull_help_is_the_ts_pull_schema_help() -> None:
    # TS runs pull as `chkit pull schema`, and prints its plugin flags without
    # --help-plugins because the config is loaded for a plugin command.
    assert _only_in_each(FIXTURE["pull schema --help"], _help(["pull", "--help-plugins"])) == (
        [
            "chkit pull schema [options]",
            "  Pull live ClickHouse table schema and write chkit schema file",
        ],
        [
            "chkit pull [options]",
            "  Introspect live ClickHouse and emit a Python schema file",
        ],
    )


@pytest.mark.parametrize(
    ("command", "ts_only_flags"),
    [
        ("login", ["  --api-url              ObsessionDB API base URL"]),
        (
            "signup",
            [
                "  --api-url              ObsessionDB API base URL",
                "  --email                Email to sign up/log in with (skips the prompt)",
                "  --code                 One-time code (skips the prompt; for scripts/tests)",
                "  --org-name             Override the auto-created organization name",
                "  --request-only         Only send the code and print the follow-up command "
                "(step 1 of 2)",
            ],
        ),
    ],
)
def test_obsessiondb_command_help_lists_the_python_flags(
    command: str, ts_only_flags: list[str]
) -> None:
    help_text = _help(["obsessiondb", command, "-h"])
    assert _only_in_each(FIXTURE[f"obsessiondb {command} --help"], help_text) == (
        ["", "Options:", *ts_only_flags],
        [],
    )


def test_an_unknown_obsessiondb_command_shows_the_plugin_help() -> None:
    assert _help(["obsessiondb", "nope", "-h"]) == FIXTURE["obsessiondb --help"]
