"""Text and ``--json`` renderings of the remote backfill job commands.

1:1 port of ``packages/plugin-obsessiondb/src/backfill/job-output.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from chkit_plugin_obsessiondb.jobs_api import JobDetail, JobsListResponse
from chkit_plugin_obsessiondb.json_envelope import JSON_CONTRACT_VERSION


@dataclass(frozen=True)
class JobOutput:
    """Text and ``--json`` renderings of one remote job command result."""

    text: str
    json: dict[str, Any]


def job_status_output(job: JobDetail, url: str | None) -> JobOutput:
    last_error = _last_run_error(job)
    lines = [
        f"Backfill job {job.id} ({job.target}): {job.status}",
        f"Tasks: {job.completed_tasks}/{job.total_tasks} completed, "
        f"{job.failed_tasks} failed",
    ]
    if last_error:
        lines.append(f"Last error: {last_error}")
    if url:
        lines.append(f"Track progress: {url}")
    return JobOutput(
        text="\n".join(lines),
        json={
            "command": "backfill status",
            "schemaVersion": JSON_CONTRACT_VERSION,
            "ok": True,
            "job": job.model_dump(by_alias=True),
            "lastError": last_error,
            "url": url,
        },
    )


def job_list_output(
    command: str, service_slug: str, result: JobsListResponse
) -> JobOutput:
    if not result.jobs:
        text = f"No backfill jobs for service {service_slug}."
    else:
        text = "\n".join(
            [
                f"Backfill jobs for service {service_slug} ({result.total}):",
                *(
                    f"- {job.id} {job.target}: {job.status} "
                    f"({job.completed_tasks}/{job.total_tasks} completed, "
                    f"{job.failed_tasks} failed)"
                    for job in result.jobs
                ),
            ]
        )
    return JobOutput(
        text=text,
        json={
            "command": command,
            "schemaVersion": JSON_CONTRACT_VERSION,
            "ok": True,
            "serviceSlug": service_slug,
            "jobs": [job.model_dump(by_alias=True) for job in result.jobs],
            "total": result.total,
        },
    )


def job_cancel_output(job_id: str, url: str | None) -> JobOutput:
    lines = [f"Cancellation requested for backfill job {job_id}."]
    if url:
        lines.append(f"Track progress: {url}")
    return JobOutput(
        text="\n".join(lines),
        json={
            "command": "backfill cancel",
            "schemaVersion": JSON_CONTRACT_VERSION,
            "ok": True,
            "jobId": job_id,
            "url": url,
        },
    )


def _last_run_error(job: JobDetail) -> str | None:
    """The error of the most recently finished failed run across all tasks."""
    latest: tuple[str, str] | None = None
    for task in job.tasks:
        for run in task.get("runs") or []:
            error = run.get("error")
            if not error:
                continue
            at = run.get("finishedAt") or run.get("startedAt") or ""
            if latest is None or at >= latest[1]:
                latest = (error, at)
    return latest[0] if latest else None


__all__ = [
    "JobOutput",
    "job_cancel_output",
    "job_list_output",
    "job_status_output",
]
