"""1:1 port of ``packages/plugin-backfill/src/mv-replay-plan.e2e.test.ts``.

Regression e2e for chkit#187: an mv_replay backfill of a from-scratch EMPTY
aggregate target must plan its chunks against the MV *source* (the table the
view reads), not the target. Before the fix, planning introspected the empty
target and failed with "No partitions found for <target>".

This drives the full path against a live cluster: ``build_backfill_plan``
(schema load -> MV detection -> source introspection -> chunking) followed by
``execute_backfill`` running the generated INSERT...SELECTs, then verifies the
populated target matches the forward MV output.

Requires a reachable ClickHouse (defaults to ``http://localhost:8123``; see
``tests/e2e_testkit.py``). Hard-fails when the server is unreachable — never
skips.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig, ChxUserConfig, resolve_config
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import PlannerQuery, QuerySettings
from chkit_plugin_backfill.chunking.utils.ids import generate_idempotency_token
from chkit_plugin_backfill.options import PlanOptions
from chkit_plugin_backfill.planner import build_backfill_plan
from chkit_plugin_backfill.plugin import _ThreadLocalExecutor
from tests.e2e_testkit import LiveEnv, create_prefix, resolve_live_env

SOURCE_ROWS = 4000
BUCKETS = 4


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


def _aggregate_by_bucket(
    ddl: ClickHouseClient, fqn: str, value_expr: str
) -> list[dict[str, object]]:
    return ddl.query(
        f"SELECT toString(bucket) AS bucket, toString({value_expr}) AS total\n"
        f"     FROM {fqn}\n"
        "     GROUP BY bucket\n"
        "     ORDER BY bucket\n"
        "     SETTINGS select_sequential_consistency = 1"
    ).rows


def _schema_source(db: str, source_table: str, target_table: str) -> str:
    """Self-contained schema module ``load_schema_definitions`` can import from
    a temp dir, matching the unit-test convention."""
    return f'''from chkit import materialized_view, table

events_target = table(
    database="{db}",
    name="{target_table}",
    columns=[
        {{"name": "bucket", "type": "UInt8"}},
        {{"name": "total", "type": "UInt64"}},
    ],
    engine="SummingMergeTree",
    primary_key=["bucket"],
    order_by=["bucket"],
)

events_mv = materialized_view(
    database="{db}",
    name="{source_table}_mv",
    to={{"database": "{db}", "name": "{target_table}"}},
    as_="SELECT bucket, sum(id) AS total FROM {db}.{source_table} GROUP BY bucket",
)
'''


@dataclass
class _MvReplayContext:
    ddl: ClickHouseClient
    run_executor: _ThreadLocalExecutor
    planner_query: PlannerQuery
    db: str
    source_table: str
    target_table: str
    source_fqn: str
    target_fqn: str
    config_path: Path


@pytest.fixture(scope="module")
def mv_ctx(tmp_path_factory: pytest.TempPathFactory) -> Iterator[_MvReplayContext]:
    env = resolve_live_env()
    config = _clickhouse_config(env)
    # DDL / inserts / counts go through the session-bound client (sequential).
    ddl = _connect_or_fail(config, env)
    # The execute loop submits + polls in parallel; per-thread connections avoid
    # session-locking errors under concurrency.
    run_executor = _ThreadLocalExecutor(config)

    db = env.clickhouse_database
    prefix = create_prefix("backfill_mvreplay")
    source_table = f"{prefix}source"
    target_table = f"{prefix}agg"
    source_fqn = f"{db}.{source_table}"
    target_fqn = f"{db}.{target_table}"

    # Partitioned source with real data.
    ddl.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {source_fqn} (
          id UInt64,
          bucket UInt8,
          payload String
        ) ENGINE = MergeTree()
        PARTITION BY bucket
        ORDER BY id
        """
    )
    # Aggregate target that starts EMPTY — the scenario the bug blocked.
    ddl.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {target_fqn} (
          bucket UInt8,
          total UInt64
        ) ENGINE = SummingMergeTree()
        ORDER BY bucket
        """
    )
    _wait_for_table(ddl, db, source_table)
    _wait_for_table(ddl, db, target_table)

    rows = [
        {"id": i, "bucket": i % BUCKETS, "payload": "x" * 256}
        for i in range(SOURCE_ROWS)
    ]
    ddl.insert(source_fqn, rows)

    project_dir = tmp_path_factory.mktemp("chkit-backfill-mvreplay-")
    (project_dir / "schema.py").write_text(
        _schema_source(db, source_table, target_table), encoding="utf-8"
    )
    config_path = project_dir / "clickhouse.config.py"

    def planner_query(
        sql: str, settings: QuerySettings | None
    ) -> list[dict[str, object]]:
        return ddl.query(sql, dict(settings) if settings is not None else None).rows

    yield _MvReplayContext(
        ddl=ddl,
        run_executor=run_executor,
        planner_query=planner_query,
        db=db,
        source_table=source_table,
        target_table=target_table,
        source_fqn=source_fqn,
        target_fqn=target_fqn,
        config_path=config_path,
    )

    ddl.execute(f"DROP TABLE IF EXISTS {source_fqn}")
    ddl.execute(f"DROP TABLE IF EXISTS {target_fqn}")
    run_executor.close()
    ddl.close()


def test_plans_from_the_source_then_execute_backfill_populates_the_empty_target(
    mv_ctx: _MvReplayContext,
) -> None:
    # Confirm the target really is empty before we plan against it.
    assert len(_aggregate_by_bucket(mv_ctx.ddl, mv_ctx.target_fqn, "sum(total)")) == 0

    config = resolve_config(
        ChxUserConfig.model_validate(
            {"schema": "./schema.py", "metaDir": "./chkit/meta"}
        )
    )

    # Size chunks so each source partition is one chunk (partition-aligned, no
    # intra-partition range splitting) — the same shape the copy e2e uses. This
    # keeps the test on the part the fix touches (source introspection + the
    # per-partition INSERT...SELECT) rather than the sort-key splitter.
    bytes_rows = mv_ctx.ddl.query(
        "SELECT toString(sum(data_uncompressed_bytes)) AS total\n"
        "      FROM system.parts\n"
        f"      WHERE database = '{mv_ctx.db}' AND table = '{mv_ctx.source_table}'"
        " AND active = 1\n"
        "      SETTINGS select_sequential_consistency = 1"
    ).rows
    uncompressed_bytes = int(float(bytes_rows[0]["total"])) if bytes_rows else 0
    assert uncompressed_bytes > 0

    opts = PlanOptions.model_validate(
        {"target": mv_ctx.target_fqn, "maxChunkBytes": uncompressed_bytes}
    )

    # The bug: this threw "No partitions found for <target>". Now it plans off
    # the source instead.
    output = build_backfill_plan(
        opts=opts,
        config_path=str(mv_ctx.config_path),
        config=config,
        clickhouse_query=mv_ctx.planner_query,
        query_settings={"enable_parallel_replicas": 0},
    )

    plan = output.plan
    assert plan.execution.mode == "mv_replay"
    # Chunk plan is sourced from the MV's FROM table, not the empty target.
    assert plan.chunk_plan.table.database == mv_ctx.db
    assert plan.chunk_plan.table.table == mv_ctx.source_table
    # One chunk per source partition — a real multi-chunk plan over the source.
    assert len(plan.chunk_plan.chunks) == BUCKETS

    chunk_by_id = {chunk.id: chunk for chunk in plan.chunk_plan.chunks}

    def build_query(chunk_id: str) -> str:
        plan_chunk = chunk_by_id.get(chunk_id)
        if plan_chunk is None:
            msg = f"Chunk {chunk_id} not found in plan"
            raise AssertionError(msg)
        return build_chunk_execution_sql(
            plan_id=plan.plan_id,
            chunk=plan_chunk,
            target=plan.target,
            source_target=plan.execution.source_target,
            table=plan.chunk_plan.table,
            mv_replay_queries=plan.execution.mv_replay_queries,
            target_columns=plan.execution.target_columns,
            idempotency_token=(
                generate_idempotency_token(plan.plan_id, plan_chunk.id)
                if plan.execution.require_idempotency_token
                else ""
            ),
        )

    result = execute_backfill(
        executor=mv_ctx.run_executor,
        plan_id=plan.plan_id,
        chunk_ids=[chunk.id for chunk in plan.chunk_plan.chunks],
        build_query=build_query,
        concurrency=3,
        poll_interval_ms=1500,
    )

    assert result.failed == 0
    assert result.completed == len(plan.chunk_plan.chunks)

    # Per-bucket values must match a forward run of the MV over the whole source.
    expected = _aggregate_by_bucket(mv_ctx.ddl, mv_ctx.source_fqn, "sum(id)")
    actual = _aggregate_by_bucket(mv_ctx.ddl, mv_ctx.target_fqn, "sum(total)")
    assert len(expected) == BUCKETS
    assert actual == expected
