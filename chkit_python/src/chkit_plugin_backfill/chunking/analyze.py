"""Analyze facade — port of ``chunking/analyze.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.chunking.planner import generate_chunk_plan
from chkit_plugin_backfill.chunking.types import ChunkPlan, GenerateChunkPlanInput


def analyze_and_chunk(input_: GenerateChunkPlanInput) -> ChunkPlan:
    return generate_chunk_plan(input_)


def analyze_table(input_: GenerateChunkPlanInput) -> ChunkPlan:
    return analyze_and_chunk(input_)


__all__ = ["analyze_and_chunk", "analyze_table"]
