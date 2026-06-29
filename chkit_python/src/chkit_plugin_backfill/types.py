"""Pydantic models for backfill plan/run state.

1:1 port of ``packages/plugin-backfill/src/types.ts`` (structural part only).
The chunking-engine types (``ChunkPlan``, ``ChunkExecutionState``, etc.) live
behind a TODO until the engine itself is ported (Phase 2).
"""

from __future__ import annotations

from typing import Any, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field

BackfillPlanStatus: TypeAlias = Literal[
    "planned", "running", "paused", "completed", "failed", "cancelled"
]
BackfillRunStatus: TypeAlias = Literal["running", "completed", "failed", "cancelled"]
BackfillChunkStatus: TypeAlias = Literal[
    "pending", "submitted", "running", "done", "failed"
]


class BackfillEnvironment(BaseModel):
    fingerprint: str
    url: str
    database: str

    model_config = ConfigDict(frozen=True, extra="forbid")


class BackfillExecutionPlan(BaseModel):
    mode: Literal["copy", "mv_replay"]
    source_target: str = Field(..., alias="sourceTarget")
    mv_as_query: str | None = Field(default=None, alias="mvAsQuery")
    target_columns: list[str] | None = Field(default=None, alias="targetColumns")
    require_idempotency_token: bool = Field(..., alias="requireIdempotencyToken")

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


class BackfillPlanOptions(BaseModel):
    max_chunk_bytes: int | None = Field(default=None, alias="maxChunkBytes")
    max_parallel_chunks: int = Field(..., alias="maxParallelChunks")
    max_retries_per_chunk: int = Field(..., alias="maxRetriesPerChunk")
    require_idempotency_token: bool = Field(..., alias="requireIdempotencyToken")
    sort_key_column: str | None = Field(default=None, alias="sortKeyColumn")

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


class BackfillPlanPolicy(BaseModel):
    require_dry_run_before_run: bool = Field(..., alias="requireDryRunBeforeRun")
    require_explicit_window: bool = Field(..., alias="requireExplicitWindow")
    block_overlapping_runs: bool = Field(..., alias="blockOverlappingRuns")
    fail_check_on_required_pending_backfill: bool = Field(
        ..., alias="failCheckOnRequiredPendingBackfill"
    )

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


class BackfillPlanLimits(BaseModel):
    max_window_hours: float = Field(..., alias="maxWindowHours")
    min_chunk_minutes: float = Field(..., alias="minChunkMinutes")

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


class BackfillPlanState(BaseModel):
    """Persisted plan blob (``<state_dir>/plans/<plan_id>.json``).

    The ``chunk_plan`` field is kept as an opaque dict in Phase 1 because the
    chunking-engine types aren't ported yet. Phase 2 will replace it with a
    typed ``ChunkPlan`` model.
    """

    plan_id: str = Field(..., alias="planId")
    target: str
    created_at: str = Field(..., alias="createdAt")
    environment: BackfillEnvironment | None = None
    from_: str = Field(..., alias="from")
    to: str
    chunk_plan: dict[str, Any] = Field(..., alias="chunkPlan")
    execution: BackfillExecutionPlan
    options: BackfillPlanOptions
    policy: BackfillPlanPolicy
    limits: BackfillPlanLimits

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


class BackfillChunkProgress(BaseModel):
    status: BackfillChunkStatus
    query_id: str | None = Field(default=None, alias="queryId")
    written_rows: int | None = Field(default=None, alias="writtenRows")
    written_bytes: int | None = Field(default=None, alias="writtenBytes")
    duration_ms: int | None = Field(default=None, alias="durationMs")
    last_error: str | None = Field(default=None, alias="lastError")
    attempts: int | None = None

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


class BackfillRunState(BaseModel):
    plan_id: str = Field(..., alias="planId")
    target: str
    status: BackfillRunStatus
    started_at: str = Field(..., alias="startedAt")
    updated_at: str = Field(..., alias="updatedAt")
    completed_at: str | None = Field(default=None, alias="completedAt")
    last_error: str | None = Field(default=None, alias="lastError")
    progress: dict[str, BackfillChunkProgress] = Field(default_factory=dict)

    model_config = ConfigDict(frozen=False, extra="ignore", populate_by_name=True)


class BackfillStatusTotals(BaseModel):
    total: int = 0
    pending: int = 0
    submitted: int = 0
    running: int = 0
    done: int = 0
    failed: int = 0

    model_config = ConfigDict(frozen=True, extra="forbid")


class BackfillStatusSummary(BaseModel):
    plan_id: str = Field(..., alias="planId")
    target: str
    status: BackfillPlanStatus
    totals: BackfillStatusTotals
    rows_written: int = Field(..., alias="rowsWritten")
    updated_at: str = Field(..., alias="updatedAt")
    run_path: str = Field(..., alias="runPath")
    last_error: str | None = Field(default=None, alias="lastError")

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


class BackfillPathSet(BaseModel):
    state_dir: str = Field(..., alias="stateDir")
    plans_dir: str = Field(..., alias="plansDir")
    runs_dir: str = Field(..., alias="runsDir")
    plan_path: str = Field(..., alias="planPath")
    run_path: str = Field(..., alias="runPath")

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)


__all__ = [
    "BackfillChunkProgress",
    "BackfillChunkStatus",
    "BackfillEnvironment",
    "BackfillExecutionPlan",
    "BackfillPathSet",
    "BackfillPlanLimits",
    "BackfillPlanOptions",
    "BackfillPlanPolicy",
    "BackfillPlanState",
    "BackfillPlanStatus",
    "BackfillRunState",
    "BackfillRunStatus",
    "BackfillStatusSummary",
    "BackfillStatusTotals",
]
