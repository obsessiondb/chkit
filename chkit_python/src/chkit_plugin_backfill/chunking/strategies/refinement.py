"""Slice refinement + partition diagnostics — port of ``strategies/refinement.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.chunking.partition_slices import build_slice_estimate
from chkit_plugin_backfill.chunking.services.row_probe import (
    count_rows_exact,
    get_row_probe_strategy,
)
from chkit_plugin_backfill.chunking.types import (
    EstimateFilter,
    Partition,
    PartitionBuildResult,
    PartitionDiagnostics,
    PartitionSlice,
    PlannerContext,
    SortKey,
)

_ESTIMATE_RATIO_MIN = 0.7
_ESTIMATE_RATIO_MAX = 1.3


def refine_partition_slices(
    context: PlannerContext,
    partition: Partition,
    slices: list[PartitionSlice],
    sort_keys: list[SortKey],
    used_distribution_fallback: bool,
) -> PartitionBuildResult:
    working_slices = slices
    used_low_confidence_chunk_refinement = False

    if any(slice_.estimate.confidence == "low" for slice_ in slices):
        working_slices = _refine_low_confidence_slices(
            context, partition, slices, sort_keys
        )
        used_low_confidence_chunk_refinement = True

    diagnostics = _build_partition_diagnostics(
        partition,
        working_slices,
        used_distribution_fallback,
        used_low_confidence_chunk_refinement,
        used_exact_count_fallback=False,
    )

    if (
        get_row_probe_strategy(context) != "explain-estimate"
        or not diagnostics.suspicious_estimate
    ):
        return PartitionBuildResult(slices=working_slices, diagnostics=diagnostics)

    refined_slices = _refine_all_slices(context, partition, working_slices, sort_keys)
    return PartitionBuildResult(
        slices=refined_slices,
        diagnostics=_build_partition_diagnostics(
            partition,
            refined_slices,
            used_distribution_fallback,
            used_low_confidence_chunk_refinement,
            used_exact_count_fallback=True,
        ),
    )


def _build_partition_diagnostics(
    partition: Partition,
    slices: list[PartitionSlice],
    used_distribution_fallback: bool,
    used_low_confidence_chunk_refinement: bool,
    *,
    used_exact_count_fallback: bool,
) -> PartitionDiagnostics:
    estimated_row_sum = sum(slice_.estimate.rows for slice_ in slices)
    estimate_to_exact_ratio = (
        estimated_row_sum / partition.rows if partition.rows > 0 else 1
    )

    return PartitionDiagnostics(
        estimated_row_sum=estimated_row_sum,
        exact_partition_rows=partition.rows,
        estimate_to_exact_ratio=estimate_to_exact_ratio,
        suspicious_estimate=(
            estimate_to_exact_ratio < _ESTIMATE_RATIO_MIN
            or estimate_to_exact_ratio > _ESTIMATE_RATIO_MAX
        ),
        low_confidence_chunk_count=sum(
            1 for slice_ in slices if slice_.estimate.confidence == "low"
        ),
        used_distribution_fallback=used_distribution_fallback,
        used_low_confidence_chunk_refinement=used_low_confidence_chunk_refinement,
        used_exact_count_fallback=used_exact_count_fallback,
    )


def _refine_low_confidence_slices(
    context: PlannerContext,
    partition: Partition,
    slices: list[PartitionSlice],
    sort_keys: list[SortKey],
) -> list[PartitionSlice]:
    refined: list[PartitionSlice] = []

    for slice_ in slices:
        if slice_.estimate.confidence != "low":
            refined.append(slice_)
            continue
        refined.append(_refine_slice(context, partition, slice_, sort_keys))

    return refined


def _refine_all_slices(
    context: PlannerContext,
    partition: Partition,
    slices: list[PartitionSlice],
    sort_keys: list[SortKey],
) -> list[PartitionSlice]:
    return [
        _refine_slice(context, partition, slice_, sort_keys) for slice_ in slices
    ]


def _refine_slice(
    context: PlannerContext,
    partition: Partition,
    slice_: PartitionSlice,
    sort_keys: list[SortKey],
) -> PartitionSlice:
    rows = count_rows_exact(
        context,
        EstimateFilter(partition_id=partition.partition_id, ranges=slice_.ranges),
        sort_keys,
    )

    return slice_.model_copy(
        update={
            "estimate": build_slice_estimate(partition, rows, "exact", "exact-count"),
        }
    )


__all__ = ["refine_partition_slices"]
