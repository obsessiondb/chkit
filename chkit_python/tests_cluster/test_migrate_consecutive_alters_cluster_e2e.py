"""Port of the #240 case in ``packages/cli/test/cluster-2shard.e2e.test.ts``.

The consecutive dependent ALTERs of ``tests/test_migrate_consecutive_alters_e2e.py``
on a ReplicatedMergeTree table, every statement ``ON CLUSTER`` the 2-shard x
2-replica cluster (``test/cluster/2shard``), applied by chkit-py migrate with
``clickhouse.cluster`` set. Every node of both shards must end on the final schema.

Like the TS cluster suites this lives outside the default test path: run it
explicitly after ``bun run cluster:2shard:up`` with ``pytest tests_cluster``.
Hard-fails (never skips) if a node is unreachable.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest
from tests.e2e_testkit import create_journal_table_name, create_prefix, format_test_diagnostic
from tests.test_migrate_consecutive_alters_e2e import (
    FINAL_COLUMNS,
    columns_on_every_replica,
    write_migrations,
)
from typer.testing import CliRunner

from chkit.cli.main import app

NODES = (
    os.environ.get("CHKIT_CLUSTER_2S_NODES")
    or "http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136"
).split(",")
CLUSTER = os.environ.get("CHKIT_CLUSTER_2S") or "test_cluster_2s"
USER = os.environ.get("CLICKHOUSE_USER") or "default"
PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD") or "clusterpass"
DATABASE = os.environ.get("CLICKHOUSE_DB") or "default"


def test_dependent_alters_leave_every_node_of_both_shards_on_the_final_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _connect_or_fail(NODES[0])
    table = f"{create_prefix('twoshard_alters_py')}t"
    journal_table = create_journal_table_name("twoshard_alters_py")
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
                "url": NODES[0],
                "username": USER,
                "password": PASSWORD,
                "database": DATABASE,
                "cluster": CLUSTER,
            },
        })
        + ")\n"
    )
    write_migrations(
        tmp_path / "chkit" / "migrations", DATABASE, table,
        engine="ReplicatedMergeTree", cluster=CLUSTER,
    )
    try:
        migrate = CliRunner().invoke(app, ["migrate", "--apply", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic("migrate --apply failed", migrate)

        replicas, hosts = columns_on_every_replica(node, DATABASE, table, cluster=CLUSTER)
        assert replicas == len(NODES)
        assert len(hosts) == replicas, hosts
        assert all(columns == FINAL_COLUMNS for columns in hosts.values()), hosts
    finally:
        node.command(f"DROP TABLE IF EXISTS {DATABASE}.{table} ON CLUSTER '{CLUSTER}' SYNC")
        node.command(
            f"DROP TABLE IF EXISTS {DATABASE}.`{journal_table}` ON CLUSTER '{CLUSTER}' SYNC"
        )
        node.close()


def _connect_or_fail(url: str) -> Any:
    host, _, port = url.removeprefix("http://").partition(":")
    try:
        client = clickhouse_connect.get_client(
            host=host, port=int(port or 8123), username=USER, password=PASSWORD,
            database=DATABASE,
        )
        client.query("SELECT 1")
    except Exception as exc:  # never skip on an unreachable node
        pytest.fail(f"Cluster node unreachable at {url}: {exc!r}", pytrace=False)
    return client
