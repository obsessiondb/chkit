"""`chkit query --json` prints what the TS CLI prints for the same query (#377).

Both print ClickHouse's own ``FORMAT JSON`` envelope plus the ``query_id``.
The expected ``meta`` and ``data`` below are the TS output for ``SQL``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from tests.e2e_testkit import format_test_diagnostic, resolve_live_env

SQL = (
    "SELECT toUInt8(1) AS u8, toUInt64(18446744073709551615) AS u64, "
    "toInt64(-9223372036854775808) AS i64, 'a\"b' AS s, "
    "CAST(NULL AS Nullable(String)) AS ns, toNullable(toInt32(7)) AS ni, "
    "toDateTime('2026-10-31 00:32:27', 'UTC') AS dt, "
    "toDateTime64('2026-10-31 00:32:27.123', 3, 'UTC') AS dt64, "
    "toDecimal64(12.345, 3) AS dec, [1, 2, 3] AS arr, ['x', NULL] AS arrn, "
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
    {"name": "arr", "type": "Array(UInt8)"},
    {"name": "arrn", "type": "Array(Nullable(String))"},
    {"name": "utf8", "type": "String"},
]

EXPECTED_DATA = [
    {
        "u8": 1,
        # ClickHouse sends these digits. TS prints 18446744073709552000 and
        # -9223372036854776000 because JSON.parse reads them as doubles.
        "u64": 18446744073709551615,
        "i64": -9223372036854775808,
        "s": 'a"b',
        "ns": None,
        "ni": 7,
        "dt": "2026-10-31 00:32:27",
        "dt64": "2026-10-31 00:32:27.123",
        "dec": 12.345,
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
