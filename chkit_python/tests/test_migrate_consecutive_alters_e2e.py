"""Port of ``packages/cli/src/test/migrate-consecutive-alters.e2e.test.ts`` (#240).

One migration of consecutive dependent ALTERs on one column. Each statement
only succeeds, or only does what it says, when the replica that runs it has
applied the previous one: MODIFY COLUMN needs the column, RENAME COLUMN IF
EXISTS silently skips a column it cannot see, and the MODIFY after the rename
needs the new name. migrate returns only after its waits saw each change on
every replica, so the final schema is checked on every replica without polling.
"""

from __future__ import annotations

import json
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

FINAL_COLUMNS = ["id UInt32  ", "ts DateTime  ", "z String DEFAULT 'z'"]


def write_migrations(
    migrations: Path, db: str, table: str, *, engine: str = "MergeTree()", cluster: str = ""
) -> None:
    """Write the create and ALTER migrations; ``cluster`` stamps ``ON CLUSTER``."""
    fqn = f"{quote_ident(db)}.{quote_ident(table)}"
    on_cluster = f" ON CLUSTER '{cluster}'" if cluster else ""
    key = f"table:{db}.{table}"
    alter = f"ALTER TABLE {fqn}{on_cluster}"
    create = (
        "-- chkit-migration-format: v1\n"
        f"-- operation: create_table key={key} risk=safe\n"
        f"CREATE TABLE IF NOT EXISTS {fqn}{on_cluster} (id UInt32, ts DateTime) "
        f"ENGINE = {engine} ORDER BY id;\n"
    )
    statements = [
        ("alter_table_add_column", f"{key}:column:x",
         f"{alter} ADD COLUMN IF NOT EXISTS x UInt32 DEFAULT 1;"),
        ("alter_table_modify_column", f"{key}:column:x",
         f"{alter} MODIFY COLUMN x UInt64 DEFAULT 2;"),
        ("alter_table_modify_column", f"{key}:column:x",
         f"{alter} MODIFY COLUMN x UInt64 MATERIALIZED id + 3;"),
        ("alter_table_modify_column", f"{key}:column:x",
         f"{alter} MODIFY COLUMN x UInt64 MATERIALIZED id + 4;"),
        ("alter_table_rename_column", f"{key}:column_rename:x:y",
         f"{alter} RENAME COLUMN IF EXISTS x TO y;"),
        ("alter_table_modify_column", f"{key}:column:y",
         f"{alter} MODIFY COLUMN y UInt64 DEFAULT id + 5;"),
        ("alter_table_add_column", f"{key}:column:z",
         f"{alter} ADD COLUMN IF NOT EXISTS z String DEFAULT 'z';"),
        ("alter_table_drop_column", f"{key}:column:y", f"{alter} DROP COLUMN IF EXISTS y;"),
    ]
    alters = "-- chkit-migration-format: v1\n\n" + "\n".join(
        f"-- operation: {op} key={op_key} risk=safe\n{sql}\n" for op, op_key, sql in statements
    )
    migrations.mkdir(parents=True)
    (migrations / "20990101000000_create.sql").write_text(create)
    (migrations / "20990101000001_alters.sql").write_text(alters)


def columns_on_every_replica(
    client: Any, db: str, table: str, *, cluster: str = "default"
) -> tuple[int, dict[str, list[str]]]:
    """Columns of ``db.table`` per replica of ``cluster``, and the replica count.

    ObsessionDB exposes its replicas as the ``default`` cluster; a single
    server (or one without that cluster) reads ``system.columns`` directly.
    ``client`` is a clickhouse-connect client.
    """
    try:
        replicas = int(client.query(
            f"SELECT count(DISTINCT hostName()) FROM clusterAllReplicas('{cluster}', system.one)"
        ).result_rows[0][0])
    except Exception:
        replicas = 1
    source = (
        f"clusterAllReplicas('{cluster}', system.columns)" if replicas > 1 else "system.columns"
    )
    rows = client.query(
        "SELECT hostName() AS host, concat(name, ' ', type, ' ', default_kind, ' ', "
        f"default_expression) AS column, position FROM {source} "
        f"WHERE database = '{db}' AND table = '{table}' ORDER BY host, position"
    ).result_rows
    hosts: dict[str, list[str]] = {}
    for host, column, _ in rows:
        hosts.setdefault(str(host), []).append(str(column))
    return max(replicas, 1), hosts


def test_dependent_alters_leave_every_replica_on_the_final_schema(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ch_client._client
    env = resolve_live_env()
    db = client.database
    table = f"{create_prefix('alters_py')}t"
    journal_table = create_journal_table_name("alters_py")
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
    write_migrations(tmp_path / "chkit" / "migrations", db, table)
    try:
        migrate = CliRunner().invoke(app, ["migrate", "--apply", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic("migrate --apply failed", migrate)

        replicas, hosts = columns_on_every_replica(client, db, table)
        assert len(hosts) == replicas, hosts
        assert all(columns == FINAL_COLUMNS for columns in hosts.values()), hosts
    finally:
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(table)} SYNC")
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)} SYNC")
