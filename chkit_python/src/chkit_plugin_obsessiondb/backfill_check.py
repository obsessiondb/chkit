"""Verify submitted backfill jobs — port of ``packages/plugin-obsessiondb/src/backfill/check.ts``.

The backfill plugin's check leaves a submitted plan without a local run to the
job backend, so a plan only counts as done once its ObsessionDB job is
confirmed completed. A confirmation is saved in the submission marker, so
later checks of that plan make no network call.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from chkit.plugins import ChxCheckFinding
from chkit_plugin_backfill.sdk import (
    RemoteSubmission,
    confirm_backfill_submission,
    list_remote_submissions,
)
from chkit_plugin_backfill.types import BackfillSubmissionState
from chkit_plugin_obsessiondb.credentials import (
    Credentials,
    load_credentials,
    resolve_base_url,
)
from chkit_plugin_obsessiondb.jobs_api import JobDetail, jobs_get

JobOutcome = Literal["confirmed", "incomplete", "failed", "unverified"]


@dataclass
class BackfillJobCounts:
    submitted: int = 0
    confirmed: int = 0
    incomplete: int = 0
    failed: int = 0
    unverified: int = 0

    def to_metadata(self) -> dict[str, int]:
        return {
            "submitted": self.submitted,
            "confirmed": self.confirmed,
            "incomplete": self.incomplete,
            "failed": self.failed,
            "unverified": self.unverified,
        }


@dataclass
class BackfillJobCheck:
    findings: list[ChxCheckFinding] = field(default_factory=list)
    counts: BackfillJobCounts = field(default_factory=BackfillJobCounts)


def check_submitted_backfill_jobs(
    *, config: Any, config_path: str | Path, state_dir: str | None = None
) -> BackfillJobCheck | None:
    """Check every submitted plan's job; ``None`` when nothing was submitted.

    ``state_dir`` is the backfill plugin's ``stateDir``, where ``submit``
    saves plans and markers.
    """
    submissions = list_remote_submissions(
        config_path=config_path, config=config, state_dir=state_dir
    )
    if not submissions:
        return None

    needs_backend = any(
        entry.submission.status != "completed" for entry in submissions
    )
    stored = load_credentials() if needs_backend else None
    credentials = (
        Credentials(
            access_token=stored.access_token,
            base_url=resolve_base_url(stored.base_url),
        )
        if stored is not None
        else None
    )

    result = BackfillJobCheck(counts=BackfillJobCounts(submitted=len(submissions)))
    for entry in submissions:
        outcome, finding = _verify_submission(entry, credentials)
        setattr(result.counts, outcome, getattr(result.counts, outcome) + 1)
        if finding is not None:
            result.findings.append(finding)
    return result


def _verify_submission(
    entry: RemoteSubmission, credentials: Credentials | None
) -> tuple[JobOutcome, ChxCheckFinding | None]:
    submission = entry.submission
    if submission.status == "completed":
        return "confirmed", None
    if credentials is None:
        return _unverified(submission, "Not logged in to ObsessionDB.")

    try:
        job = jobs_get(credentials, job_id=submission.job_id)
    except Exception as error:  # any API failure leaves the job unverified
        return _unverified(submission, str(error))

    label = f"ObsessionDB backfill job {submission.job_id} (plan {submission.plan_id})"
    if job.status == "completed":
        confirm_backfill_submission(
            submission_path=entry.submission_path, submission=submission
        )
        return "confirmed", None
    if job.status in ("failed", "cancelled"):
        last_error = _find_last_error(job)
        verb = "was cancelled" if job.status == "cancelled" else "failed"
        detail = f": {last_error}" if last_error else ""
        return "failed", ChxCheckFinding(
            code="obsessiondb_backfill_job_failed",
            message=(
                f"{label} {verb}{detail}. Inspect it with chkit plugin backfill"
                f" status --job-id {submission.job_id}, then re-submit the plan"
                " with chkit plugin backfill submit --plan-id"
                f" {submission.plan_id}, or run the plan locally with --local."
            ),
            severity="error",
        )
    return "incomplete", ChxCheckFinding(
        code="obsessiondb_backfill_job_incomplete",
        message=(
            f"{label} is {job.status} ({job.completed_tasks}/{job.total_tasks}"
            " tasks completed). Re-run chkit check once it completes; follow it"
            f" with chkit plugin backfill status --job-id {submission.job_id}."
        ),
        severity="error",
    )


def _unverified(
    submission: BackfillSubmissionState, reason: str
) -> tuple[JobOutcome, ChxCheckFinding]:
    sentence = re.sub(r"\.?$", ".", reason, count=1)
    return "unverified", ChxCheckFinding(
        code="obsessiondb_backfill_job_unverified",
        message=(
            f"Cannot verify ObsessionDB backfill job {submission.job_id}"
            f" (plan {submission.plan_id}): {sentence} Log in with chkit"
            " obsessiondb login, or check the job with chkit plugin backfill"
            f" status --job-id {submission.job_id}."
        ),
        severity="error",
    )


def _find_last_error(job: JobDetail) -> str | None:
    errors = [
        run["error"]
        for task in job.tasks
        for run in task.get("runs") or []
        if isinstance(run, dict) and isinstance(run.get("error"), str) and run["error"]
    ]
    return errors[-1] if errors else None


__all__ = [
    "BackfillJobCheck",
    "BackfillJobCounts",
    "check_submitted_backfill_jobs",
]
