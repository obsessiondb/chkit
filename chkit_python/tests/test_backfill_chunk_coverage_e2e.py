"""1:1 port of ``packages/plugin-backfill/src/chunking/e2e/chunk-coverage.e2e.test.ts``.

Coverage invariant (chkit#826): every source row matches exactly one chunk,
read through the SQL the run executes. A numeric bound rendered as a string
literal equal to the partition id ('3' in ``_partition_id = '3' AND id >= '3'``)
made ClickHouse's analyzer derive a string comparison on ``_partition_id``, so
the planner dropped ranges it counted as empty and the run copied 0 rows for
chunks it kept.

Requires a reachable ClickHouse (defaults to the local test stack on
``CHKIT_TEST_PORT``, default 8123; see ``tests/e2e_testkit.py``). Hard-fails
when the server is unreachable — never skips.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.chunking.planner import generate_chunk_plan
from chkit_plugin_backfill.chunking.sql import build_where_clause_from_chunk
from chkit_plugin_backfill.chunking.types import GenerateChunkPlanInput, QuerySettings
from tests.e2e_testkit import create_prefix, poll_until, resolve_live_env


@dataclass(frozen=True)
class Layout:
    name: str
    columns: str
    engine: str
    insert: str
    target_chunk_bytes: int


LAYOUTS = [
    Layout(
        name="partition id equal to the lowest sort key of the partition",
        columns="id UInt64, p UInt8, s String",
        engine="PARTITION BY p ORDER BY id",
        insert="SELECT number, number % 8, repeat('x', 200) FROM numbers(80000)",
        target_chunk_bytes=700_000,
    ),
    Layout(
        name="partition key is the leading sort key",
        columns="tenant UInt32, id UInt64, s String",
        engine="PARTITION BY tenant ORDER BY (tenant, id)",
        insert="SELECT number % 12, number, repeat('x', 200) FROM numbers(60000)",
        target_chunk_bytes=400_000,
    ),
    Layout(
        name="signed key partitioned by its sign",
        columns="id Int64, s String",
        engine="PARTITION BY id < 0 ORDER BY id",
        insert="SELECT toInt64(number) - 20000, repeat('x', 200) FROM numbers(40000)",
        target_chunk_bytes=1_000_000,
    ),
    Layout(
        name="unpartitioned numeric key",
        columns="id UInt64, s String",
        engine="ORDER BY id",
        insert="SELECT number, repeat('x', 200) FROM numbers(40000)",
        target_chunk_bytes=1_000_000,
    ),
    Layout(
        name="monthly partitions on a datetime key",
        columns="ts DateTime, id UInt64, s String",
        engine="PARTITION BY toYYYYMM(ts) ORDER BY (ts, id)",
        insert=(
            "SELECT toDateTime('2026-01-01 00:00:00') + number * 120, number, "
            "repeat('x', 200) FROM numbers(60000)"
        ),
        target_chunk_bytes=1_000_000,
    ),
    Layout(
        name="string key partitioned by a digit",
        columns="k String, p UInt8, s String",
        engine="PARTITION BY p ORDER BY k",
        insert="SELECT toString(number), number % 4, repeat('x', 200) FROM numbers(20000)",
        target_chunk_bytes=500_000,
    ),
]


@pytest.fixture
def client() -> Iterator[ClickHouseClient]:
    env = resolve_live_env()
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https"),
    )
    try:
        connected = ClickHouseClient.connect(config)
        connected.query("SELECT 1")
    except Exception as exc:  # connection failure must fail loudly, never skip
        pytest.fail(
            f"Failed to connect to ClickHouse at {env.clickhouse_url}: {exc!r}",
            pytrace=False,
        )
    yield connected
    connected.close()


@pytest.mark.parametrize("layout", LAYOUTS, ids=lambda layout: layout.name)
def test_chunk_plan_covers_every_source_row_exactly_once(
    client: ClickHouseClient, layout: Layout
) -> None:
    db = client.database
    table = f"{create_prefix('backfill_coverage')}t"
    fqn = f"{db}.{table}"

    def query(sql: str, settings: QuerySettings | None) -> list[dict[str, object]]:
        return client.query(sql, dict(settings) if settings is not None else None).rows

    def count_rows(sql: str) -> int:
        rows = client.query(f"{sql} SETTINGS select_sequential_consistency = 1").rows
        return int(str(rows[0]["cnt"])) if rows else 0

    try:
        client.execute(f"CREATE TABLE {fqn} ({layout.columns}) ENGINE = MergeTree {layout.engine}")
        wait_for_table(client, db, table)
        client.execute(f"INSERT INTO {fqn} {layout.insert}")
        total_rows = count_rows(f"SELECT count() AS cnt FROM ({layout.insert})")
        poll_until(
            lambda: count_rows(f"SELECT count() AS cnt FROM {fqn}"),
            lambda count: count == total_rows,
        )

        plan = generate_chunk_plan(
            GenerateChunkPlanInput(
                database=db,
                table=table,
                target_chunk_bytes=layout.target_chunk_bytes,
                query=query,
                query_settings={"enable_parallel_replicas": 0},
            )
        )
        assert len(plan.chunks) > 1

        predicates = [build_where_clause_from_chunk(chunk, plan.table) for chunk in plan.chunks]
        # Each chunk counted through its own WHERE, as the run's INSERT ... SELECT reads it.
        per_chunk = [
            count_rows(f"SELECT count() AS cnt FROM {fqn} WHERE {where}") for where in predicates
        ]
        assert sum(per_chunk) == total_rows

        matches = " + ".join(f"toUInt32({where.replace(chr(10), ' ')})" for where in predicates)
        not_exactly_once = count_rows(
            f"SELECT countIf(matches != 1) AS cnt FROM (SELECT {matches} AS matches FROM {fqn})"
        )
        assert not_exactly_once == 0
    finally:
        client.execute(f"DROP TABLE IF EXISTS {fqn}")
