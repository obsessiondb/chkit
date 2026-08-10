"""String-prefix distribution splitting — port of ``strategies/string-prefix-split.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.chunking.partition_slices import build_slice_from_rows
from chkit_plugin_backfill.chunking.services.distribution_source import (
    probe_string_prefix_distribution,
)
from chkit_plugin_backfill.chunking.types import (
    ChunkDerivationStep,
    FocusedValue,
    Partition,
    PartitionSlice,
    PlannerContext,
    SortKey,
    StringPrefixBucket,
)
from chkit_plugin_backfill.chunking.utils.binary_string import (
    build_observed_string_upper_bound,
    max_binary_string,
    min_binary_string,
    next_prefix_value,
)
from chkit_plugin_backfill.chunking.utils.ranges import (
    get_chunk_range,
    replace_chunk_range,
)

_TARGET_BYTES_FUZZ_FACTOR = 1.15
_PREFIX_START_DEPTH = 1
_PREFIX_MAX_DEPTH = 4


def split_slice_with_string_prefixes(
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
    if sort_key is None or sort_key.category != "string":
        return []

    range_ = get_chunk_range(slice_.ranges, dimension_index)
    if range_.from_ is None or range_.to is None:
        return []

    return _build_prefix_slices(
        context,
        partition,
        slice_,
        sort_keys,
        dimension_index,
        range_.from_,
        range_.to,
        _PREFIX_START_DEPTH,
    )


def build_root_string_upper_bound(max_value: str) -> str:
    return build_observed_string_upper_bound(max_value)


def _build_prefix_slices(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
    range_from: str,
    range_to: str,
    depth: int,
) -> list[PartitionSlice]:
    sort_key = (
        sort_keys[dimension_index]
        if 0 <= dimension_index < len(sort_keys)
        else None
    )
    if sort_key is None:
        return []

    buckets = probe_string_prefix_distribution(
        context,
        partition.partition_id,
        replace_chunk_range(slice_.ranges, dimension_index, range_from, range_to),
        sort_key,
        dimension_index,
        depth,
        sort_keys,
    )

    slices: list[PartitionSlice] = []
    for bucket in buckets:
        if bucket.row_count <= 0:
            continue

        bucket_slice = _build_bucket_slice(
            partition, slice_, dimension_index, range_from, range_to, bucket
        )
        if bucket_slice is None:
            continue

        if (
            bucket_slice.estimate.bytes_uncompressed
            <= context.target_chunk_bytes * _TARGET_BYTES_FUZZ_FACTOR
        ):
            slices.append(bucket_slice)
            continue

        if not bucket.is_exact_value and depth < _PREFIX_MAX_DEPTH:
            bucket_range = get_chunk_range(bucket_slice.ranges, dimension_index)
            if bucket_range.from_ is not None and bucket_range.to is not None:
                slices.extend(
                    _build_prefix_slices(
                        context,
                        partition,
                        slice_,
                        sort_keys,
                        dimension_index,
                        bucket_range.from_,
                        bucket_range.to,
                        depth + 1,
                    )
                )
                continue

        slices.append(bucket_slice)

    return slices


def _build_bucket_slice(  # noqa: PLR0917 — TS signature parity
    partition: Partition,
    parent_slice: PartitionSlice,
    dimension_index: int,
    range_from: str,
    range_to: str,
    bucket: StringPrefixBucket,
) -> PartitionSlice | None:
    bucket_from = max_binary_string(range_from, bucket.value)
    bucket_upper = (
        f"{bucket.value}\0" if bucket.is_exact_value else next_prefix_value(bucket.value)
    )
    if bucket_upper is None:
        return None

    bucket_to = min_binary_string(range_to, bucket_upper)
    if bucket_from == bucket_to:
        return None

    focused_value = (
        FocusedValue(dimension_index=dimension_index, value=bucket.value)
        if bucket.is_exact_value
        else parent_slice.analysis.focused_value
    )

    return build_slice_from_rows(
        partition,
        ranges=replace_chunk_range(
            parent_slice.ranges, dimension_index, bucket_from, bucket_to
        ),
        rows=bucket.row_count,
        focused_value=focused_value,
        confidence="high",
        reason="string-prefix-distribution",
        lineage=[
            *parent_slice.analysis.lineage,
            ChunkDerivationStep(
                strategy_id="string-prefix-split",
                dimension_index=dimension_index,
                reason="split slice using string prefix distribution",
            ),
        ],
    )


__all__ = ["build_root_string_upper_bound", "split_slice_with_string_prefixes"]
