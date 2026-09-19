"""Candidate dimension policy — port of ``chunking/strategy-policy.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.chunking.types import PartitionSlice, SortKey


def get_candidate_dimensions(
    sort_keys: list[SortKey],
    _slice: PartitionSlice | None = None,
) -> list[int]:
    return list(range(len(sort_keys)))


__all__ = ["get_candidate_dimensions"]
