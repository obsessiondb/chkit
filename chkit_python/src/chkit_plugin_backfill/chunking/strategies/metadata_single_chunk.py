"""Whole-partition single chunk — port of ``strategies/metadata-single-chunk.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.chunking.partition_slices import build_root_slice
from chkit_plugin_backfill.chunking.types import Partition, PartitionSlice


def build_single_chunk_partition(partition: Partition) -> list[PartitionSlice]:
    return [build_root_slice(partition)]


__all__ = ["build_single_chunk_partition"]
