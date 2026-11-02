"""Without a `clickhouse` block or a selected service, each command fails with
the TS CLI's message, stream and exit code (#459)."""

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

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
    }
)
"""

JOURNAL_COMMANDS = [
    ("check", "clickhouse config is required for check (journal is stored in ClickHouse)"),
    ("status", "clickhouse config is required for status (journal is stored in ClickHouse)"),
    ("migrate", "clickhouse config is required for migrate (journal is stored in ClickHouse)"),
    ("drift", "clickhouse config is required for drift checks"),
]
QUERY_MESSAGE = (
    "No target configured. Provide clickhouse settings in your config or install a "
    "plugin (e.g. obsessiondb) that supplies one."
)
PULL_MESSAGE = (
    "pull needs a target: set CLICKHOUSE_URL or select an ObsessionDB service "
    "(chkit obsessiondb service select)"
)


@pytest.fixture(autouse=True)
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    for name in ("CLICKHOUSE_URL", "CLICKHOUSE_HOST", "CLICKHOUSE_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    (tmp_path / "schema.py").write_text("", encoding="utf-8")
    # drift reads the snapshot before it looks for a target, as in TS.
    assert CliRunner().invoke(app, ["generate"]).exit_code == 0
    _reset_for_testing()
    yield tmp_path
    _reset_for_testing()


@pytest.mark.parametrize(
    ("args", "message"),
    [([command], message) for command, message in JOURNAL_COMMANDS]
    + [(["query", "SELECT 1"], QUERY_MESSAGE)],
)
def test_no_target_prints_the_ts_message_on_stderr(args: list[str], message: str) -> None:
    result = CliRunner().invoke(app, args)

    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr == f"{message}\n"


@pytest.mark.parametrize(
    ("args", "message"),
    [([command], message) for command, message in JOURNAL_COMMANDS]
    + [(["query", "SELECT 1"], QUERY_MESSAGE)],
)
def test_no_target_json_prints_the_ts_envelope(args: list[str], message: str) -> None:
    result = CliRunner().invoke(app, [*args, "--json"])

    assert result.exit_code == 1
    assert result.stderr == f"{message}\n"
    assert json.loads(result.stdout) == {
        "command": args[0],
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "error", "message": message},
    }


def test_pull_without_target_reports_like_the_ts_pull_plugin() -> None:
    result = CliRunner().invoke(app, ["pull"])

    assert result.exit_code == 2
    assert result.stdout == f"Pull schema failed: {PULL_MESSAGE}\n"
    assert result.stderr == ""


def test_pull_json_without_target_reports_like_the_ts_pull_plugin() -> None:
    result = CliRunner().invoke(app, ["pull", "--json"])

    assert result.exit_code == 2
    assert json.loads(result.stdout) == {"ok": False, "command": "schema", "error": PULL_MESSAGE}
    assert result.stderr == ""
