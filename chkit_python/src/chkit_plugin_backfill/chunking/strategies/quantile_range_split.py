"""Quantile-aligned range splitting — port of ``strategies/quantile-range-split.ts``.

The TS module runs its row estimates through ``pMap`` with a concurrency cap;
``pMap`` preserves input order, so the sequential Python loop produces the
identical result list (performance-only divergence, recorded in DRIFT.md).
"""

from __future__ import annotations

import math

from chkit_plugin_backfill.chunking.partition_slices import build_slice_from_rows
from chkit_plugin_backfill.chunking.services.row_probe import estimate_rows
from chkit_plugin_backfill.chunking.types import (
    ChunkDerivationStep,
    EstimateFilter,
    Partition,
    PartitionSlice,
    PlannerContext,
    SortKey,
)
from chkit_plugin_backfill.chunking.utils.binary_string import (
    big_int_to_str,
    str_to_big_int,
)
from chkit_plugin_backfill.chunking.utils.jsnum import (
    js_number_to_string,
    parse_js_number,
)
from chkit_plugin_backfill.chunking.utils.ranges import (
    get_chunk_range,
    replace_chunk_range,
)
from chkit_plugin_backfill.time_utils import iso_from_epoch_ms, parse_planner_datetime

_BINARY_SEARCH_STEPS = 24


def split_slice_with_quantiles(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
    boundaries: list[str],
) -> list[PartitionSlice]:
    intervals: list[tuple[str, str]] = []
    for index in range(len(boundaries) - 1):
        from_ = boundaries[index]
        to = boundaries[index + 1]
        if from_ == to:
            continue
        intervals.append((from_, to))

    results: list[PartitionSlice] = []
    for from_, to in intervals:
        ranges = replace_chunk_range(slice_.ranges, dimension_index, from_, to)
        rows = estimate_rows(
            context,
            EstimateFilter(partition_id=partition.partition_id, ranges=ranges),
            sort_keys,
        )
        if rows <= 0:
            continue
        results.append(
            build_slice_from_rows(
                partition,
                ranges=ranges,
                rows=rows,
                focused_value=slice_.analysis.focused_value,
                confidence="exact" if context.row_probe_strategy == "count" else "high",
                reason=(
                    "exact-count"
                    if context.row_probe_strategy == "count"
                    else "quantile-estimate"
                ),
                lineage=[
                    *slice_.analysis.lineage,
                    ChunkDerivationStep(
                        strategy_id="quantile-range-split",
                        dimension_index=dimension_index,
                        reason="split slice into quantile-aligned ranges",
                    ),
                ],
            )
        )

    return results


def find_quantile_boundary_on_dimension(
    context: PlannerContext,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
    target_cum_rows: float,
) -> str:
    sort_key = (
        sort_keys[dimension_index]
        if 0 <= dimension_index < len(sort_keys)
        else None
    )
    if sort_key is None:
        msg = f"Missing sort key at dimension {dimension_index}"
        raise ValueError(msg)

    range_ = get_chunk_range(slice_.ranges, dimension_index)
    if range_.from_ is None or range_.to is None:
        msg = f"Missing range for quantile split on dimension {dimension_index}"
        raise ValueError(msg)

    if sort_key.category == "string":
        return _find_string_boundary(
            context, slice_, sort_keys, dimension_index, range_.from_, range_.to, target_cum_rows
        )
    if sort_key.category == "datetime":
        return _find_datetime_boundary(
            context, slice_, sort_keys, dimension_index, range_.from_, range_.to, target_cum_rows
        )
    return _find_numeric_boundary(
        context, slice_, sort_keys, dimension_index, range_.from_, range_.to, target_cum_rows
    )


def build_evenly_spaced_boundaries(
    range_from: str,
    range_to: str,
    sub_count: int,
    sort_key: SortKey,
) -> list[str]:
    if sub_count <= 1:
        return [range_from, range_to]

    if sort_key.category == "datetime":
        start = parse_planner_datetime(range_from)
        end = parse_planner_datetime(range_to)
        return [
            iso_from_epoch_ms(start + math.floor(((end - start) * index) / sub_count))
            for index in range(sub_count + 1)
        ]

    if sort_key.category == "numeric":
        num_start = parse_js_number(range_from)
        num_end = parse_js_number(range_to)
        return [
            js_number_to_string(
                num_start + math.floor(((num_end - num_start) * index) / sub_count)
            )
            for index in range(sub_count + 1)
        ]

    width = max(len(range_from), len(range_to))
    big_start = str_to_big_int(range_from, width)
    big_end = str_to_big_int(range_to, width)
    boundaries = [
        big_int_to_str(
            big_start + ((big_end - big_start) * index) // sub_count, width, width
        )
        for index in range(sub_count + 1)
    ]
    # Use original values at endpoints to avoid round-trip length changes
    boundaries[0] = range_from
    boundaries[-1] = range_to
    return boundaries


def _find_string_boundary(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
    range_from: str,
    range_to: str,
    target_cum_rows: float,
) -> str:
    width = max(len(range_from), len(range_to))
    low = str_to_big_int(range_from, width)
    high = str_to_big_int(range_to, width)

    for _step in range(_BINARY_SEARCH_STEPS):
        midpoint = (low + high) // 2
        if midpoint in {low, high}:
            break

        mid = big_int_to_str(midpoint, width, width)
        rows = _estimate_rows_until(
            context, slice_, sort_keys, dimension_index, range_from, mid
        )
        if rows < target_cum_rows:
            low = midpoint
        else:
            high = midpoint

    return big_int_to_str((low + high) // 2, width, width)


def _find_datetime_boundary(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
    range_from: str,
    range_to: str,
    target_cum_rows: float,
) -> str:
    low = parse_planner_datetime(range_from)
    high = parse_planner_datetime(range_to)

    for _step in range(_BINARY_SEARCH_STEPS):
        midpoint = math.floor((low + high) / 2)
        if midpoint in {low, high}:
            break

        mid = iso_from_epoch_ms(midpoint)
        rows = _estimate_rows_until(
            context, slice_, sort_keys, dimension_index, range_from, mid
        )
        if rows < target_cum_rows:
            low = midpoint
        else:
            high = midpoint

    return iso_from_epoch_ms(math.floor((low + high) / 2))


def _find_numeric_boundary(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
    range_from: str,
    range_to: str,
    target_cum_rows: float,
) -> str:
    low = parse_js_number(range_from)
    high = parse_js_number(range_to)

    for _step in range(_BINARY_SEARCH_STEPS):
        midpoint = math.floor((low + high) / 2)
        if midpoint in {low, high}:
            break

        rows = _estimate_rows_until(
            context,
            slice_,
            sort_keys,
            dimension_index,
            range_from,
            js_number_to_string(midpoint),
        )
        if rows < target_cum_rows:
            low = midpoint
        else:
            high = midpoint

    return js_number_to_string(math.floor((low + high) / 2))


def _estimate_rows_until(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
    range_from: str,
    range_to: str,
) -> float:
    return estimate_rows(
        context,
        EstimateFilter(
            partition_id=slice_.partition_id,
            ranges=replace_chunk_range(
                slice_.ranges, dimension_index, range_from, range_to
            ),
        ),
        sort_keys,
    )


__all__ = [
    "build_evenly_spaced_boundaries",
    "find_quantile_boundary_on_dimension",
    "split_slice_with_quantiles",
]
