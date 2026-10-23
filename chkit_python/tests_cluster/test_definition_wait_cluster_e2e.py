"""Port of ``packages/cli/test/cluster-2shard-definition-wait.e2e.test.ts`` (#290).

A replica that has not applied a MODIFY COLUMN yet still lists the column. This
stops one replica's replication queue so it keeps the old definition, then
checks that the migrate wait holds until that replica catches up, where the
column-presence wait did not.

The ALTERs run on one replica of each shard without ON CLUSTER: an ON CLUSTER
ALTER would hold the cluster's DDL queue until the stopped replica applies it.
Run explicitly after ``bun run cluster:2shard:up`` with ``pytest tests_cluster``.
Hard-fails (never skips) if a node is unreachable.
"""

from __future__ import annotations

import os
import threading
import time
from types import SimpleNamespace
from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest
from tests.e2e_testkit import create_prefix

from chkit.clickhouse.ddl_propagation import (
    wait_for_column,
    wait_for_ddl_propagation,
    wait_for_table,
)

NODES = (
    os.environ.get("CHKIT_CLUSTER_2S_NODES")
    or "http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136"
).split(",")
CLUSTER = os.environ.get("CHKIT_CLUSTER_2S") or "test_cluster_2s"
USER = os.environ.get("CLICKHOUSE_USER") or "default"
PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD") or "clusterpass"
DATABASE = os.environ.get("CLICKHOUSE_DB") or "default"
LAG_SECONDS = 3.0


class _LiveClient:
    """Adapts clickhouse-connect to the ``query(sql) -> .rows`` shape the waits use."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def query(self, sql: str) -> SimpleNamespace:
        return SimpleNamespace(rows=list(self._client.query(sql).named_results()))


def test_modify_column_waits_until_a_lagging_replica_shows_the_new_default() -> None:
    nodes = [_connect_or_fail(url) for url in NODES]
    shard1, lagging, shard2 = nodes[0], nodes[1], nodes[2]
    live = _LiveClient(shard1)
    table = f"{create_prefix('twoshard_defwait_py')}t"
    qualified = f"{DATABASE}.{table}"
    statement = f"ALTER TABLE {qualified} MODIFY COLUMN `s` String DEFAULT 'new';"

    def default_on(node: Any) -> str:
        return str(
            node.query(
                f"SELECT default_expression FROM system.columns WHERE database = '{DATABASE}' "
                f"AND table = '{table}' AND name = 's'"
            ).result_rows[0][0]
        )

    try:
        shard1.command(
            f"CREATE TABLE {qualified} ON CLUSTER '{CLUSTER}' (id UInt32, s String DEFAULT 'old') "
            "ENGINE = ReplicatedMergeTree ORDER BY id"
        )
        for node in nodes:
            wait_for_table(_LiveClient(node), DATABASE, table)
        lagging.command(f"SYSTEM STOP REPLICATION QUEUES {qualified}")
        shard1.command(statement)
        shard2.command(statement)

        # The gap: the column is listed on every replica, so a presence wait
        # passes while the lagging replica still has the old default.
        wait_for_column(live, DATABASE, table, "s", cluster=CLUSTER)
        assert default_on(lagging) == "'old'"

        catch_up = threading.Timer(
            LAG_SECONDS, lambda: lagging.command(f"SYSTEM START REPLICATION QUEUES {qualified}")
        )
        started = time.monotonic()
        catch_up.start()
        wait_for_ddl_propagation(
            live,
            "alter_table_modify_column",
            f"table:{qualified}:column:s",
            cluster=CLUSTER,
            statement=statement,
        )
        catch_up.join()
        assert time.monotonic() - started >= LAG_SECONDS
        assert [default_on(node) for node in nodes] == ["'new'"] * len(nodes)
    finally:
        lagging.command(f"SYSTEM START REPLICATION QUEUES {qualified}")
        shard1.command(f"DROP TABLE IF EXISTS {qualified} ON CLUSTER '{CLUSTER}' SYNC")


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
