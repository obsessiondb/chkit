"""Recover a possibly accepted managed submit while holding the plan's lock."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from chkit_plugin_backfill.sdk import (
    clear_submission_intent,
    read_plan_submission,
    read_submission_intent,
    record_backfill_submission,
    submission_intent_path,
)
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.jobs_api import jobs_list


def reconcile_submission_intent(
    *,
    plan_id: str,
    service_slug: str,
    config_path: str | Path,
    config: Any,
    state_dir: str | None = None,
    credentials: Credentials,
) -> None:
    location = {
        "plan_id": plan_id,
        "config_path": config_path,
        "config": config,
        "state_dir": state_dir,
    }
    intent = read_submission_intent(**location)
    if intent is None:
        return
    saved = read_plan_submission(**location)
    if saved is None:
        return

    response = jobs_list(credentials, service_slug=service_slug)
    listed = response.jobs
    match = next(
        (
            job for job in listed
            if job.metadata is not None
            and job.metadata.get("planId") == plan_id
            and job.metadata.get("submissionId") == intent.submission_id
        ),
        None,
    )
    if match is not None:
        record_backfill_submission(**location, target=saved.plan.target, job_id=match.id)
    else:
        reason = None
        if len(listed) != response.total:
            reason = f"it lists {len(listed)} of {response.total} jobs"
        elif saved.submission is not None:
            marker_job_id = saved.submission.job_id
            if not any(
                job.id == marker_job_id and (job.metadata or {}).get("planId") == plan_id
                for job in listed
            ):
                reason = f"it does not list job {marker_job_id} of this plan"
        elif not any(isinstance((job.metadata or {}).get("planId"), str) for job in listed):
            reason = "it returns no plan metadata"
        if reason is not None:
            started_at = intent.started_at
            path = submission_intent_path(**location)
            msg = (
                f"An earlier submit of plan {plan_id} (started {started_at}) "
                f"may have created a job, and the job list of service {service_slug} "
                f"cannot show whether it did ({reason}). "
                f"Nothing was submitted. If the console lists no job for plan {plan_id} "
                f"created since {started_at}, delete {path} and re-run."
            )
            raise ValueError(msg)
    clear_submission_intent(**location)
