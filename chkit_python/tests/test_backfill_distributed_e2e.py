"""1:1 port of ``packages/plugin-backfill/src/async-backfill-distributed.e2e.test.ts``.

#821: a chunk is done only once its rows are written, also downstream.

A chunk INSERT into a Distributed table used to return once its rows were
queued on the initiator for background delivery (distributed_foreground_insert
= 0 by default), so the chunk was checkpointed done before any row reached a
shard. The local stack's one-node ``cluster`` (test/infra/clickhouse.xml)
writes its local shard in place, so the chunk runs with
prefer_localhost_replica = 0, as a profile could set it, and delivery is
stopped: rows that go through the queue stay in it.

A profile with materialized_views_ignore_errors = 1 let a chunk end done
although a materialized view on its target failed to write its rows (to a
shard it could not reach, once delivery is in the foreground).

ObsessionDB has no shards, no Distributed grant and no CREATE USER, so there
the chunk goes into a plain table, and the failing view runs with the default
profile.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterator

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.async_backfill import BackfillResult, execute_backfill
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import Chunk, TableProfile
from chkit_plugin_backfill.plugin import _ThreadLocalExecutor
from chkit_plugin_backfill.types import BackfillProgress
from tests.e2e_testkit import (
    create_prefix,
    poll_until,
    quote_ident,
    resolve_live_env,
    wait_for_table_on_every_replica,
)
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
    def __init__(
        self,
        config: ChxResolvedClickHouseConfig,
        ddl: ClickHouseClient,
        run_executor: _ThreadLocalExecutor,
        prefix: str,
    ) -> None:
        self.config = config
        self.ddl = ddl
        self.run_executor = run_executor
        self.database = config.database
        self.prefix = prefix

    def fqn(self, table: str) -> str:
        return f"{quote_ident(self.database)}.{quote_ident(self.prefix + table)}"

    def count_rows(self, read: _ThreadLocalExecutor | ClickHouseClient, table: str) -> int:
        result = read.query(f"SELECT toString(count()) AS cnt FROM {self.fqn(table)}")
        rows = result.rows  # type: ignore[attr-defined]
        return int(rows[0]["cnt"]) if rows else 0

    def run_chunk(
        self,
        executor: _ThreadLocalExecutor,
        target: str,
        plan_id: str,
        extra_settings: str = "",
        on_progress: object = None,
    ) -> BackfillResult:
        return execute_backfill(
            executor=executor,
            plan_id=plan_id,
            chunk_ids=[CHUNK.id],
            build_query=lambda _chunk_id: (
                build_chunk_execution_sql(
                    plan_id=plan_id,
                    chunk=CHUNK,
                    target=self.fqn(target),
                    source_target=self.fqn("source"),
                    table=TableProfile.model_validate(
                        {"database": self.database, "table": self.prefix + target, "sortKeys": []}
                    ),
                )
                + extra_settings
            ),
            concurrency=1,
            poll_interval_ms=500,
            on_progress=on_progress,  # type: ignore[arg-type]
        )


@pytest.fixture(scope="module")
def ctx() -> Iterator[_Ctx]:
    env = resolve_live_env()
    config = _clickhouse_config(env)
    ddl = _connect_or_fail(config, env)
    context = _Ctx(config, ddl, _ThreadLocalExecutor(config), create_prefix("backfill_dist"))
    ddl.execute(f"CREATE TABLE {context.fqn('source')} (id UInt64) ENGINE = MergeTree ORDER BY id")
    ddl.execute(f"INSERT INTO {context.fqn('source')} SELECT number FROM numbers({SOURCE_ROWS})")
    ddl.execute(f"CREATE TABLE {context.fqn('local')} (id UInt64) ENGINE = MergeTree ORDER BY id")
    # A chunk that lands on a replica which cannot see the source yet copies
    # nothing and still ends done: every one of a few stateless reads sees it.
    wait_for_table_on_every_replica(ddl, context.database, context.prefix + "local")
    seen = [0]

    def read_seen() -> int:
        # A new connection per read, so each one can land on another replica.
        reader: ClickHouseClient | None = None
        try:
            reader = ClickHouseClient.connect(config)
            full = context.count_rows(reader, "source") == SOURCE_ROWS
        except Exception:  # no connection, or a replica that does not list the table yet
            full = False
        finally:
            if reader is not None:
                reader.close()
        seen[0] = seen[0] + 1 if full else 0
        return seen[0]

    assert poll_until(read_seen, lambda count: count >= 3, timeout=45, interval=0.25) >= 3
    yield context
    for table in ("dist", "mv", "sink", "mv_target", "local", "source"):
        ddl.execute(f"DROP TABLE IF EXISTS {context.fqn(table)} SYNC")
    if not ON_OBSESSIONDB:
        ddl.execute(f"DROP USER IF EXISTS {quote_ident(context.prefix + 'user')}")
    context.run_executor.close()
    ddl.close()


def test_a_chunk_into_a_distributed_table_is_done_only_once_its_rows_reached_the_shards(
    ctx: _Ctx,
) -> None:
    if not ON_OBSESSIONDB:
        ctx.ddl.execute(
            f"CREATE TABLE {ctx.fqn('dist')} AS {ctx.fqn('local')} ENGINE = Distributed("
            f"{CLUSTER}, {quote_ident(ctx.database)}, {quote_ident(ctx.prefix + 'local')}, rand())"
        )
        ctx.ddl.execute(f"SYSTEM STOP DISTRIBUTED SENDS {ctx.fqn('dist')}")
    result = ctx.run_chunk(
        ctx.run_executor,
        "local" if ON_OBSESSIONDB else "dist",
        f"{ctx.prefix}dist_plan",
        "" if ON_OBSESSIONDB else ", prefer_localhost_replica = 0",
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
    assert (
        poll_until(lambda: ctx.count_rows(ctx.ddl, "local"), lambda rows: rows == SOURCE_ROWS)
        == SOURCE_ROWS
    )


def test_a_chunk_whose_materialized_view_fails_to_write_is_not_done(ctx: _Ctx) -> None:
    ctx.ddl.execute(
        f"CREATE TABLE {ctx.fqn('mv_target')} (id UInt64) ENGINE = MergeTree ORDER BY id"
    )
    ctx.ddl.execute(f"CREATE TABLE {ctx.fqn('sink')} (id UInt64) ENGINE = MergeTree ORDER BY id")
    ctx.ddl.execute(
        f"CREATE MATERIALIZED VIEW {ctx.fqn('mv')} TO {ctx.fqn('sink')} AS "
        f"SELECT throwIf(id >= 0, 'view write failed') AS id FROM {ctx.fqn('mv_target')}"
    )
    wait_for_table_on_every_replica(ctx.ddl, ctx.database, ctx.prefix + "mv_target")
    wait_for_table_on_every_replica(ctx.ddl, ctx.database, ctx.prefix + "mv")

    executor = ctx.run_executor
    if not ON_OBSESSIONDB:
        user = quote_ident(ctx.prefix + "user")
        password = f"p_{ctx.prefix}"
        ctx.ddl.execute(
            f"CREATE USER {user} IDENTIFIED BY '{password}' SETTINGS materialized_views_ignore_errors = 1"
        )
        ctx.ddl.execute(f"GRANT ALL ON {quote_ident(ctx.database)}.* TO {user}")
        ctx.ddl.execute(f"GRANT SELECT ON system.processes TO {user}")
        ctx.ddl.execute(f"GRANT SELECT ON system.query_log TO {user}")
        executor = _ThreadLocalExecutor(
            ctx.config.model_copy(update={"username": ctx.prefix + "user", "password": password})
        )
    statuses: list[str | None] = []

    def on_progress(progress: BackfillProgress) -> None:
        state = progress.get(CHUNK.id)
        statuses.append(state.status if state is not None else None)

    # The INSERT's error can come back as its send's response, which stops the
    # run, or later through system.query_log, which records it failed.
    try:
        result = ctx.run_chunk(
            executor, "mv_target", f"{ctx.prefix}mv_plan", on_progress=on_progress
        )
        state = result.progress[CHUNK.id]
        outcome = f"run ended, chunk {state.status}: {state.error or ''}"
    except Exception as error:  # the run stopping is one of the two outcomes asserted
        outcome = f"run stopped: {error}"
    finally:
        if executor is not ctx.run_executor:
            executor.close()
    assert "done" not in statuses, f"statuses the checkpoint recorded: {statuses}"
    assert re.match(r"^(run ended, chunk failed|run stopped): [\s\S]*view write failed", outcome), (
        outcome
    )
