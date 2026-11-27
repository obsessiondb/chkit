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
    try:
        intent = read_submission_intent(**location)
    except (OSError, ValueError) as error:
        path = submission_intent_path(**location)
        msg = (
            f"The submission record {path} of plan {plan_id} cannot be read. "
            f"Nothing was submitted. If the console lists no job for plan {plan_id} "
            f"created by the interrupted submit, delete {path} and re-run."
        )
        raise ValueError(msg) from error
    if intent is None:
        return
    saved = read_plan_submission(**location)
    if saved and saved.submission and saved.submission.submission_id == intent.submission_id:
        clear_submission_intent(**location)
        return

    if intent.service_slug is not None:
        service_slug = intent.service_slug
    response = jobs_list(credentials, service_slug=service_slug)
    match = next(
        (
            job for job in response.jobs
            if job.metadata is not None
            and job.metadata.get("planId") == plan_id
            and job.metadata.get("submissionId") == intent.submission_id
        ),
        None,
    )
    if match is None:
        started_at = intent.started_at
        path = submission_intent_path(**location)
        msg = (
            f"An earlier submit of plan {plan_id} (started {started_at}) "
            f"may have created a job on service {service_slug}, and its job list shows none "
            "from that submit. Nothing was submitted. A request that timed out can still "
            "create its job later, and a re-run follows it once it is listed. Delete "
            f"{path} and re-run only once you are sure that submit ended without creating "
            f"a job for plan {plan_id}."
        )
        raise ValueError(msg)
    if saved is None:
        return
    record_backfill_submission(
        **location, target=saved.plan.target, job_id=match.id, submission_id=intent.submission_id
    )
    clear_submission_intent(**location)
