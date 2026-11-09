"""``--table`` only where it scopes the command (#565).

generate, migrate, check and drift take it; snapshot rebuild rejects it with
its own message. Every other command rejects it as an unknown option, as TS
does, instead of accepting a scope it would ignore.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

# CI forces rich to colour usage errors.
ANSI_STYLE = re.compile(r"\x1b\[[0-9;]*m")

# The server is never contacted: every command here fails on the flag first.
CONFIG = """
from chkit import define_config
from chkit_plugin_codegen import codegen

config = define_config({
    "schema": "./schema.py",
    "outDir": "./chkit",
    "clickhouse": {"url": "http://127.0.0.1:9", "username": "default", "password": "", "database": "default"},
    "plugins": [codegen({"outFile": "./gen/models.py"})],
})
"""
SCHEMA = (
    "from chkit import table\n\n"
    "users = table(database='app', name='users', engine='MergeTree()', "
    "columns=[{'name': 'id', 'type': 'UInt64'}], primary_key=['id'], order_by=['id'])\n"
)


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text(SCHEMA)
    return tmp_path


@pytest.mark.parametrize(
    "command",
    [
        ["status"],
        ["query", "SELECT 1"],
        ["pull", "--dryrun"],
        ["codegen"],
        ["plugin", "codegen", "codegen"],
    ],
    ids=["status", "query", "pull", "codegen", "plugin"],
)
def test_commands_that_ignore_a_scope_reject_table(project: Path, command: list[str]) -> None:
    for flag_args, flag in (
        (["--table", "app.users"], "--table"),
        (["-t", "app.users"], "-t"),
    ):
        result = CliRunner().invoke(app, [*command, *flag_args])
        output = ANSI_STYLE.sub("", result.output)
        # Reported as TS reports an unknown flag (#563).
        assert result.exit_code == 1, (command, flag_args, output)
        assert f"Unknown flag: {flag}" in output, (command, flag_args, output)
    assert not (project / "gen").exists()


def test_help_lists_table_only_for_the_commands_that_take_it() -> None:
    for command in ("status", "query", "pull"):
        result = CliRunner().invoke(app, [command, "-h"])
        assert result.exit_code == 0, result.output
        assert "--table" not in ANSI_STYLE.sub("", result.output), command
    for command in ("generate", "migrate", "check", "drift"):
        result = CliRunner().invoke(app, [command, "-h"])
        assert result.exit_code == 0, result.output
        assert "--table" in ANSI_STYLE.sub("", result.output), command
