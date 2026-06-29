"""Pydantic-validated option models for the backfill plugin.

1:1 port of ``packages/plugin-backfill/src/options.ts``. The TS module uses
Zod schemas + coercion helpers tied to its CLI flag pipeline. Python uses
Pydantic models + standalone coercion helpers; the runtime calls the helpers
when promoting CLI flags into the option dict.

Defaults match TS exactly.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from chkit_plugin_backfill.errors import BackfillConfigError

_GiB = 1024**3

# ---------- coercion helpers ----------


def _normalize_timestamp(raw: str, flag_name: str) -> str:
    value = raw.strip()
    if not value:
        msg = f"Missing value for {flag_name}"
        raise BackfillConfigError(msg)
    try:
        normalised = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalised)
    except ValueError as error:
        msg = f"Invalid timestamp for {flag_name}: {raw}"
        raise BackfillConfigError(msg) from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    # Same shape as JS Date.toISOString(): always UTC + millisecond precision + 'Z'.
    utc = parsed.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


_TARGET_RE = re.compile(r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")


def _normalize_target(raw: str) -> str:
    value = raw.strip()
    if not _TARGET_RE.match(value):
        msg = "Invalid value for --target. Expected <database.table>."
        raise BackfillConfigError(msg)
    return value


_BYTE_SUFFIXES: dict[str, int] = {
    "T": 1024**4,
    "G": 1024**3,
    "M": 1024**2,
    "K": 1024,
}
_BYTE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*([TGMK])?$")


def parse_byte_size(raw: str) -> int:
    trimmed = raw.strip().upper()
    match = _BYTE_RE.match(trimmed)
    if not match:
        msg = f"Invalid byte size: {raw}. Expected a number with optional suffix (K, M, G, T)."
        raise BackfillConfigError(msg)
    value = float(match.group(1))
    suffix = match.group(2)
    multiplier = _BYTE_SUFFIXES.get(suffix, 1) if suffix else 1
    result = value * multiplier
    if result <= 0:
        msg = f"Invalid byte size: {raw}. Must be a positive number."
        raise BackfillConfigError(msg)
    return int(result)


_PLAN_ID_RE = re.compile(r"^[a-f0-9]{16}$")


def _normalize_plan_id(raw: str) -> str:
    value = raw.strip()
    if not _PLAN_ID_RE.match(value):
        msg = "Invalid value for --plan-id. Expected a 16-char lowercase hex id."
        raise BackfillConfigError(msg)
    return value


def _coerce_positive_int(raw: str, flag: str) -> int:
    try:
        parsed = float(raw)
    except ValueError as error:
        msg = f"Invalid value for {flag}. Expected integer > 0."
        raise BackfillConfigError(msg) from error
    if parsed <= 0 or not parsed.is_integer():
        msg = f"Invalid value for {flag}. Expected integer > 0."
        raise BackfillConfigError(msg)
    return int(parsed)


# ---------- option models ----------


class PluginConfig(BaseModel):
    """User-supplied options to ``backfill({...})``. All fields optional."""

    max_chunk_bytes: int | None = Field(default=None, alias="maxChunkBytes", gt=0)
    max_retries_per_chunk: int | None = Field(default=None, alias="maxRetriesPerChunk", gt=0)
    retry_delay_ms: int | None = Field(default=None, alias="retryDelayMs", ge=0)
    max_parallel_chunks: int | None = Field(default=None, alias="maxParallelChunks", gt=0)
    require_idempotency_token: bool | None = Field(default=None, alias="requireIdempotencyToken")
    chunk_hours: float | None = Field(default=None, alias="chunkHours", gt=0)
    time_column: str | None = Field(default=None, alias="timeColumn", min_length=1)
    require_dry_run_before_run: bool | None = Field(default=None, alias="requireDryRunBeforeRun")
    require_explicit_window: bool | None = Field(default=None, alias="requireExplicitWindow")
    block_overlapping_runs: bool | None = Field(default=None, alias="blockOverlappingRuns")
    fail_check_on_required_pending_backfill: bool | None = Field(
        default=None, alias="failCheckOnRequiredPendingBackfill"
    )
    max_window_hours: float | None = Field(default=None, alias="maxWindowHours", gt=0)
    min_chunk_minutes: float | None = Field(default=None, alias="minChunkMinutes", gt=0)
    state_dir: str | None = Field(default=None, alias="stateDir", min_length=1)

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)


class PlanOptions(BaseModel):
    target: str
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    max_chunk_bytes: int = Field(default=10 * _GiB, alias="maxChunkBytes", gt=0)
    max_parallel_chunks: int = Field(default=1, alias="maxParallelChunks", gt=0)
    max_retries_per_chunk: int = Field(default=3, alias="maxRetriesPerChunk", gt=0)
    require_idempotency_token: bool = Field(default=True, alias="requireIdempotencyToken")
    require_explicit_window: bool = Field(default=True, alias="requireExplicitWindow")
    block_overlapping_runs: bool = Field(default=True, alias="blockOverlappingRuns")
    require_dry_run_before_run: bool = Field(default=True, alias="requireDryRunBeforeRun")
    fail_check_on_required_pending_backfill: bool = Field(
        default=True, alias="failCheckOnRequiredPendingBackfill"
    )
    max_window_hours: float = Field(default=720, alias="maxWindowHours", gt=0)
    min_chunk_minutes: float = Field(default=15, alias="minChunkMinutes", gt=0)
    chunk_hours: float | None = Field(default=None, alias="chunkHours", gt=0)
    time_column: str | None = Field(default=None, alias="timeColumn", min_length=1)
    state_dir: str | None = Field(default=None, alias="stateDir", min_length=1)

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)


class RunOptions(BaseModel):
    plan_id: str = Field(..., alias="planId")
    force_environment: bool = Field(default=False, alias="forceEnvironment")
    concurrency: int = Field(default=3, gt=0)
    poll_interval_ms: int = Field(default=5000, alias="pollIntervalMs", ge=0)
    state_dir: str | None = Field(default=None, alias="stateDir", min_length=1)

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)


class ResumeOptions(RunOptions):
    replay_failed: bool = Field(default=False, alias="replayFailed")


class StatusOptions(BaseModel):
    plan_id: str = Field(..., alias="planId")
    state_dir: str | None = Field(default=None, alias="stateDir", min_length=1)

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)


class CheckOptions(BaseModel):
    state_dir: str | None = Field(default=None, alias="stateDir", min_length=1)
    fail_check_on_required_pending_backfill: bool = Field(
        default=True, alias="failCheckOnRequiredPendingBackfill"
    )

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)


# ---------- flag definitions ----------

PLAN_FLAGS: list[dict[str, Any]] = [
    {
        "name": "--target",
        "type": "string",
        "description": "Target table (database.table)",
        "placeholder": "<database.table>",
    },
    {
        "name": "--from",
        "type": "string",
        "description": "Filter partitions starting from timestamp",
        "placeholder": "<timestamp>",
    },
    {
        "name": "--to",
        "type": "string",
        "description": "Filter partitions up to timestamp",
        "placeholder": "<timestamp>",
    },
    {
        "name": "--max-chunk-bytes",
        "type": "string",
        "description": "Max bytes per chunk (e.g. 10G, 500M)",
        "placeholder": "<bytes>",
    },
]

RUN_FLAGS: list[dict[str, Any]] = [
    {
        "name": "--plan-id",
        "type": "string",
        "description": "Plan ID to execute",
        "placeholder": "<id>",
    },
    {
        "name": "--force-environment",
        "type": "boolean",
        "description": "Skip environment mismatch checks",
    },
    {
        "name": "--concurrency",
        "type": "string",
        "description": "Max concurrent async queries",
        "placeholder": "<n>",
    },
    {
        "name": "--poll-interval",
        "type": "string",
        "description": "Polling interval in ms",
        "placeholder": "<ms>",
    },
]

RESUME_FLAGS: list[dict[str, Any]] = [
    *RUN_FLAGS,
    {
        "name": "--replay-failed",
        "type": "boolean",
        "description": "Re-execute failed chunks",
    },
]

PLAN_ID_FLAGS: list[dict[str, Any]] = [
    {
        "name": "--plan-id",
        "type": "string",
        "description": "Plan ID",
        "placeholder": "<id>",
    },
]


# ---------- flag mappings ----------

PLAN_FLAG_MAP: dict[str, dict[str, Any]] = {
    "--target": {"key": "target", "coerce": _normalize_target},
    "--from": {"key": "from", "coerce": lambda v: _normalize_timestamp(v, "--from")},
    "--to": {"key": "to", "coerce": lambda v: _normalize_timestamp(v, "--to")},
    "--max-chunk-bytes": {"key": "max_chunk_bytes", "coerce": parse_byte_size},
}

RUN_FLAG_MAP: dict[str, dict[str, Any]] = {
    "--plan-id": {"key": "plan_id", "coerce": _normalize_plan_id},
    "--force-environment": {"key": "force_environment"},
    "--concurrency": {
        "key": "concurrency",
        "coerce": lambda v: _coerce_positive_int(v, "--concurrency"),
    },
    "--poll-interval": {
        "key": "poll_interval_ms",
        "coerce": lambda v: _coerce_positive_int(v, "--poll-interval"),
    },
}

RESUME_FLAG_MAP: dict[str, dict[str, Any]] = {
    **RUN_FLAG_MAP,
    "--replay-failed": {"key": "replay_failed"},
}

PLAN_ID_FLAG_MAP: dict[str, dict[str, Any]] = {
    "--plan-id": {"key": "plan_id", "coerce": _normalize_plan_id},
}


__all__ = [
    "PLAN_FLAGS",
    "PLAN_FLAG_MAP",
    "PLAN_ID_FLAGS",
    "PLAN_ID_FLAG_MAP",
    "RESUME_FLAGS",
    "RESUME_FLAG_MAP",
    "RUN_FLAGS",
    "RUN_FLAG_MAP",
    "CheckOptions",
    "PlanOptions",
    "PluginConfig",
    "ResumeOptions",
    "RunOptions",
    "StatusOptions",
    "parse_byte_size",
]
