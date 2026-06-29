"""Jobs oRPC client (used for backfill status / cancel / list)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

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


class Job(BaseModel):
    """Subset of the jobs.get / jobs.list row shape."""

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)

    id: str
    service_slug: str
    status: JobStatus
    submitted_at: str | None = None
    completed_at: str | None = None
    error: str | None = None
    plan: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


class JobsListResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    jobs: list[Job]


def jobs_get(creds: Credentials, *, job_id: str) -> Job:
    body = _rpc_post(creds, "jobs/get", {"jobId": job_id})
    return Job.model_validate(body)


def jobs_list(creds: Credentials, *, service_slug: str) -> list[Job]:
    body = _rpc_post(creds, "jobs/list", {"serviceSlug": service_slug})
    parsed = JobsListResponse.model_validate(body)
    return parsed.jobs


def jobs_cancel(creds: Credentials, *, job_id: str) -> Job:
    body = _rpc_post(creds, "jobs/cancel", {"jobId": job_id})
    return Job.model_validate(body)
