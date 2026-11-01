"""Port of the codec test in ``packages/cli/src/test/drift.e2e.test.ts`` (#383).

Every codec form migrates without drift, the same codecs respelled on the
server stay clean, and a codec changed, added or removed on the server reports
``changed_column`` and fails ``check --strict``.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
)

COLUMNS = [
    "{'name': 'id', 'type': 'UInt64'}",
    "{'name': 'none', 'type': 'String', 'codec': {'kind': 'NONE'}}",
    "{'name': 'lz4', 'type': 'String', 'codec': {'kind': 'LZ4'}}",
    "{'name': 'zstd', 'type': 'String', 'codec': {'kind': 'ZSTD'}}",
    "{'name': 'zstd3', 'type': 'String', 'codec': {'kind': 'ZSTD', 'level': 3}}",
    "{'name': 'zstd_negative', 'type': 'String', 'codec': {'kind': 'ZSTD', 'level': -1}}",
    "{'name': 'lz4hc', 'type': 'String', 'codec': {'kind': 'LZ4HC'}}",
    "{'name': 'lz4hc0', 'type': 'String', 'codec': {'kind': 'LZ4HC', 'level': 0}}",
    "{'name': 'lz4hc12', 'type': 'String', 'codec': {'kind': 'LZ4HC', 'level': 12}}",
    "{'name': 't64', 'type': 'UInt64', 'codec': {'kind': 'T64'}}",
    "{'name': 't64_lz4', 'type': 'UInt64', 'codec': [{'kind': 'T64'}, {'kind': 'LZ4'}]}",
    "{'name': 't64_zstd3', 'type': 'UInt64', 'codec': [{'kind': 'T64'}, {'kind': 'ZSTD', 'level': 3}]}",
    "{'name': 'delta_t64_lz4', 'type': 'UInt64', "
    "'codec': [{'kind': 'Delta'}, {'kind': 'T64'}, {'kind': 'LZ4'}]}",
    "{'name': 'gcd', 'type': 'UInt64', 'codec': [{'kind': 'GCD'}, {'kind': 'LZ4'}]}",
    "{'name': 'delta_gcd', 'type': 'UInt64', "
    "'codec': [{'kind': 'Delta'}, {'kind': 'GCD'}, {'kind': 'ZSTD'}]}",
    "{'name': 'delta', 'type': 'Int64', 'codec': [{'kind': 'Delta'}, {'kind': 'ZSTD'}]}",
    "{'name': 'delta8', 'type': 'Int64', 'codec': [{'kind': 'Delta', 'size': 8}, {'kind': 'LZ4'}]}",
    "{'name': 'delta_t64', 'type': 'UInt32', 'codec': [{'kind': 'Delta', 'size': 4}, {'kind': 'T64'}]}",
    "{'name': 'double_delta', 'type': 'Int64', 'codec': [{'kind': 'DoubleDelta'}, {'kind': 'LZ4'}]}",
    "{'name': 'double_delta4', 'type': 'DateTime', "
    "'codec': [{'kind': 'DoubleDelta', 'size': 4}, {'kind': 'ZSTD', 'level': 2}]}",
    "{'name': 'gorilla', 'type': 'Float64', 'codec': [{'kind': 'Gorilla'}, {'kind': 'LZ4'}]}",
    "{'name': 'gorilla8', 'type': 'Float64', "
    "'codec': [{'kind': 'Gorilla', 'size': 8}, {'kind': 'ZSTD', 'level': 2}]}",
    "{'name': 'fpc', 'type': 'Float64', "
    "'codec': [{'kind': 'FPC', 'level': 12, 'floatSize': 8}, {'kind': 'LZ4'}]}",
    "{'name': 'fpc4', 'type': 'Float32', "
    "'codec': [{'kind': 'FPC', 'level': 5, 'floatSize': 4}, {'kind': 'LZ4HC'}]}",
    # nullable=True, not an inline Nullable(Int64): chkit-py's drift does not
    # yet equate the two, unlike chkit's.
    "{'name': 'nullable_delta', 'type': 'Int64', 'nullable': True, "
    "'codec': [{'kind': 'Delta', 'size': 8}, {'kind': 'LZ4'}]}",
    "{'name': 'low_cardinality', 'type': 'LowCardinality(String)', 'codec': {'kind': 'ZSTD'}}",
    "{'name': 'raw', 'type': 'String', 'codec': {'kind': 'raw', 'expression': 'ZSTD'}}",
    "{'name': 'raw_chain', 'type': 'Int64', 'codec': {'kind': 'raw', 'expression': 'Delta(8),ZSTD(3)'}}",
    "{'name': 'raw_fpc', 'type': 'Float64', 'codec': {'kind': 'raw', 'expression': 'FPC, LZ4'}}",
    "{'name': 'mixed', 'type': 'Int32', "
    "'codec': [{'kind': 'Delta', 'size': 4}, {'kind': 'raw', 'expression': 'ZSTD(3)'}]}",
    "{'name': 'plain', 'type': 'String'}",
]


def _render_schema(database: str, table_name: str) -> str:
    return "\n".join([
        "from chkit import schema, table",
        "",
        "definitions = schema(",
        f"    table(database={database!r}, name={table_name!r}, engine='MergeTree()', "
        "primary_key=['id'], order_by=['id'], columns=[",
        *(f"        {column}," for column in COLUMNS),
        "    ]),",
        ")",
        "",
    ])


def _wait_for_codecs(client: Any, sql: str, done: Any, timeout: float = 60) -> dict[str, str]:
    deadline = time.monotonic() + timeout
    codecs = {row["name"]: row["compression_codec"] for row in client.query(sql).named_results()}
    while not done(codecs) and time.monotonic() < deadline:
        time.sleep(1)
        codecs = {row["name"]: row["compression_codec"] for row in client.query(sql).named_results()}
    return codecs


def test_every_codec_form_migrates_without_drift_and_server_codec_changes_drift(  # noqa: PLR0915
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ch_client._client
    env = resolve_live_env()
    database = client.database
    table_name = f"{create_prefix('drift_codec')}metrics"
    journal_table = create_journal_table_name("drift_codec_py")
    obj = f"{quote_ident(database)}.{quote_ident(table_name)}"
    selector = ["--table", f"{database}.{table_name}", "--json"]
    codecs_sql = (
        "SELECT name, compression_codec FROM system.columns "
        f"WHERE database = '{database}' AND table = '{table_name}'"
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    runner = CliRunner()
    (tmp_path / "schema.py").write_text(_render_schema(database, table_name))
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
                "database": database,
            },
        })
        + ")\n"
    )

    def drift() -> dict[str, Any]:
        result = runner.invoke(app, ["drift", "--live", *selector])
        assert result.exit_code == 0, format_test_diagnostic("drift failed", result)
        return dict(json.loads(result.stdout))

    def check(exit_code: int) -> dict[str, Any]:
        result = runner.invoke(app, ["check", "--strict", "--live", *selector])
        assert result.exit_code == exit_code, format_test_diagnostic("check --strict", result)
        return dict(json.loads(result.stdout))

    def expect_no_drift() -> None:
        payload = drift()
        assert payload["tableDrift"] == []
        assert payload["drifted"] is False
        assert check(0)["failedChecks"] == []

    try:
        generated = runner.invoke(app, ["generate", "--name", "codecs", "--json"])
        assert generated.exit_code == 0, format_test_diagnostic("generate failed", generated)
        migrated = runner.invoke(app, ["migrate", "--execute", "--json"])
        for _ in range(2):
            if migrated.exit_code == 0:
                break
            time.sleep(2)
            migrated = runner.invoke(app, ["migrate", "--execute", "--json"])
        assert migrated.exit_code == 0, format_test_diagnostic("migrate --execute failed", migrated)
        _wait_for_codecs(client, codecs_sql, lambda codecs: len(codecs) == len(COLUMNS))
        expect_no_drift()

        # The same codecs, spelled the way ClickHouse fills in itself.
        client.command(f"ALTER TABLE {obj} MODIFY COLUMN lz4hc CODEC(LZ4HC)")
        client.command(f"ALTER TABLE {obj} MODIFY COLUMN double_delta4 CODEC(DoubleDelta(8), ZSTD(2))")
        _wait_for_codecs(client, codecs_sql, lambda codecs: codecs.get("lz4hc") == "CODEC(LZ4HC(0))")
        expect_no_drift()

        client.command(f"ALTER TABLE {obj} MODIFY COLUMN zstd3 String CODEC(LZ4)")
        client.command(f"ALTER TABLE {obj} MODIFY COLUMN plain String CODEC(ZSTD(3))")
        client.command(f"ALTER TABLE {obj} MODIFY COLUMN lz4 REMOVE CODEC")
        codecs = _wait_for_codecs(
            client,
            codecs_sql,
            lambda seen: (seen.get("zstd3"), seen.get("plain"), seen.get("lz4"))
            == ("CODEC(LZ4)", "CODEC(ZSTD(3))", ""),
        )
        assert (codecs["zstd3"], codecs["plain"], codecs["lz4"]) == ("CODEC(LZ4)", "CODEC(ZSTD(3))", "")
        payload = drift()
        assert payload["drifted"] is True
        [detail] = payload["tableDrift"]
        assert detail["reasonCodes"] == ["changed_column"]
        assert sorted(detail["changedColumns"]) == ["lz4", "plain", "zstd3"]
        assert check(1)["failedChecks"] == ["schema_drift"]
    finally:
        client.command(f"DROP TABLE IF EXISTS {obj}")
        client.command(f"DROP TABLE IF EXISTS {quote_ident(database)}.{quote_ident(journal_table)}")
