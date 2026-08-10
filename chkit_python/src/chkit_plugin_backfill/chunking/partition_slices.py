"""Partition-slice building + adjacent-slice merging.

1:1 port of ``chunking/partition-slices.ts``.
"""

from __future__ import annotations

import math

from chkit_plugin_backfill.chunking.types import (
    ChunkAnalysis,
    ChunkDerivationStep,
    ChunkEstimate,
    ChunkRange,
    EstimateConfidence,
    EstimateReason,
    FocusedValue,
    Partition,
    PartitionSlice,
)

_MERGE_FUZZ_FACTOR = 1.1


def build_root_slice(partition: Partition) -> PartitionSlice:
    return PartitionSlice(
        partition_id=partition.partition_id,
        ranges=[],
        estimate=ChunkEstimate(
            rows=partition.rows,
            bytes_compressed=partition.bytes_compressed,
            bytes_uncompressed=partition.bytes_uncompressed,
            confidence="high",
            reason="partition-metadata",
        ),
        analysis=ChunkAnalysis(lineage=[]),
    )


def _js_round(value: float) -> float:
    """JS ``Math.round`` — half-up (toward +Infinity), unlike Python's banker's.

    Not ``floor(value + 0.5)``: for 0.49999999999999994 the float addition
    rounds up to 1.0 first, but the spec (and JS engines) return 0. Comparing
    the fractional part directly avoids that double-rounding.
    """
    floor = math.floor(value)
    return floor if value - floor < 0.5 else floor + 1  # noqa: PLR2004 — .5 tie


def build_slice_estimate(
    partition: Partition,
    rows: float,
    confidence: EstimateConfidence,
    reason: EstimateReason,
) -> ChunkEstimate:
    bytes_compressed = (
        _js_round((rows / partition.rows) * partition.bytes_compressed)
        if partition.rows > 0
        else 0
    )
    bytes_uncompressed = (
        _js_round((rows / partition.rows) * partition.bytes_uncompressed)
        if partition.rows > 0
        else 0
    )
    return ChunkEstimate(
        rows=rows,
        bytes_compressed=bytes_compressed,
        bytes_uncompressed=bytes_uncompressed,
        confidence=confidence,
        reason=reason,
    )


def build_slice_from_rows(
    partition: Partition,
    *,
    ranges: list[ChunkRange],
    rows: float,
    confidence: EstimateConfidence,
    reason: EstimateReason,
    lineage: list[ChunkDerivationStep],
    focused_value: FocusedValue | None = None,
) -> PartitionSlice:
    return PartitionSlice(
        partition_id=partition.partition_id,
        ranges=ranges,
        estimate=build_slice_estimate(partition, rows, confidence, reason),
        analysis=ChunkAnalysis(focused_value=focused_value, lineage=lineage),
    )


def get_target_chunk_rows(partition: Partition, target_chunk_bytes: float) -> float:
    if partition.bytes_uncompressed <= 0:
        return partition.rows
    return (target_chunk_bytes * partition.rows) / partition.bytes_uncompressed


def merge_adjacent_slices(
    slices: list[PartitionSlice],
    target_chunk_bytes: float,
) -> list[PartitionSlice]:
    if len(slices) <= 1:
        return slices

    merged: list[PartitionSlice] = []
    current: PartitionSlice | None = None

    for slice_ in slices:
        if current is None:
            current = slice_
            continue

        can_merge = (
            current.analysis.focused_value is None
            and slice_.analysis.focused_value is None
            and _have_same_trailing_ranges(current.ranges, slice_.ranges)
            and current.estimate.bytes_uncompressed + slice_.estimate.bytes_uncompressed
            <= target_chunk_bytes * _MERGE_FUZZ_FACTOR
        )

        if not can_merge:
            merged.append(current)
            current = slice_
            continue

        current = current.model_copy(
            update={
                "ranges": _merge_ranges(current.ranges, slice_.ranges),
                "estimate": current.estimate.model_copy(
                    update={
                        "rows": current.estimate.rows + slice_.estimate.rows,
                        "bytes_compressed": current.estimate.bytes_compressed
                        + slice_.estimate.bytes_compressed,
                        "bytes_uncompressed": current.estimate.bytes_uncompressed
                        + slice_.estimate.bytes_uncompressed,
                    }
                ),
            }
        )

    if current is not None:
        merged.append(current)
    return merged


def _merge_ranges(left: list[ChunkRange], right: list[ChunkRange]) -> list[ChunkRange]:
    result: list[ChunkRange] = []
    for left_range in left:
        right_range = next(
            (
                candidate
                for candidate in right
                if candidate.dimension_index == left_range.dimension_index
            ),
            None,
        )
        if right_range is None:
            result.append(left_range)
        else:
            result.append(
                ChunkRange(
                    dimension_index=left_range.dimension_index,
                    from_=left_range.from_,
                    to=right_range.to,
                )
            )
    return result


def _have_same_trailing_ranges(
    left: list[ChunkRange], right: list[ChunkRange]
) -> bool:
    if len(left) != len(right):
        return False

    differing_dimensions = 0

    for left_range in left:
        right_range = next(
            (
                candidate
                for candidate in right
                if candidate.dimension_index == left_range.dimension_index
            ),
            None,
        )
        if right_range is None:
            return False

        same = left_range.from_ == right_range.from_ and left_range.to == right_range.to
        if not same:
            differing_dimensions += 1
            if left_range.to != right_range.from_:
                return False

    return differing_dimensions <= 1


__all__ = [
    "build_root_slice",
    "build_slice_estimate",
    "build_slice_from_rows",
    "get_target_chunk_rows",
    "merge_adjacent_slices",
]
