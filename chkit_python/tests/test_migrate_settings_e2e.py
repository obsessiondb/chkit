"""Port of ``packages/cli/src/test/migrate-settings.e2e.test.ts`` (#321).

``migrate --setting`` sends ClickHouse settings with every migration
statement: a 1-byte ``max_table_size_to_drop`` makes the server refuse a DROP,
and 0 lets the resumed run drop the table. The DROP's before-retry SQL, an async
INSERT and a barrier read a unique ``log_comment`` back with ``getSetting()``,
and a run without ``--setting`` sends none.
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


def test_migrate_sends_settings_with_every_statement(
    live: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    db = live.database
    prefix = create_prefix("setting_py")
    table = f"{prefix}big"
    sink = f"{prefix}sink"
    journal_table = create_journal_table_name("setting_py")
    fqn = f"{quote_ident(db)}.{quote_ident(table)}"
    sink_fqn = f"{quote_ident(db)}.{quote_ident(sink)}"
    # A unique log_comment the statements read back with getSetting().
    tag = prefix

    def unset_check(step: str) -> str:
        return (
            f"throwIf(getSetting('log_comment') != '{tag}', "
            f"'--setting log_comment is not set for the {step}')"
        )

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
    # A sync DROP with a before-retry guard, an async INSERT and a barrier,
    # each of which reads the settings it was sent.
    (migrations / "20990101000000_drop_big.sql").write_text(
        f"-- operation: drop_table key=table:{db}.{table} risk=danger\n"
        f"-- before-retry: SELECT {unset_check('before-retry SQL')}\n"
        f"DROP TABLE IF EXISTS {fqn};\n"
        f"-- operation: load_table_data key=table:{db}.{sink} risk=caution mode=async\n"
        f"INSERT INTO {sink_fqn} SELECT getSetting('log_comment');\n"
        f"-- operation: cutover_wait_for_inserts key=table:{db}.{sink}:cutover:mirror_barrier "
        "risk=safe mode=barrier\n"
        f"SELECT query_id FROM system.processes WHERE {unset_check('barrier')} = 1 "
        "OR query_kind IN ('Insert', 'AsyncInsertFlush');\n"
    )

    def migrate(*settings: str) -> Any:
        flags = [arg for setting in settings for arg in ("--setting", setting)]
        return CliRunner().invoke(app, ["migrate", "--apply", "--allow-destructive", *flags])

    def count(sql: str) -> int:
        return int(live.query(sql).rows[0]["n"])

    try:
        live.execute(f"CREATE TABLE {fqn} (id UInt64) ENGINE = MergeTree ORDER BY id")
        wait_for_table_on_every_replica(live, db, table)
        live.execute(f"INSERT INTO {fqn} SELECT number FROM numbers(1000)")
        live.execute(f"CREATE TABLE {sink_fqn} (comment String) ENGINE = MergeTree ORDER BY comment")
        wait_for_table_on_every_replica(live, db, sink)

        # A 1-byte limit makes the server refuse the drop: the setting reached it.
        refused = migrate("max_table_size_to_drop=1", f"log_comment={tag}")
        assert refused.exit_code != 0, format_test_diagnostic("drop was not refused", refused)
        assert "max_[table/partition]_size_to_drop" in refused.output, refused.output
        assert count(f"SELECT count() AS n FROM {fqn}") == 1000

        # Without --setting no setting is sent: the before-retry guard of the
        # failed DROP finds log_comment unset and stops the run.
        unset = migrate()
        assert unset.exit_code != 0, format_test_diagnostic("guard did not stop the run", unset)
        assert "--setting log_comment is not set for the before-retry SQL" in unset.output, (
            unset.output
        )
        assert count(f"SELECT count() AS n FROM {fqn}") == 1000

        # 0 lifts the limit: the run resumes at the DROP, and the before-retry
        # SQL, the async INSERT and the barrier all see the settings.
        applied = migrate("max_table_size_to_drop=0", f"log_comment={tag}")
        assert applied.exit_code == 0, format_test_diagnostic("migrate --apply failed", applied)
        remaining = count(
            f"SELECT count() AS n FROM system.tables WHERE database = '{db}' AND name = '{table}'"
        )
        assert remaining == 0
        written = live.query(f"SELECT comment FROM {sink_fqn}").rows
        assert written == [{"comment": tag}]
    finally:
        live.execute(f"DROP TABLE IF EXISTS {fqn} SYNC", {"max_table_size_to_drop": 0})
        live.execute(f"DROP TABLE IF EXISTS {sink_fqn} SYNC")
        live.execute(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)} SYNC")
