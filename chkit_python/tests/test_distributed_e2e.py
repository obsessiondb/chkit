"""Port of ``packages/cli/src/test/distributed.e2e.test.ts`` (#279).

On open-source ClickHouse a local table and a Distributed table over it go
through generate, migrate, insert, drift, pull, ALTER and a resharding
recreate. ObsessionDB has no shards and no Distributed grant, so there the
obsessiondb plugin rejects the table at generate time with a clear message.
"""

from __future__ import annotations

import json
import os
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
    poll_until,
    quote_ident,
    resolve_live_env,
)

# The local stack defines a one-node cluster named `cluster` (test/infra/clickhouse.xml).
CLUSTER = "cluster"
_ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"


def test_distributed_table_lifecycle(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ch_client._client
    env = resolve_live_env()
    prefix = create_prefix("dist_py")
    # ObsessionDB users cannot create databases; the rejection never gets that far.
    database = env.clickhouse_database if _ON_OBSESSIONDB else f"{prefix}db"
    local, distributed = f"{prefix}events_local", f"{prefix}events"
    journal_table = create_journal_table_name("dist_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("CI", "1")
    clickhouse = json.dumps({
        "url": env.clickhouse_url,
        "username": env.clickhouse_user,
        "password": env.clickhouse_password,
        "database": env.clickhouse_database,
    })
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n"
        "from chkit_plugin_obsessiondb import obsessiondb\n\n"
        "config = define_config({\n"
        '    "schema": "./schema.py",\n'
        '    "outDir": "./chkit",\n'
        '    "migrationsDir": "./chkit/migrations",\n'
        '    "metaDir": "./chkit/meta",\n'
        f'    "clickhouse": {clickhouse},\n'
        '    "plugins": [obsessiondb()],\n'
        "})\n"
    )
    project = _Project(CliRunner(), tmp_path, database, local, distributed)
    try:
        if _ON_OBSESSIONDB:
            _assert_obsessiondb_rejects(project)
        else:
            _assert_distributed_lifecycle(project, client)
    finally:
        if not _ON_OBSESSIONDB:
            client.command(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        client.command(
            f"DROP TABLE IF EXISTS {quote_ident(env.clickhouse_database)}."
            f"{quote_ident(journal_table)} SYNC"
        )


class _Project:
    def __init__(
        self, runner: CliRunner, root: Path, database: str, local: str, distributed: str
    ) -> None:
        self.runner = runner
        self.root = root
        self.database = database
        self.local = local
        self.distributed = distributed

    def write_schema(self, extra_columns: list[dict[str, str]], sharding_key: str = "rand()") -> None:
        columns = [{"name": "id", "type": "UInt64"}, {"name": "ts", "type": "DateTime"}]
        columns += extra_columns
        engine = f"Distributed({CLUSTER}, {self.database}, {self.local}, {sharding_key})"
        (self.root / "schema.py").write_text(
            "from chkit import schema, table\n\n"
            # index_granularity is spelled out because pull writes the server
            # default (as a number in Python; TS pull writes a string).
            f"columns = {columns!r}\n\n"
            "definitions = schema(\n"
            f"    table(database={self.database!r}, name={self.local!r}, engine='MergeTree()', "
            "columns=columns, primary_key=['id'], order_by=['id'], "
            "partition_by='toYYYYMM(ts)', settings={'index_granularity': 8192}),\n"
            f"    table(database={self.database!r}, name={self.distributed!r}, "
            f"engine={engine!r}, columns=columns),\n"
            ")\n"
        )

    def invoke(self, args: list[str]) -> Any:
        return self.runner.invoke(app, args)

    def migrate(self, name: str) -> None:
        generate = self.invoke(["generate", "--name", name, "--json"])
        assert generate.exit_code == 0, format_test_diagnostic(f"generate {name}", generate)
        migrate = self.invoke(["migrate", "--execute", "--json"])
        for _ in range(2):
            if migrate.exit_code == 0:
                break
            time.sleep(2)
            migrate = self.invoke(["migrate", "--execute", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic(f"migrate {name}", migrate)

    def assert_no_drift(self) -> None:
        drift = self.invoke(["drift", "--live", "--json"])
        assert drift.exit_code == 0, format_test_diagnostic("drift", drift)
        payload = json.loads(drift.stdout)
        assert payload["tableDrift"] == [], format_test_diagnostic("drift", drift)
        assert payload["drifted"] is False


def _assert_obsessiondb_rejects(project: _Project) -> None:
    project.write_schema([])
    generate = project.invoke(["generate", "--name", "init", "--json"])
    assert generate.exit_code != 0, format_test_diagnostic("generate should fail", generate)
    # A failing plugin hook prints its message as one stderr line, as for every hook.
    assert (
        f"Table {project.database}.{project.distributed} uses the Distributed engine, "
        "which ObsessionDB does not support: ObsessionDB has no shards"
    ) in generate.stderr


def _assert_distributed_lifecycle(project: _Project, client: Any) -> None:
    database, local, distributed = project.database, project.local, project.distributed
    distributed_name = f"{quote_ident(database)}.{quote_ident(distributed)}"

    def engine_full() -> str:
        rows = client.query(
            "SELECT engine_full FROM system.tables WHERE database = {db:String} "
            "AND name = {name:String}",
            parameters={"db": database, "name": distributed},
        ).result_rows
        return str(rows[0][0]) if rows else ""

    def count(where: str = "") -> int:
        return int(client.query(f"SELECT count() FROM {distributed_name} {where}").result_rows[0][0])

    def insert(values: str, columns: str = "id, ts") -> None:
        client.command(
            f"INSERT INTO {distributed_name} ({columns}) "
            f"SETTINGS distributed_foreground_insert = 1 VALUES {values}"
        )

    # 1. Create both tables through chkit.
    project.write_schema([])
    project.migrate("init")
    assert engine_full() == f"Distributed('{CLUSTER}', '{database}', '{local}', rand())"

    # 2. Rows inserted through the Distributed table land in the local table.
    insert("(1, '2026-01-01 00:00:00'), (2, '2026-01-02 00:00:00')")
    assert poll_until(count, lambda c: c == 2) == 2

    # 3. Drift is clean for both tables.
    project.assert_no_drift()

    # 4. A pulled schema round-trips: generating from it plans nothing.
    pulled = project.invoke(
        ["pull", "--out-file", "pulled.py", "--database", database, "--force", "--json"]
    )
    assert pulled.exit_code == 0, format_test_diagnostic("pull", pulled)
    pulled_content = (project.root / "pulled.py").read_text()
    assert f"engine=\"Distributed('{CLUSTER}', '{database}', '{local}', rand())\"" in pulled_content
    (project.root / "schema.py").write_text(pulled_content)
    plan = project.invoke(["generate", "--dryrun", "--json"])
    assert plan.exit_code == 0, format_test_diagnostic("generate from pulled schema", plan)
    assert json.loads(plan.stdout)["operations"] == []

    # 5. Add a column to both tables: two ALTERs, one per table.
    project.write_schema([{"name": "country", "type": "String"}])
    plan = project.invoke(["generate", "--dryrun", "--json"])
    assert plan.exit_code == 0, format_test_diagnostic("generate add column", plan)
    assert sorted(op["sql"] for op in json.loads(plan.stdout)["operations"]) == [
        f"ALTER TABLE {database}.{distributed} ADD COLUMN IF NOT EXISTS `country` String;",
        f"ALTER TABLE {database}.{local} ADD COLUMN IF NOT EXISTS `country` String;",
    ]
    project.migrate("add_country")
    insert("(3, '2026-01-03 00:00:00', 'ES')", "id, ts, country")
    assert poll_until(lambda: count("WHERE country = 'ES'"), lambda c: c == 1) == 1
    project.assert_no_drift()

    # 6. A new sharding key recreates the Distributed table at caution risk, so
    # migrate applies it without --allow-destructive and the rows stay readable.
    project.write_schema([{"name": "country", "type": "String"}], "cityHash64(id)")
    project.migrate("reshard")
    assert poll_until(engine_full, lambda e: "cityHash64" in e) == (
        f"Distributed('{CLUSTER}', '{database}', '{local}', cityHash64(id))"
    )
    assert poll_until(count, lambda c: c == 3) == 3
    project.assert_no_drift()
