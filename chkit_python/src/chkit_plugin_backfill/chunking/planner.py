"""Chunk-plan generation — port of ``chunking/planner.ts``.

The TS module wraps the query callable with slow-query warning timers
(``setTimeout``); the Python port uses :class:`threading.Timer` for the same
live "still running" warnings. Estimate probes that TS fans out through
``pMap`` run sequentially here (order-preserving, results identical —
documented in DRIFT.md).
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import replace
from threading import Timer

from chkit_plugin_backfill.chunking.partition_slices import (
    build_root_slice,
    merge_adjacent_slices,
)
from chkit_plugin_backfill.chunking.services.metadata_source import (
    introspect_partitions,
    introspect_sort_keys,
)
from chkit_plugin_backfill.chunking.services.row_probe import (
    get_row_probe_strategy,
    get_sort_key_range,
)
from chkit_plugin_backfill.chunking.strategies.equal_width_split import (
    split_slice_with_equal_width_ranges,
)
from chkit_plugin_backfill.chunking.strategies.group_by_key_split import (
    split_slice_with_group_by_key,
)
from chkit_plugin_backfill.chunking.strategies.metadata_single_chunk import (
    build_single_chunk_partition,
)
from chkit_plugin_backfill.chunking.strategies.quantile_range_split import (
    find_quantile_boundary_on_dimension,
    split_slice_with_quantiles,
)
from chkit_plugin_backfill.chunking.strategies.refinement import (
    refine_partition_slices,
)
from chkit_plugin_backfill.chunking.strategies.string_prefix_split import (
    build_root_string_upper_bound,
    split_slice_with_string_prefixes,
)
from chkit_plugin_backfill.chunking.strategies.temporal_bucket_split import (
    split_slice_with_temporal_buckets,
)
from chkit_plugin_backfill.chunking.strategy_policy import get_candidate_dimensions
from chkit_plugin_backfill.chunking.types import (
    Chunk,
    ChunkPlan,
    ChunkPlanStats,
    FocusedValue,
    GenerateChunkPlanInput,
    Partition,
    PartitionBuildResult,
    PartitionSlice,
    PlannerContext,
    PlannerQuery,
    QuerySettings,
    SortKey,
    TableProfile,
)
from chkit_plugin_backfill.chunking.utils.ids import (
    generate_chunk_id,
    generate_plan_id,
)
from chkit_plugin_backfill.chunking.utils.jsnum import (
    js_number_to_string,
    parse_js_number,
)
from chkit_plugin_backfill.chunking.utils.ranges import (
    get_chunk_range,
    is_exact_chunk_range,
    replace_chunk_range,
)
from chkit_plugin_backfill.logging_utils import (
    SLOW_CLICKHOUSE_QUERY_MS,
    SLOW_CLICKHOUSE_QUERY_REPEAT_INITIAL_MS,
    SLOW_CLICKHOUSE_QUERY_REPEAT_MAX_MS,
    describe_sql_context,
    describe_sql_operation,
    format_bytes,
    get_backfill_logger,
    summarize_sql,
)
from chkit_plugin_backfill.state import now_iso
from chkit_plugin_backfill.time_utils import iso_from_epoch_ms, parse_planner_datetime

_MAX_SPLIT_DEPTH_MULTIPLIER = 3
_STOP_SPLIT_FUZZ_FACTOR = 1.5
_QUANTILE_MIN_UNIQUE_DIVISOR = 3
_logger = get_backfill_logger("chunking", "planner")
_query_logger = get_backfill_logger("chunking", "clickhouse")


def generate_chunk_plan(input_: GenerateChunkPlanInput) -> ChunkPlan:
    plan_started_at = time.monotonic()
    context = PlannerContext(
        database=input_.database,
        table=input_.table,
        from_=input_.from_,
        to=input_.to,
        target_chunk_bytes=input_.target_chunk_bytes,
        query=_create_timed_planner_query(input_),
        query_settings=input_.query_settings,
        row_probe_strategy=(
            input_.row_probe_strategy
            if input_.row_probe_strategy is not None
            else "count"
        ),
    )

    _logger.info(
        "starting chunk plan for %s.%s (target chunk size %s, row probe %s)",
        input_.database,
        input_.table,
        format_bytes(input_.target_chunk_bytes),
        context.row_probe_strategy,
    )

    introspection_started_at = time.monotonic()
    partitions = introspect_partitions(context)
    sort_keys = introspect_sort_keys(context)
    table = TableProfile(
        database=input_.database, table=input_.table, sort_keys=sort_keys
    )
    plan_id = generate_plan_id()

    _logger.info(
        "introspection completed for %s.%s: %d partitions, %d oversized partitions,"
        " %d sort keys (%dms)",
        input_.database,
        input_.table,
        len(partitions),
        sum(
            1
            for partition in partitions
            if partition.bytes_uncompressed > context.target_chunk_bytes
        ),
        len(sort_keys),
        round((time.monotonic() - introspection_started_at) * 1000),
    )

    slices: list[PartitionSlice] = []
    planned_partitions: list[Partition] = []
    for partition in partitions:
        result = _plan_partition(context, partition, table)
        slices.extend(result.slices)
        planned_partitions.append(
            partition.model_copy(update={"diagnostics": result.diagnostics})
        )

    chunks = _assign_chunk_ids(plan_id, slices)
    chunk_bytes = [chunk.estimate.bytes_uncompressed for chunk in chunks]
    stats = ChunkPlanStats(
        total_partitions=len(partitions),
        oversized_partitions=sum(
            1
            for partition in partitions
            if partition.bytes_uncompressed > context.target_chunk_bytes
        ),
        focused_chunks=sum(
            1 for chunk in chunks if chunk.analysis.focused_value is not None
        ),
        total_chunks=len(chunks),
        avg_chunk_bytes=(
            math.floor(sum(chunk_bytes) / len(chunk_bytes) + 0.5) if chunk_bytes else 0
        ),
        max_chunk_bytes=max(chunk_bytes) if chunk_bytes else 0,
        min_chunk_bytes=min(chunk_bytes) if chunk_bytes else 0,
    )

    _logger.info(
        "finished chunk plan for %s.%s: %d chunks across %d partitions,"
        " %s uncompressed (%dms)",
        input_.database,
        input_.table,
        len(chunks),
        len(partitions),
        format_bytes(sum(partition.bytes_uncompressed for partition in partitions)),
        round((time.monotonic() - plan_started_at) * 1000),
    )

    return ChunkPlan(
        plan_id=plan_id,
        generated_at=now_iso(),
        row_probe_strategy=get_row_probe_strategy(context),
        target_chunk_bytes=context.target_chunk_bytes,
        table=table,
        partitions=planned_partitions,
        chunks=chunks,
        total_rows=sum(partition.rows for partition in partitions),
        total_bytes_compressed=sum(
            partition.bytes_compressed for partition in partitions
        ),
        total_bytes_uncompressed=sum(
            partition.bytes_uncompressed for partition in partitions
        ),
        stats=stats,
    )


def _plan_partition(
    context: PlannerContext,
    partition: Partition,
    table: TableProfile,
) -> PartitionBuildResult:
    started_at = time.monotonic()
    _logger.info(
        "planning partition %s (%s rows, %s uncompressed, target %s)",
        partition.partition_id,
        partition.rows,
        format_bytes(partition.bytes_uncompressed),
        format_bytes(context.target_chunk_bytes),
    )

    if (
        partition.bytes_uncompressed <= context.target_chunk_bytes
        or len(table.sort_keys) == 0
    ):
        refined = refine_partition_slices(
            context,
            partition,
            build_single_chunk_partition(partition),
            table.sort_keys,
            used_distribution_fallback=False,
        )

        _logger.info(
            "kept partition %s as a single chunk (%dms, %s)",
            partition.partition_id,
            round((time.monotonic() - started_at) * 1000),
            (
                "within target size"
                if partition.bytes_uncompressed <= context.target_chunk_bytes
                else "no sort keys available"
            ),
        )

        return refined

    root_slice = build_root_slice(partition)
    split_slices = _split_slice_recursively(
        context, partition, root_slice, table.sort_keys, 0
    )
    merged_slices = merge_adjacent_slices(split_slices, context.target_chunk_bytes)
    used_distribution_fallback = any(
        slice_.estimate.reason
        in {
            "string-prefix-distribution",
            "group-by-key-distribution",
            "temporal-distribution",
            "equal-width-distribution",
        }
        for slice_ in merged_slices
    )

    _logger.debug(
        "partition %s produced %d candidate slices before refinement"
        " (%d after merge, distribution fallback %s)",
        partition.partition_id,
        len(split_slices),
        len(merged_slices),
        "used" if used_distribution_fallback else "not used",
    )

    refined = refine_partition_slices(
        context,
        partition,
        merged_slices,
        table.sort_keys,
        used_distribution_fallback,
    )

    _logger.info(
        "finished partition %s: %d chunks (%dms)",
        partition.partition_id,
        len(refined.slices),
        round((time.monotonic() - started_at) * 1000),
    )

    return refined


def _split_slice_recursively(
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    depth: int,
) -> list[PartitionSlice]:
    if (
        slice_.estimate.bytes_uncompressed
        <= context.target_chunk_bytes * _STOP_SPLIT_FUZZ_FACTOR
    ):
        _logger.debug(
            "stopped splitting slice for partition %s at depth %d:"
            " %s is within threshold %s",
            partition.partition_id,
            depth,
            format_bytes(slice_.estimate.bytes_uncompressed),
            format_bytes(
                math.floor(context.target_chunk_bytes * _STOP_SPLIT_FUZZ_FACTOR + 0.5)
            ),
        )
        return [slice_]

    if depth >= len(sort_keys) * _MAX_SPLIT_DEPTH_MULTIPLIER:
        _logger.debug(
            "stopped splitting slice for partition %s: reached max depth %d",
            partition.partition_id,
            len(sort_keys) * _MAX_SPLIT_DEPTH_MULTIPLIER,
        )
        return [slice_]

    children = _split_oversized_slice(context, partition, slice_, sort_keys, depth)
    if len(children) <= 1:
        _logger.debug(
            "slice could not be split further for partition %s at depth %d",
            partition.partition_id,
            depth,
        )
        return [slice_]

    finalized: list[PartitionSlice] = []
    for child in children:
        finalized.extend(
            _split_slice_recursively(context, partition, child, sort_keys, depth + 1)
        )

    return finalized


def _split_oversized_slice(  # noqa: PLR0911, PLR0912
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    depth: int,
) -> list[PartitionSlice]:
    candidate_dimensions = get_candidate_dimensions(sort_keys, slice_)

    _logger.debug(
        "attempting oversized slice split for partition %s at depth %d"
        " (%s uncompressed across %d candidate dimensions)",
        partition.partition_id,
        depth,
        format_bytes(slice_.estimate.bytes_uncompressed),
        len(candidate_dimensions),
    )

    for dimension_index in candidate_dimensions:
        prepared_slice = _hydrate_slice_range(
            context, slice_, sort_keys, dimension_index
        )
        if prepared_slice is None:
            continue

        sort_key = (
            sort_keys[dimension_index]
            if 0 <= dimension_index < len(sort_keys)
            else None
        )
        if sort_key is None:
            continue

        root_like = depth == 0
        focused_value = _find_focused_value(prepared_slice, sort_keys)

        _logger.debug(
            "trying split dimension %d on %s using %s (%s)",
            dimension_index,
            partition.partition_id,
            sort_key.name,
            sort_key.category,
        )

        if sort_key.category == "string":
            if root_like:
                # First pass: equal-width EXPLAIN ESTIMATE (fast, metadata-only)
                estimate_slices = _split_with_equal_width_estimate(
                    context, partition, prepared_slice, sort_keys, dimension_index
                )
                if _is_effective_split(prepared_slice, estimate_slices):
                    _logger.debug(
                        "equal-width estimate split succeeded for partition %s:"
                        " %d slices",
                        partition.partition_id,
                        len(estimate_slices),
                    )
                    return _apply_focused_value(estimate_slices, focused_value)
            else:
                # Refinement pass: full GROUP BY key to detect hot keys directly
                key_slices = split_slice_with_group_by_key(
                    context, partition, prepared_slice, sort_keys, dimension_index
                )
                if key_slices is not None and _is_effective_split(
                    prepared_slice, key_slices
                ):
                    _logger.debug(
                        "group-by-key split succeeded for partition %s: %d slices",
                        partition.partition_id,
                        len(key_slices),
                    )
                    return _apply_focused_value(key_slices, focused_value)

                # Single hot key: narrow the range and re-enter dispatch so
                # focused_value is detected
                if (
                    key_slices is not None
                    and len(key_slices) == 1
                    and key_slices[0].analysis.focused_value is not None
                ):
                    refined = key_slices[0]
                    current_range = get_chunk_range(
                        prepared_slice.ranges, dimension_index
                    )
                    refined_range = get_chunk_range(refined.ranges, dimension_index)
                    if (
                        current_range.from_ != refined_range.from_
                        or current_range.to != refined_range.to
                    ):
                        _logger.debug(
                            "narrowed single hot key for partition %s,"
                            " re-entering dispatch",
                            partition.partition_id,
                        )
                        return _split_oversized_slice(
                            context, partition, refined, sort_keys, depth
                        )

                # Fallback: GROUP BY prefix when too many distinct keys
                string_slices = split_slice_with_string_prefixes(
                    context, partition, prepared_slice, sort_keys, dimension_index
                )
                if _is_effective_split(prepared_slice, string_slices):
                    _logger.debug(
                        "string-prefix split succeeded for partition %s: %d slices",
                        partition.partition_id,
                        len(string_slices),
                    )
                    return _apply_focused_value(string_slices, focused_value)

        if sort_key.category == "datetime" and (
            not root_like or focused_value is not None
        ):
            temporal_slices = split_slice_with_temporal_buckets(
                context,
                partition,
                _mark_focused_slice(prepared_slice, focused_value),
                sort_keys,
                dimension_index,
            )
            if _is_effective_split(prepared_slice, temporal_slices):
                _logger.debug(
                    "temporal bucket split succeeded for partition %s: %d slices",
                    partition.partition_id,
                    len(temporal_slices),
                )
                return _apply_focused_value(temporal_slices, focused_value)

        ranged_slices = _split_with_ranges(
            context, partition, prepared_slice, sort_keys, dimension_index
        )
        if _is_effective_split(prepared_slice, ranged_slices):
            _logger.debug(
                "range-based split succeeded for partition %s: %d slices",
                partition.partition_id,
                len(ranged_slices),
            )
            return _apply_focused_value(ranged_slices, focused_value)

    _logger.debug(
        "no effective split found for partition %s at depth %d",
        partition.partition_id,
        depth,
    )

    return [slice_]


def _split_with_ranges(
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
) -> list[PartitionSlice]:
    sort_key = (
        sort_keys[dimension_index]
        if 0 <= dimension_index < len(sort_keys)
        else None
    )
    if sort_key is None:
        return [slice_]

    range_ = get_chunk_range(slice_.ranges, dimension_index)
    if range_.from_ is None or range_.to is None:
        return [slice_]
    if sort_key.category == "string" and is_exact_chunk_range(range_):
        return [slice_]

    sub_count = math.ceil(
        slice_.estimate.bytes_uncompressed / context.target_chunk_bytes
    )
    if sub_count <= 1:
        return [slice_]

    quantile_boundaries = _build_quantile_boundaries(
        context, slice_, sort_keys, dimension_index, sub_count
    )
    if quantile_boundaries is not None:
        _logger.debug(
            "using quantile-aligned range split for partition %s on dimension %d"
            " with %d boundaries",
            partition.partition_id,
            dimension_index,
            len(quantile_boundaries),
        )
        return split_slice_with_quantiles(
            context, partition, slice_, sort_keys, dimension_index, quantile_boundaries
        )

    _logger.debug(
        "falling back to equal-width range split for partition %s on dimension %d"
        " with %d subranges",
        partition.partition_id,
        dimension_index,
        sub_count,
    )

    return split_slice_with_equal_width_ranges(
        context,
        partition,
        slice_,
        sort_keys,
        dimension_index,
        range_.from_,
        range_.to,
        sub_count,
    )


def _split_with_equal_width_estimate(
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
) -> list[PartitionSlice]:
    estimate_context = replace(context, row_probe_strategy="explain-estimate")
    return _split_with_ranges(
        estimate_context, partition, slice_, sort_keys, dimension_index
    )


def _build_quantile_boundaries(
    context: PlannerContext,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
    sub_count: int,
) -> list[str] | None:
    range_ = get_chunk_range(slice_.ranges, dimension_index)
    if range_.from_ is None or range_.to is None:
        return None

    # TS fans the quantile searches through pMap({concurrency: 10}); results
    # are order-preserving either way, so the sequential loop is identical.
    found_boundaries = [
        find_quantile_boundary_on_dimension(
            context,
            slice_,
            sort_keys,
            dimension_index,
            math.floor((slice_.estimate.rows * step) / sub_count + 0.5),
        )
        for step in range(1, sub_count)
    ]
    boundaries = [range_.from_, *found_boundaries]

    unique_boundary_count = len(set(boundaries))
    if unique_boundary_count <= max(
        2, math.ceil(sub_count / _QUANTILE_MIN_UNIQUE_DIVISOR)
    ):
        _logger.debug(
            "discarded quantile boundaries for partition %s on dimension %d"
            " because only %d unique boundaries remained",
            slice_.partition_id,
            dimension_index,
            unique_boundary_count,
        )
        return None

    return [*boundaries, range_.to]


def _hydrate_slice_range(
    context: PlannerContext,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
) -> PartitionSlice | None:
    existing_range = get_chunk_range(slice_.ranges, dimension_index)
    if existing_range.from_ is not None and existing_range.to is not None:
        return slice_

    sort_key = (
        sort_keys[dimension_index]
        if 0 <= dimension_index < len(sort_keys)
        else None
    )
    if sort_key is None:
        return None

    observed_range = get_sort_key_range(
        context, slice_.partition_id, slice_.ranges, sort_keys, sort_key
    )
    if observed_range is None:
        return None
    observed_min, observed_max = observed_range

    _logger.debug(
        "hydrated missing sort-key range for partition %s on %s: [%s, %s]",
        slice_.partition_id,
        sort_key.name,
        observed_min,
        observed_max,
    )

    return slice_.model_copy(
        update={
            "ranges": replace_chunk_range(
                slice_.ranges,
                dimension_index,
                observed_min,
                _to_exclusive_upper_bound(observed_max, sort_key),
            ),
        }
    )


def _to_exclusive_upper_bound(value: str, sort_key: SortKey) -> str:
    if sort_key.category == "string":
        return build_root_string_upper_bound(value)
    if sort_key.category == "datetime":
        return iso_from_epoch_ms(parse_planner_datetime(value) + 1000)
    return js_number_to_string(parse_js_number(value) + 1)


def _is_effective_split(
    parent_slice: PartitionSlice, child_slices: list[PartitionSlice]
) -> bool:
    if len(child_slices) <= 1:
        return False

    parent_ranges = _ranges_fingerprint(parent_slice)
    return any(
        child_slice.estimate.rows != parent_slice.estimate.rows
        or _ranges_fingerprint(child_slice) != parent_ranges
        for child_slice in child_slices
    )


def _ranges_fingerprint(slice_: PartitionSlice) -> str:
    """TS compares ``JSON.stringify(slice.ranges)`` — replicate the shape
    (camelCase keys, ``undefined`` omitted, insertion order preserved)."""
    return json.dumps(
        [
            range_.model_dump(by_alias=True, exclude_none=True)
            for range_ in slice_.ranges
        ],
        separators=(",", ":"),
    )


def _find_focused_value(
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
) -> FocusedValue | None:
    for range_ in slice_.ranges:
        sort_key = (
            sort_keys[range_.dimension_index]
            if 0 <= range_.dimension_index < len(sort_keys)
            else None
        )
        if sort_key is None or sort_key.category != "string":
            continue
        if is_exact_chunk_range(range_) and range_.from_ is not None:
            return FocusedValue(
                dimension_index=range_.dimension_index, value=range_.from_
            )
    return None


def _apply_focused_value(
    slices: list[PartitionSlice],
    focused_value: FocusedValue | None,
) -> list[PartitionSlice]:
    if focused_value is None:
        return slices
    return [_mark_focused_slice(slice_, focused_value) for slice_ in slices]


def _mark_focused_slice(
    slice_: PartitionSlice,
    focused_value: FocusedValue | None,
) -> PartitionSlice:
    if focused_value is None:
        return slice_
    return slice_.model_copy(
        update={
            "analysis": slice_.analysis.model_copy(
                update={"focused_value": focused_value}
            ),
        }
    )


def _assign_chunk_ids(plan_id: str, slices: list[PartitionSlice]) -> list[Chunk]:
    chunk_indexes: dict[str, int] = {}

    chunks: list[Chunk] = []
    for slice_ in slices:
        current_index = chunk_indexes.get(slice_.partition_id, 0)
        chunk_indexes[slice_.partition_id] = current_index + 1
        chunks.append(
            Chunk(
                id=generate_chunk_id(plan_id, slice_.partition_id, current_index),
                partition_id=slice_.partition_id,
                ranges=slice_.ranges,
                estimate=slice_.estimate,
                analysis=slice_.analysis,
            )
        )
    return chunks


def _create_timed_planner_query(input_: GenerateChunkPlanInput) -> PlannerQuery:
    def timed_planner_query(
        sql: str, settings: QuerySettings | None
    ) -> list[dict[str, object]]:
        started_at = time.monotonic()
        sql_summary = summarize_sql(sql)
        operation = describe_sql_operation(sql)
        context_label = describe_sql_context(sql)
        query_label = (
            f"{operation} ({context_label})" if context_label else operation
        )

        timers: list[Timer] = []
        repeat_delay_ms = [SLOW_CLICKHOUSE_QUERY_REPEAT_INITIAL_MS]

        def schedule_repeat_warning() -> None:
            def repeat_warn() -> None:
                elapsed_repeat_ms = round((time.monotonic() - started_at) * 1000)
                _query_logger.warning(
                    "clickhouse query still running for %s.%s after %dms: %s",
                    input_.database,
                    input_.table,
                    elapsed_repeat_ms,
                    query_label,
                )
                repeat_delay_ms[0] = min(
                    repeat_delay_ms[0] * 2, SLOW_CLICKHOUSE_QUERY_REPEAT_MAX_MS
                )
                schedule_repeat_warning()

            timer = Timer(repeat_delay_ms[0] / 1000, repeat_warn)
            timer.daemon = True
            timers.append(timer)
            timer.start()

        def slow_warn() -> None:
            elapsed_ms = round((time.monotonic() - started_at) * 1000)
            _query_logger.warning(
                "clickhouse query still running for %s.%s after %dms: %s | %s",
                input_.database,
                input_.table,
                elapsed_ms,
                query_label,
                sql_summary,
            )
            schedule_repeat_warning()

        slow_timer = Timer(SLOW_CLICKHOUSE_QUERY_MS / 1000, slow_warn)
        slow_timer.daemon = True
        timers.append(slow_timer)
        slow_timer.start()

        _query_logger.debug(
            "clickhouse query started for %s.%s: %s",
            input_.database,
            input_.table,
            sql_summary,
        )

        try:
            rows = input_.query(sql, settings)
            duration_ms = round((time.monotonic() - started_at) * 1000)

            if duration_ms >= SLOW_CLICKHOUSE_QUERY_MS:
                _query_logger.debug(
                    "slow clickhouse query completed for %s.%s in %dms (%d rows): %s",
                    input_.database,
                    input_.table,
                    duration_ms,
                    len(rows),
                    query_label,
                )
            else:
                _query_logger.debug(
                    "clickhouse query completed for %s.%s in %dms (%d rows): %s",
                    input_.database,
                    input_.table,
                    duration_ms,
                    len(rows),
                    sql_summary,
                )

            return rows
        except Exception:
            _query_logger.error(
                "clickhouse query failed for %s.%s after %dms: %s",
                input_.database,
                input_.table,
                round((time.monotonic() - started_at) * 1000),
                sql_summary,
            )
            raise
        finally:
            for timer in timers:
                timer.cancel()

    return timed_planner_query


__all__ = ["generate_chunk_plan"]
