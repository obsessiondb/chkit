"""Full GROUP BY key splitting — port of ``strategies/group-by-key-split.ts``."""

from __future__ import annotations

import functools

from chkit_plugin_backfill.chunking.partition_slices import build_slice_from_rows
from chkit_plugin_backfill.chunking.services.distribution_source import (
    StringKeyBucket,
    probe_string_key_distribution,
)
from chkit_plugin_backfill.chunking.types import (
    ChunkDerivationStep,
    FocusedValue,
    Partition,
    PartitionSlice,
    PlannerContext,
    SortKey,
)
from chkit_plugin_backfill.chunking.utils.binary_string import (
    compare_binary_strings,
    max_binary_string,
    min_binary_string,
)
from chkit_plugin_backfill.chunking.utils.ranges import (
    get_chunk_range,
    replace_chunk_range,
)

_KEY_LIMIT = 100


def split_slice_with_group_by_key(
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
    dimension_index: int,
) -> list[PartitionSlice] | None:
    sort_key = (
        sort_keys[dimension_index]
        if 0 <= dimension_index < len(sort_keys)
        else None
    )
    if sort_key is None or sort_key.category != "string":
        return None

    range_ = get_chunk_range(slice_.ranges, dimension_index)
    if range_.from_ is None or range_.to is None:
        return None

    buckets = probe_string_key_distribution(
        context,
        slice_.partition_id,
        slice_.ranges,
        sort_key,
        dimension_index,
        sort_keys,
        _KEY_LIMIT,
    )

    if buckets is None or len(buckets) == 0:
        return None

    # Sort by value for range-ordered slice construction
    def by_value(a: StringKeyBucket, b: StringKeyBucket) -> int:
        return compare_binary_strings(a.value, b.value)

    sorted_buckets = sorted(buckets, key=functools.cmp_to_key(by_value))

    return _build_key_slices(
        partition, slice_, dimension_index, range_.from_, range_.to, sorted_buckets
    )


def _build_key_slices(  # noqa: PLR0917 — TS signature parity
    partition: Partition,
    parent_slice: PartitionSlice,
    dimension_index: int,
    range_from: str,
    range_to: str,
    sorted_buckets: list[StringKeyBucket],
) -> list[PartitionSlice]:
    slices: list[PartitionSlice] = []
    cursor = range_from

    for bucket in sorted_buckets:
        key_from = bucket.value
        key_to = f"{bucket.value}\0"

        # Gap slice before this key (non-hot residual between keys): it has
        # zero rows in our full distribution, so we skip it (all rows are
        # accounted for by the key buckets).
        _gap_from = max_binary_string(cursor, range_from)
        _gap_to = min_binary_string(key_from, range_to)

        # Exact key slice
        slice_from = max_binary_string(key_from, range_from)
        slice_to = min_binary_string(key_to, range_to)
        if compare_binary_strings(slice_from, slice_to) < 0:
            slices.append(
                build_slice_from_rows(
                    partition,
                    ranges=replace_chunk_range(
                        parent_slice.ranges, dimension_index, slice_from, slice_to
                    ),
                    rows=bucket.row_count,
                    focused_value=FocusedValue(
                        dimension_index=dimension_index, value=bucket.value
                    ),
                    confidence="high",
                    reason="group-by-key-distribution",
                    lineage=[
                        *parent_slice.analysis.lineage,
                        ChunkDerivationStep(
                            strategy_id="group-by-key-split",
                            dimension_index=dimension_index,
                            reason="split slice using full GROUP BY key distribution",
                        ),
                    ],
                )
            )

        cursor = key_to

    return slices


__all__ = ["split_slice_with_group_by_key"]
