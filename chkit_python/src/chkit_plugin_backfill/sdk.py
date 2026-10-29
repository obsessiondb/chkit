"""Programmatic SDK surface — port of ``packages/plugin-backfill/src/sdk.ts``.

Everything the ObsessionDB plugin's managed-submit path (and third-party
tooling) needs, re-exported from one module.
"""

from __future__ import annotations

from chkit_plugin_backfill.async_backfill import (
    BackfillResult,
    execute_backfill,
    sync_progress,
)
from chkit_plugin_backfill.chunking.analyze import analyze_and_chunk, analyze_table
from chkit_plugin_backfill.chunking.boundary_codec import (
    decode_chunk_plan_from_persistence,
    encode_chunk_plan_for_persistence,
)
from chkit_plugin_backfill.chunking.planner import generate_chunk_plan
from chkit_plugin_backfill.chunking.sql import (
    build_chunk_execution_sql,
    build_where_clause_from_chunk,
    inject_sort_key_filter,
    rewrite_select_columns,
)
from chkit_plugin_backfill.chunking.types import (
    Chunk,
    ChunkDerivationStep,
    ChunkPlan,
    ChunkRange,
    EstimateConfidence,
    EstimateReason,
    FocusedValue,
    Partition,
    PartitionDiagnostics,
    SortKey,
)
from chkit_plugin_backfill.chunking.utils.ids import generate_idempotency_token
from chkit_plugin_backfill.logging_utils import (
    CHKIT_BACKFILL_LOGGER_CATEGORY,
    CHKIT_LOGGER_CATEGORY,
    get_backfill_logger,
)
from chkit_plugin_backfill.options import (
    PlanOptions,
    SubmitOptions,
    parse_byte_size,
)
from chkit_plugin_backfill.planner import (
    BuildBackfillPlanOutput,
    build_backfill_plan,
)
from chkit_plugin_backfill.state import (
    PlanSubmission,
    RemoteSubmission,
    confirm_backfill_submission,
    list_remote_submissions,
    read_plan_submission,
    record_backfill_submission,
)
from chkit_plugin_backfill.types import (
    BackfillChunkState,
    BackfillPlanState,
    BackfillProgress,
    BackfillSubmissionState,
)

__all__ = [
    "CHKIT_BACKFILL_LOGGER_CATEGORY",
    "CHKIT_LOGGER_CATEGORY",
    "BackfillChunkState",
    "BackfillPlanState",
    "BackfillProgress",
    "BackfillResult",
    "BackfillSubmissionState",
    "BuildBackfillPlanOutput",
    "Chunk",
    "ChunkDerivationStep",
    "ChunkPlan",
    "ChunkRange",
    "EstimateConfidence",
    "EstimateReason",
    "FocusedValue",
    "Partition",
    "PartitionDiagnostics",
    "PlanOptions",
    "PlanSubmission",
    "RemoteSubmission",
    "SortKey",
    "SubmitOptions",
    "analyze_and_chunk",
    "analyze_table",
    "build_backfill_plan",
    "build_chunk_execution_sql",
    "build_where_clause_from_chunk",
    "confirm_backfill_submission",
    "decode_chunk_plan_from_persistence",
    "encode_chunk_plan_for_persistence",
    "execute_backfill",
    "generate_chunk_plan",
    "generate_idempotency_token",
    "get_backfill_logger",
    "inject_sort_key_filter",
    "list_remote_submissions",
    "parse_byte_size",
    "read_plan_submission",
    "record_backfill_submission",
    "rewrite_select_columns",
    "sync_progress",
]
