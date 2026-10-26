"""Zero-downtime cutover (#202) on the 2-shard x 2-replica cluster.

Port of ``packages/cli/test/cluster-2shard-cutover.e2e.test.ts``: the keep and
retry scenarios of ``tests/test_cutover_e2e.py`` with ``clickhouse.cluster``
set, ReplicatedMergeTree tables, and writers inserting into both shards. The
backfill copy is refused with ``clickhouse.cluster``.

Like the TS cluster suites this lives outside the default test path: run it
explicitly after ``bun run cluster:2shard:up`` with ``pytest tests_cluster``.
Hard-fails (never skips) if a node is unreachable.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from tests.cutover_scenario import (
    CutoverTarget,
    cli,
    create_cutover_project,
    drop_cutover_project,
    run_keep_scenario,
    run_retry_scenario,
    write_schema,
)

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig

NODES = (
    os.environ.get("CHKIT_CLUSTER_2S_NODES")
    or "http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136"
).split(",")
CLUSTER = os.environ.get("CHKIT_CLUSTER_2S") or "test_cluster_2s"
USER = os.environ.get("CLICKHOUSE_USER") or "default"
PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD") or "clusterpass"
DATABASE = os.environ.get("CLICKHOUSE_DB") or "default"
# {uuid} keeps the replication path unchanged by the swap, so drift stays clean.
ENGINE = "ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')"


def _config(url: str) -> ChxResolvedClickHouseConfig:
    return ChxResolvedClickHouseConfig(
        url=url, username=USER, password=PASSWORD, database=DATABASE, secure=False
    )


@pytest.fixture
def target(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[CutoverTarget]:
    try:
        admin = ClickHouseClient.connect(_config(NODES[0]))
        admin.query("SELECT 1")
    except Exception as exc:  # never skip on an unreachable cluster
        pytest.fail(f"2-shard cluster unreachable at {NODES[0]}: {exc!r}", pytrace=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CI", "1")
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", "")

    # cluster() reads any replica of a shard, which may not have fetched the
    # last parts the writers inserted on the other one yet.
    def settle(tables: list[str]) -> None:
        for table in tables:
            admin.execute(
                f"SYSTEM SYNC REPLICA ON CLUSTER '{CLUSTER}' {DATABASE}.{table} LIGHTWEIGHT"
            )

    yield CutoverTarget(
        database=DATABASE,
        connection={
            "url": NODES[0],
            "username": USER,
            "password": PASSWORD,
            "database": DATABASE,
            "cluster": CLUSTER,
        },
        admin=admin,
        # A shard-1 node and a shard-2 node: writers insert into both shards.
        writer_configs=[_config(NODES[0]), _config(NODES[2])],
        engine=ENGINE,
        rows_of=lambda table: f"cluster('{CLUSTER}', {DATABASE}, {table})",
        read_settings="",
        settle=settle,
    )
    admin.close()


def test_keeps_every_row_on_both_shards_while_writers_insert(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_keep_scenario(target, "cutover_keep_2s", tmp_path)


def test_resumes_after_a_failure_at_every_step_on_both_shards(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_retry_scenario(target, "cutover_retry_2s", tmp_path)


def test_refuses_the_backfill_copy_with_a_cluster(target: CutoverTarget, tmp_path: Path) -> None:
    project = create_cutover_project(target, "cutover_backfill_2s", tmp_path)
    try:
        write_schema(target, project, ["user_id", "id"])
        refused = cli(
            [
                "generate",
                "--name",
                "cutover",
                "--cutover",
                f"{DATABASE}.{project.table}=id",
                "--cutover-copy",
                "backfill",
                "--json",
            ]
        )
        assert refused.exit_code == 1, refused.output
        assert "--cutover-copy backfill is not supported with clickhouse.cluster" in refused.output
    finally:
        drop_cutover_project(target, project)
