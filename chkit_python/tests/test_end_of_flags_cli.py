"""``--`` ends a core command's flags, as in the TS CLI (#614): what follows it
is an argument, even ``--help`` or ``--json``, and a command that takes none
rejects it. A bare trailing ``--`` is ignored."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app

CONFIG = (
    'from chkit import define_config\n\nconfig = define_config({"schema": "./schema.py", '
    '"outDir": "./chkit"})\n'
)
SCHEMA = (
    "from chkit import table\n\n"
    "users = table(database='app', name='users', engine='MergeTree()', "
    "columns=[{'name': 'id', 'type': 'UInt64'}], primary_key=['id'], order_by=['id'])\n"
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
    (tmp_path / "schema.py").write_text(SCHEMA)
    return tmp_path


def _extra_args(args: str) -> str:
    return f"Got unexpected extra argument(s) ({args})"


def _usage_message(output: str) -> str:
    """The usage error's text, without click's colors, box drawing and line wrapping."""
    plain = re.sub(r"\x1b\[[0-9;]*m", "", output)
    return " ".join(re.sub(r"[│╭╮╰╯─]", " ", plain).split())


def test_a_trailing_dash_dash_is_ignored(project: Path) -> None:
    plain = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])
    assert plain.exit_code == 0, plain.output
    trailing = CliRunner().invoke(app, ["generate", "--dryrun", "--json", "--"])
    assert trailing.exit_code == 0, trailing.output
    assert json.loads(trailing.stdout) == json.loads(plain.stdout)

    rebuild = CliRunner().invoke(app, ["snapshot", "rebuild", "--dryrun", "--json", "--"])
    assert rebuild.exit_code == 0, rebuild.output
    assert json.loads(rebuild.stdout)["mode"] == "plan"


@pytest.mark.parametrize(
    ("args", "rest"),
    [
        # After --, --help and --json are arguments: no help, no JSON mode.
        (["generate", "--dryrun", "--", "--help"], "--help"),
        (["generate", "--dryrun", "--", "-h"], "-h"),
        (["generate", "--dryrun", "--", "--json"], "--json"),
        (["generate", "--", "--dryrun"], "--dryrun"),
        (["generate", "--dryrun", "--", "--", "x"], "-- x"),
        (["status", "--", "x", "y"], "x y"),
        (["migrate", "--", "x"], "x"),
        (["drift", "--", "x"], "x"),
        (["check", "--", "-z"], "-z"),
    ],
)
def test_what_follows_dash_dash_is_a_stray_argument(
    project: Path, args: list[str], rest: str
) -> None:
    result = CliRunner().invoke(app, args)
    # The exit code and the form of click's report are #607.
    assert result.exit_code != 0, args
    assert result.stdout == "", args
    assert _extra_args(rest) in _usage_message(result.stderr), args


def test_a_flag_error_before_dash_dash_ignores_a_json_after_it(project: Path) -> None:
    result = CliRunner().invoke(app, ["status", "--bogus", "--", "--json"])
    assert (result.exit_code, result.stdout, result.stderr) == (1, "", "Unknown flag: --bogus\n")

    missing = CliRunner().invoke(app, ["generate", "--name", "--", "--dryrun"])
    assert (missing.exit_code, missing.stderr) == (1, "Missing value for --name\n")


def test_snapshot_gets_what_follows_dash_dash_as_its_arguments(project: Path) -> None:
    after = CliRunner().invoke(app, ["snapshot", "--", "rebuild", "--dryrun", "--json"])
    assert after.exit_code == 1
    assert after.stdout == ""
    assert after.stderr.startswith('Unexpected argument "--dryrun" for `chkit snapshot rebuild`.')


def test_init_rejects_what_follows_dash_dash_before_writing_anything(project: Path) -> None:
    (project / "clickhouse.config.py").unlink()
    for args, rest in (
        (["init", "-y", "--", "foo"], "foo"),
        (["init", "--", "--yes"], "--yes"),
        (["init", "-y", "--", "--connect", "bogus"], "--connect bogus"),
    ):
        result = CliRunner().invoke(app, args)
        assert result.exit_code != 0, args
        assert _extra_args(rest) in _usage_message(result.stderr), args
    assert not (project / "clickhouse.config.py").exists()

    accepted = CliRunner().invoke(app, ["init", "-y", "--"])
    assert accepted.exit_code == 0, accepted.output
    assert (project / "clickhouse.config.py").exists()
