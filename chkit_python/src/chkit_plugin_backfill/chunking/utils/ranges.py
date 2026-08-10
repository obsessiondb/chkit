"""Range helpers over a slice's dimension ranges — port of ``chunking/utils/ranges.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.chunking.types import ChunkRange


def get_chunk_range(
    ranges: list[ChunkRange],
    dimension_index: int,
) -> ChunkRange:
    for candidate in ranges:
        if candidate.dimension_index == dimension_index:
            return candidate
    return ChunkRange(dimension_index=dimension_index, from_=None, to=None)


def replace_chunk_range(
    ranges: list[ChunkRange],
    dimension_index: int,
    from_: str | None,
    to: str | None,
) -> list[ChunkRange]:
    kept = [
        candidate for candidate in ranges if candidate.dimension_index != dimension_index
    ]
    kept.append(ChunkRange(dimension_index=dimension_index, from_=from_, to=to))
    return sorted(kept, key=lambda candidate: candidate.dimension_index)


def is_exact_chunk_range(range_: ChunkRange) -> bool:
    if range_.from_ is None or range_.to is None:
        return False
    return range_.to == f"{range_.from_}\0"


__all__ = ["get_chunk_range", "is_exact_chunk_range", "replace_chunk_range"]
