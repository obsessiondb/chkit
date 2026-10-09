"""Chunk-plan data model.

1:1 port of ``packages/plugin-backfill/src/chunking/types.ts``. The models
serialize with camelCase aliases and ``exclude_none`` so a Python-written
plan file is byte-compatible with the TS reader (``JSON.stringify`` omits
``undefined`` keys).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field

RowProbeStrategy: TypeAlias = Literal["explain-estimate", "count"]
SortKeyCategory: TypeAlias = Literal["numeric", "datetime", "string"]
SortKeyBoundaryEncoding: TypeAlias = Literal["literal", "hex-latin1"]
EstimateConfidence: TypeAlias = Literal["high", "low", "exact"]
EstimateReason: TypeAlias = Literal[
    "partition-metadata",
    "quantile-estimate",
    "string-prefix-distribution",
    "group-by-key-distribution",
    "temporal-distribution",
    "equal-width-distribution",
    "exact-count",
]

QuerySettings: TypeAlias = Mapping[str, "str | int | float | bool | None"]
PlannerQuery: TypeAlias = Callable[
    [str, "QuerySettings | None"], "list[dict[str, object]]"
]


class _Model(BaseModel):
    model_config = ConfigDict(
        frozen=True, extra="ignore", populate_by_name=True
    )


class SortKey(_Model):
    name: str
    type: str
    category: SortKeyCategory
    boundary_encoding: SortKeyBoundaryEncoding = Field(..., alias="boundaryEncoding")


class ChunkRange(_Model):
    dimension_index: int = Field(..., alias="dimensionIndex")
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None


class ChunkDerivationStep(_Model):
    strategy_id: str = Field(..., alias="strategyId")
    dimension_index: int | None = Field(default=None, alias="dimensionIndex")
    reason: str


class ChunkEstimate(_Model):
    rows: float
    bytes_compressed: float = Field(..., alias="bytesCompressed")
    bytes_uncompressed: float = Field(..., alias="bytesUncompressed")
    confidence: EstimateConfidence
    reason: EstimateReason


class FocusedValue(_Model):
    dimension_index: int = Field(..., alias="dimensionIndex")
    value: str


class ChunkAnalysis(_Model):
    focused_value: FocusedValue | None = Field(default=None, alias="focusedValue")
    lineage: list[ChunkDerivationStep] = Field(default_factory=list)


class PartitionDiagnostics(_Model):
    estimated_row_sum: float = Field(..., alias="estimatedRowSum")
    exact_partition_rows: float = Field(..., alias="exactPartitionRows")
    estimate_to_exact_ratio: float = Field(..., alias="estimateToExactRatio")
    suspicious_estimate: bool = Field(..., alias="suspiciousEstimate")
    low_confidence_chunk_count: int = Field(..., alias="lowConfidenceChunkCount")
    used_distribution_fallback: bool = Field(..., alias="usedDistributionFallback")
    used_low_confidence_chunk_refinement: bool = Field(
        ..., alias="usedLowConfidenceChunkRefinement"
    )
    used_exact_count_fallback: bool = Field(..., alias="usedExactCountFallback")


class Partition(_Model):
    partition_id: str = Field(..., alias="partitionId")
    rows: float
    bytes_compressed: float = Field(..., alias="bytesCompressed")
    bytes_uncompressed: float = Field(..., alias="bytesUncompressed")
    min_time: str = Field(..., alias="minTime")
    max_time: str = Field(..., alias="maxTime")
    diagnostics: PartitionDiagnostics | None = None


class TableProfile(_Model):
    database: str
    table: str
    sort_keys: list[SortKey] = Field(..., alias="sortKeys")


class Chunk(_Model):
    id: str
    partition_id: str = Field(..., alias="partitionId")
    ranges: list[ChunkRange]
    estimate: ChunkEstimate
    analysis: ChunkAnalysis


class ChunkPlanStats(_Model):
    total_partitions: int = Field(..., alias="totalPartitions")
    oversized_partitions: int = Field(..., alias="oversizedPartitions")
    focused_chunks: int = Field(..., alias="focusedChunks")
    total_chunks: int = Field(..., alias="totalChunks")
    avg_chunk_bytes: float = Field(..., alias="avgChunkBytes")
    max_chunk_bytes: float = Field(..., alias="maxChunkBytes")
    min_chunk_bytes: float = Field(..., alias="minChunkBytes")


class ChunkPlan(_Model):
    plan_id: str = Field(..., alias="planId")
    generated_at: str = Field(..., alias="generatedAt")
    row_probe_strategy: RowProbeStrategy = Field(..., alias="rowProbeStrategy")
    target_chunk_bytes: float = Field(..., alias="targetChunkBytes")
    table: TableProfile
    partitions: list[Partition]
    chunks: list[Chunk]
    total_rows: float = Field(..., alias="totalRows")
    total_bytes_compressed: float = Field(..., alias="totalBytesCompressed")
    total_bytes_uncompressed: float = Field(..., alias="totalBytesUncompressed")
    stats: ChunkPlanStats


class PartitionSlice(_Model):
    partition_id: str = Field(..., alias="partitionId")
    ranges: list[ChunkRange]
    estimate: ChunkEstimate
    analysis: ChunkAnalysis


class PartitionBuildResult(_Model):
    slices: list[PartitionSlice]
    diagnostics: PartitionDiagnostics


class EstimateFilter(_Model):
    partition_id: str = Field(..., alias="partitionId")
    ranges: list[ChunkRange]
    exact_dimension_index: int | None = Field(default=None, alias="exactDimensionIndex")
    exact_value: str | None = Field(default=None, alias="exactValue")


class StringPrefixBucket(_Model):
    value: str
    row_count: float = Field(..., alias="rowCount")
    is_exact_value: bool = Field(..., alias="isExactValue")


class TemporalBucket(_Model):
    start: str
    row_count: float = Field(..., alias="rowCount")


@dataclass(frozen=True)
class PlannerContext:
    """Runtime planning context (holds the query callable — not serialized)."""

    database: str
    table: str
    target_chunk_bytes: float
    query: PlannerQuery
    row_probe_strategy: RowProbeStrategy
    from_: str | None = None
    to: str | None = None
    query_settings: QuerySettings | None = None


@dataclass(frozen=True)
class GenerateChunkPlanInput:
    database: str
    table: str
    target_chunk_bytes: float
    query: PlannerQuery
    from_: str | None = None
    to: str | None = None
    query_settings: QuerySettings | None = None
    row_probe_strategy: RowProbeStrategy | None = None


__all__ = [
    "Chunk",
    "ChunkAnalysis",
    "ChunkDerivationStep",
    "ChunkEstimate",
    "ChunkPlan",
    "ChunkPlanStats",
    "ChunkRange",
    "EstimateConfidence",
    "EstimateFilter",
    "EstimateReason",
    "FocusedValue",
    "GenerateChunkPlanInput",
    "Partition",
    "PartitionBuildResult",
    "PartitionDiagnostics",
    "PartitionSlice",
    "PlannerContext",
    "PlannerQuery",
    "QuerySettings",
    "RowProbeStrategy",
    "SortKey",
    "SortKeyCategory",
    "StringPrefixBucket",
    "TableProfile",
    "TemporalBucket",
]
