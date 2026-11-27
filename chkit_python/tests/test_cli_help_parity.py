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
from chkit.cli.json_output import _reset_for_testing
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


# drift and check too: their no-op --live is hidden from the help, as TS has none (#776).
SAME_COMMANDS = ["generate", "migrate", "status", "drift", "check", "snapshot", "query", "plugin"]


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
        ["obsessiondb", "login", "--help"],
        ["obsessiondb", "signup", "-h"],
        ["obsessiondb", "logout", "--help"],
        ["obsessiondb", "whoami", "-h"],
        ["obsessiondb", "service", "--help"],
        ["obsessiondb", "service", "--json", "--help-plugins"],
    ],
)
def test_obsessiondb_help_is_the_ts_help(args: list[str]) -> None:
    key = " ".join(arg for arg in args if arg not in ("-h", "--help", "--json", "--help-plugins"))
    assert _help(args) == FIXTURE[f"{key} --help"]


@pytest.mark.parametrize(
    ("args", "key"),
    [
        # As TS `firstPluginPositional`: global flags and --table (long) with
        # their values are skipped; the first other token names the subcommand.
        (["obsessiondb", "--json", "-c", "x", "whoami", "-h"], "obsessiondb whoami"),
        (["obsessiondb", "--table", "x", "service", "-h"], "obsessiondb service"),
        (["obsessiondb", "--help-plugins", "logout"], "obsessiondb logout"),
        # TS expands no -t of a plugin command here, and -h is no global flag:
        # either is the first positional, so the forwarder's own help shows.
        (["obsessiondb", "-h", "whoami"], "obsessiondb"),
        (["obsessiondb", "-t", "x", "whoami", "-h"], "obsessiondb"),
        (["obsessiondb", "-t", "-h"], "obsessiondb"),
    ],
)
def test_forwarder_help_names_the_ts_subcommand(args: list[str], key: str) -> None:
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


@pytest.mark.parametrize(
    "args",
    [
        ["pull", "--help"],
        ["pull", "-h"],
        ["pull", "--help-plugins"],
        # As in TS, the first token other than a global flag names the
        # command whose help is shown (#771).
        ["pull", "foo", "--help"],
        ["pull", "--dryrun", "schema", "--help"],
        ["pull", "-h", "schema"],
    ],
)
def test_pull_help_is_the_ts_pull_plugin_help(args: list[str]) -> None:
    # TS runs pull as a plugin, and prints its plugin flags without
    # --help-plugins because the config is loaded for a plugin command.
    assert _help(args) == FIXTURE["pull --help"]


@pytest.mark.parametrize(
    "args",
    [
        ["pull", "schema", "--help"],
        ["pull", "schema", "-h", "foo"],
        ["pull", "--help-plugins", "schema"],
        ["pull", "--json", "schema", "--help"],
    ],
)
def test_pull_schema_help_is_the_ts_pull_schema_help(args: list[str]) -> None:
    assert _help(args) == FIXTURE["pull schema --help"]


def test_an_unknown_obsessiondb_command_shows_the_plugin_help() -> None:
    assert _help(["obsessiondb", "nope", "-h"]) == FIXTURE["obsessiondb --help"]


def _write_project(root: Path, plugins: str) -> None:
    (root / "clickhouse.config.py").write_text(
        "from chkit import define_config\n"
        "from chkit_plugin_obsessiondb import obsessiondb\n\n"
        f'config = define_config({{"schema": "./schema.py", "plugins": [{plugins}]}})\n'
    )
    (root / "schema.py").write_text("")


def _without_service_section(help_text: str) -> str:
    section = (
        "Plugin: obsessiondb\n"
        "  --service              Override the selected ObsessionDB service by name "
        "for this command\n\n"
    )
    assert section in help_text
    return help_text.replace(section, "")


@pytest.fixture
def empty_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    return tmp_path


@pytest.mark.parametrize("command", [["pull"], ["pull", "schema"]])
@pytest.mark.parametrize("flag", ["--help", "--help-plugins"])
def test_pull_help_lists_the_flags_of_the_configured_plugins(
    empty_home: Path, command: list[str], flag: str
) -> None:
    # TS loads the config for the help of pull, a plugin command there (#771).
    expected = FIXTURE[f"{' '.join(command)} --help"]
    _write_project(empty_home, "")
    assert _help([*command, flag]) == _without_service_section(expected)
    _write_project(empty_home, "obsessiondb()")
    assert _help([*command, flag]) == expected


def test_pull_help_reports_a_config_that_fails_to_load(empty_home: Path) -> None:
    message = "Unable to load config module from /dev/null"
    text = CliRunner().invoke(app, ["pull", "schema", "-c", "/dev/null", "--help"])
    assert (text.exit_code, text.stdout, text.stderr) == (1, "", f"{message}\n")
    _reset_for_testing()
    as_json = CliRunner().invoke(app, ["pull", "schema", "--json", "-c", "/dev/null", "--help"])
    _reset_for_testing()
    assert (as_json.exit_code, as_json.stderr) == (1, f"{message}\n")
    assert json.loads(as_json.stdout) == {
        "command": "pull",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "error", "message": message},
    }
    # A --config that names no file is no config, as in TS: the help.
    assert _help(["pull", "--help", "-c", "missing.py"]) == FIXTURE["pull --help"]


def test_pull_help_reads_an_empty_config_value_as_no_path(empty_home: Path) -> None:
    assert _help(["pull", "--config=", "--help"]) == FIXTURE["pull --help"]
    _write_project(empty_home, "")
    # The project config, without obsessiondb(), as in TS.
    expected = _without_service_section(FIXTURE["pull --help"])
    assert _help(["pull", "--config=", "--help"]) == expected


def test_pull_help_loads_a_user_profile_used_alone(empty_home: Path) -> None:
    profile = empty_home / "chkit" / "config.py"
    profile.parent.mkdir()
    profile.write_text('config = {"clickhouse": {"url": "http://localhost:8123"}}\n')
    assert _help(["pull", "--help"]) == FIXTURE["pull --help"]
    # As in TS, a profile that fails to resolve is the error.
    profile.write_text(
        'config = {"clickhouse": {"url": "http://localhost:8123", "indexGranularity": 0}}\n'
    )
    result = CliRunner().invoke(app, ["pull", "--help"])
    assert (result.exit_code, result.stdout) == (1, "")
    assert "indexGranularity" in result.stderr
