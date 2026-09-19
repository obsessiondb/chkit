"""Tests for ``chkit_plugin_backfill.planner`` orchestration.

1:1 port of ``packages/plugin-backfill/src/planner.test.ts`` (the top-level
``buildBackfillPlan`` suite, not ``chunking/planner``).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit_plugin_backfill.chunking.sql import (
    build_chunk_execution_sql,
    rewrite_select_columns,
)
from chkit_plugin_backfill.chunking.types import PlannerQuery, QuerySettings
from chkit_plugin_backfill.chunking.utils.ids import generate_idempotency_token
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.options import PlanOptions
from chkit_plugin_backfill.planner import build_backfill_plan
from chkit_plugin_backfill.state import (
    backfill_paths,
    compute_backfill_state_dir,
    read_plan,
)

# ---------- helpers ----------


def _resolve_config(meta_dir: str = "./chkit/meta") -> ChxResolvedConfig:
    """Mirror of TS ``resolveConfig({schema: './schema.ts', metaDir: './chkit/meta'})``."""
    return ChxResolvedConfig(
        schema_=["./schema.py"],
        out_dir="./chkit/out",
        migrations_dir="./chkit/migrations",
        meta_dir=meta_dir,
        check=ChxResolvedCheckConfig(
            fail_on_pending=False,
            fail_on_checksum_mismatch=True,
            fail_on_drift=False,
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


def _create_mock_query(
    *,
    partitions: list[dict[str, str]] | None = None,
    sorting_key: str = "event_time",
    column_rows: list[dict[str, str]] | None = None,
) -> PlannerQuery:
    resolved_partitions = (
        partitions
        if partitions is not None
        else [
            {
                "partition_id": "202601",
                "total_rows": "1000",
                "total_bytes": "500000",
                "total_uncompressed_bytes": "1000000",
                "min_time": "2026-01-01 00:00:00",
                "max_time": "2026-01-01 18:00:00",
            }
        ]
    )
    resolved_columns = (
        column_rows
        if column_rows is not None
        else [{"name": "event_time", "type": "DateTime"}]
    )

    def query(sql: str, settings: QuerySettings | None) -> list[dict[str, object]]:
        _ = settings
        if "SELECT 1 FROM" in sql:
            return [{"ok": 1}]
        if "FROM system.parts" in sql:
            return [dict(row) for row in resolved_partitions]
        if "FROM system.tables" in sql:
            return [{"sorting_key": sorting_key}]
        if "FROM system.columns" in sql:
            return [dict(row) for row in resolved_columns]
        return []

    return query


def _create_source_scoped_mock_query(
    *,
    source_table: str,
    partitions: list[dict[str, str]] | None = None,
    sorting_key: str = "id",
    column_rows: list[dict[str, str]] | None = None,
) -> PlannerQuery:
    """A mock that only knows about ``source_table``: every introspection query
    scoped to any other table (e.g. the empty aggregate target) returns no
    rows. This lets a test assert that mv_replay planning introspects the MV
    *source* and not the target.
    """
    resolved_partitions = (
        partitions
        if partitions is not None
        else [
            {
                "partition_id": "202606",
                "total_rows": "1000",
                "total_bytes": "500000",
                "total_uncompressed_bytes": "1000000",
                "min_time": "2026-06-01 00:00:00",
                "max_time": "2026-06-30 18:00:00",
            }
        ]
    )
    resolved_columns = (
        column_rows if column_rows is not None else [{"name": "id", "type": "UInt64"}]
    )

    def query(sql: str, settings: QuerySettings | None) -> list[dict[str, object]]:
        _ = settings
        if "SELECT 1 FROM" in sql:
            return [{"ok": 1}]
        if "FROM system.parts" in sql and f"table = '{source_table}'" in sql:
            return [dict(row) for row in resolved_partitions]
        if "FROM system.tables" in sql and f"name = '{source_table}'" in sql:
            return [{"sorting_key": sorting_key}]
        if "FROM system.columns" in sql and f"table = '{source_table}'" in sql:
            return [dict(row) for row in resolved_columns]
        return []

    return query


MV_REPLAY_SCHEMA = """
from chkit import ColumnDefinition, materialized_view, table

events_target = table(
    database="app",
    name="events_agg",
    columns=[
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="count", type="UInt64"),
    ],
    engine="SummingMergeTree",
    primary_key=["id"],
    order_by=["id"],
)

events_mv = materialized_view(
    database="app",
    name="events_mv",
    to={"database": "app", "name": "events_agg"},
    as_="SELECT id, count() AS count FROM app.raw_events GROUP BY id",
)
"""


# ---------- tests ----------


def test_each_plan_gets_a_unique_random_id_and_canonical_chunk_plan(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    config = _resolve_config()
    opts = PlanOptions.model_validate(
        {
            "target": "app.events",
            "from": "2026-01-01T00:00:00.000Z",
            "to": "2026-01-01T18:00:00.000Z",
        }
    )
    mock_query = _create_mock_query(
        partitions=[
            {
                "partition_id": "202601a",
                "total_rows": "500",
                "total_bytes": "250000",
                "total_uncompressed_bytes": "500000",
                "min_time": "2026-01-01 00:00:00",
                "max_time": "2026-01-01 06:00:00",
            },
            {
                "partition_id": "202601b",
                "total_rows": "500",
                "total_bytes": "250000",
                "total_uncompressed_bytes": "500000",
                "min_time": "2026-01-01 06:00:00",
                "max_time": "2026-01-01 12:00:00",
            },
            {
                "partition_id": "202601c",
                "total_rows": "500",
                "total_bytes": "250000",
                "total_uncompressed_bytes": "500000",
                "min_time": "2026-01-01 12:00:00",
                "max_time": "2026-01-01 18:00:00",
            },
        ]
    )

    first = build_backfill_plan(
        opts=opts, config_path=config_path, config=config, clickhouse_query=mock_query
    )
    second = build_backfill_plan(
        opts=opts, config_path=config_path, config=config, clickhouse_query=mock_query
    )

    assert first.plan.plan_id != second.plan.plan_id
    assert re.fullmatch(r"[a-f0-9]{16}", first.plan.plan_id) is not None
    assert len(first.plan.chunk_plan.chunks) == 3

    chunk = first.plan.chunk_plan.chunks[0]
    token = generate_idempotency_token(first.plan.plan_id, chunk.id)
    sql = build_chunk_execution_sql(
        plan_id=first.plan.plan_id,
        chunk=chunk,
        target=first.plan.target,
        source_target=first.plan.execution.source_target,
        table=first.plan.chunk_plan.table,
        idempotency_token=token,
    )

    assert len(token) == 64
    assert "INSERT INTO app.events" in sql
    assert f"insert_deduplication_token='{token}'" in sql


def test_writes_immutable_plan_state_to_plans_directory(tmp_path: Path) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    config = _resolve_config()
    opts = PlanOptions.model_validate({"target": "app.events"})

    output = build_backfill_plan(
        opts=opts,
        config_path=config_path,
        config=config,
        clickhouse_query=_create_mock_query(),
    )

    raw = Path(output.plan_path).read_text(encoding="utf-8")
    persisted = json.loads(raw)
    assert persisted["planId"] == output.plan.plan_id
    assert len(persisted["chunkPlan"]["chunks"]) == 1
    assert "/plans/" in output.plan_path.replace("\\", "/")


def test_detects_sort_key_column_from_clickhouse_metadata(tmp_path: Path) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    config = _resolve_config()
    opts = PlanOptions.model_validate({"target": "app.events"})

    output = build_backfill_plan(
        opts=opts,
        config_path=config_path,
        config=config,
        clickhouse_query=_create_mock_query(
            sorting_key="session_date",
            column_rows=[{"name": "session_date", "type": "Date"}],
        ),
    )

    assert output.plan.chunk_plan.table.sort_keys[0].name == "session_date"
    assert output.plan.chunk_plan.table.sort_keys[0].category == "datetime"
    assert output.plan.options.sort_key_column == "session_date"


def test_computes_state_dir_from_config_by_default_and_plugin_override() -> None:
    config = _resolve_config()
    config_path = "/tmp/project/clickhouse.config.py"

    default_dir = compute_backfill_state_dir(config, config_path)
    overridden_dir = compute_backfill_state_dir(config, config_path, "./custom-state")

    assert default_dir == Path("/tmp/project/chkit/meta/backfill").resolve()
    assert overridden_dir == Path("/tmp/project/custom-state").resolve()


def test_generates_mv_replay_execution_metadata_and_sql_when_schema_contains_mv(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    schema_path = tmp_path / "schema.py"
    schema_path.write_text(
        """
from chkit import ColumnDefinition, materialized_view, table

events_target = table(
    database="app",
    name="events_agg",
    columns=[
        ColumnDefinition(name="event_time", type="DateTime"),
        ColumnDefinition(name="count", type="UInt64"),
    ],
    engine="MergeTree",
    primary_key=["event_time"],
    order_by=["event_time"],
)

events_mv = materialized_view(
    database="app",
    name="events_mv",
    to={"database": "app", "name": "events_agg"},
    as_=(
        "SELECT toStartOfHour(event_time) AS event_time, count() AS count "
        "FROM app.events GROUP BY event_time"
    ),
)
""",
        encoding="utf-8",
    )

    config = _resolve_config()
    opts = PlanOptions.model_validate({"target": "app.events_agg"})
    output = build_backfill_plan(
        opts=opts,
        config_path=config_path,
        config=config,
        clickhouse_query=_create_mock_query(),
    )

    assert output.plan.execution.mode == "mv_replay"

    chunk = output.plan.chunk_plan.chunks[0]
    sql = build_chunk_execution_sql(
        plan_id=output.plan.plan_id,
        chunk=chunk,
        target=output.plan.target,
        source_target=output.plan.execution.source_target,
        table=output.plan.chunk_plan.table,
        mv_replay_queries=output.plan.execution.mv_replay_queries,
        target_columns=output.plan.execution.target_columns,
        idempotency_token=generate_idempotency_token(output.plan.plan_id, chunk.id),
    )

    assert "INSERT INTO app.events_agg" in sql
    assert "SELECT toStartOfHour(event_time)" in sql
    assert "FROM app.events" in sql
    assert "GROUP BY event_time" in sql
    assert "SETTINGS async_insert=0" in sql
    assert "FROM app.events_agg" not in sql
    # Single MV: no UNION ALL, output identical to prior behavior.
    assert "UNION ALL" not in sql


def test_replays_every_mv_feeding_the_target_via_union_all_when_multiple_mvs_exist(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    schema_path = tmp_path / "schema.py"
    schema_path.write_text(
        """
from chkit import ColumnDefinition, materialized_view, table

events_target = table(
    database="app",
    name="events_agg",
    columns=[
        ColumnDefinition(name="event_time", type="DateTime"),
        ColumnDefinition(name="count", type="UInt64"),
    ],
    engine="MergeTree",
    primary_key=["event_time"],
    order_by=["event_time"],
)

web_mv = materialized_view(
    database="app",
    name="web_mv",
    to={"database": "app", "name": "events_agg"},
    as_=(
        "SELECT toStartOfHour(event_time) AS event_time, count() AS count "
        "FROM app.web_events GROUP BY event_time"
    ),
)

api_mv = materialized_view(
    database="app",
    name="api_mv",
    to={"database": "app", "name": "events_agg"},
    as_=(
        "SELECT toStartOfHour(event_time) AS event_time, count() AS count "
        "FROM app.api_events GROUP BY event_time"
    ),
)
""",
        encoding="utf-8",
    )

    config = _resolve_config()
    opts = PlanOptions.model_validate({"target": "app.events_agg"})
    output = build_backfill_plan(
        opts=opts,
        config_path=config_path,
        config=config,
        clickhouse_query=_create_mock_query(),
    )

    assert output.plan.execution.mode == "mv_replay"
    assert output.plan.execution.mv_replay_queries is not None
    assert len(output.plan.execution.mv_replay_queries) == 2

    chunk = output.plan.chunk_plan.chunks[0]
    sql = build_chunk_execution_sql(
        plan_id=output.plan.plan_id,
        chunk=chunk,
        target=output.plan.target,
        source_target=output.plan.execution.source_target,
        table=output.plan.chunk_plan.table,
        mv_replay_queries=output.plan.execution.mv_replay_queries,
        target_columns=output.plan.execution.target_columns,
        idempotency_token=generate_idempotency_token(output.plan.plan_id, chunk.id),
    )

    # Both source tables are replayed, joined by a single UNION ALL, under one INSERT.
    assert sql.count("INSERT INTO app.events_agg") == 1
    assert "FROM app.web_events" in sql
    assert "FROM app.api_events" in sql
    assert sql.count("UNION ALL") == 1


def test_mv_replay_rewrites_select_columns_to_match_target_table_order() -> None:
    rewritten = rewrite_select_columns(
        "SELECT *, extractAll(content, 'skill') AS skills,"
        " extractAll(content, 'cmd') AS slash_commands FROM app.raw_sessions",
        ["session_date", "session_id", "skills", "slash_commands", "ingested_at"],
    )

    assert (
        "SELECT session_date, session_id, extractAll(content, 'skill') AS skills,"
        " extractAll(content, 'cmd') AS slash_commands, ingested_at" in rewritten
    )
    assert "FROM app.raw_sessions" in rewritten


def test_mv_replay_preserves_distinct_when_rewriting_projection_columns() -> None:
    rewritten = rewrite_select_columns(
        "SELECT DISTINCT event_time AS ts, user_id AS uid FROM app.events",
        ["uid", "ts"],
    )

    assert "SELECT DISTINCT user_id AS uid, event_time AS ts" in rewritten
    assert "FROM app.events" in rewritten


def test_omits_idempotency_token_when_disabled(tmp_path: Path) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    config = _resolve_config()
    opts = PlanOptions.model_validate(
        {"target": "app.events", "requireIdempotencyToken": False}
    )
    output = build_backfill_plan(
        opts=opts,
        config_path=config_path,
        config=config,
        clickhouse_query=_create_mock_query(),
    )

    chunk = output.plan.chunk_plan.chunks[0]
    sql = build_chunk_execution_sql(
        plan_id=output.plan.plan_id,
        chunk=chunk,
        target=output.plan.target,
        source_target=output.plan.execution.source_target,
        table=output.plan.chunk_plan.table,
        idempotency_token="",
    )

    assert output.plan.execution.require_idempotency_token is False
    assert "SETTINGS async_insert=0" in sql
    assert "insert_deduplication_token" not in sql


def test_mv_replay_chunks_the_mv_source_even_when_the_target_aggregate_is_empty(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    schema_path = tmp_path / "schema.py"
    schema_path.write_text(MV_REPLAY_SCHEMA, encoding="utf-8")

    config = _resolve_config()
    opts = PlanOptions.model_validate({"target": "app.events_agg"})

    # The target (events_agg) is empty; only the MV source (raw_events) has
    # partitions. Before the fix this threw "No partitions found for
    # app.events_agg" because planning introspected the target.
    output = build_backfill_plan(
        opts=opts,
        config_path=config_path,
        config=config,
        clickhouse_query=_create_source_scoped_mock_query(source_table="raw_events"),
    )

    assert output.plan.execution.mode == "mv_replay"
    # Chunk plan is sourced from the MV's FROM table, not the target.
    assert output.plan.chunk_plan.table.database == "app"
    assert output.plan.chunk_plan.table.table == "raw_events"
    assert len(output.plan.chunk_plan.chunks) > 0

    chunk = output.plan.chunk_plan.chunks[0]
    sql = build_chunk_execution_sql(
        plan_id=output.plan.plan_id,
        chunk=chunk,
        target=output.plan.target,
        source_target=output.plan.execution.source_target,
        table=output.plan.chunk_plan.table,
        mv_replay_queries=output.plan.execution.mv_replay_queries,
        target_columns=output.plan.execution.target_columns,
        idempotency_token=generate_idempotency_token(output.plan.plan_id, chunk.id),
    )

    assert "INSERT INTO app.events_agg" in sql
    assert "FROM app.raw_events" in sql
    # Chunk conditions reference the source's real partition, not the target.
    assert "_partition_id = '202606'" in sql


def test_mv_replay_still_fails_fast_when_the_mv_source_itself_is_empty(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    schema_path = tmp_path / "schema.py"
    schema_path.write_text(MV_REPLAY_SCHEMA, encoding="utf-8")

    config = _resolve_config()
    opts = PlanOptions.model_validate({"target": "app.events_agg"})

    # No partitions for the source either — the empty-check must still guard,
    # now pointed at the source rather than the target.
    with pytest.raises(
        BackfillConfigError, match=re.escape("No partitions found for app.raw_events")
    ):
        build_backfill_plan(
            opts=opts,
            config_path=config_path,
            config=config,
            clickhouse_query=_create_source_scoped_mock_query(
                source_table="raw_events", partitions=[]
            ),
        )


def test_rejects_persisted_legacy_plans_with_an_actionable_error(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    plan_id = "deadbeefdeadbeef"

    config = _resolve_config()
    state_dir = compute_backfill_state_dir(config, config_path)
    plan_path = Path(backfill_paths(state_dir, plan_id).plan_path)
    plan_path.parent.mkdir(parents=True, exist_ok=True)

    plan_path.write_text(
        json.dumps(
            {
                "planId": plan_id,
                "target": "app.events",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "from": "2026-01-01T00:00:00.000Z",
                "to": "2026-01-01T01:00:00.000Z",
                "chunks": [],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(BackfillConfigError, match="uses a previous chunking format"):
        read_plan(plan_id=plan_id, config_path=config_path, config=config)
