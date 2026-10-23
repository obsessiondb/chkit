"""Port of the #278 case in ``packages/cli/test/cluster-2shard.e2e.test.ts``.

A vector_similarity index and table constraints on a ReplicatedMergeTree table,
migrated by chkit-py ``ON CLUSTER`` on the 2-shard x 2-replica cluster
(``test/cluster/2shard``, ClickHouse 25.3), then changed. On 25.3 the index
takes no dimensions argument and is still experimental: the connection enables
``allow_experimental_vector_similarity_index`` (the documented opt-in; chkit
itself sets no experimental setting). ``clickhouse-connect`` ignores URL
parameters, so the test patches ``clickhouse_connect.get_client`` the way a
settings profile would apply it.

Run explicitly after ``bun run cluster:2shard:up`` with ``pytest tests_cluster``.
Hard-fails (never skips) if a node is unreachable.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest
from tests.e2e_testkit import create_journal_table_name, create_prefix
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
EXPERIMENTAL = {"allow_experimental_vector_similarity_index": 1}
ENGINE = "ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')"

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


def _schema(table: str, index: str, constraints: str) -> str:
    return (
        "from chkit import schema, table\n\n"
        "definitions = schema(table(\n"
        f"    database={DATABASE!r}, name={table!r}, engine={ENGINE!r},\n"
        "    columns=[{'name': 'id', 'type': 'UInt64'}, {'name': 's', 'type': 'String'},\n"
        "             {'name': 'embedding', 'type': 'Array(Float32)'}],\n"
        "    primary_key=['id'], order_by=['id'],\n"
        f"    indexes=[{index}],\n"
        f"    constraints=[{constraints}],\n"
        "))\n"
    )


def test_vector_index_and_constraints_migrate_on_cluster_and_read_back_on_every_node(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_get_client: Callable[..., Any] = clickhouse_connect.get_client

    def experimental_get_client(*args: Any, **kwargs: Any) -> Any:
        settings = {**(kwargs.pop("settings", None) or {}), **EXPERIMENTAL}
        return original_get_client(*args, **kwargs, settings=settings)

    monkeypatch.setattr(clickhouse_connect, "get_client", experimental_get_client)
    nodes = [_connect_or_fail(url) for url in NODES]
    table = f"{create_prefix('py_twoshard_vec')}vectors"
    journal = create_journal_table_name("py_twoshard_vec")
    fqn = f"{DATABASE}.{table}"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal)
    runner = CliRunner()
    (tmp_path / "clickhouse.config.py").write_text(
        CONFIG_TEMPLATE.format(
            url=NODES[0], user=USER, password=PASSWORD, database=DATABASE, cluster=CLUSTER
        ),
        encoding="utf-8",
    )
    schema_path = tmp_path / "schema.py"

    def create_queries() -> list[str]:
        return [
            str(node.query(
                "SELECT create_table_query AS q FROM system.tables "
                f"WHERE database = '{DATABASE}' AND name = '{table}'"
            ).rows[0]["q"])
            for node in nodes
        ]

    def drift_clean() -> None:
        payload = _invoke_json(runner, ["drift", "--live", "--table", fqn, "--json"])
        assert payload["drifted"] is False, payload["tableDrift"]

    try:
        schema_path.write_text(_schema(
            table,
            "{'name': 'e', 'expression': 'embedding', 'type': 'vector_similarity', "
            "'method': 'hnsw', 'distanceFunction': 'L2Distance'}",
            "{'name': 'allowed', 'check': \"s IN ('a','b') AND (id+1)*2 > 0\"}, "
            "{'name': 'positive-id', 'assume': 'id > 0'}",
        ))
        _invoke_json(runner, ["generate", "--name", "init", "--json"])
        _invoke_json(runner, ["migrate", "--execute", "--json"])
        for node in nodes:
            wait_for_table(node, DATABASE, table)
        for query in create_queries():
            assert "TYPE vector_similarity('hnsw', 'L2Distance')" in query
            assert "CONSTRAINT allowed CHECK (s IN ('a', 'b')) AND (((id + 1) * 2) > 0)" in query
            assert "CONSTRAINT `positive-id` ASSUME id > 0" in query
        drift_clean()

        # Change the index tuning and the CHECK, drop the ASSUME.
        schema_path.write_text(_schema(
            table,
            "{'name': 'e', 'expression': 'embedding', 'type': 'vector_similarity', "
            "'method': 'hnsw', 'distanceFunction': 'cosineDistance', 'quantization': 'f32', "
            "'hnswMaxConnectionsPerLayer': 16, 'hnswCandidateListSizeForConstruction': 64}",
            "{'name': 'allowed', 'check': \"s IN ('a','b','c')\"}",
        ))
        planned = _invoke_json(runner, ["generate", "--dryrun", "--json"])
        on_cluster = f"ALTER TABLE {fqn} ON CLUSTER '{CLUSTER}'"
        assert [op["sql"] for op in planned["operations"]] == [
            f"{on_cluster} DROP CONSTRAINT IF EXISTS `allowed`;",
            f"{on_cluster} DROP CONSTRAINT IF EXISTS `positive-id`;",
            f"{on_cluster} DROP INDEX IF EXISTS `e`;",
            f"{on_cluster} ADD CONSTRAINT IF NOT EXISTS `allowed` CHECK s IN ('a','b','c');",
            f"{on_cluster} ADD INDEX IF NOT EXISTS `e` (embedding) TYPE "
            "vector_similarity('hnsw', 'cosineDistance', 'f32', 16, 64) GRANULARITY 100000000;",
        ]
        _invoke_json(runner, ["generate", "--name", "change", "--json"])
        _invoke_json(runner, ["migrate", "--execute", "--json"])
        for query in create_queries():
            assert "TYPE vector_similarity('hnsw', 'cosineDistance', 'f32', 16, 64)" in query
            assert "CONSTRAINT allowed CHECK s IN ('a', 'b', 'c')" in query
            assert "positive-id" not in query
        drift_clean()
        # The CHECK is enforced on a shard-2 replica.
        with pytest.raises(Exception, match="allowed"):
            nodes[3].execute(f"INSERT INTO {fqn} VALUES (1, 'z', [0.1, 0.2])")
    finally:
        nodes[0].execute(f"DROP TABLE IF EXISTS {fqn} ON CLUSTER '{CLUSTER}' SYNC")
        nodes[0].execute(f"DROP TABLE IF EXISTS {DATABASE}.`{journal}` ON CLUSTER '{CLUSTER}' SYNC")
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
