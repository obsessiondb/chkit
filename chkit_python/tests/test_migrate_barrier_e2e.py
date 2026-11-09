"""Port of ``packages/cli/src/test/migrate-barrier.e2e.test.ts`` (#634).

``migrate --apply`` refuses a pending statement marked ``mode=barrier`` that
is not a SELECT before any migration runs, with the same text, exit code and
``--json`` envelope as the TS CLI, and applies a ``WITH ... SELECT`` barrier.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
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


def test_migrate_refuses_a_barrier_that_is_not_a_select(
    live: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    db = live.database
    prefix = create_prefix("barrier_py")
    journal_table = create_journal_table_name("barrier_py")
    first = f"{db}.{prefix}first"
    second = f"{db}.{prefix}second"
    create_second = f"CREATE TABLE {second} (id UInt64) ENGINE = MergeTree ORDER BY id;"
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
    (migrations / "20990101000000_first.sql").write_text(
        f"-- operation: create_table key=table:{first} risk=safe\n"
        f"CREATE TABLE {first} (id UInt64) ENGINE = MergeTree ORDER BY id;\n"
    )
    second_file = migrations / "20990101000001_second.sql"
    second_file.write_text(
        f"-- operation: create_table key=table:{second} risk=safe mode=barrier\n{create_second}\n"
    )
    expected_message = (
        "Cannot apply: a statement marked mode=barrier is not a SELECT:\n"
        "  - 20990101000001_second.sql, statement 1 of 1 "
        f"(-- operation: create_table key=table:{second} risk=safe mode=barrier):\n"
        f"      {create_second}\n"
        "chkit runs a barrier statement as a read of the running INSERTs, once and then "
        "every second, and waits for no change it makes to reach every replica.\n"
        "Make each statement a SELECT (or WITH ... SELECT) that returns a query_id column, "
        "or remove mode=barrier from its -- operation: marker, then re-run chkit migrate "
        "--apply. Nothing was applied."
    )

    def table_count() -> int:
        return int(
            live.query(
                f"SELECT count() AS n FROM system.tables WHERE database = '{db}' "
                f"AND name IN ('{prefix}first', '{prefix}second')"
            ).rows[0]["n"]
        )

    try:
        text = CliRunner().invoke(app, ["migrate", "--apply"])
        assert text.exit_code == 1, format_test_diagnostic("text run was not refused", text)
        assert text.stderr.strip() == expected_message

        as_json = CliRunner().invoke(app, ["migrate", "--apply", "--json"])
        assert as_json.exit_code == 1, format_test_diagnostic("--json run was not refused", as_json)
        assert json.loads(as_json.stdout) == {
            "command": "migrate",
            "schemaVersion": 1,
            "ok": False,
            "error": {"code": "barrier_not_select", "message": expected_message},
        }
        # Neither migration ran, not even the valid first one.
        assert table_count() == 0

        second_file.write_text(
            f"-- operation: cutover_wait_for_inserts key=table:{second}:cutover:mirror_barrier "
            "risk=safe mode=barrier\n"
            "WITH 'Insert' AS kind SELECT query_id FROM system.processes WHERE query_kind = kind;\n"
        )
        applied = CliRunner().invoke(app, ["migrate", "--apply", "--json"])
        assert applied.exit_code == 0, format_test_diagnostic("migrate --apply failed", applied)
        assert [entry["name"] for entry in json.loads(applied.stdout)["applied"]] == [
            "20990101000000_first.sql",
            "20990101000001_second.sql",
        ]
        assert table_count() == 1
    finally:
        for name in (f"{prefix}first", f"{prefix}second", journal_table):
            live.execute(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(name)} SYNC")
