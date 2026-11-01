"""`chkit query --json` prints what the TS CLI prints for the same query (#377).

Both print ClickHouse's own ``FORMAT JSON`` envelope plus the ``query_id``.
The expected ``meta`` and ``data`` below are the TS output for ``SQL``.
64-bit integers and Decimals are strings with every digit ClickHouse sent
(#381), and the table prints the same values.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from tests.e2e_testkit import (
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
)

SQL = (
    "SELECT toUInt8(1) AS u8, toUInt64(18446744073709551615) AS u64, "
    "toInt64(-9223372036854775808) AS i64, 'a\"b' AS s, "
    "CAST(NULL AS Nullable(String)) AS ns, toNullable(toInt32(7)) AS ni, "
    "toDateTime('2026-10-31 00:32:27', 'UTC') AS dt, "
    "toDateTime64('2026-10-31 00:32:27.123', 3, 'UTC') AS dt64, "
    "toDecimal64(12.345, 3) AS dec, "
    "toDecimal128('12345678901234567890.123456789', 9) AS d128, "
    "[toUInt64(18446744073709551615), 1] AS arr_u64, "
    "toNullable(toDecimal64('-12.345', 3)) AS nd, "
    "[1, 2, 3] AS arr, ['x', NULL] AS arrn, "
    "'ñandú €' AS utf8"
)

EXPECTED_META = [
    {"name": "u8", "type": "UInt8"},
    {"name": "u64", "type": "UInt64"},
    {"name": "i64", "type": "Int64"},
    {"name": "s", "type": "String"},
    {"name": "ns", "type": "Nullable(String)"},
    {"name": "ni", "type": "Nullable(Int32)"},
    {"name": "dt", "type": "DateTime('UTC')"},
    {"name": "dt64", "type": "DateTime64(3, 'UTC')"},
    {"name": "dec", "type": "Decimal(18, 3)"},
    {"name": "d128", "type": "Decimal(38, 9)"},
    {"name": "arr_u64", "type": "Array(UInt64)"},
    {"name": "nd", "type": "Nullable(Decimal(18, 3))"},
    {"name": "arr", "type": "Array(UInt8)"},
    {"name": "arrn", "type": "Array(Nullable(String))"},
    {"name": "utf8", "type": "String"},
]

EXPECTED_DATA = [
    {
        "u8": 1,
        # Unquoted, TS printed 18446744073709552000 and -9223372036854776000
        # because JSON.parse reads them as doubles.
        "u64": "18446744073709551615",
        "i64": "-9223372036854775808",
        "s": 'a"b',
        "ns": None,
        "ni": 7,
        "dt": "2026-10-31 00:32:27",
        "dt64": "2026-10-31 00:32:27.123",
        "dec": "12.345",
        # Unquoted, json.loads read it as the float 1.2345678901234567e+19.
        "d128": "12345678901234567890.123456789",
        "arr_u64": ["18446744073709551615", "1"],
        "nd": "-12.345",
        "arr": [1, 2, 3],
        "arrn": ["x", None],
        "utf8": "ñandú €",
    }
]


def test_query_json_prints_the_clickhouse_json_envelope_like_ts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "outDir": "./chkit",
            "migrationsDir": "./chkit/migrations",
            "metaDir": "./chkit/meta",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": env.clickhouse_user,
                "password": env.clickhouse_password,
                "database": env.clickhouse_database,
            },
        })
        + ")\n"
    )

    result = CliRunner().invoke(app, ["query", SQL, "--json"])

    assert result.exit_code == 0, format_test_diagnostic("query --json failed", result)
    # Like JSON.stringify, non-ASCII text is printed as is, not \u-escaped.
    assert '"utf8": "ñandú €"' in result.stdout
    payload: dict[str, Any] = json.loads(result.stdout)
    assert list(payload) == ["data", "meta", "rows", "statistics", "query_id"]
    assert payload["meta"] == EXPECTED_META
    assert payload["data"] == EXPECTED_DATA
    assert payload["rows"] == 1
    statistics = payload["statistics"]
    assert list(statistics) == ["elapsed", "rows_read", "bytes_read"]
    assert isinstance(statistics["elapsed"], float)
    assert isinstance(statistics["rows_read"], int)
    assert isinstance(statistics["bytes_read"], int)
    assert isinstance(payload["query_id"], str)
    assert payload["query_id"]


def test_query_table_prints_every_digit_like_ts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": env.clickhouse_user,
                "password": env.clickhouse_password,
                "database": env.clickhouse_database,
            },
        })
        + ")\n"
    )

    result = CliRunner().invoke(app, ["query", SQL])

    assert result.exit_code == 0, format_test_diagnostic("query failed", result)
    cells = [cell.strip() for cell in result.stdout.splitlines()[2].split("│")]
    # The --json values: strings as they are (no quotes), anything else as
    # compact JSON, as the TS table prints them.
    assert cells == [
        "1",
        "18446744073709551615",
        "-9223372036854775808",
        'a"b',
        "",
        "7",
        "2026-10-31 00:32:27",
        "2026-10-31 00:32:27.123",
        "12.345",
        "12345678901234567890.123456789",
        '["18446744073709551615","1"]',
        "-12.345",
        "[1,2,3]",
        '["x",null]',
        "ñandú €",
    ]


def test_query_json_keeps_numbers_in_json_and_dynamic_columns_like_ts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # #438: a number becomes a string only when a float would change it.
    env = resolve_live_env()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": env.clickhouse_user,
                "password": env.clickhouse_password,
                "database": env.clickhouse_database,
            },
        })
        + ")\n"
    )
    sql = (
        """SELECT CAST('{"a": 2.5, "b": [1, 0.1], "u": 18446744073709551615}' AS JSON) AS j, """
        "CAST(toFloat64(0.1) AS Dynamic) AS d_f64, "
        "CAST(toUInt64(18446744073709551615) AS Dynamic) AS d_u64"
    )

    result = CliRunner().invoke(app, ["query", sql, "--json"])

    assert result.exit_code == 0, format_test_diagnostic("query --json failed", result)
    assert json.loads(result.stdout)["data"] == [
        {
            "j": {"a": 2.5, "b": [1, 0.1], "u": "18446744073709551615"},
            "d_f64": 0.1,
            "d_u64": "18446744073709551615",
        }
    ]


def test_a_statement_without_a_result_set_prints_no_rows_like_ts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": env.clickhouse_user,
                "password": env.clickhouse_password,
                "database": env.clickhouse_database,
            },
        })
        + ")\n"
    )
    sql = (
        f"DROP TABLE IF EXISTS {quote_ident(env.clickhouse_database)}."
        f"{quote_ident(create_prefix('noresult_py') + 't')}"
    )

    table = CliRunner().invoke(app, ["query", sql])
    as_json = CliRunner().invoke(app, ["query", sql, "--json"])

    assert table.exit_code == 0, format_test_diagnostic("query failed", table)
    assert table.stdout.strip() == "(no rows)"
    assert as_json.exit_code == 0, format_test_diagnostic("query --json failed", as_json)
    payload = json.loads(as_json.stdout)
    assert list(payload) == ["data", "meta", "rows", "query_id"]
    assert (payload["data"], payload["meta"], payload["rows"]) == ([], [], 0)


def test_a_failing_query_prints_the_clickhouse_message_like_ts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # #413: without clickhouse-connect's "Received ClickHouse exception, code:
    # N, server response: Code: N. DB::Exception:" prefix and its "(NAME) (for
    # url ...)" suffix, in the text output and in --json's error.message.
    env = resolve_live_env()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": env.clickhouse_user,
                "password": env.clickhouse_password,
                "database": env.clickhouse_database,
            },
        })
        + ")\n"
    )
    sql = "SELECT throwIf(1, 'boom')"

    table = CliRunner().invoke(app, ["query", sql])
    as_json = CliRunner().invoke(app, ["query", sql, "--json"])

    assert table.exit_code == 1, format_test_diagnostic("query did not fail", table)
    assert table.stdout == ""
    assert table.stderr.startswith("boom: while executing 'FUNCTION throwIf(")
    assert table.stderr.endswith("'. \n")
    assert as_json.exit_code == 1, format_test_diagnostic("query --json did not fail", as_json)
    payload = json.loads(as_json.stdout)
    assert payload["error"] == {"code": "395", "message": table.stderr.removesuffix("\n")}
