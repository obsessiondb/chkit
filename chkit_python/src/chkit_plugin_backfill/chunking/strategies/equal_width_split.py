"""Equal-width range splitting — port of ``strategies/equal-width-split.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.chunking.partition_slices import build_slice_from_rows
from chkit_plugin_backfill.chunking.services.row_probe import estimate_rows
from chkit_plugin_backfill.chunking.strategies.quantile_range_split import (
    build_evenly_spaced_boundaries,
)
from chkit_plugin_backfill.chunking.types import (
    ChunkDerivationStep,
    EstimateFilter,
    Partition,
    PartitionSlice,
    PlannerContext,
    SortKey,
)
from chkit_plugin_backfill.chunking.utils.ranges import replace_chunk_range

_DEFAULT_OVERSAMPLING_MULTIPLIER = 3


def split_slice_with_equal_width_ranges(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
    range_from: str,
    range_to: str,
    sub_count: int,
    oversampling_multiplier: int = _DEFAULT_OVERSAMPLING_MULTIPLIER,
) -> list[PartitionSlice]:
    sort_key = (
        sort_keys[dimension_index]
        if 0 <= dimension_index < len(sort_keys)
        else None
    )
    if sort_key is None:
        return [slice_]

    boundaries = list(
        dict.fromkeys(
            build_evenly_spaced_boundaries(
                range_from, range_to, sub_count * oversampling_multiplier, sort_key
            )
        )
    )
    if len(boundaries) <= 2:  # noqa: PLR2004 — only endpoints left
        return [slice_]

    intervals: list[tuple[str, str]] = []
    for index in range(len(boundaries) - 1):
        from_ = boundaries[index]
        to = boundaries[index + 1]
        if from_ == to:
            continue
        intervals.append((from_, to))

    slices: list[PartitionSlice] = []
    for from_, to in intervals:
        ranges = replace_chunk_range(slice_.ranges, dimension_index, from_, to)
        rows = estimate_rows(
            context,
            EstimateFilter(partition_id=partition.partition_id, ranges=ranges),
            sort_keys,
        )
        if rows <= 0:
            continue
        slices.append(
            build_slice_from_rows(
                partition,
                ranges=ranges,
                rows=rows,
                focused_value=slice_.analysis.focused_value,
                confidence="exact" if context.row_probe_strategy == "count" else "low",
                reason=(
                    "exact-count"
                    if context.row_probe_strategy == "count"
                    else "equal-width-distribution"
                ),
                lineage=[
                    *slice_.analysis.lineage,
                    ChunkDerivationStep(
                        strategy_id="equal-width-split",
                        dimension_index=dimension_index,
                        reason="fallback to equal-width ranges",
                    ),
                ],
            )
        )

    return slices if slices else [slice_]


__all__ = ["split_slice_with_equal_width_ranges"]
