"""1:1 port of ``packages/plugin-backfill/src/async-backfill.e2e.test.ts``.

Live execute-loop coverage: drives ``execute_backfill`` against a real
cluster — submitting the chunk INSERT...SELECTs, polling ``system.processes``
/ ``system.query_log`` to completion, and verifying the data lands. Covers
the full run plus the resume and replay-failed paths, which are otherwise
only exercised against a mock executor.

Requires a reachable ClickHouse (defaults to ``http://localhost:8123``; see
``tests/e2e_testkit.py``). Hard-fails when the server is unreachable — never
skips.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.chunking.analyze import analyze_and_chunk
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import (
    ChunkPlan,
    GenerateChunkPlanInput,
    QuerySettings,
)
from chkit_plugin_backfill.plugin import _ThreadLocalExecutor
from chkit_plugin_backfill.types import BackfillChunkState, BackfillProgress
from tests.e2e_testkit import LiveEnv, create_prefix, resolve_live_env

SOURCE_ROWS = 2000


def _clickhouse_config(env: LiveEnv) -> ChxResolvedClickHouseConfig:
    return ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https"),
    )


def _connect_or_fail(
    config: ChxResolvedClickHouseConfig, env: LiveEnv
) -> ClickHouseClient:
    """Hard-fail (never skip) when ClickHouse is unreachable."""
    try:
        client = ClickHouseClient.connect(config)
        client.query("SELECT 1")
    except Exception as exc:  # connection failure must fail loudly, never skip
        pytest.fail(
            f"Failed to connect to ClickHouse at {env.clickhouse_url} "
            f"(user={env.clickhouse_user}, database={env.clickhouse_database}). "
            f"Set CLICKHOUSE_URL/CLICKHOUSE_PASSWORD to override defaults. "
            f"Original error: {exc!r}",
            pytrace=False,
        )
    return client


def _wait_for_table(
    ddl: ClickHouseClient, database: str, table: str, timeout_s: float = 30.0
) -> None:
    """State-based poll for eventually-consistent DDL (TS ``waitForTable``)."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        rows = ddl.query(
            "SELECT name FROM system.tables "
            f"WHERE database = '{database}' AND name = '{table}'"
        ).rows
        if rows:
            return
        time.sleep(0.25)
    msg = f"Table {database}.{table} did not appear within {timeout_s}s"
    raise AssertionError(msg)


def _table_ddl(fqn: str) -> str:
    return f"""
    CREATE TABLE IF NOT EXISTS {fqn} (
      id UInt64,
      bucket UInt8,
      payload String
    ) ENGINE = MergeTree()
    PARTITION BY bucket
    ORDER BY id
    """


@dataclass
class _ExecContext:
    ddl: ClickHouseClient
    run_executor: _ThreadLocalExecutor
    db: str
    source_table: str
    source_fqn: str
    target_fqn: str
    plan: ChunkPlan


def _count_rows(ddl: ClickHouseClient, fqn: str) -> int:
    rows = ddl.query(
        f"SELECT count() AS cnt FROM {fqn} SETTINGS select_sequential_consistency = 1"
    ).rows
    return int(rows[0]["cnt"]) if rows else 0


def _sql_for_chunk(ctx: _ExecContext, chunk_id: str) -> str:
    chunk = next(
        (candidate for candidate in ctx.plan.chunks if candidate.id == chunk_id), None
    )
    if chunk is None:
        msg = f"Chunk {chunk_id} is not part of the plan"
        raise AssertionError(msg)
    return build_chunk_execution_sql(
        plan_id=ctx.plan.plan_id,
        chunk=chunk,
        target=ctx.target_fqn,
        source_target=ctx.source_fqn,
        table=ctx.plan.table,
    )


@pytest.fixture(scope="module")
def exec_ctx() -> Iterator[_ExecContext]:
    env = resolve_live_env()
    config = _clickhouse_config(env)
    # DDL / inserts / counts go through the session-bound client (sequential).
    ddl = _connect_or_fail(config, env)
    # The execute loop submits + polls in parallel; per-thread connections avoid
    # session-locking errors under concurrency.
    run_executor = _ThreadLocalExecutor(config)

    db = env.clickhouse_database
    prefix = create_prefix("backfill_exec")
    source_table = f"{prefix}source"
    source_fqn = f"{db}.{source_table}"
    target_fqn = f"{db}.{prefix}target"

    ddl.execute(_table_ddl(source_fqn))
    ddl.execute(_table_ddl(target_fqn))
    _wait_for_table(ddl, db, source_table)
    _wait_for_table(ddl, db, f"{prefix}target")

    rows = [{"id": i, "bucket": i % 4, "payload": "x" * 256} for i in range(SOURCE_ROWS)]
    ddl.insert(source_fqn, rows)

    # Target a few chunks per run so resume/replay operate on more than one chunk.
    bytes_rows = ddl.query(
        "SELECT toString(sum(data_uncompressed_bytes)) AS total\n"
        "    FROM system.parts\n"
        f"    WHERE database = '{db}' AND table = '{source_table}' AND active = 1\n"
        "    SETTINGS select_sequential_consistency = 1"
    ).rows
    uncompressed_bytes = int(float(bytes_rows[0]["total"])) if bytes_rows else 0
    target_chunk_bytes = max(1, uncompressed_bytes // 4)

    def planner_query(
        sql: str, settings: QuerySettings | None
    ) -> list[dict[str, object]]:
        return ddl.query(sql, dict(settings) if settings is not None else None).rows

    plan = analyze_and_chunk(
        GenerateChunkPlanInput(
            database=db,
            table=source_table,
            target_chunk_bytes=target_chunk_bytes,
            query=planner_query,
            query_settings={"enable_parallel_replicas": 0},
        )
    )

    yield _ExecContext(
        ddl=ddl,
        run_executor=run_executor,
        db=db,
        source_table=source_table,
        source_fqn=source_fqn,
        target_fqn=target_fqn,
        plan=plan,
    )

    ddl.execute(f"DROP TABLE IF EXISTS {source_fqn}")
    ddl.execute(f"DROP TABLE IF EXISTS {target_fqn}")
    run_executor.close()
    ddl.close()


def test_produces_a_multi_chunk_plan_to_exercise_the_loop(
    exec_ctx: _ExecContext,
) -> None:
    assert len(exec_ctx.plan.chunks) > 1


def test_full_backfill_copies_every_source_row_into_the_target(
    exec_ctx: _ExecContext,
) -> None:
    exec_ctx.ddl.execute(f"TRUNCATE TABLE {exec_ctx.target_fqn}")

    result = execute_backfill(
        executor=exec_ctx.run_executor,
        plan_id=f"{exec_ctx.plan.plan_id}-full",
        chunk_ids=[chunk.id for chunk in exec_ctx.plan.chunks],
        build_query=lambda chunk_id: _sql_for_chunk(exec_ctx, chunk_id),
        concurrency=3,
        poll_interval_ms=1500,
    )

    assert result.total == len(exec_ctx.plan.chunks)
    assert result.failed == 0
    assert result.completed == len(exec_ctx.plan.chunks)

    assert _count_rows(exec_ctx.ddl, exec_ctx.source_fqn) == SOURCE_ROWS
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) == SOURCE_ROWS


def test_resume_skips_already_completed_chunks_without_re_inserting_them(
    exec_ctx: _ExecContext,
) -> None:
    exec_ctx.ddl.execute(f"TRUNCATE TABLE {exec_ctx.target_fqn}")

    # Simulate a prior run that finished exactly the first chunk: insert its
    # rows out-of-band and mark it done in the resume checkpoint.
    assert len(exec_ctx.plan.chunks) > 0, "plan produced no chunks"
    first_chunk_id = exec_ctx.plan.chunks[0].id
    exec_ctx.ddl.execute(_sql_for_chunk(exec_ctx, first_chunk_id))
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) > 0

    resume_from: BackfillProgress = {
        first_chunk_id: BackfillChunkState(status="done")
    }

    result = execute_backfill(
        executor=exec_ctx.run_executor,
        plan_id=f"{exec_ctx.plan.plan_id}-resume",
        chunk_ids=[chunk.id for chunk in exec_ctx.plan.chunks],
        build_query=lambda chunk_id: _sql_for_chunk(exec_ctx, chunk_id),
        concurrency=3,
        poll_interval_ms=1500,
        resume_from=resume_from,
    )

    assert result.failed == 0
    assert result.completed == len(exec_ctx.plan.chunks)
    # Re-running the first chunk would push the target above the source count;
    # an exact match proves it was skipped, not duplicated.
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) == SOURCE_ROWS


def test_replay_failed_re_runs_a_failed_chunk_and_restores_the_full_row_count(
    exec_ctx: _ExecContext,
) -> None:
    exec_ctx.ddl.execute(f"TRUNCATE TABLE {exec_ctx.target_fqn}")

    # Simulate a prior run where every chunk except the first one succeeded.
    chunk_ids = [chunk.id for chunk in exec_ctx.plan.chunks]
    assert len(chunk_ids) > 0, "plan produced no chunks"
    failed_id = chunk_ids[0]
    succeeded_ids = chunk_ids[1:]
    assert len(succeeded_ids) > 0

    for chunk_id in succeeded_ids:
        exec_ctx.ddl.execute(_sql_for_chunk(exec_ctx, chunk_id))
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) < SOURCE_ROWS

    resume_from: BackfillProgress = {
        failed_id: BackfillChunkState(status="failed", error="simulated failure"),
        **{
            chunk_id: BackfillChunkState(status="done")
            for chunk_id in succeeded_ids
        },
    }

    result = execute_backfill(
        executor=exec_ctx.run_executor,
        plan_id=f"{exec_ctx.plan.plan_id}-replay",
        chunk_ids=chunk_ids,
        build_query=lambda chunk_id: _sql_for_chunk(exec_ctx, chunk_id),
        concurrency=3,
        poll_interval_ms=1500,
        resume_from=resume_from,
        replay_failed=True,
    )

    assert result.failed == 0
    assert result.completed == len(exec_ctx.plan.chunks)
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) == SOURCE_ROWS
