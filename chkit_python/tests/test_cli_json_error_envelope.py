"""A failing command under ``--json`` leaves stdout a JSON error envelope (#329).

Mirrors the TS CLI's top-level catch in ``packages/cli/src/bin/chkit.ts``.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands import check, drift, pull, status
from chkit.cli.json_output import _reset_for_testing, has_emitted_json
from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient

CONFIG = """
from chkit import define_config

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {
            "url": "http://localhost:8123",
            "username": "default",
            "password": "",
            "database": "default",
        },
    }
)
"""


@pytest.fixture(autouse=True)
def _fresh_emit_flag() -> Iterator[None]:
    _reset_for_testing()
    yield
    _reset_for_testing()


def _raise_connection_refused(*_args: Any, **_kwargs: Any) -> Any:
    msg = "Connection refused"
    raise ConnectionError(msg)


@pytest.mark.parametrize(
    ("command", "module", "args"),
    [
        ("status", status, ["status", "--json"]),
        ("check", check, ["check", "--json"]),
        ("drift", drift, ["drift", "--json"]),
        ("pull", pull, ["pull", "--json"]),
    ],
)
def test_failing_command_prints_the_envelope(
    command: str,
    module: Any,
    args: list[str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(module, "load_config", _raise_connection_refused)

    result = CliRunner().invoke(app, args)

    assert result.exit_code == 1
    assert json.loads(result.stdout) == {
        "command": command,
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "error", "message": "Connection refused"},
    }


def test_failing_command_without_json_prints_nothing_to_stdout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(status, "load_config", _raise_connection_refused)

    result = CliRunner().invoke(app, ["status"])

    assert result.exit_code == 1
    assert result.stdout == ""
    assert isinstance(result.exception, ConnectionError)


def test_usage_error_prints_the_envelope_and_keeps_exit_code_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(app, ["query", "--json"])

    assert result.exit_code == 2
    envelope = json.loads(result.stdout)
    assert envelope["command"] == "query"
    assert envelope["error"]["code"] == "error"
    assert "SQL string as the first positional argument" in envelope["error"]["message"]


def _failing_query_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    monkeypatch.setattr(ClickHouseClient, "connect", _raise_connection_refused)


def test_failing_query_prints_the_envelope_and_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _failing_query_project(tmp_path, monkeypatch)

    result = CliRunner().invoke(app, ["query", "SELECT 1", "--json"])

    assert result.exit_code == 1
    assert "Connection refused" in result.stderr
    assert json.loads(result.stdout) == {
        "command": "query",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "error", "message": "Connection refused"},
    }


def test_failing_query_without_json_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _failing_query_project(tmp_path, monkeypatch)

    result = CliRunner().invoke(app, ["query", "SELECT 1"])

    assert result.exit_code == 1
    assert "Connection refused" in result.stderr
    assert result.stdout == ""


def _project_without_snapshot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    (tmp_path / "schema.py").write_text("definitions = []\n", encoding="utf-8")


@pytest.mark.parametrize(
    ("command", "args", "message"),
    [
        (
            "drift",
            ["drift", "--json"],
            "Snapshot not found. Run `chkit generate` before drift checks.",
        ),
        (
            "generate",
            ["generate", "--cutover-copy", "backfill", "--json"],
            "--cutover-copy and --cutover-old apply to a cutover: add "
            "--cutover <database>.<table>=<key columns>.",
        ),
    ],
)
def test_exit_paths_print_the_envelope(
    command: str,
    args: list[str],
    message: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_without_snapshot(tmp_path, monkeypatch)

    result = CliRunner().invoke(app, args)

    assert result.exit_code == 1
    assert result.stderr == f"{message}\n"
    assert json.loads(result.stdout) == {
        "command": command,
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "error", "message": message},
    }


def test_exit_path_without_json_prints_the_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _project_without_snapshot(tmp_path, monkeypatch)

    result = CliRunner().invoke(app, ["drift"])

    assert result.exit_code == 1
    assert result.stdout == ""
    assert "Snapshot not found" in result.stderr


def test_drift_payload_is_wrapped_and_marks_json_emitted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _project_without_snapshot(tmp_path, monkeypatch)
    assert CliRunner().invoke(app, ["generate"]).exit_code == 0
    _reset_for_testing()

    # A selector matching no snapshot table returns before reading the server.
    result = CliRunner().invoke(app, ["drift", "--json", "--table", "missing"])

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["command"] == "drift"
    assert payload["schemaVersion"] == 1
    assert payload["drifted"] is False
    assert has_emitted_json()
