"""Re-submit a saved backfill plan.

Port of ``packages/plugin-obsessiondb/src/backfill/resubmit.ts``.

``backfill submit --plan-id <id>`` re-submits only a plan whose job failed or
was cancelled, and only with the chunks whose task did not finish in that job,
so no chunk is written twice.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from chkit_plugin_backfill.sdk import BackfillPlanState, read_plan_submission
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.jobs_api import jobs_get


@dataclass(frozen=True)
class ReplacedJob:
    id: str
    status: Literal["failed", "cancelled"]


@dataclass(frozen=True)
class ResubmitPlan:
    plan: BackfillPlanState
    replaced_job: ReplacedJob
    # Chunks left out because they finished in the replaced job.
    skipped_chunks: int


def load_plan_for_resubmit(
    *,
    plan_id: str,
    config_path: str | Path,
    config: Any,
    credentials: Credentials,
    state_dir: str | None = None,
) -> ResubmitPlan:
    """Load a saved plan for ``submit --plan-id`` once its job failed or was cancelled."""
    saved = read_plan_submission(
        plan_id=plan_id, config_path=config_path, config=config, state_dir=state_dir
    )
    if saved is None:
        msg = (
            f"Backfill plan {plan_id} not found. Submit a new backfill with"
            " --target or --cutover instead."
        )
        raise ValueError(msg)
    submission = saved.submission
    if submission is None:
        msg = (
            f"Backfill plan {plan_id} was never submitted. Submit a new backfill"
            " with --target or --cutover, or run the plan locally with --local."
        )
        raise ValueError(msg)

    job_id = submission.job_id
    job = jobs_get(credentials, job_id=job_id)
    match job.status:
        case "failed" | "cancelled":
            replaced_job = ReplacedJob(job_id, job.status)
        case _:
            msg = (
                f"Job {job_id} for plan {plan_id} is {job.status}. Only a failed or"
                " cancelled job can be re-submitted."
            )
            raise ValueError(msg)

    # Task ids are the chunk ids sent by submit.
    finished = {
        task.get("id")
        for task in job.tasks
        if any(
            run.get("type") == "insert" and run.get("status") == "done"
            for run in task.get("runs") or []
        )
    }
    plan = saved.plan
    remaining = [chunk for chunk in plan.chunk_plan.chunks if chunk.id not in finished]
    if not remaining:
        msg = (
            f"Every chunk of plan {plan_id} already finished in job {job_id}."
            " Nothing to re-submit."
        )
        raise ValueError(msg)
    return ResubmitPlan(
        plan=plan.model_copy(
            update={
                "chunk_plan": plan.chunk_plan.model_copy(update={"chunks": remaining})
            }
        ),
        replaced_job=replaced_job,
        skipped_chunks=len(plan.chunk_plan.chunks) - len(remaining),
    )


__all__ = [
    "ReplacedJob",
    "ResubmitPlan",
    "load_plan_for_resubmit",
]
