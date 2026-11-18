"""1:1 port of ``packages/plugin-backfill/src/async-backfill.e2e.test.ts``.

Live execute-loop coverage: drives ``execute_backfill`` against a real
cluster — submitting the chunk INSERT...SELECTs, polling ``system.processes``
/ ``system.query_log`` to completion, and verifying the data lands. Covers
the full run plus the resume and replay-failed paths, which are otherwise
only exercised against a mock executor.

Requires a reachable ClickHouse (defaults to the local test stack on
``CHKIT_TEST_PORT``, default 8123; see ``tests/e2e_testkit.py``). Hard-fails
when the server is unreachable — never skips.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest

from chkit.clickhouse.client import ClickHouseClient, QueryStatus
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.async_backfill import BackfillResult, execute_backfill
from chkit_plugin_backfill.chunking.analyze import analyze_and_chunk
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import (
    ChunkPlan,
    GenerateChunkPlanInput,
    QuerySettings,
)
from chkit_plugin_backfill.plugin import _ThreadLocalExecutor
from chkit_plugin_backfill.types import BackfillChunkState, BackfillProgress
from tests.e2e_testkit import LiveEnv, create_prefix, poll_until, resolve_live_env

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
        poll_interval_ms=250,
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
        poll_interval_ms=250,
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
    partial = _count_rows(exec_ctx.ddl, exec_ctx.target_fqn)
    assert partial < SOURCE_ROWS

    resume_from: BackfillProgress = {
        failed_id: BackfillChunkState(status="failed", error="simulated failure"),
        **{
            chunk_id: BackfillChunkState(status="done")
            for chunk_id in succeeded_ids
        },
    }
    plan_id = f"{exec_ctx.plan.plan_id}-replay"

    def replay(*, accept_unknown: bool) -> BackfillResult:
        return execute_backfill(
            executor=exec_ctx.run_executor,
            plan_id=plan_id,
            chunk_ids=chunk_ids,
            build_query=lambda chunk_id: _sql_for_chunk(exec_ctx, chunk_id),
            concurrency=3,
            poll_interval_ms=250,
            outcome_recheck_interval_ms=200,
            resume_from=resume_from,
            replay_failed=True,
            accept_unknown=accept_unknown,
        )

    # #765: the checkpoint says failed, but the server has no row of the
    # chunk, so nothing proves it did not write its rows: no replay.
    with pytest.raises(RuntimeError) as raised:
        replay(accept_unknown=False)
    assert (
        f"the outcome of the last attempt is unknown for chunk {failed_id} (query_id "
        f"backfill-{plan_id}-{failed_id}): it is not running on any replica and "
        "system.query_log has no outcome for it."
    ) in str(raised.value)
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) == partial

    result = replay(accept_unknown=True)

    assert result.failed == 0
    assert result.completed == len(exec_ctx.plan.chunks)
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) == SOURCE_ROWS


# #765: a replay started right after the failure used to reuse the failed
# attempt's query id, so polling read that attempt's ExceptionWhileProcessing
# row in the query_log flush gap and marked the finished replay failed.
def test_a_replay_started_right_after_a_chunk_failed_ends_done(
    exec_ctx: _ExecContext,
) -> None:
    exec_ctx.ddl.execute(f"TRUNCATE TABLE {exec_ctx.target_fqn}")

    chunk_ids = [chunk.id for chunk in exec_ctx.plan.chunks]
    assert len(chunk_ids) > 0, "plan produced no chunks"
    failed_id = chunk_ids[0]
    succeeded_ids = chunk_ids[1:]
    for chunk_id in succeeded_ids:
        exec_ctx.ddl.execute(_sql_for_chunk(exec_ctx, chunk_id))

    plan_id = f"{exec_ctx.plan.plan_id}-quick-replay"
    first_id = f"backfill-{plan_id}-{failed_id}"
    # The first attempt fails while it runs, which query_log records as
    # ExceptionWhileProcessing, the row a KILL QUERY also leaves. The submit
    # fails with it (or with the reset of the started response), so the run
    # stops before it records the chunk, like the run in #765.
    with pytest.raises(Exception):  # noqa: B017, PT011
        execute_backfill(
            executor=exec_ctx.run_executor,
            plan_id=plan_id,
            chunk_ids=[failed_id],
            build_query=lambda _chunk_id: (
                "SELECT throwIf(number = 3, 'chunk failed') FROM numbers(10)"
                " SETTINGS max_block_size = 1"
            ),
            poll_interval_ms=100,
        )
    logged = poll_until(
        lambda: exec_ctx.run_executor.query_status(first_id),
        lambda status: status.status == "failed",
    )
    assert logged.status == "failed"

    # Replay at once: the failure is seconds old.
    resume_from: BackfillProgress = {
        failed_id: BackfillChunkState(status="pending"),
        **{chunk_id: BackfillChunkState(status="done") for chunk_id in succeeded_ids},
    }
    replay = execute_backfill(
        executor=exec_ctx.run_executor,
        plan_id=plan_id,
        chunk_ids=chunk_ids,
        build_query=lambda chunk_id: _sql_for_chunk(exec_ctx, chunk_id),
        poll_interval_ms=100,
        resume_from=resume_from,
        replay_failed=True,
    )

    assert replay.progress[failed_id].status == "done"
    assert replay.progress[failed_id].query_id != first_id
    assert replay.failed == 0
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) == SOURCE_ROWS


# #765: a run that dies while a replay's INSERT runs leaves the chunk pending
# under the replay's id. A resume right after the INSERT committed must find
# its outcome, not run the chunk a second time.
def test_a_resume_right_after_a_replay_committed_records_it_done(
    exec_ctx: _ExecContext,
) -> None:
    exec_ctx.ddl.execute(f"TRUNCATE TABLE {exec_ctx.target_fqn}")

    chunk_ids = [chunk.id for chunk in exec_ctx.plan.chunks]
    assert len(chunk_ids) > 0, "plan produced no chunks"
    replayed_id = chunk_ids[0]
    succeeded_ids = chunk_ids[1:]
    for chunk_id in succeeded_ids:
        exec_ctx.ddl.execute(_sql_for_chunk(exec_ctx, chunk_id))

    plan_id = f"{exec_ctx.plan.plan_id}-committed-replay"
    replay_id = f"backfill-{plan_id}-{replayed_id}-committed"
    exec_ctx.run_executor.submit(_sql_for_chunk(exec_ctx, replayed_id), replay_id)

    submits: list[str] = []

    class RecordingExecutor:
        def submit(self, statement: str, query_id: str | None = None) -> str:
            submits.append(query_id or statement)
            return exec_ctx.run_executor.submit(statement, query_id)

        def query_status(self, query_id: str, *, running_only: bool = False) -> QueryStatus:
            return exec_ctx.run_executor.query_status(query_id, running_only=running_only)

        def query(self, statement: str) -> object:
            return exec_ctx.run_executor.query(statement)

    hour_ago = datetime.now(tz=UTC) - timedelta(hours=1)
    resumed = execute_backfill(
        executor=RecordingExecutor(),
        plan_id=plan_id,
        chunk_ids=chunk_ids,
        build_query=lambda chunk_id: _sql_for_chunk(exec_ctx, chunk_id),
        poll_interval_ms=100,
        resume_from={
            replayed_id: BackfillChunkState(
                status="pending",
                query_id=replay_id,
                submitted_at=hour_ago.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            ),
            **{chunk_id: BackfillChunkState(status="done") for chunk_id in succeeded_ids},
        },
    )

    assert submits == []
    assert resumed.progress[replayed_id].status == "done"
    assert resumed.progress[replayed_id].query_id == replay_id
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) == SOURCE_ROWS


# #765: a recorded attempt that left no row in query_log (log_queries = 0
# here; a slow or disabled log does the same) may have written its rows. The
# resume stops; accept_unknown replays it under a new id.
def test_a_resume_stops_on_a_recorded_attempt_query_log_has_no_row_of(
    exec_ctx: _ExecContext,
) -> None:
    exec_ctx.ddl.execute(f"TRUNCATE TABLE {exec_ctx.target_fqn}")

    chunk_ids = [chunk.id for chunk in exec_ctx.plan.chunks]
    assert len(chunk_ids) > 0, "plan produced no chunks"
    recorded_id = chunk_ids[0]
    succeeded_ids = chunk_ids[1:]
    for chunk_id in succeeded_ids:
        exec_ctx.ddl.execute(_sql_for_chunk(exec_ctx, chunk_id))

    plan_id = f"{exec_ctx.plan.plan_id}-unlogged"
    attempt_id = f"backfill-{plan_id}-{recorded_id}-unlogged"
    exec_ctx.run_executor.submit("SELECT 1 SETTINGS log_queries = 0", attempt_id)

    submits: list[str] = []

    class RecordingExecutor:
        def submit(self, statement: str, query_id: str | None = None) -> str:
            submits.append(query_id or statement)
            return exec_ctx.run_executor.submit(statement, query_id)

        def query_status(self, query_id: str, *, running_only: bool = False) -> QueryStatus:
            return exec_ctx.run_executor.query_status(query_id, running_only=running_only)

        def query(self, statement: str) -> object:
            return exec_ctx.run_executor.query(statement)

    hour_ago = datetime.now(tz=UTC) - timedelta(hours=1)

    def resume(*, accept_unknown: bool) -> BackfillResult:
        return execute_backfill(
            executor=RecordingExecutor(),
            plan_id=plan_id,
            chunk_ids=chunk_ids,
            build_query=lambda chunk_id: _sql_for_chunk(exec_ctx, chunk_id),
            poll_interval_ms=100,
            outcome_recheck_interval_ms=200,
            accept_unknown=accept_unknown,
            resume_from={
                recorded_id: BackfillChunkState(
                    status="pending",
                    query_id=attempt_id,
                    submitted_at=hour_ago.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                ),
                **{chunk_id: BackfillChunkState(status="done") for chunk_id in succeeded_ids},
            },
        )

    with pytest.raises(RuntimeError) as raised:
        resume(accept_unknown=False)
    assert (
        f"the outcome of the last attempt is unknown for chunk {recorded_id} (query_id "
        f"{attempt_id}): it is not running on any replica and system.query_log has no "
        "outcome for it."
    ) in str(raised.value)
    assert submits == []

    accepted = resume(accept_unknown=True)

    assert len(submits) == 1
    assert submits[0] != attempt_id
    assert accepted.progress[recorded_id].status == "done"
    assert accepted.progress[recorded_id].query_id == submits[0]
    assert _count_rows(exec_ctx.ddl, exec_ctx.target_fqn) == SOURCE_ROWS
