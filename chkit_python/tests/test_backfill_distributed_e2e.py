"""1:1 port of ``packages/plugin-backfill/src/async-backfill-distributed.e2e.test.ts``.

A chunk INSERT into a Distributed table used to return once its rows were
queued on the initiator for background delivery (distributed_foreground_insert
= 0 by default), so the chunk was checkpointed done before any row reached a
shard. The local stack's one-node ``cluster`` (test/infra/clickhouse.xml)
writes its local shard in place, so the chunk runs with
prefer_localhost_replica = 0, as a profile could set it, and delivery is
stopped: rows that go through the queue stay in it. ObsessionDB has no shards
and no Distributed grant, so there a chunk into a plain table checks that the
server takes the pinned settings.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import Chunk, TableProfile
from chkit_plugin_backfill.plugin import _ThreadLocalExecutor
from tests.e2e_testkit import create_prefix, poll_until, quote_ident, resolve_live_env
from tests.test_backfill_async_e2e import _clickhouse_config, _connect_or_fail

ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"
CLUSTER = "cluster"
SOURCE_ROWS = 1000

CHUNK = Chunk.model_validate(
    {
        "id": "all-0",
        "partitionId": "all",
        "ranges": [],
        "estimate": {
            "rows": SOURCE_ROWS,
            "bytesCompressed": 0,
            "bytesUncompressed": 0,
            "confidence": "exact",
            "reason": "exact-count",
        },
        "analysis": {"lineage": []},
    }
)


class _Ctx:
    def __init__(self, ddl: ClickHouseClient, run_executor: _ThreadLocalExecutor, database: str, prefix: str) -> None:
        self.ddl = ddl
        self.run_executor = run_executor
        self.database = database
        self.prefix = prefix

    def fqn(self, table: str) -> str:
        return f"{quote_ident(self.database)}.{quote_ident(self.prefix + table)}"

    def count_rows(self, table: str) -> int:
        rows = self.ddl.query(f"SELECT toString(count()) AS cnt FROM {self.fqn(table)}").rows
        return int(rows[0]["cnt"]) if rows else 0


@pytest.fixture(scope="module")
def ctx() -> Iterator[_Ctx]:
    env = resolve_live_env()
    config = _clickhouse_config(env)
    ddl = _connect_or_fail(config, env)
    context = _Ctx(ddl, _ThreadLocalExecutor(config), env.clickhouse_database, create_prefix("backfill_dist"))
    ddl.execute(f"CREATE TABLE {context.fqn('source')} (id UInt64) ENGINE = MergeTree ORDER BY id")
    ddl.execute(f"INSERT INTO {context.fqn('source')} SELECT number FROM numbers({SOURCE_ROWS})")
    ddl.execute(f"CREATE TABLE {context.fqn('local')} (id UInt64) ENGINE = MergeTree ORDER BY id")
    if not ON_OBSESSIONDB:
        ddl.execute(
            f"CREATE TABLE {context.fqn('dist')} AS {context.fqn('local')} ENGINE = Distributed("
            f"{CLUSTER}, {quote_ident(context.database)}, {quote_ident(context.prefix + 'local')}, rand())"
        )
        ddl.execute(f"SYSTEM STOP DISTRIBUTED SENDS {context.fqn('dist')}")
    yield context
    for table in ("dist", "local", "source"):
        ddl.execute(f"DROP TABLE IF EXISTS {context.fqn(table)} SYNC")
    context.run_executor.close()
    ddl.close()


def test_a_chunk_is_done_only_once_its_rows_reached_the_shards(ctx: _Ctx) -> None:
    target = "local" if ON_OBSESSIONDB else "dist"
    plan_id = f"{ctx.prefix}plan"
    suffix = "" if ON_OBSESSIONDB else ", prefer_localhost_replica = 0"
    result = execute_backfill(
        executor=ctx.run_executor,
        plan_id=plan_id,
        chunk_ids=[CHUNK.id],
        build_query=lambda _chunk_id: build_chunk_execution_sql(
            plan_id=plan_id,
            chunk=CHUNK,
            target=ctx.fqn(target),
            source_target=ctx.fqn("source"),
            table=TableProfile.model_validate({"database": ctx.database, "table": ctx.prefix + target, "sortKeys": []}),
        )
        + suffix,
        concurrency=1,
        poll_interval_ms=500,
    )
    assert result.failed == 0
    assert result.completed == 1
    assert result.progress[CHUNK.id].status == "done"

    if not ON_OBSESSIONDB:
        queue = ctx.ddl.query(
            "SELECT toString(sum(data_files)) AS files FROM system.distribution_queue "
            f"WHERE database = '{ctx.database}' AND table = '{ctx.prefix}dist'"
        ).rows
        files = int(queue[0]["files"]) if queue else 0
        assert files == 0, "files still queued for background delivery once the chunk is done"
    assert poll_until(lambda: ctx.count_rows("local"), lambda rows: rows == SOURCE_ROWS) == SOURCE_ROWS
