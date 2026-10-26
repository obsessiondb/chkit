"""``build_backfill_plan`` orchestration — port of ``packages/plugin-backfill/src/planner.ts``."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

from chkit.core.cutover import CutoverMetadata, parse_cutover_metadata
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


# The same pins every chunk INSERT carries (see ``chunking/sql.py``), so ``*``
# in a view's query expands to the same columns at plan time as at run time,
# whatever the user's settings profile says. Inline, like the INSERT's, so no
# client or URL-level setting can override them.
_ASTERISK_SETTINGS = (
    "asterisk_include_materialized_columns=0, asterisk_include_alias_columns=0"
)


@dataclass(frozen=True)
class _BackfillStrategy:
    mvs: list[MaterializedViewDefinition]
    mv_replay_queries: list[str] | None = None


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
        if table_def is not None and any(
            column.default_kind == "EPHEMERAL" for column in table_def.columns
        ):
            raise BackfillConfigError(
                "Automatic backfill cannot reconstruct EPHEMERAL inputs; "
                "use an explicit INSERT with an input column mapping."
            )
        return _BackfillStrategy(mvs=mvs, mv_replay_queries=[mv.as_ for mv in mvs])
    except BackfillConfigError:
        raise
    except Exception:
        # Schema load failed, fall back to direct copy.
        return _BackfillStrategy(mvs=[])


def assert_backfill_target_safe(
    *, database: str, table: str, mode: Literal["copy", "mv_replay", "cutover_copy"],
    query: PlannerQuery,
    query_settings: QuerySettings | None = None,
) -> list[str]:
    """Fail closed when live metadata cannot establish safe input semantics.

    Copy mode re-inserts ``SELECT *``, which keeps stored DEFAULT values but
    recomputes MATERIALIZED ones. Expressions are not parsed, so a copy is
    refused whenever a MATERIALIZED column could read an EPHEMERAL input.

    Returns the live target's insertable columns (no MATERIALIZED, ALIAS or
    EPHEMERAL) in table order.
    """
    def quote(value: str) -> str:
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"

    target = f"{database}.{table}"
    rows = query(
        "SELECT name, default_kind FROM system.columns "
        f"WHERE database = {quote(database)} AND table = {quote(table)} ORDER BY position",
        query_settings,
    )
    if not rows and not query(
        "SELECT name FROM system.tables "
        f"WHERE database = {quote(database)} AND name = {quote(table)}",
        query_settings,
    ):
        raise BackfillConfigError(
            f"Backfill target {target} does not exist or is not visible yet. "
            "DDL may still be propagating on managed ClickHouse (e.g. ObsessionDB); "
            "check the name and retry."
        )
    if not rows or any(
        not column.get("name")
        or column.get("default_kind") not in {"", "DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL"}
        for column in rows
    ):
        raise BackfillConfigError(
            "Cannot verify live target column kinds; automatic backfill is blocked. "
            "Check metadata access and use an explicit INSERT if needed."
        )
    ephemeral = [str(c["name"]) for c in rows if c["default_kind"] == "EPHEMERAL"]
    materialized = [str(c["name"]) for c in rows if c["default_kind"] == "MATERIALIZED"]
    if ephemeral and mode == "mv_replay":
        raise BackfillConfigError(
            "Automatic backfill cannot reconstruct EPHEMERAL inputs; "
            "use an explicit INSERT with an input column mapping."
        )
    if ephemeral and materialized:
        raise BackfillConfigError(
            f"Automatic backfill cannot reconstruct EPHEMERAL inputs; copying {target} "
            f"recomputes MATERIALIZED column(s) {', '.join(materialized)}, which may read "
            f"EPHEMERAL column(s) {', '.join(ephemeral)}. "
            "Use an explicit INSERT with an input column mapping."
        )
    return [str(c["name"]) for c in rows if c["default_kind"] in {"", "DEFAULT"}]


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
    if opts.cutover:
        return _build_cutover_backfill_plan(
            opts=opts,
            cutover=opts.cutover,
            config_path=config_path,
            config=config,
            clickhouse_query=clickhouse_query,
            clickhouse=clickhouse,
            query_settings=query_settings,
        )
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
    # aggregate. Target column safety is checked separately for both paths.
    strategy = _detect_backfill_strategy(
        schema=config.schema_,
        config_dir=Path(config_path).resolve().parent,
        database=database,
        table=table,
    )
    insertable_columns = assert_backfill_target_safe(
        database=database, table=table, query=clickhouse_query, query_settings=query_settings,
        mode="mv_replay" if strategy.mv_replay_queries is not None else "copy",
    )
    target_columns = (
        _resolve_replay_columns(
            target=opts.target,
            mvs=strategy.mvs,
            insertable_columns=insertable_columns,
            query=clickhouse_query,
            query_settings=query_settings,
        )
        if strategy.mv_replay_queries is not None
        else None
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


def _build_cutover_backfill_plan(
    *,
    opts: PlanOptions,
    cutover: str,
    config_path: str | Path,
    config: _PlanConfig,
    clickhouse_query: PlannerQuery,
    clickhouse: dict[str, str] | None,
    query_settings: QuerySettings | None,
) -> BuildBackfillPlanOutput:
    """Plan the copy step of a ``generate --cutover ... --cutover-copy backfill``
    migration (TS ``buildCutoverBackfillPlan``).

    Chunks over the frozen snapshot table the migration took, inserted into the
    shadow table. Each chunk skips the rows whose key the shadow already holds
    (mirrored rows, or rows an earlier attempt of the chunk wrote), so a chunk
    can run again without duplicating rows. The cutover's metadata is read from
    the snapshot table's comment.
    """
    if opts.target:
        msg = (
            "Use either --target or --cutover, not both: --cutover targets the shadow "
            "table of the cutover."
        )
        raise BackfillConfigError(msg)
    metadata = _read_cutover_metadata(cutover, clickhouse_query, query_settings)
    target = f"{metadata.database}.{metadata.shadow}"
    insertable_columns = assert_backfill_target_safe(
        database=metadata.database,
        table=metadata.shadow,
        mode="cutover_copy",
        query=clickhouse_query,
        query_settings=query_settings,
    )
    assert_replay_columns_still_insertable(
        plan_id="cutover",
        target=target,
        target_columns=metadata.columns,
        insertable_columns=insertable_columns,
    )
    chunk_plan = generate_chunk_plan(
        GenerateChunkPlanInput(
            database=metadata.database,
            table=metadata.snapshot,
            from_=None,
            to=None,
            target_chunk_bytes=opts.max_chunk_bytes,
            query=clickhouse_query,
            query_settings=query_settings,
        )
    )
    if not chunk_plan.partitions:
        msg = (
            f"The cutover snapshot {metadata.database}.{metadata.snapshot} has no rows, so "
            "there is nothing to copy. Run chkit migrate --apply to verify and swap."
        )
        raise BackfillConfigError(msg)
    state_dir = compute_backfill_state_dir(config, config_path, opts.state_dir)
    paths = backfill_paths(state_dir, chunk_plan.plan_id)
    plan = BackfillPlanState(
        plan_id=chunk_plan.plan_id,
        target=target,
        created_at=now_iso(),
        environment=compute_environment_fingerprint(clickhouse),
        from_=min(partition.min_time for partition in chunk_plan.partitions),
        to=max(partition.max_time for partition in chunk_plan.partitions),
        chunk_plan=chunk_plan,
        execution=BackfillExecutionPlan(
            mode="cutover_copy",
            source_target=f"{metadata.database}.{metadata.snapshot}",
            target_columns=list(metadata.columns),
            cutover_key=list(metadata.key),
            # The key-based skip makes a chunk safe to run again. A deduplication
            # token would instead drop the smaller retry blocks as duplicates.
            require_idempotency_token=False,
        ),
        options=BackfillPlanOptions(
            max_chunk_bytes=opts.max_chunk_bytes,
            max_parallel_chunks=opts.max_parallel_chunks,
            max_retries_per_chunk=opts.max_retries_per_chunk,
            require_idempotency_token=False,
            sort_key_column=(
                chunk_plan.table.sort_keys[0].name if chunk_plan.table.sort_keys else None
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


def _read_cutover_metadata(
    cutover: str, query: PlannerQuery, query_settings: QuerySettings | None
) -> CutoverMetadata:
    """Find the snapshot table of a pending cutover of ``cutover`` and read its metadata."""
    parts = cutover.split(".")
    database = parts[0] if parts else ""
    table = parts[1] if len(parts) > 1 else ""
    if not database or not table:
        msg = "Invalid value for --cutover. Expected <database.table>."
        raise BackfillConfigError(msg)

    def quote(value: str) -> str:
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"

    rows = query(
        "SELECT name, comment FROM system.tables "
        f"WHERE database = {quote(database)} AND startsWith(name, {quote(f'{table}__cutover_')}) "
        "AND endsWith(name, '_snapshot') ORDER BY name",
        query_settings,
    )
    cutovers: list[CutoverMetadata] = []
    for row in rows:
        metadata = parse_cutover_metadata(str(row.get("comment") or ""))
        if (
            metadata is not None
            and metadata.database == database
            and metadata.table == table
            and metadata.snapshot == row.get("name")
        ):
            cutovers.append(metadata)
    if not cutovers:
        msg = (
            f"No pending cutover of {cutover} was found: its snapshot table "
            f"({table}__cutover_<stamp>_snapshot) does not exist. Generate the cutover with "
            f"chkit generate --cutover {cutover}=<key> --cutover-copy backfill and run chkit "
            "migrate --apply first; it stops before the copy."
        )
        raise BackfillConfigError(msg)
    if len(cutovers) > 1:
        snapshots = ", ".join(metadata.snapshot for metadata in cutovers)
        msg = (
            f"Several pending cutovers of {cutover} exist ({snapshots}). Drop the objects of "
            "the abandoned ones first."
        )
        raise BackfillConfigError(msg)
    return cutovers[0]


def _resolve_replay_columns(
    *,
    target: str,
    mvs: list[MaterializedViewDefinition],
    insertable_columns: list[str],
    query: PlannerQuery,
    query_settings: QuerySettings | None,
) -> list[str]:
    """Name the columns an mv_replay INSERT writes, the way ClickHouse does when
    a materialized view inserts into its ``TO`` table: each view's output column
    goes to the target column of the same name, whatever the order, and target
    columns the view does not output get their DEFAULT. Chunk SQL renders this
    list on both sides of ``INSERT … SELECT``, so a ``SELECT *`` view never
    lines up by position. The list is persisted in the plan, so ``run`` does not
    depend on what the target looks like later.

    Fails when a view outputs a column the target cannot take (missing,
    MATERIALIZED or ALIAS), which ClickHouse also refuses when the view is
    created, and when views feeding one target output different column sets:
    one INSERT cannot leave a column to its DEFAULT for some rows only.
    """
    outputs: list[tuple[MaterializedViewDefinition, list[str]]] = []
    for mv in mvs:
        rows = query(
            f"DESCRIBE TABLE (\n{mv.as_}\n) SETTINGS {_ASTERISK_SETTINGS}", query_settings
        )
        names = [str(row["name"]) for row in rows]
        if not names:
            raise BackfillConfigError(
                f"Cannot read the output columns of materialized view {mv.database}.{mv.name}; "
                "automatic backfill is blocked."
            )
        rejected = [name for name in names if name not in insertable_columns]
        if rejected:
            raise BackfillConfigError(
                f"Materialized view {mv.database}.{mv.name} outputs column(s) "
                f"{', '.join(rejected)}, which {target} cannot take (missing, MATERIALIZED "
                "or ALIAS). ClickHouse matches view output to target columns by name and "
                "refuses such a view by default; align the view's SELECT with the target "
                "(use AS to rename) before backfilling."
            )
        outputs.append((mv, names))

    def describe(output: tuple[MaterializedViewDefinition, list[str]]) -> str:
        mv, names = output
        return f"{mv.database}.{mv.name} ({', '.join(names)})"

    first = outputs[0]
    mismatch = next((out for out in outputs if set(out[1]) != set(first[1])), None)
    if mismatch is not None:
        raise BackfillConfigError(
            f"Materialized views feeding {target} output different columns: "
            f"{describe(first)} vs {describe(mismatch)}. Backfill replays them in one "
            "INSERT, which cannot leave a column to its DEFAULT for only some views' rows."
        )
    return [name for name in insertable_columns if name in first[1]]


def assert_replay_columns_still_insertable(
    *,
    plan_id: str,
    target: str,
    target_columns: list[str] | None,
    insertable_columns: list[str],
) -> None:
    """A plan names its replay columns at plan time. Before running it, make
    sure the live target still takes every one of them, so a target altered
    after planning fails with a clear message instead of on every chunk.
    """
    missing = [name for name in target_columns or [] if name not in insertable_columns]
    if missing:
        raise BackfillConfigError(
            f"Target {target} changed since plan {plan_id} was created: column(s) "
            f"{', '.join(missing)} are gone or no longer insertable. "
            "Create a new plan with backfill plan."
        )


__all__ = ["BuildBackfillPlanOutput", "build_backfill_plan"]
