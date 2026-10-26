"""Backfill ``on_check`` tests — port of ``packages/plugin-backfill/src/check.test.ts``."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit_plugin_backfill.check import evaluate_backfill_check
from chkit_plugin_backfill.state import (
    backfill_paths,
    compute_backfill_state_dir,
    read_submission,
    record_backfill_submission,
    write_json,
)
from chkit_plugin_backfill.types import BackfillRunState, BackfillRunStatus

PLAN_ID = "0123456789abcdef"
TARGET = "app.events"


def test_fails_on_a_saved_plan_with_no_local_run(tmp_path: Path) -> None:
    config, config_path, _state_dir = _setup_plan(tmp_path)

    result = evaluate_backfill_check(
        config_path=config_path,
        config=config,
        fail_check_on_required_pending_backfill=True,
    )

    assert result.ok is False
    assert [finding.code for finding in result.findings] == ["backfill_required_pending"]
    assert result.metadata == {
        "requiredCount": 1,
        "activeRuns": 0,
        "failedRuns": 0,
        "submittedCount": 0,
    }


def test_passes_on_a_plan_submitted_to_a_managed_job_backend_and_names_its_job(
    tmp_path: Path,
) -> None:
    config, config_path, _state_dir = _setup_plan(tmp_path)
    record_backfill_submission(
        plan_id=PLAN_ID, target=TARGET, job_id="job-123", config_path=config_path, config=config
    )

    result = evaluate_backfill_check(
        config_path=config_path,
        config=config,
        fail_check_on_required_pending_backfill=True,
    )

    assert result.ok is True
    assert result.metadata == {
        "requiredCount": 0,
        "activeRuns": 0,
        "failedRuns": 0,
        "submittedCount": 1,
    }
    [finding] = result.findings
    assert finding.code == "backfill_submitted_remote"
    assert finding.severity == "info"
    assert finding.metadata == {"submittedCount": 1, "jobIds": ["job-123"]}
    assert "status --job-id" in finding.message


def test_still_fails_on_an_unsubmitted_plan_next_to_a_submitted_one(
    tmp_path: Path,
) -> None:
    config, config_path, state_dir = _setup_plan(tmp_path)
    write_json(backfill_paths(state_dir, "fedcba9876543210").plan_path, {})
    record_backfill_submission(
        plan_id=PLAN_ID, target=TARGET, job_id="job-123", config_path=config_path, config=config
    )

    result = evaluate_backfill_check(
        config_path=config_path,
        config=config,
        fail_check_on_required_pending_backfill=True,
    )

    assert result.ok is False
    assert [finding.code for finding in result.findings] == [
        "backfill_required_pending",
        "backfill_submitted_remote",
    ]
    assert result.metadata is not None
    assert result.metadata["requiredCount"] == 1
    assert result.metadata["submittedCount"] == 1


def test_judges_a_submitted_plan_by_its_local_run_once_one_exists(
    tmp_path: Path,
) -> None:
    config, config_path, state_dir = _setup_plan(tmp_path)
    record_backfill_submission(
        plan_id=PLAN_ID, target=TARGET, job_id="job-123", config_path=config_path, config=config
    )
    _write_run(state_dir, "failed")

    failed = evaluate_backfill_check(
        config_path=config_path,
        config=config,
        fail_check_on_required_pending_backfill=True,
    )
    assert failed.ok is False
    assert failed.metadata == {
        "requiredCount": 1,
        "activeRuns": 0,
        "failedRuns": 1,
        "submittedCount": 0,
    }

    _write_run(state_dir, "completed")
    completed = evaluate_backfill_check(
        config_path=config_path,
        config=config,
        fail_check_on_required_pending_backfill=True,
    )
    assert completed.ok is True
    assert completed.findings == []
    assert completed.metadata == {
        "requiredCount": 0,
        "activeRuns": 0,
        "failedRuns": 0,
        "submittedCount": 0,
    }


def test_record_backfill_submission_writes_the_job_id_in_a_custom_state_dir(
    tmp_path: Path,
) -> None:
    config, config_path, _state_dir = _setup_plan(tmp_path, "./backfill-state")

    submission_path = record_backfill_submission(
        plan_id=PLAN_ID,
        target=TARGET,
        job_id="job-123",
        config_path=config_path,
        config=config,
        state_dir="./backfill-state",
    )

    state_dir = compute_backfill_state_dir(config, config_path, "./backfill-state")
    assert submission_path == str(state_dir / "submissions" / f"{PLAN_ID}.json")
    submission = read_submission(submission_path)
    assert submission is not None
    assert (submission.plan_id, submission.target, submission.job_id) == (
        PLAN_ID,
        TARGET,
        "job-123",
    )
    datetime.fromisoformat(submission.submitted_at)

    result = evaluate_backfill_check(
        config_path=config_path,
        config=config,
        state_dir="./backfill-state",
        fail_check_on_required_pending_backfill=True,
    )
    assert result.ok is True


def test_submission_file_uses_the_ts_layout(tmp_path: Path) -> None:
    config, config_path, _state_dir = _setup_plan(tmp_path)

    submission_path = record_backfill_submission(
        plan_id=PLAN_ID, target=TARGET, job_id="job-123", config_path=config_path, config=config
    )

    text = Path(submission_path).read_text(encoding="utf-8")
    assert text.startswith('{\n  "planId": "0123456789abcdef",\n  "target": "app.events",\n')
    assert '\n  "jobId": "job-123",\n  "submittedAt": "' in text
    assert text.endswith('"\n}\n')


def _setup_plan(
    tmp_path: Path, state_dir_option: str | None = None
) -> tuple[ChxResolvedConfig, Path, Path]:
    config = ChxResolvedConfig(
        schema_=["./schema.py"],
        out_dir="./out",
        migrations_dir="./m",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )
    config_path = tmp_path / "clickhouse.config.py"
    state_dir = compute_backfill_state_dir(config, config_path, state_dir_option)
    write_json(backfill_paths(state_dir, PLAN_ID).plan_path, {})
    return config, config_path, state_dir


def _write_run(state_dir: Path, status: BackfillRunStatus) -> None:
    run = BackfillRunState(
        planId=PLAN_ID,
        target=TARGET,
        status=status,
        startedAt="2026-01-01T00:00:00.000Z",
        updatedAt="2026-01-01T00:00:00.000Z",
    )
    write_json(backfill_paths(state_dir, PLAN_ID).run_path, run)
