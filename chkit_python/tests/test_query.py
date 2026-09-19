"""Tests for `chkit query` formatters + error cleaner + CLI rejection paths."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.commands.query import (
    EXPECTED_TOKEN_CAP,
    clean_query_error,
    format_query_json,
    format_rows,
)
from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseColumnMeta, ClickHouseJsonQueryResult

CONFIG_TEMPLATE = """
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

CONFIG_NO_CLICKHOUSE = """
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


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG_TEMPLATE, encoding="utf-8")
    return tmp_path


# ---------- clean_query_error ----------


def test_clean_error_strips_format_json_clause() -> None:
    original = RuntimeError("Syntax error near foo FORMAT JSON, expected term")
    cleaned = clean_query_error(original)
    assert "FORMAT JSON" not in str(cleaned)
    assert "Syntax error near foo" in str(cleaned)


def test_clean_error_strips_format_json_each_row() -> None:
    original = RuntimeError("X FORMAT JSONEachRow Y")
    cleaned = clean_query_error(original)
    assert "JSONEachRow" not in str(cleaned)


def test_clean_error_strips_format_json_case_insensitive() -> None:
    original = RuntimeError("Bad X format json end")
    cleaned = clean_query_error(original)
    assert "format json" not in str(cleaned).lower()


def test_clean_error_returns_original_when_nothing_to_strip() -> None:
    original = RuntimeError("Plain connection failure")
    cleaned = clean_query_error(original)
    assert cleaned is original


def test_clean_error_truncates_long_expected_one_of() -> None:
    tokens = ", ".join(f"tok{i}" for i in range(15))
    original = RuntimeError(f"Bad: Expected one of: {tokens}.")
    cleaned = clean_query_error(original)
    msg = str(cleaned)
    assert "tok0" in msg
    assert f"tok{EXPECTED_TOKEN_CAP - 1}" in msg
    assert f"tok{EXPECTED_TOKEN_CAP}" not in msg
    assert "more" in msg


def test_clean_error_preserves_short_expected_one_of() -> None:
    original = RuntimeError("Bad: Expected one of: a, b, c.")
    cleaned = clean_query_error(original)
    assert "a, b, c" in str(cleaned)
    assert "more" not in str(cleaned)


def test_clean_error_passes_through_non_exception() -> None:
    sentinel: BaseException = SystemExit(0)
    assert clean_query_error(sentinel) is sentinel


# ---------- format_rows ----------


def test_format_rows_empty_returns_no_rows() -> None:
    assert format_rows([]) == "(no rows)"


def test_format_rows_aligned_header_and_row_count() -> None:
    rows: list[dict[str, object]] = [{"id": 1, "name": "alice"}]
    out = format_rows(rows)
    assert "id" in out
    assert "name" in out
    assert "alice" in out
    assert "(1 row)" in out


def test_format_rows_plural() -> None:
    rows = [{"id": 1}, {"id": 2}]
    out = format_rows(rows)
    assert "(2 rows)" in out


def test_format_rows_truncates_above_limit() -> None:
    rows = [{"id": i} for i in range(30)]
    out = format_rows(rows)
    assert "(30 rows, showing 25)" in out


def test_format_rows_respects_explicit_limit() -> None:
    rows = [{"id": i} for i in range(10)]
    out = format_rows(rows, limit=3)
    assert "(10 rows, showing 3)" in out


def test_format_rows_handles_missing_keys_across_rows() -> None:
    rows: list[dict[str, object]] = [
        {"id": 1, "name": "alice"},
        {"id": 2},
    ]
    out = format_rows(rows)
    assert "alice" in out
    # The row missing "name" should have an empty cell where "name" was.
    lines = out.splitlines()
    body = lines[3]  # header, separator, row1, row2, '', summary
    assert body.startswith("2")


def test_format_rows_serializes_complex_cells_as_json() -> None:
    rows: list[dict[str, object]] = [{"data": {"nested": True}}]
    out = format_rows(rows)
    assert '"nested": true' in out


def test_format_rows_handles_none_as_empty() -> None:
    rows: list[dict[str, object]] = [{"id": 1, "name": None}]
    out = format_rows(rows)
    # The "None" should NOT be in the body — empty string instead.
    lines = out.splitlines()
    body = lines[2]
    assert "None" not in body


# ---------- format_query_json ----------


def test_format_query_json_returns_indented_envelope() -> None:
    payload = ClickHouseJsonQueryResult(
        data=[{"id": 1}],
        meta=[ClickHouseColumnMeta(name="id", type="UInt64")],
        rows=1,
        statistics=None,
        query_id="abc-123",
    )
    out = format_query_json(payload)
    decoded = json.loads(out)
    assert decoded["data"] == [{"id": 1}]
    assert decoded["meta"] == [{"name": "id", "type": "UInt64"}]
    assert decoded["rows"] == 1
    assert decoded["query_id"] == "abc-123"


# ---------- CLI: rejection paths (no DB needed) ----------


def test_cli_rejects_missing_sql(runner: CliRunner, project: Path) -> None:
    result = runner.invoke(app, ["query"])
    assert result.exit_code != 0
    assert "SQL string as the first positional argument" in result.output


def test_cli_rejects_empty_sql(runner: CliRunner, project: Path) -> None:
    result = runner.invoke(app, ["query", "   "])
    assert result.exit_code != 0
    assert "SQL string" in result.output


def test_cli_rejects_multiple_positional_args(
    runner: CliRunner, project: Path
) -> None:
    result = runner.invoke(app, ["query", "SELECT", "1"])
    assert result.exit_code != 0
    assert "Wrap it in quotes" in result.output


def test_cli_rejects_missing_clickhouse_config(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(
        CONFIG_NO_CLICKHOUSE, encoding="utf-8"
    )
    result = runner.invoke(app, ["query", "SELECT 1"])
    assert result.exit_code != 0
    assert "No target configured" in result.output
