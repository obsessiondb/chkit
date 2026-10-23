"""Port of the #243 case in ``packages/cli/test/cluster-2shard.e2e.test.ts``.

A copy backfill of a ReplicatedMergeTree table created ``ON CLUSTER`` on the
2-shard x 2-replica cluster (``test/cluster/2shard``), run through chkit-py
under a profile that widens ``SELECT *`` with MATERIALIZED and ALIAS columns.

Like the TS cluster suites this lives outside the default test path: run it
explicitly after ``bun run cluster:2shard:up`` with
``pytest tests_cluster``. Hard-fails (never skips) if a node is unreachable.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest
from tests.e2e_testkit import create_prefix, poll_until
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig

NODES = (
    os.environ.get("CHKIT_CLUSTER_2S_NODES")
    or "http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136"
).split(",")
CLUSTER = os.environ.get("CHKIT_CLUSTER_2S") or "test_cluster_2s"
USER = os.environ.get("CLICKHOUSE_USER") or "default"
PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD") or "clusterpass"
DATABASE = os.environ.get("CLICKHOUSE_DB") or "default"
# NODES[0] and NODES[1] are the shard-1 replicas; NODES[2] and NODES[3] shard 2.
SHARD1_REPLICAS = 2

PROFILE_SETTINGS = {
    "asterisk_include_materialized_columns": 1,
    "asterisk_include_alias_columns": 1,
}

CONFIG_TEMPLATE = """
from chkit import define_config
from chkit_plugin_backfill import backfill

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
        "plugins": [backfill()],
    }}
)
"""

EMPTY_SCHEMA = """
from chkit import schema

definitions = schema()
"""

EXPECTED_SHARD1_ROWS = [
    {"id": "1", "a": "x", "m": "x_m", "al": "x_al", "d": "custom", "b": "bx", "copies": "2"},
    {"id": "2", "a": "y", "m": "y_m", "al": "y_al", "d": "dflt", "b": "by", "copies": "2"},
]


def test_copy_backfill_of_replicated_table_under_widened_asterisk_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Node clients are opened before the profile patch, so they read and
    # write without it.
    nodes = [_connect_or_fail(url) for url in NODES]
    shard1 = nodes[0]
    table = f"{create_prefix('twoshard_bf_asterisk')}events"
    fqn = f"{DATABASE}.{table}"
    try:
        shard1.execute(
            f"CREATE TABLE {fqn} ON CLUSTER '{CLUSTER}' ("
            "id UInt64, event_time DateTime, a String, "
            "m String MATERIALIZED concat(a, '_m'), al String ALIAS concat(a, '_al'), "
            "d String DEFAULT 'dflt', b String"
            ") ENGINE = ReplicatedMergeTree "
            "PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)"
        )
        for node in nodes:
            wait_for_table(node, DATABASE, table)
        shard1.execute(
            f"INSERT INTO {fqn} (id, event_time, a, d, b) VALUES "
            "(1, '2026-01-01 12:00:00', 'x', 'custom', 'bx'), "
            "(2, '2026-01-02 12:00:00', 'y', 'dflt', 'by')"
        )

        # Every client the CLI opens from here on carries the profile.
        original_get_client: Callable[..., Any] = clickhouse_connect.get_client

        def profiled_get_client(*args: Any, **kwargs: Any) -> Any:
            settings = {**(kwargs.pop("settings", None) or {}), **PROFILE_SETTINGS}
            return original_get_client(*args, **kwargs, settings=settings)

        monkeypatch.setattr(clickhouse_connect, "get_client", profiled_get_client)
        monkeypatch.chdir(tmp_path)
        (tmp_path / "schema.py").write_text(EMPTY_SCHEMA, encoding="utf-8")
        (tmp_path / "clickhouse.config.py").write_text(
            CONFIG_TEMPLATE.format(
                url=NODES[0], user=USER, password=PASSWORD, database=DATABASE, cluster=CLUSTER
            ),
            encoding="utf-8",
        )

        # Guard against a vacuous test: the profile must actually widen `*`.
        with _connect_or_fail(NODES[0]) as profiled:
            star_columns = profiled.query(f"SELECT * FROM {fqn} LIMIT 1").column_names
        assert star_columns == ["id", "event_time", "a", "m", "d", "b", "al"]

        runner = CliRunner()
        planned = _invoke_json(
            runner,
            ["plugin", "backfill", "plan", "--target", fqn,
             "--from", "2026-01-01T00:00:00.000Z", "--to", "2026-01-03T00:00:00.000Z", "--json"],
        )
        assert planned["strategy"] == "copy"
        ran = _invoke_json(
            runner,
            ["plugin", "backfill", "run", "--plan-id", planned["planId"],
             "--poll-interval", "500", "--json"],
        )
        assert ran["status"] == "completed"

        # Both shard-1 replicas hold the doubled rows; shard 2 never had any.
        for index, node in enumerate(nodes):
            expected = EXPECTED_SHARD1_ROWS if index < SHARD1_REPLICAS else []
            rows = _poll_rows(node, fqn, expected)
            assert rows == expected, NODES[index]
    finally:
        shard1.execute(f"DROP TABLE IF EXISTS {fqn} ON CLUSTER '{CLUSTER}' SYNC")
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


def _invoke_json(runner: CliRunner, args: list[str]) -> dict[str, Any]:
    result = runner.invoke(app, args)
    assert result.exit_code == 0, result.output
    payload: dict[str, Any] = json.loads(result.output)
    return payload


def _poll_rows(
    node: ClickHouseClient, fqn: str, expected: list[dict[str, str]]
) -> list[dict[str, str]]:
    def read() -> list[dict[str, str]]:
        return _read_rows(node, fqn)

    def done(rows: list[dict[str, str]]) -> bool:
        return rows == expected

    return poll_until(read, done)


def _read_rows(node: ClickHouseClient, fqn: str) -> list[dict[str, str]]:
    rows = node.query(
        f"SELECT toString(id) AS id, a, m, al, d, b, toString(count()) AS copies "
        f"FROM {fqn} GROUP BY id, a, m, al, d, b ORDER BY id"
    ).rows
    return [{key: str(value) for key, value in row.items()} for row in rows]
