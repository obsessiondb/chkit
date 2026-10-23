"""Port of ``packages/cli/test/cluster-2shard-distributed.e2e.test.ts`` (#279).

A Distributed table over a ReplicatedMergeTree table on the 2-shard x
2-replica cluster (``test/cluster/2shard``): chkit-py creates both ``ON
CLUSTER``, rows inserted through the Distributed table spread over both
shards, and adding a column to both tables leaves drift clean from either
shard.

Like the TS cluster suites this lives outside the default test path: run it
explicitly after ``bun run cluster:2shard:up`` with
``pytest tests_cluster``. Hard-fails (never skips) if a node is unreachable.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from tests.e2e_testkit import create_journal_table_name, create_prefix, poll_until
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_column, wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig

NODES = (
    os.environ.get("CHKIT_CLUSTER_2S_NODES")
    or "http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136"
).split(",")
CLUSTER = os.environ.get("CHKIT_CLUSTER_2S") or "test_cluster_2s"
USER = os.environ.get("CLICKHOUSE_USER") or "default"
PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD") or "clusterpass"
DATABASE = os.environ.get("CLICKHOUSE_DB") or "default"
ROWS = 100
# NODES[0] is a shard-1 replica, NODES[2] a shard-2 replica.
SHARD2_NODE = 2

CONFIG_TEMPLATE = """
from chkit import define_config

config = define_config(
    {{
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {{
            "url": {url!r},
            "username": {user!r},
            "password": {password!r},
            "database": {database!r},
            "cluster": {cluster!r},
        }},
    }}
)
"""


def test_distributed_over_replicated_merge_tree(  # noqa: PLR0915 — mirrors the TS cluster test
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    nodes = [_connect_or_fail(url) for url in NODES]
    shard1, shard2 = nodes[0], nodes[SHARD2_NODE]
    prefix = create_prefix("twoshard_dist_py")
    local, distributed = f"{prefix}events_local", f"{prefix}events"
    journal_table = create_journal_table_name("twoshard_dist_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")
    (tmp_path / "clickhouse.config.py").write_text(
        CONFIG_TEMPLATE.format(
            url=NODES[0], user=USER, password=PASSWORD, database=DATABASE, cluster=CLUSTER
        ),
        encoding="utf-8",
    )
    runner = CliRunner()

    def write_schema(extra_columns: list[dict[str, str]]) -> None:
        columns = [{"name": "id", "type": "UInt64"}, *extra_columns]
        # Explicit replication arguments: a bare ReplicatedMergeTree reads back
        # with the server's default path, and ClickHouse unfolds {database} and
        # {table}, so either would show as an engine mismatch in drift.
        path = f"/clickhouse/tables/{{shard}}/{DATABASE}/{local}"
        local_engine = f"ReplicatedMergeTree('{path}', '{{replica}}')"
        dist_engine = f"Distributed({CLUSTER}, {DATABASE}, {local}, rand())"
        (tmp_path / "schema.py").write_text(
            "from chkit import schema, table\n\n"
            f"columns = {columns!r}\n\n"
            "definitions = schema(\n"
            f"    table(database={DATABASE!r}, name={local!r}, engine={local_engine!r}, "
            "columns=columns, primary_key=['id'], order_by=['id']),\n"
            f"    table(database={DATABASE!r}, name={distributed!r}, engine={dist_engine!r}, "
            "columns=columns),\n"
            ")\n",
            encoding="utf-8",
        )

    def migrate(name: str) -> None:
        generate = runner.invoke(app, ["generate", "--name", name, "--json"])
        assert generate.exit_code == 0, generate.output
        applied = runner.invoke(app, ["migrate", "--execute", "--json"])
        assert applied.exit_code == 0, applied.output

    def assert_no_drift() -> None:
        drift = runner.invoke(app, ["drift", "--live", "--json"])
        assert drift.exit_code == 0, drift.output
        payload = json.loads(drift.stdout)
        assert payload["tableDrift"] == [], drift.output
        assert payload["drifted"] is False

    def count(node: ClickHouseClient, source: str, expected: Any) -> int:
        def read() -> int:
            return int(node.query(f"SELECT count() AS c FROM {source}").rows[0]["c"])

        return poll_until(read, expected)

    try:
        # 1. Both tables are created on every node of both shards.
        write_schema([])
        migrate("init")
        for node in nodes:
            wait_for_table(node, DATABASE, local)
            wait_for_table(node, DATABASE, distributed)

        # 2. Rows inserted through the Distributed table land on both shards and
        # read back whole through the Distributed table from either shard.
        shard1.execute(
            f"INSERT INTO {DATABASE}.{distributed} SETTINGS distributed_foreground_insert = 1 "
            f"SELECT number + 1 FROM numbers({ROWS})"
        )
        assert count(shard1, f"{DATABASE}.{distributed}", lambda n: n == ROWS) == ROWS
        assert count(shard2, f"{DATABASE}.{distributed}", lambda n: n == ROWS) == ROWS
        on_shard1 = count(shard1, f"{DATABASE}.{local}", lambda n: n > 0)
        on_shard2 = count(shard2, f"{DATABASE}.{local}", lambda n: n > 0)
        assert on_shard1 > 0
        assert on_shard2 > 0
        assert on_shard1 + on_shard2 == ROWS
        assert_no_drift()

        # 3. Adding a column to both tables applies one ALTER per table ON CLUSTER.
        write_schema([{"name": "country", "type": "String"}])
        migrate("add_country")
        for node in nodes:
            wait_for_column(node, DATABASE, local, "country")
            wait_for_column(node, DATABASE, distributed, "country")
        shard2.execute(
            f"INSERT INTO {DATABASE}.{distributed} (id, country) "
            "SETTINGS distributed_foreground_insert = 1 VALUES (1000, 'ES'), (1001, 'ES')"
        )
        es = f"{DATABASE}.{distributed} WHERE country = 'ES'"
        assert count(shard1, es, lambda n: n == 2) == 2  # noqa: PLR2004
        assert_no_drift()
    finally:
        for name in (distributed, local, journal_table):
            shard1.execute(f"DROP TABLE IF EXISTS {DATABASE}.`{name}` ON CLUSTER '{CLUSTER}' SYNC")
        for node in nodes:
            node.close()


def _connect_or_fail(url: str) -> ClickHouseClient:
    config = ChxResolvedClickHouseConfig(
        url=url, username=USER, password=PASSWORD, database=DATABASE, secure=False
    )
    try:
        client = ClickHouseClient.connect(config)
        client.query("SELECT 1")
    except Exception as exc:  # never skip on an unreachable node
        pytest.fail(f"Cluster node unreachable at {url}: {exc!r}", pytrace=False)
    return client
