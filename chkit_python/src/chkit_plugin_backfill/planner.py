"""``build_backfill_plan`` orchestration — port of ``packages/plugin-backfill/src/planner.ts``."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from chkit.core.model import (
    MaterializedViewDefinition,
    TableDefinition,
)
from chkit.core.schema_loader import load_schema_definitions
from chkit_plugin_backfill.chunking.boundary_codec import (
    encode_chunk_plan_for_persistence,
)
from chkit_plugin_backfill.chunking.planner import generate_chunk_plan
from chkit_plugin_backfill.chunking.types import (
    GenerateChunkPlanInput,
    PlannerQuery,
    QuerySettings,
)
from chkit_plugin_backfill.detect import find_mvs_for_target, resolve_mv_replay_source
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.options import PlanOptions
from chkit_plugin_backfill.state import (
    backfill_paths,
    compute_backfill_state_dir,
    compute_environment_fingerprint,
    now_iso,
    write_json,
)
from chkit_plugin_backfill.types import (
    BackfillExecutionPlan,
    BackfillPlanLimits,
    BackfillPlanOptions,
    BackfillPlanPolicy,
    BackfillPlanState,
)


class _PlanConfig(Protocol):
    """The slice of ``ChxResolvedConfig`` the planner needs."""

    @property
    def meta_dir(self) -> str: ...

    @property
    def schema_(self) -> list[str]: ...


@dataclass(frozen=True)
class _BackfillStrategy:
    mvs: list[MaterializedViewDefinition]
    mv_replay_queries: list[str] | None = None
    target_columns: list[str] | None = None


def _detect_backfill_strategy(
    *,
    schema: list[str],
    config_dir: Path,
    database: str,
    table: str,
) -> _BackfillStrategy:
    """Inspect the schema to decide how the target gets populated. When one or
    more materialized views feed it, this is an mv_replay backfill and their
    queries drive the insert; otherwise it's a plain copy. A schema that can't
    be loaded falls back to copy — the same lenient behaviour as TS.
    """
    try:
        definitions = load_schema_definitions(schema, cwd=config_dir)
        mvs = find_mvs_for_target(definitions, database, table)
        if len(mvs) == 0:
            return _BackfillStrategy(mvs=[])

        table_def = next(
            (
                definition
                for definition in definitions
                if isinstance(definition, TableDefinition)
                and definition.database == database
                and definition.name == table
            ),
            None,
        )
        return _BackfillStrategy(
            mvs=mvs,
            mv_replay_queries=[mv.as_ for mv in mvs],
            target_columns=(
                [column.name for column in table_def.columns]
                if table_def is not None
                else None
            ),
        )
    except Exception:
        # Schema load failed, fall back to direct copy.
        return _BackfillStrategy(mvs=[])


@dataclass(frozen=True)
class BuildBackfillPlanOutput:
    plan: BackfillPlanState
    plan_path: str


def build_backfill_plan(
    *,
    opts: PlanOptions,
    config_path: str | Path,
    config: _PlanConfig,
    clickhouse_query: PlannerQuery,
    clickhouse: dict[str, str] | None = None,
    query_settings: QuerySettings | None = None,
) -> BuildBackfillPlanOutput:
    target_parts = opts.target.split(".")
    database = target_parts[0] if len(target_parts) > 0 else ""
    table = target_parts[1] if len(target_parts) > 1 else ""
    if not database or not table:
        msg = "Invalid target format. Expected <database.table>."
        raise BackfillConfigError(msg)

    # Detect the execution strategy before chunk planning: an mv_replay
    # backfill sizes its chunks against the MV *source* (the table its SELECT
    # reads), because the injected chunk conditions run against that source —
    # not the target, which is legitimately empty when bootstrapping an
    # aggregate. Only the copy path introspects the target itself.
    strategy = _detect_backfill_strategy(
        schema=config.schema_,
        config_dir=Path(config_path).resolve().parent,
        database=database,
        table=table,
    )
    replay_source = (
        resolve_mv_replay_source(strategy.mvs)
        if strategy.mv_replay_queries is not None
        else None
    )
    chunk_source = (
        replay_source
        if replay_source is not None
        else {"database": database, "table": table}
    )

    chunk_plan = generate_chunk_plan(
        GenerateChunkPlanInput(
            database=chunk_source["database"],
            table=chunk_source["table"],
            from_=opts.from_,
            to=opts.to,
            target_chunk_bytes=opts.max_chunk_bytes,
            query=clickhouse_query,
            query_settings=query_settings,
        )
    )

    if not chunk_plan.partitions:
        window_note = (
            " within the specified time range" if (opts.from_ or opts.to) else ""
        )
        msg = (
            f"No partitions found for {chunk_source['database']}."
            f"{chunk_source['table']}{window_note}. The table may be empty."
        )
        raise BackfillConfigError(msg)
    first_partition = chunk_plan.partitions[0]

    env = compute_environment_fingerprint(clickhouse)
    derived_from = (
        opts.from_
        if opts.from_ is not None
        else min(
            (partition.min_time for partition in chunk_plan.partitions),
            default=first_partition.min_time,
        )
    )
    derived_to = (
        opts.to
        if opts.to is not None
        else max(
            (partition.max_time for partition in chunk_plan.partitions),
            default=first_partition.max_time,
        )
    )

    state_dir = compute_backfill_state_dir(config, config_path, opts.state_dir)
    paths = backfill_paths(state_dir, chunk_plan.plan_id)

    mv_replay_queries = strategy.mv_replay_queries
    target_columns = strategy.target_columns

    plan = BackfillPlanState(
        plan_id=chunk_plan.plan_id,
        target=opts.target,
        created_at=now_iso(),
        environment=env,
        from_=derived_from,
        to=derived_to,
        chunk_plan=chunk_plan,
        execution=BackfillExecutionPlan(
            mode="mv_replay" if mv_replay_queries is not None else "copy",
            source_target=opts.target,
            mv_replay_queries=mv_replay_queries,
            target_columns=target_columns,
            require_idempotency_token=opts.require_idempotency_token,
        ),
        options=BackfillPlanOptions(
            max_chunk_bytes=opts.max_chunk_bytes,
            max_parallel_chunks=opts.max_parallel_chunks,
            max_retries_per_chunk=opts.max_retries_per_chunk,
            require_idempotency_token=opts.require_idempotency_token,
            sort_key_column=(
                chunk_plan.table.sort_keys[0].name
                if chunk_plan.table.sort_keys
                else None
            ),
        ),
        policy=BackfillPlanPolicy(
            require_dry_run_before_run=opts.require_dry_run_before_run,
            require_explicit_window=opts.require_explicit_window,
            block_overlapping_runs=opts.block_overlapping_runs,
            fail_check_on_required_pending_backfill=(
                opts.fail_check_on_required_pending_backfill
            ),
        ),
        limits=BackfillPlanLimits(
            max_window_hours=opts.max_window_hours,
            min_chunk_minutes=opts.min_chunk_minutes,
        ),
    )

    write_json(
        paths.plan_path,
        plan.model_copy(
            update={"chunk_plan": encode_chunk_plan_for_persistence(plan.chunk_plan)}
        ),
    )

    return BuildBackfillPlanOutput(plan=plan, plan_path=paths.plan_path)


__all__ = ["BuildBackfillPlanOutput", "build_backfill_plan"]
