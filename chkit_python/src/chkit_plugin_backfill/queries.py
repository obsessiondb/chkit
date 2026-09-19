"""Status / cancel / doctor state queries — port of ``packages/plugin-backfill/src/queries.ts``."""

from __future__ import annotations

from pathlib import Path

from chkit.core import ChxResolvedConfig
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.state import (
    backfill_paths,
    now_iso,
    read_plan,
    read_run,
    summarize_run_status,
    write_json,
)
from chkit_plugin_backfill.types import (
    BackfillDoctorReport,
    BackfillPlanState,
    BackfillStatusSummary,
    BackfillStatusTotals,
)


def _planned_summary(
    plan: BackfillPlanState, run_path: str
) -> BackfillStatusSummary:
    total = len(plan.chunk_plan.chunks)
    return BackfillStatusSummary(
        plan_id=plan.plan_id,
        target=plan.target,
        status="planned",
        totals=BackfillStatusTotals(
            total=total, pending=total, submitted=0, running=0, done=0, failed=0
        ),
        rows_written=0,
        updated_at=plan.created_at,
        run_path=run_path,
    )


def get_backfill_status(
    *,
    plan_id: str,
    config_path: str | Path,
    config: ChxResolvedConfig,
    state_dir: str | None = None,
) -> BackfillStatusSummary:
    plan, _plan_path, resolved_state_dir = read_plan(
        plan_id=plan_id,
        config_path=config_path,
        config=config,
        state_dir=state_dir,
    )
    paths = backfill_paths(resolved_state_dir, plan.plan_id)
    run = read_run(paths.run_path)

    if run is None:
        return _planned_summary(plan, paths.run_path)

    return summarize_run_status(run, paths.run_path, plan)


def cancel_backfill_run(
    *,
    plan_id: str,
    config_path: str | Path,
    config: ChxResolvedConfig,
    state_dir: str | None = None,
) -> BackfillStatusSummary:
    plan, _plan_path, resolved_state_dir = read_plan(
        plan_id=plan_id,
        config_path=config_path,
        config=config,
        state_dir=state_dir,
    )
    paths = backfill_paths(resolved_state_dir, plan.plan_id)
    run = read_run(paths.run_path)

    if run is None:
        msg = (
            f"Run state not found for plan {plan.plan_id}. "
            "Start with backfill run before cancel."
        )
        raise BackfillConfigError(msg)
    if run.status == "completed":
        msg = f"Run already completed for plan {plan.plan_id}; cannot cancel."
        raise BackfillConfigError(msg)
    if run.status == "cancelled":
        return summarize_run_status(run, paths.run_path, plan)

    run.status = "cancelled"
    run.completed_at = now_iso()
    run.last_error = "Cancelled by operator"

    write_json(paths.run_path, run)

    return summarize_run_status(run, paths.run_path, plan)


def get_backfill_doctor_report(
    *,
    plan_id: str,
    config_path: str | Path,
    config: ChxResolvedConfig,
    state_dir: str | None = None,
) -> BackfillDoctorReport:
    plan, _plan_path, resolved_state_dir = read_plan(
        plan_id=plan_id,
        config_path=config_path,
        config=config,
        state_dir=state_dir,
    )
    paths = backfill_paths(resolved_state_dir, plan.plan_id)
    run = read_run(paths.run_path)

    status = (
        summarize_run_status(run, paths.run_path, plan)
        if run is not None
        else _planned_summary(plan, paths.run_path)
    )

    issue_codes: list[str] = []
    recommendations: list[str] = []
    failed_chunk_ids: list[str] = []

    if run is not None:
        for chunk_id, state in run.progress.items():
            if state.status == "failed":
                failed_chunk_ids.append(chunk_id)

    if status.status == "planned":
        issue_codes.append("backfill_plan_missing")
        recommendations.append(
            f"Run: chkit plugin backfill run --plan-id {status.plan_id}"
        )
    if status.status == "failed":
        issue_codes.append("backfill_chunk_failed_retry_exhausted")
        recommendations.append(
            f"Inspect status: chkit plugin backfill status --plan-id {status.plan_id}"
        )
        recommendations.append(
            "Retry failed chunks: chkit plugin backfill resume --plan-id "
            f"{status.plan_id} --replay-failed"
        )
    if status.status == "cancelled":
        issue_codes.append("backfill_required_pending")
        recommendations.append(
            "Resume execution: chkit plugin backfill resume --plan-id "
            f"{status.plan_id} --replay-failed"
        )
    if status.status == "running":
        issue_codes.append("backfill_required_pending")
        recommendations.append(
            f"Monitor progress: chkit plugin backfill status --plan-id {status.plan_id}"
        )
    if len(issue_codes) == 0:
        recommendations.append("No remediation required.")

    return BackfillDoctorReport(
        plan_id=status.plan_id,
        status=status.status,
        issue_codes=issue_codes,
        recommendations=recommendations,
        failed_chunk_ids=failed_chunk_ids,
    )


__all__ = [
    "cancel_backfill_run",
    "get_backfill_doctor_report",
    "get_backfill_status",
]
