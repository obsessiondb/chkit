"""Hex-latin1 boundary encoding for persisted plans.

1:1 port of ``chunking/boundary-codec.ts``. String sort-key boundaries can
contain arbitrary bytes; plans persist them hex-encoded so the JSON file
stays valid and TS/Python read each other's plans.
"""

from __future__ import annotations

from chkit_plugin_backfill.chunking.types import (
    Chunk,
    ChunkAnalysis,
    ChunkPlan,
    ChunkRange,
    FocusedValue,
    SortKey,
)
from chkit_plugin_backfill.chunking.utils.binary_string import latin1_bytes, latin1_str


def _encode_boundary(value: str | None, sort_key: SortKey | None) -> str | None:
    if value is None or sort_key is None:
        return value
    if sort_key.boundary_encoding == "hex-latin1":
        return latin1_bytes(value).hex()
    return value


def _decode_boundary(value: str | None, sort_key: SortKey | None) -> str | None:
    if value is None or sort_key is None:
        return value
    if sort_key.boundary_encoding == "hex-latin1":
        return latin1_str(bytes.fromhex(value))
    return value


def _sort_key_at(sort_keys: list[SortKey], index: int) -> SortKey | None:
    if 0 <= index < len(sort_keys):
        return sort_keys[index]
    return None


def _encode_ranges(ranges: list[ChunkRange], sort_keys: list[SortKey]) -> list[ChunkRange]:
    return [
        ChunkRange(
            dimension_index=range_.dimension_index,
            from_=_encode_boundary(range_.from_, _sort_key_at(sort_keys, range_.dimension_index)),
            to=_encode_boundary(range_.to, _sort_key_at(sort_keys, range_.dimension_index)),
        )
        for range_ in ranges
    ]


def _decode_ranges(ranges: list[ChunkRange], sort_keys: list[SortKey]) -> list[ChunkRange]:
    return [
        ChunkRange(
            dimension_index=range_.dimension_index,
            from_=_decode_boundary(range_.from_, _sort_key_at(sort_keys, range_.dimension_index)),
            to=_decode_boundary(range_.to, _sort_key_at(sort_keys, range_.dimension_index)),
        )
        for range_ in ranges
    ]


def _encode_focused_value(
    focused_value: FocusedValue | None, sort_keys: list[SortKey]
) -> FocusedValue | None:
    if focused_value is None:
        return None
    encoded = _encode_boundary(
        focused_value.value, _sort_key_at(sort_keys, focused_value.dimension_index)
    )
    return FocusedValue(
        dimension_index=focused_value.dimension_index,
        value=encoded if encoded is not None else focused_value.value,
    )


def _decode_focused_value(
    focused_value: FocusedValue | None, sort_keys: list[SortKey]
) -> FocusedValue | None:
    if focused_value is None:
        return None
    decoded = _decode_boundary(
        focused_value.value, _sort_key_at(sort_keys, focused_value.dimension_index)
    )
    return FocusedValue(
        dimension_index=focused_value.dimension_index,
        value=decoded if decoded is not None else focused_value.value,
    )


def _encode_chunk(chunk: Chunk, sort_keys: list[SortKey]) -> Chunk:
    return chunk.model_copy(
        update={
            "ranges": _encode_ranges(chunk.ranges, sort_keys),
            "analysis": ChunkAnalysis(
                focused_value=_encode_focused_value(chunk.analysis.focused_value, sort_keys),
                lineage=chunk.analysis.lineage,
            ),
        }
    )


def _decode_chunk(chunk: Chunk, sort_keys: list[SortKey]) -> Chunk:
    return chunk.model_copy(
        update={
            "ranges": _decode_ranges(chunk.ranges, sort_keys),
            "analysis": ChunkAnalysis(
                focused_value=_decode_focused_value(chunk.analysis.focused_value, sort_keys),
                lineage=chunk.analysis.lineage,
            ),
        }
    )


def encode_chunk_plan_for_persistence(plan: ChunkPlan) -> ChunkPlan:
    return plan.model_copy(
        update={
            "chunks": [_encode_chunk(chunk, plan.table.sort_keys) for chunk in plan.chunks],
        }
    )


def decode_chunk_plan_from_persistence(plan: ChunkPlan) -> ChunkPlan:
    return plan.model_copy(
        update={
            "chunks": [_decode_chunk(chunk, plan.table.sort_keys) for chunk in plan.chunks],
        }
    )


__all__ = ["decode_chunk_plan_from_persistence", "encode_chunk_plan_for_persistence"]
