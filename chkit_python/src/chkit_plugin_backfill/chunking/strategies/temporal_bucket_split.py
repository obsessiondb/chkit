"""Temporal-bucket splitting — port of ``strategies/temporal-bucket-split.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.chunking.partition_slices import (
    build_slice_from_rows,
    get_target_chunk_rows,
)
from chkit_plugin_backfill.chunking.services.distribution_source import (
    probe_temporal_distribution,
)
from chkit_plugin_backfill.chunking.types import (
    ChunkDerivationStep,
    Partition,
    PartitionSlice,
    PlannerContext,
    SortKey,
    TemporalBucket,
)
from chkit_plugin_backfill.chunking.utils.ranges import (
    get_chunk_range,
    replace_chunk_range,
)
from chkit_plugin_backfill.time_utils import iso_from_epoch_ms, parse_planner_datetime

_TARGET_BYTES_FUZZ_FACTOR = 1.15


def split_slice_with_temporal_buckets(
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
) -> list[PartitionSlice]:
    day_buckets = probe_temporal_distribution(
        context,
        partition.partition_id,
        slice_.ranges,
        sort_keys,
        dimension_index,
        "day",
    )
    if len(day_buckets) == 0:
        return [slice_]

    day_slices = _build_temporal_slices(
        partition, slice_, dimension_index, day_buckets, context.target_chunk_bytes
    )
    if all(
        candidate.estimate.bytes_uncompressed
        <= context.target_chunk_bytes * _TARGET_BYTES_FUZZ_FACTOR
        for candidate in day_slices
    ):
        return day_slices

    hour_buckets = probe_temporal_distribution(
        context,
        partition.partition_id,
        slice_.ranges,
        sort_keys,
        dimension_index,
        "hour",
    )
    if len(hour_buckets) == 0:
        return day_slices

    return _build_temporal_slices(
        partition, slice_, dimension_index, hour_buckets, context.target_chunk_bytes
    )


def _get_partition_end_exclusive(partition: Partition) -> str:
    return iso_from_epoch_ms(parse_planner_datetime(partition.max_time) + 1000)


def _build_temporal_slices(
    partition: Partition,
    parent_slice: PartitionSlice,
    dimension_index: int,
    buckets: list[TemporalBucket],
    target_chunk_bytes: float,
) -> list[PartitionSlice]:
    target_chunk_rows = get_target_chunk_rows(partition, target_chunk_bytes)
    slices: list[PartitionSlice] = []
    current_start: str | None = None
    current_rows = 0.0
    parent_range = get_chunk_range(parent_slice.ranges, dimension_index)
    slice_start = parent_range.from_
    slice_end = (
        parent_range.to
        if parent_range.to is not None
        else _get_partition_end_exclusive(partition)
    )

    for index, bucket in enumerate(buckets):
        bucket_start = (
            slice_start
            if slice_start is not None and bucket.start < slice_start
            else bucket.start
        )
        if current_start is None:
            current_start = bucket_start

        would_exceed = (
            current_rows > 0
            and current_rows + bucket.row_count
            > target_chunk_rows * _TARGET_BYTES_FUZZ_FACTOR
        )
        if would_exceed and current_start is not None and current_start < bucket_start:
            slices.append(
                _build_slice(
                    parent_slice,
                    partition,
                    dimension_index,
                    current_start,
                    bucket_start,
                    current_rows,
                )
            )
            current_start = bucket_start
            current_rows = 0.0

        current_rows += bucket.row_count

        if (
            index == len(buckets) - 1
            and current_start is not None
            and current_start < slice_end
        ):
            slices.append(
                _build_slice(
                    parent_slice,
                    partition,
                    dimension_index,
                    current_start,
                    slice_end,
                    current_rows,
                )
            )

    return slices if slices else [parent_slice]


def _build_slice(  # noqa: PLR0917 — TS signature parity
    parent_slice: PartitionSlice,
    partition: Partition,
    dimension_index: int,
    from_: str,
    to: str,
    rows: float,
) -> PartitionSlice:
    return build_slice_from_rows(
        partition,
        ranges=replace_chunk_range(parent_slice.ranges, dimension_index, from_, to),
        rows=rows,
        focused_value=parent_slice.analysis.focused_value,
        confidence="low",
        reason="temporal-distribution",
        lineage=[
            *parent_slice.analysis.lineage,
            ChunkDerivationStep(
                strategy_id="temporal-bucket-split",
                dimension_index=dimension_index,
                reason="split slice using temporal distribution buckets",
            ),
        ],
    )


__all__ = ["split_slice_with_temporal_buckets"]
