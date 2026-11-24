"""1:1 port of ``packages/plugin-backfill/src/async-backfill-parallel-replicas.e2e.test.ts``.

#765: an INSERT SELECT that parallel replicas spread over the replicas of a
ReplicatedMergeTree target commits rows on the replicas while the initial
query's query_log row says it wrote none. A failure of such an attempt proves
nothing, and the chunk INSERT pins settings that keep it from running any
secondary query. The local stack's embedded Keeper and its
``parallel_replicas`` cluster (``test/infra/clickhouse.xml``) make that real,
so this always targets the local stack (``LOCAL_STACK_ENV``), also when the
rest of the suite targets ObsessionDB. Hard-fails when it is unreachable.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator
from dataclasses import dataclass

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.async_backfill import CHECKPOINT_VERSION, execute_backfill
from chkit_plugin_backfill.chunking.analyze import analyze_and_chunk
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import GenerateChunkPlanInput, QuerySettings
from chkit_plugin_backfill.plugin import _ThreadLocalExecutor
from chkit_plugin_backfill.types import BackfillProgress
from tests.e2e_testkit import LOCAL_STACK_ENV, LiveEnv, create_prefix, poll_until

SOURCE_ROWS = 200_000
# What a profile with parallel replicas sets: the INSERT runs on the replicas,
# each writing its share of the rows.
PARALLEL_REPLICAS_PROFILE = ", ".join(
    [
        "allow_experimental_parallel_reading_from_replicas = 1",
        "max_parallel_replicas = 3",
        "cluster_for_parallel_replicas = 'parallel_replicas'",
        "parallel_distributed_insert_select = 2",
        "parallel_replicas_insert_select_local_pipeline = 0",
    ]
)
PASSWORD = "chkit-pr-e2e"


def _config(env: LiveEnv) -> ChxResolvedClickHouseConfig:
    return ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=False,
    )


@dataclass
class _Ctx:
    admin: ClickHouseClient
    executor: _ThreadLocalExecutor
    prefix: str
    database: str
    source: str


@pytest.fixture(scope="module")
def ctx() -> Iterator[_Ctx]:
    prefix = create_prefix("bf_parallel_replicas")
    database = f"{prefix}db"
    user = f"{prefix}user"
    source = f"`{database}`.source"
    # DDL and counts as the stack's default user, which has no parallel replicas.
    try:
        admin = ClickHouseClient.connect(_config(LOCAL_STACK_ENV))
        admin.query("SELECT 1")
    except Exception as exc:  # connection failure must fail loudly, never skip
        pytest.fail(
            f"Failed to connect to the local test stack at {LOCAL_STACK_ENV.clickhouse_url}: {exc!r}",
            pytrace=False,
        )
    admin.execute(f"CREATE DATABASE `{database}`")
    admin.execute(
        f"CREATE TABLE {source} (id UInt64, payload String) "
        "ENGINE = ReplicatedMergeTree ORDER BY id"
    )
    admin.execute(
        f"INSERT INTO {source} SELECT number, toString(number) FROM numbers({SOURCE_ROWS})"
    )
    admin.execute(
        f"CREATE USER `{user}` IDENTIFIED WITH sha256_password BY '{PASSWORD}' "
        f"SETTINGS {PARALLEL_REPLICAS_PROFILE}"
    )
    admin.execute(f"GRANT ALL ON `{database}`.* TO `{user}`")
    admin.execute(f"GRANT SELECT ON system.* TO `{user}`")
    admin.execute(f"GRANT REMOTE ON *.* TO `{user}`")
    # Chunks run as a user whose profile has parallel replicas on.
    executor = _ThreadLocalExecutor(
        _config(
            dataclasses.replace(LOCAL_STACK_ENV, clickhouse_user=user, clickhouse_password=PASSWORD)
        )
    )

    yield _Ctx(admin=admin, executor=executor, prefix=prefix, database=database, source=source)

    executor.close()
    admin.execute(f"DROP USER IF EXISTS `{user}`")
    admin.execute(f"DROP DATABASE IF EXISTS `{database}` SYNC")
    admin.close()


def _create_target(ctx: _Ctx, name: str) -> str:
    target = f"`{ctx.database}`.`{name}`"
    ctx.admin.execute(
        f"CREATE TABLE {target} (id UInt64, payload String) "
        "ENGINE = ReplicatedMergeTree ORDER BY id"
    )
    return target


def _count_rows(ctx: _Ctx, table: str) -> int:
    rows = ctx.admin.query(f"SELECT toString(count()) AS rows FROM {table}").rows
    return int(str(rows[0]["rows"]))


def _settled_queries(ctx: _Ctx, initial_query_id: str) -> list[dict[str, object]]:
    """The outcome rows of ``initial_query_id`` and of the secondary queries it
    started, once none of them runs and query_log holds an outcome for each
    one it shows started: a reply can come before its own QueryFinish is
    logged, and a cancelled secondary can still be writing."""

    def read() -> tuple[int, list[dict[str, object]]]:
        ctx.admin.execute("SYSTEM FLUSH LOGS")
        running = ctx.admin.query(
            "SELECT toString(count()) AS running FROM system.processes "
            f"WHERE initial_query_id = '{initial_query_id}'"
        ).rows
        rows = ctx.admin.query(
            "SELECT query_id, is_initial_query, type, toString(written_rows) AS written_rows "
            f"FROM system.query_log WHERE initial_query_id = '{initial_query_id}'"
        ).rows
        return int(str(running[0]["running"])), rows

    def settled(value: tuple[int, list[dict[str, object]]]) -> bool:
        running, rows = value
        started = {row["query_id"] for row in rows if row["type"] == "QueryStart"}
        ended = {row["query_id"] for row in rows if row["type"] != "QueryStart"}
        return running == 0 and initial_query_id in ended and started <= ended

    # A query that has not started by the time the initial one logged its
    # outcome gets no work from it any more, so it cannot write.
    value = poll_until(read, settled, timeout=30.0, interval=0.5)
    assert settled(value), (
        f"queries of {initial_query_id} still running or without an outcome: {value!r}"
    )
    return [row for row in value[1] if row["type"] != "QueryStart"]


def _initial(rows: list[dict[str, object]]) -> dict[str, object]:
    return next(row for row in rows if int(str(row["is_initial_query"])) == 1)


def _secondaries(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    return [row for row in rows if int(str(row["is_initial_query"])) == 0]


def test_the_chunk_insert_runs_no_secondary_query_under_a_profile_with_parallel_replicas(
    ctx: _Ctx,
) -> None:
    # The profile spreads an unpinned INSERT over the replicas: the initial
    # query says it wrote nothing.
    control = _create_target(ctx, "control")
    control_id = f"{ctx.prefix}control"
    ctx.executor.submit(f"INSERT INTO {control} SELECT * FROM {ctx.source}", control_id)
    control_rows = _settled_queries(ctx, control_id)
    assert len(_secondaries(control_rows)) > 0
    initial = _initial(control_rows)
    assert (initial["type"], initial["written_rows"]) == ("QueryFinish", "0")
    assert _count_rows(ctx, control) == SOURCE_ROWS

    target = _create_target(ctx, "target")

    def planner_query(sql: str, settings: QuerySettings | None) -> list[dict[str, object]]:
        return ctx.admin.query(sql, dict(settings) if settings is not None else None).rows

    plan = analyze_and_chunk(
        GenerateChunkPlanInput(
            database=ctx.database,
            table="source",
            target_chunk_bytes=1 << 30,
            query=planner_query,
        )
    )
    plan_id = f"{ctx.prefix}pinned"
    chunks = {chunk.id: chunk for chunk in plan.chunks}
    result = execute_backfill(
        executor=ctx.executor,
        plan_id=plan_id,
        chunk_ids=list(chunks),
        build_query=lambda chunk_id: build_chunk_execution_sql(
            plan_id=plan_id,
            chunk=chunks[chunk_id],
            target=target,
            source_target=ctx.source,
            table=plan.table,
        ),
        poll_interval_ms=250,
    )

    assert result.failed == 0
    assert result.completed == len(chunks)
    assert _count_rows(ctx, target) == SOURCE_ROWS
    chunk_rows = [
        row
        for chunk_id in chunks
        for row in _settled_queries(ctx, f"backfill-{plan_id}-{chunk_id}")
    ]
    assert _secondaries(chunk_rows) == []
    assert sum(int(str(row["written_rows"])) for row in chunk_rows) == SOURCE_ROWS


def test_a_failed_attempt_that_ran_secondary_queries_is_not_replayed_by_replay_failed(
    ctx: _Ctx,
) -> None:
    target = _create_target(ctx, "failed")
    plan_id = f"{ctx.prefix}failed"
    chunk_id = "c0"
    query_id = f"backfill-{plan_id}-{chunk_id}"
    # Unpinned, so the profile spreads it over the replicas; it fails partway,
    # after a replica may have committed blocks the initial query does not count.
    spread_failure = (
        f"INSERT INTO {target} SELECT id, payload FROM {ctx.source} "
        "WHERE throwIf(id = 190000, 'late block') = 0 "
        "SETTINGS max_block_size = 1000, max_insert_block_size = 1000, "
        "min_insert_block_size_rows = 1000, min_insert_block_size_bytes = 0, "
        "insert_deduplicate = 0"
    )
    saved: list[BackfillProgress] = []
    with pytest.raises(Exception, match="late block"):
        execute_backfill(
            executor=ctx.executor,
            plan_id=plan_id,
            chunk_ids=[chunk_id],
            build_query=lambda _chunk_id: spread_failure,
            poll_interval_ms=100,
            on_progress=saved.append,
        )
    logged = _settled_queries(ctx, query_id)
    written = _count_rows(ctx, target)
    initial = _initial(logged)
    assert (initial["type"], initial["written_rows"]) == ("ExceptionWhileProcessing", "0")
    assert len(_secondaries(logged)) > 0
    assert saved[-1][chunk_id].query_id == query_id
    assert saved[-1][chunk_id].single_send is True

    submits: list[str] = []

    class RecordingExecutor:
        def submit(self, statement: str, query_id: str | None = None) -> str:
            submits.append(query_id or statement)
            return ctx.executor.submit(statement, query_id)

        def query(self, statement: str) -> object:
            return ctx.executor.query(statement)

    progress: list[BackfillProgress] = []
    with pytest.raises(RuntimeError) as raised:
        execute_backfill(
            executor=RecordingExecutor(),
            plan_id=plan_id,
            chunk_ids=[chunk_id],
            build_query=lambda _chunk_id: spread_failure,
            poll_interval_ms=100,
            resume_from=saved[-1],
            checkpoint_version=CHECKPOINT_VERSION,
            replay_failed=True,
            on_progress=progress.append,
        )
    assert (
        f"the outcome of the last attempt is unknown for chunk {chunk_id} "
        f"(query_id {query_id}): it ran a secondary query on another replica or shard"
    ) in str(raised.value)
    assert submits == []
    assert isinstance(progress[-1][chunk_id].secondary_query_id, str)
    assert _count_rows(ctx, target) == written
