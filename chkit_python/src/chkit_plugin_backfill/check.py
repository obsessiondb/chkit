"""``on_check`` evaluation — port of ``packages/plugin-backfill/src/check.ts``."""

from __future__ import annotations

from pathlib import Path

from chkit.core import ChxResolvedConfig
from chkit.plugins import ChxCheckFinding, ChxOnCheckResult
from chkit_plugin_backfill.state import (
    compute_backfill_state_dir,
    list_plan_ids,
    read_run,
    read_submission,
)


def evaluate_backfill_check(
    *,
    config_path: str | Path,
    config: ChxResolvedConfig,
    state_dir: str | None = None,
    fail_check_on_required_pending_backfill: bool,
) -> ChxOnCheckResult:
    resolved_state_dir = compute_backfill_state_dir(config, config_path, state_dir)
    plans_dir = resolved_state_dir / "plans"
    runs_dir = resolved_state_dir / "runs"
    submissions_dir = resolved_state_dir / "submissions"

    plan_ids = list_plan_ids(plans_dir)
    if len(plan_ids) == 0:
        return ChxOnCheckResult(
            plugin="backfill",
            evaluated=True,
            ok=True,
            findings=[],
            metadata={
                "requiredCount": 0,
                "activeRuns": 0,
                "failedRuns": 0,
                "submittedCount": 0,
            },
        )

    required_count = 0
    active_runs = 0
    failed_runs = 0
    submitted_count = 0
    unconfirmed_count = 0

    for plan_id in plan_ids:
        run_path = runs_dir / f"{plan_id}.json"
        run = read_run(run_path)
        if run is None:
            # A managed job runs on the backend and never writes a local run.
            # Its backend's plugin (e.g. ObsessionDB) checks whether the job
            # completed, so it is not pending here. A local run, if any, still
            # wins.
            submission = read_submission(submissions_dir / f"{plan_id}.json")
            if submission is None:
                required_count += 1
            else:
                submitted_count += 1
                unconfirmed_count += int(submission.status != "completed")
            continue

        if run.status == "running":
            active_runs += 1
        if run.status == "failed":
            failed_runs += 1
        if run.status != "completed":
            required_count += 1

    findings: list[ChxCheckFinding] = []
    if required_count > 0:
        findings.append(
            ChxCheckFinding(
                code="backfill_required_pending",
                message=f"Required backfills pending completion: {required_count}",
                severity=(
                    "error" if fail_check_on_required_pending_backfill else "warn"
                ),
                metadata={"requiredCount": required_count},
            )
        )

    # Only the ObsessionDB plugin asks the jobs API whether a submitted job
    # completed. Without it an unconfirmed submitted plan would otherwise pass
    # unverified.
    if unconfirmed_count > 0 and not _has_obsessiondb_plugin(config.plugins):
        findings.append(
            ChxCheckFinding(
                code="backfill_submitted_unverified",
                message=(
                    f"Submitted backfills not verified: {unconfirmed_count}. Only the"
                    " ObsessionDB plugin checks their jobs, and it is not loaded:"
                    " register obsessiondb() in the config plugins and log in with"
                    " chkit obsessiondb login."
                ),
                severity=(
                    "error" if fail_check_on_required_pending_backfill else "warn"
                ),
                metadata={"unconfirmedCount": unconfirmed_count},
            )
        )

    if failed_runs > 0:
        findings.append(
            ChxCheckFinding(
                code="backfill_chunk_failed_retry_exhausted",
                message=f"Backfill runs failed after retry budget: {failed_runs}",
                severity="error",
                metadata={"failedRuns": failed_runs},
            )
        )

    if not fail_check_on_required_pending_backfill:
        findings.append(
            ChxCheckFinding(
                code="backfill_policy_relaxed",
                message=(
                    "Backfill check policy is relaxed:"
                    " failCheckOnRequiredPendingBackfill=false."
                ),
                severity="warn",
            )
        )

    ok = all(finding.severity != "error" for finding in findings)
    return ChxOnCheckResult(
        plugin="backfill",
        evaluated=True,
        ok=ok,
        findings=findings,
        metadata={
            "requiredCount": required_count,
            "activeRuns": active_runs,
            "failedRuns": failed_runs,
            "submittedCount": submitted_count,
        },
    )


def _has_obsessiondb_plugin(plugins: list[object]) -> bool:
    return any(
        getattr(getattr(plugin, "manifest", None), "name", None) == "obsessiondb"
        for plugin in plugins
    )


__all__ = ["evaluate_backfill_check"]
