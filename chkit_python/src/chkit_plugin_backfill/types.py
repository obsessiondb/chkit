"""Pydantic models for backfill plan/run state.

1:1 port of ``packages/plugin-backfill/src/types.ts``, including the typed
``ChunkPlan`` payload from the Phase-2 chunking engine.
"""

from __future__ import annotations

from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field

from chkit_plugin_backfill.chunking.types import ChunkPlan

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
    # One `SELECT` per materialized view feeding the target table. mv_replay
    # inserts all of them (via `UNION ALL`) so every MV's rows are rebuilt.
    mv_replay_queries: list[str] | None = Field(
        default=None, alias="mvReplayQueries"
    )
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
    """Persisted plan blob (``<state_dir>/plans/<plan_id>.json``)."""

    plan_id: str = Field(..., alias="planId")
    target: str
    created_at: str = Field(..., alias="createdAt")
    environment: BackfillEnvironment | None = None
    from_: str = Field(..., alias="from")
    to: str
    chunk_plan: ChunkPlan = Field(..., alias="chunkPlan")
    execution: BackfillExecutionPlan
    options: BackfillPlanOptions
    policy: BackfillPlanPolicy
    limits: BackfillPlanLimits

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


class BackfillChunkProgress(BaseModel):
    """Per-chunk execution state (TS ``BackfillChunkState``)."""

    status: BackfillChunkStatus
    query_id: str | None = Field(default=None, alias="queryId")
    submitted_at: str | None = Field(default=None, alias="submittedAt")
    finished_at: str | None = Field(default=None, alias="finishedAt")
    read_rows: int | None = Field(default=None, alias="readRows")
    read_bytes: int | None = Field(default=None, alias="readBytes")
    written_rows: int | None = Field(default=None, alias="writtenRows")
    written_bytes: int | None = Field(default=None, alias="writtenBytes")
    elapsed_ms: int | None = Field(default=None, alias="elapsedMs")
    duration_ms: int | None = Field(default=None, alias="durationMs")
    error: str | None = None

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


BackfillChunkState: TypeAlias = BackfillChunkProgress
BackfillProgress: TypeAlias = dict[str, BackfillChunkProgress]


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


class BackfillDoctorReport(BaseModel):
    plan_id: str = Field(..., alias="planId")
    status: BackfillPlanStatus
    issue_codes: list[str] = Field(..., alias="issueCodes")
    recommendations: list[str]
    failed_chunk_ids: list[str] = Field(..., alias="failedChunkIds")

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


__all__ = [
    "BackfillChunkProgress",
    "BackfillChunkState",
    "BackfillChunkStatus",
    "BackfillDoctorReport",
    "BackfillEnvironment",
    "BackfillExecutionPlan",
    "BackfillPathSet",
    "BackfillPlanLimits",
    "BackfillPlanOptions",
    "BackfillPlanPolicy",
    "BackfillPlanState",
    "BackfillPlanStatus",
    "BackfillProgress",
    "BackfillRunState",
    "BackfillRunStatus",
    "BackfillStatusSummary",
    "BackfillStatusTotals",
]
