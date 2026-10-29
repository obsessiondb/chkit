"""Port of ``packages/cli/src/test/migrate-settings.e2e.test.ts`` (#321).

``migrate --setting`` sends ClickHouse settings with each migration statement:
a 1-byte ``max_table_size_to_drop`` makes the server refuse a DROP, and 0 lets
the resumed run drop the table.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_settings import parse_setting_flags
from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
    wait_for_table_on_every_replica,
)


@pytest.fixture
def live() -> Iterator[ClickHouseClient]:
    env = resolve_live_env()
    with ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    ) as client:
        yield client


def test_parse_setting_flags() -> None:
    assert parse_setting_flags(None) is None
    assert parse_setting_flags([]) is None
    assert parse_setting_flags(
        ["max_table_size_to_drop=0,max_partition_size_to_drop = 0", "log_comment=a=b"]
    ) == {
        "max_table_size_to_drop": "0",
        "max_partition_size_to_drop": "0",
        "log_comment": "a=b",
    }
    for entry in ["max_table_size_to_drop", "=0", "bad-name=0"]:
        with pytest.raises(MigrateError, match="--setting expects <name>=<value>"):
            parse_setting_flags([entry])


def test_migrate_sends_settings_with_each_statement(
    live: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    db = live.database
    table = f"{create_prefix('setting_py')}big"
    journal_table = create_journal_table_name("setting_py")
    fqn = f"{quote_ident(db)}.{quote_ident(table)}"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")

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
                "database": db,
            },
        })
        + ")\n"
    )
    migrations = tmp_path / "chkit" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "20990101000000_drop_big.sql").write_text(
        f"-- operation: drop_table key=table:{db}.{table} risk=danger\n"
        f"DROP TABLE IF EXISTS {fqn};\n"
    )

    def migrate(setting: str) -> Any:
        return CliRunner().invoke(
            app, ["migrate", "--apply", "--allow-destructive", "--setting", setting]
        )

    try:
        live.execute(f"CREATE TABLE {fqn} (id UInt64) ENGINE = MergeTree ORDER BY id")
        wait_for_table_on_every_replica(live, db, table)
        live.execute(f"INSERT INTO {fqn} SELECT number FROM numbers(1000)")

        # A 1-byte limit makes the server refuse the drop: the setting reached it.
        refused = migrate("max_table_size_to_drop=1")
        assert refused.exit_code != 0, format_test_diagnostic("drop was not refused", refused)
        assert "max_[table/partition]_size_to_drop" in refused.output, refused.output
        assert int(live.query(f"SELECT count() AS n FROM {fqn}").rows[0]["n"]) == 1000

        # 0 lifts the limit, and the run resumes the failed statement.
        applied = migrate("max_table_size_to_drop=0")
        assert applied.exit_code == 0, format_test_diagnostic("migrate --apply failed", applied)
        remaining = live.query(
            f"SELECT count() AS n FROM system.tables WHERE database = '{db}' AND name = '{table}'"
        ).rows[0]["n"]
        assert int(remaining) == 0
    finally:
        live.execute(f"DROP TABLE IF EXISTS {fqn} SYNC", {"max_table_size_to_drop": 0})
        live.execute(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)} SYNC")
