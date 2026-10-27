"""Submitted backfill job checks — port of
``packages/plugin-obsessiondb/src/backfill/check.test.ts``. The credentials
loader and the jobs client are monkeypatched; nothing reaches the console.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedClickHouseConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import ChxOnCheckContext
from chkit_plugin_backfill.plugin import backfill
from chkit_plugin_backfill.state import record_backfill_submission, write_json
from chkit_plugin_obsessiondb import backfill_check as backfill_check_module
from chkit_plugin_obsessiondb import obsessiondb
from chkit_plugin_obsessiondb.api_client import SessionExpiredError
from chkit_plugin_obsessiondb.backfill_check import check_submitted_backfill_jobs
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.jobs_api import JobDetail

PLAN_ID = "abcdef0123456789"


def test_makes_no_call_and_reports_nothing_without_submitted_plans(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _patch_backend(monkeypatch, logged_in=True, job={"status": "completed"})

    assert check_submitted_backfill_jobs(config=_config(), config_path=_config_path(tmp_path)) is None
    assert calls == []


def test_confirms_a_completed_job_and_saves_the_confirmation_in_the_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    submission_path = _submit_plan(tmp_path)
    calls = _patch_backend(
        monkeypatch, logged_in=True, job={"status": "completed", "completedTasks": 2}
    )

    result = check_submitted_backfill_jobs(config=_config(), config_path=_config_path(tmp_path))

    assert result is not None
    assert result.findings == []
    assert result.counts.to_metadata() == {
        "submitted": 1,
        "confirmed": 1,
        "incomplete": 0,
        "failed": 0,
        "unverified": 0,
    }
    assert calls == ["job-123"]
    marker = json.loads(Path(submission_path).read_text(encoding="utf-8"))
    assert marker["status"] == "completed"
    assert (marker["planId"], marker["jobId"]) == (PLAN_ID, "job-123")
    assert list(marker) == ["planId", "target", "jobId", "submittedAt", "status", "confirmedAt"]
    datetime.fromisoformat(marker["confirmedAt"])


def test_confirms_an_already_confirmed_job_without_a_network_call_or_a_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    submission_path = _submit_plan(tmp_path)
    marker = json.loads(Path(submission_path).read_text(encoding="utf-8"))
    write_json(
        submission_path,
        {**marker, "status": "completed", "confirmedAt": "2026-01-02T00:00:00.000Z"},
    )
    calls = _patch_backend(monkeypatch, logged_in=False, job={"status": "failed"})

    result = check_submitted_backfill_jobs(config=_config(), config_path=_config_path(tmp_path))

    assert result is not None
    assert result.findings == []
    assert result.counts.confirmed == 1
    assert calls == []


def test_fails_on_a_job_that_is_still_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    submission_path = _submit_plan(tmp_path)
    _patch_backend(monkeypatch, logged_in=True, job={"status": "running", "completedTasks": 1})

    result = check_submitted_backfill_jobs(config=_config(), config_path=_config_path(tmp_path))

    assert result is not None
    assert result.counts.incomplete == 1
    [finding] = result.findings
    assert (finding.code, finding.severity) == ("obsessiondb_backfill_job_incomplete", "error")
    assert "job-123 (plan abcdef0123456789) is running (1/2 tasks completed)" in finding.message
    assert "status" not in json.loads(Path(submission_path).read_text(encoding="utf-8"))


def test_fails_on_a_failed_job_and_names_its_last_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _submit_plan(tmp_path)
    _patch_backend(
        monkeypatch,
        logged_in=True,
        job={
            "status": "failed",
            "tasks": [{"id": "task-1", "runs": [{"id": "run-1", "error": "Code: 241. Memory limit exceeded"}]}],
        },
    )

    result = check_submitted_backfill_jobs(config=_config(), config_path=_config_path(tmp_path))

    assert result is not None
    assert result.counts.failed == 1
    [finding] = result.findings
    assert (finding.code, finding.severity) == ("obsessiondb_backfill_job_failed", "error")
    assert "failed: Code: 241. Memory limit exceeded" in finding.message


def test_fails_on_a_cancelled_job(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _submit_plan(tmp_path)
    _patch_backend(monkeypatch, logged_in=True, job={"status": "cancelled"})

    result = check_submitted_backfill_jobs(config=_config(), config_path=_config_path(tmp_path))

    assert result is not None
    [finding] = result.findings
    assert finding.code == "obsessiondb_backfill_job_failed"
    assert "was cancelled" in finding.message


def test_fails_without_a_session_and_says_how_to_log_in(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _submit_plan(tmp_path)
    calls = _patch_backend(monkeypatch, logged_in=False, job={"status": "completed"})

    result = check_submitted_backfill_jobs(config=_config(), config_path=_config_path(tmp_path))

    assert calls == []
    assert result is not None
    assert result.counts.unverified == 1
    [finding] = result.findings
    assert (finding.code, finding.severity) == ("obsessiondb_backfill_job_unverified", "error")
    assert "Not logged in to ObsessionDB." in finding.message
    assert "chkit obsessiondb login" in finding.message
    assert "status --job-id job-123" in finding.message


def test_fails_when_the_session_expired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _submit_plan(tmp_path)
    monkeypatch.setattr(
        backfill_check_module,
        "load_credentials",
        lambda: Credentials(access_token="tok", base_url="https://api.example.com"),
    )

    def expired(_creds: Credentials, *, job_id: str) -> JobDetail:
        raise SessionExpiredError

    monkeypatch.setattr(backfill_check_module, "jobs_get", expired)

    result = check_submitted_backfill_jobs(config=_config(), config_path=_config_path(tmp_path))

    assert result is not None
    [finding] = result.findings
    assert finding.code == "obsessiondb_backfill_job_unverified"
    assert "Session expired" in finding.message


def test_leaves_a_submitted_plan_with_a_local_run_to_the_backfill_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _submit_plan(tmp_path)
    write_json(
        tmp_path / "chkit/meta/backfill/runs" / f"{PLAN_ID}.json",
        {
            "planId": PLAN_ID,
            "target": "app.events",
            "status": "failed",
            "startedAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "progress": {},
        },
    )
    calls = _patch_backend(monkeypatch, logged_in=True, job={"status": "running"})

    assert check_submitted_backfill_jobs(config=_config(), config_path=_config_path(tmp_path)) is None
    assert calls == []


def test_on_check_reports_submitted_jobs_for_a_non_obsessiondb_check_target_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "schema.py").write_text("")
    _submit_plan(tmp_path)
    _patch_backend(monkeypatch, logged_in=True, job={"status": "running"})
    hooks = obsessiondb().hooks
    assert hooks is not None

    result = hooks.on_check(  # type: ignore[union-attr]
        ChxOnCheckContext(
            command="check",
            config=_config("http://localhost:8123"),
            table_scope=TableScope(enabled=False),
            flags={},
            config_path=str(_config_path(tmp_path)),
        )
    )

    assert result is not None
    assert (result.plugin, result.evaluated, result.ok) == ("obsessiondb", True, False)
    assert [finding.code for finding in result.findings] == ["obsessiondb_backfill_job_incomplete"]
    assert result.metadata == {
        "backfillJobs": {
            "submitted": 1,
            "confirmed": 0,
            "incomplete": 1,
            "failed": 0,
            "unverified": 0,
        }
    }


def test_on_check_reads_submissions_from_the_backfill_plugin_state_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "schema.py").write_text("")
    state_dir = "state/backfill"
    write_json(tmp_path / state_dir / "plans" / f"{PLAN_ID}.json", {})
    record_backfill_submission(
        plan_id=PLAN_ID,
        target="app.events",
        job_id="job-123",
        config_path=_config_path(tmp_path),
        config=_config(),
        state_dir=state_dir,
    )
    _patch_backend(monkeypatch, logged_in=True, job={"status": "running"})
    hooks = obsessiondb().hooks
    assert hooks is not None

    result = hooks.on_check(  # type: ignore[union-attr]
        ChxOnCheckContext(
            command="check",
            config=_config().model_copy(
                update={"plugins": [backfill({"stateDir": state_dir})]}
            ),
            table_scope=TableScope(enabled=False),
            flags={},
            config_path=str(_config_path(tmp_path)),
        )
    )

    assert result is not None
    assert result.ok is False
    assert [finding.code for finding in result.findings] == ["obsessiondb_backfill_job_incomplete"]
    assert result.metadata is not None
    assert result.metadata["backfillJobs"]["submitted"] == 1


def _config(url: str | None = None) -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=["schema.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/migrations",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
        clickhouse=(
            ChxResolvedClickHouseConfig(
                url=url, username="default", password="", database="default", secure=False
            )
            if url
            else None
        ),
    )


def _config_path(tmp_path: Path) -> Path:
    return tmp_path / "clickhouse.config.py"


def _submit_plan(tmp_path: Path) -> str:
    write_json(tmp_path / "chkit/meta/backfill/plans" / f"{PLAN_ID}.json", {})
    return record_backfill_submission(
        plan_id=PLAN_ID,
        target="app.events",
        job_id="job-123",
        config_path=_config_path(tmp_path),
        config=_config(),
    )


def _patch_backend(
    monkeypatch: pytest.MonkeyPatch, *, logged_in: bool, job: dict[str, Any]
) -> list[str]:
    calls: list[str] = []
    monkeypatch.setattr(
        backfill_check_module,
        "load_credentials",
        lambda: Credentials(access_token="tok", base_url="https://api.example.com")
        if logged_in
        else None,
    )

    def fake_jobs_get(_creds: Credentials, *, job_id: str) -> JobDetail:
        calls.append(job_id)
        return JobDetail.model_validate(
            {
                "id": job_id,
                "serviceId": "svc-1",
                "type": "backfill",
                "target": "app.events",
                "status": "running",
                "concurrency": 4,
                "totalTasks": 2,
                "completedTasks": 0,
                "failedTasks": 0,
                "createdAt": "2026-03-29T00:00:00Z",
                "updatedAt": "2026-03-29T01:00:00Z",
                "maxRetries": 3,
                "tasks": [],
                **job,
            }
        )

    monkeypatch.setattr(backfill_check_module, "jobs_get", fake_jobs_get)
    return calls
