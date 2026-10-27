"""Re-submit a saved backfill plan.

Port of ``packages/plugin-obsessiondb/src/backfill/resubmit.ts``.

``backfill submit --plan-id <id>`` replaces a job that failed or was cancelled.
A plan without a submission marker, a job that is still active or already
completed, and a job whose status cannot be read are all refused, so the same
plan never runs as two jobs. The new job runs only the chunks that never
finished on the service: the job's task states do not show an INSERT that
finished after a cancel, so the query log is read instead.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from chkit_plugin_backfill.sdk import (
    BackfillPlanState,
    ExecutedChunks,
    find_executed_chunks,
    read_plan_submission,
)
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.jobs_api import jobs_get

ResubmitRefusalCode = Literal[
    "backfill_resubmit_invalid_flags",
    "backfill_resubmit_plan_not_found",
    "backfill_resubmit_not_submitted",
    "backfill_resubmit_job_active",
    "backfill_resubmit_job_completed",
    "backfill_resubmit_job_unverified",
    "backfill_resubmit_chunks_running",
    "backfill_resubmit_chunks_unverified",
    "backfill_resubmit_nothing_to_run",
]


class ResubmitRefusedError(Exception):
    """``submit --plan-id`` refused to start a job; ``code`` is stable for ``--json`` callers."""

    def __init__(self, code: ResubmitRefusalCode, message: str) -> None:
        super().__init__(message)
        self.code: ResubmitRefusalCode = code


@dataclass(frozen=True)
class ReplacedJob:
    id: str
    status: Literal["failed", "cancelled"]


@dataclass(frozen=True)
class ResubmitPlan:
    plan: BackfillPlanState
    replaced_job: ReplacedJob
    # Chunks left out because they already finished on the service.
    skipped_chunks: int


def load_plan_for_resubmit(
    *,
    plan_id: str,
    config_path: str | Path,
    config: Any,
    credentials: Credentials,
    executor: Any,
    state_dir: str | None = None,
) -> ResubmitPlan:
    """Load a saved plan for ``submit --plan-id`` once its job failed or was cancelled."""
    saved = read_plan_submission(
        plan_id=plan_id, config_path=config_path, config=config, state_dir=state_dir
    )
    if saved is None:
        raise ResubmitRefusedError(
            "backfill_resubmit_plan_not_found",
            f"Backfill plan {plan_id} not found. Submit a new backfill with"
            " --target or --cutover instead.",
        )
    submission = saved.submission
    if submission is None:
        raise ResubmitRefusedError(
            "backfill_resubmit_not_submitted",
            f"Backfill plan {plan_id} has no recorded submission, so chkit cannot"
            " tell whether a job already runs it. Check the service with chkit"
            " plugin backfill status --service-slug <service>, then submit a new"
            " backfill with --target or --cutover, or run the plan locally with"
            " --local.",
        )

    job_id = submission.job_id
    if submission.status == "completed":
        raise _job_completed(plan_id, job_id)

    try:
        status = jobs_get(credentials, job_id=job_id).status
    except Exception as error:  # any API failure leaves the job unverified
        raise ResubmitRefusedError(
            "backfill_resubmit_job_unverified",
            f"Cannot read the status of job {job_id} (plan {plan_id}):"
            f" {_sentence(error)} Not re-submitting, to avoid running the plan"
            " twice. Retry once the job status can be read.",
        ) from error

    match status:
        case "failed" | "cancelled":
            replaced_job = ReplacedJob(job_id, status)
        case "completed":
            raise _job_completed(plan_id, job_id)
        case _:
            raise ResubmitRefusedError(
                "backfill_resubmit_job_active",
                f"Job {job_id} for plan {plan_id} is {status}. Only a failed or"
                " cancelled job can be re-submitted; cancel it with chkit plugin"
                f" backfill cancel --job-id {job_id} first, or wait for it to"
                " finish.",
            )

    plan = saved.plan
    remaining = _remaining_chunks(plan, job_id, executor)
    return ResubmitPlan(
        plan=plan.model_copy(
            update={
                "chunk_plan": plan.chunk_plan.model_copy(update={"chunks": remaining})
            }
        ),
        replaced_job=replaced_job,
        skipped_chunks=len(plan.chunk_plan.chunks) - len(remaining),
    )


def _remaining_chunks(plan: BackfillPlanState, job_id: str, executor: Any) -> list[Any]:
    plan_id = plan.plan_id
    executed: ExecutedChunks
    try:
        executed = find_executed_chunks(
            executor=executor, plan_id=plan_id, since=plan.created_at
        )
    except Exception as error:  # any read failure leaves the chunks unverified
        raise ResubmitRefusedError(
            "backfill_resubmit_chunks_unverified",
            f"Cannot read which chunks of plan {plan_id} already ran on the"
            f" service: {_sentence(error)} Not re-submitting, to avoid writing a"
            " chunk twice. Retry once the query log can be read.",
        ) from error
    if executed.running:
        count = len(executed.running)
        noun = "query" if count == 1 else "queries"
        raise ResubmitRefusedError(
            "backfill_resubmit_chunks_running",
            f"{count} chunk {noun} of plan {plan_id} (job {job_id}) still run on"
            " the service. Retry once they finish.",
        )
    finished = set(executed.finished)
    remaining = [chunk for chunk in plan.chunk_plan.chunks if chunk.id not in finished]
    if not remaining:
        raise ResubmitRefusedError(
            "backfill_resubmit_nothing_to_run",
            f"Every chunk of plan {plan_id} already finished on the service,"
            f" although job {job_id} did not complete, so a new job would only"
            " write them again. Check the target table; if the backfill is"
            f" complete, delete plans/{plan_id}.json to clear the chkit check"
            " finding.",
        )
    return remaining


def _sentence(error: Exception) -> str:
    return re.sub(r"\.?$", ".", str(error), count=1)


def _job_completed(plan_id: str, job_id: str) -> ResubmitRefusedError:
    return ResubmitRefusedError(
        "backfill_resubmit_job_completed",
        f"Job {job_id} for plan {plan_id} already completed. Nothing to re-submit.",
    )


__all__ = [
    "ReplacedJob",
    "ResubmitPlan",
    "ResubmitRefusalCode",
    "ResubmitRefusedError",
    "load_plan_for_resubmit",
]
