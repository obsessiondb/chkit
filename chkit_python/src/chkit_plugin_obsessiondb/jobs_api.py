"""Jobs oRPC client (used for backfill submit / status / cancel / list).

Mirrors ``packages/plugin-obsessiondb/src/contract/jobs.ts``: ``get`` returns
the job detail, ``list`` returns ``{jobs, total}``, ``cancel`` returns an
empty object, ``submit`` returns ``{jobId}``. Models carry the contract's
camelCase field names via aliases and are printed with ``by_alias=True`` so
CLI output matches the TS client.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.service_api import _rpc_post

JobStatus = Literal[
    "pending",
    "running",
    "draining",
    "paused",
    "completed",
    "failed",
    "cancelled",
]


class JobSummary(BaseModel):
    """``jobSummarySchema`` from the jobs contract."""

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)

    id: str
    service_id: str = Field(..., alias="serviceId")
    title: str | None = None
    type: str
    target: str
    status: JobStatus
    concurrency: int
    task_limit: int | None = Field(default=None, alias="taskLimit")
    poll_interval_base_sec: int | None = Field(
        default=None, alias="pollIntervalBaseSec"
    )
    poll_interval_max_sec: int | None = Field(
        default=None, alias="pollIntervalMaxSec"
    )
    total_tasks: int = Field(..., alias="totalTasks")
    completed_tasks: int = Field(..., alias="completedTasks")
    failed_tasks: int = Field(..., alias="failedTasks")
    created_at: str = Field(..., alias="createdAt")
    updated_at: str = Field(..., alias="updatedAt")


class JobDetail(JobSummary):
    """``jobDetailSchema`` — summary plus retry/workflow/task breakdown."""

    max_retries: int = Field(..., alias="maxRetries")
    workflow_id: str | None = Field(default=None, alias="workflowId")
    metadata: dict[str, Any] | None = None
    # Full task rows (with runs) — kept structurally loose like the TS client,
    # which passes them through without touching individual fields.
    tasks: list[dict[str, Any]] = Field(default_factory=list)


class JobsListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)

    jobs: list[JobSummary]
    total: int = 0


class JobSubmitTask(BaseModel):
    """One task in a ``jobs/submit`` request (subset of the jobs contract)."""

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    id: str
    sql: str
    group: str | None = None
    estimated_bytes: float | None = Field(default=None, alias="estimatedBytes")
    estimated_bytes_uncompressed: float | None = Field(
        default=None, alias="estimatedBytesUncompressed"
    )
    max_retries: int | None = Field(default=None, alias="maxRetries")


def jobs_submit(
    creds: Credentials,
    *,
    service_slug: str,
    target: str,
    tasks: list[JobSubmitTask],
    title: str | None = None,
    concurrency: int | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    """``jobs/submit`` — post a backfill task list; returns the new job id."""
    payload: dict[str, Any] = {
        "serviceSlug": service_slug,
        "type": "backfill",
        "target": target,
        "tasks": [
            task.model_dump(by_alias=True, exclude_none=True) for task in tasks
        ],
    }
    if title is not None:
        payload["title"] = title
    if concurrency is not None:
        payload["concurrency"] = concurrency
    if metadata is not None:
        payload["metadata"] = metadata
    body = _rpc_post(creds, "jobs/submit", payload)
    job_id = body.get("jobId") if isinstance(body, dict) else None
    if not isinstance(job_id, str):
        msg = f"jobs/submit returned an unexpected payload: {body!r}"
        raise RuntimeError(msg)
    return job_id


def jobs_get(creds: Credentials, *, job_id: str) -> JobDetail:
    body = _rpc_post(creds, "jobs/get", {"jobId": job_id})
    return JobDetail.model_validate(body)


def jobs_list(creds: Credentials, *, service_slug: str) -> JobsListResponse:
    body = _rpc_post(creds, "jobs/list", {"serviceSlug": service_slug})
    return JobsListResponse.model_validate(body)


def jobs_cancel(creds: Credentials, *, job_id: str) -> dict[str, Any]:
    """``jobs/cancel`` returns an empty object on success (per the contract)."""
    body = _rpc_post(creds, "jobs/cancel", {"jobId": job_id})
    return dict(body) if isinstance(body, dict) else {}


__all__ = [
    "JobDetail",
    "JobStatus",
    "JobSubmitTask",
    "JobSummary",
    "JobsListResponse",
    "jobs_cancel",
    "jobs_get",
    "jobs_list",
    "jobs_submit",
]
