"""Managed backfill submit tests.

1:1 port of ``packages/plugin-obsessiondb/src/backfill/submit.test.ts``
(``buildSubmitTasks`` + ``parseSubmitInput``), plus direct ``handle_submit``
flow tests with the jobs client / remote executor / planner monkeypatched.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from typing import Any
from unittest.mock import ANY, Mock

import pytest

from chkit_plugin_backfill.chunking.boundary_codec import (
    encode_chunk_plan_for_persistence,
)
from chkit_plugin_backfill.options import PluginConfig
from chkit_plugin_backfill.planner import BuildBackfillPlanOutput
from chkit_plugin_backfill.plugin import backfill
from chkit_plugin_backfill.run_lock import RunLock
from chkit_plugin_backfill.state import record_backfill_submission, write_json
from chkit_plugin_backfill.types import BackfillPlanState
from chkit_plugin_obsessiondb import backfill_resubmit as backfill_resubmit_module
from chkit_plugin_obsessiondb import backfill_submit as backfill_submit_module
from chkit_plugin_obsessiondb import jobs_api
from chkit_plugin_obsessiondb.api_client import SessionExpiredError
from chkit_plugin_obsessiondb.backfill_submit import (
    ParsedResubmitInput,
    SubmitContext,
    build_submit_tasks,
    handle_submit,
    parse_resubmit_input,
    parse_submit_input,
)
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.jobs_api import JobDetail

BASE = "https://api.test.obsessiondb.com"


def make_plan(
    *,
    require_idempotency_token: bool = True,
    execution: dict[str, Any] | None = None,
) -> BackfillPlanState:
    """Mirror of the TS ``makePlan`` fixture (camelCase plan payload)."""
    return BackfillPlanState.model_validate(
        {
            "planId": "abcdef0123456789",
            "target": "app.events",
            "createdAt": "2026-06-30T00:00:00.000Z",
            "from": "2026-01-01T00:00:00.000Z",
            "to": "2026-02-01T00:00:00.000Z",
            "chunkPlan": {
                "planId": "abcdef0123456789",
                "generatedAt": "2026-06-30T00:00:00.000Z",
                "rowProbeStrategy": "count",
                "targetChunkBytes": 1000,
                "table": {
                    "database": "app",
                    "table": "events",
                    "sortKeys": [
                        {
                            "name": "id",
                            "type": "UInt64",
                            "category": "numeric",
                            "boundaryEncoding": "literal",
                        }
                    ],
                },
                "partitions": [],
                "chunks": [
                    {
                        "id": "c1",
                        "partitionId": "p0",
                        "ranges": [{"dimensionIndex": 0, "from": "0", "to": "100"}],
                        "estimate": {
                            "rows": 100,
                            "bytesCompressed": 1000,
                            "bytesUncompressed": 3000,
                            "confidence": "high",
                            "reason": "partition-metadata",
                        },
                        "analysis": {"lineage": []},
                    },
                    {
                        "id": "c2",
                        "partitionId": "p1",
                        "ranges": [],
                        "estimate": {
                            "rows": 50,
                            "bytesCompressed": 500,
                            "bytesUncompressed": 1500,
                            "confidence": "high",
                            "reason": "partition-metadata",
                        },
                        "analysis": {"lineage": []},
                    },
                ],
                "totalRows": 150,
                "totalBytesCompressed": 1500,
                "totalBytesUncompressed": 4500,
                "stats": {
                    "totalPartitions": 2,
                    "oversizedPartitions": 0,
                    "focusedChunks": 0,
                    "totalChunks": 2,
                    "avgChunkBytes": 750,
                    "maxChunkBytes": 1000,
                    "minChunkBytes": 500,
                },
            },
            "execution": execution
            or {
                "mode": "copy",
                "sourceTarget": "app.events",
                "requireIdempotencyToken": require_idempotency_token,
            },
            "options": {
                "maxParallelChunks": 1,
                "maxRetriesPerChunk": 5,
                "requireIdempotencyToken": require_idempotency_token,
            },
            "policy": {
                "requireDryRunBeforeRun": True,
                "requireExplicitWindow": True,
                "blockOverlappingRuns": True,
                "failCheckOnRequiredPendingBackfill": True,
            },
            "limits": {"maxWindowHours": 720, "minChunkMinutes": 15},
        }
    )


# ---------- build_submit_tasks ----------


def test_build_submit_tasks_produces_one_task_per_chunk_preserving_ids() -> None:
    tasks = build_submit_tasks(make_plan())
    assert [t.id for t in tasks] == ["c1", "c2"]


def test_build_submit_tasks_renders_same_insert_select_as_local_executor() -> None:
    first = build_submit_tasks(make_plan())[0]
    assert "INSERT INTO app.events" in first.sql
    assert "FROM app.events" in first.sql
    assert "_partition_id = 'p0'" in first.sql
    assert "id >= " in first.sql


def test_build_submit_tasks_carries_estimates_group_and_retry_budget() -> None:
    first = build_submit_tasks(make_plan())[0]
    assert first.group == "p0"
    assert first.estimated_bytes == 1000
    assert first.estimated_bytes_uncompressed == 3000
    assert first.max_retries == 5


def test_build_submit_tasks_includes_idempotency_token_when_required() -> None:
    first = build_submit_tasks(make_plan(require_idempotency_token=True))[0]
    assert "insert_deduplication_token=" in first.sql


def test_build_submit_tasks_omits_idempotency_token_when_not_required() -> None:
    first = build_submit_tasks(make_plan(require_idempotency_token=False))[0]
    assert "insert_deduplication_token=" not in first.sql


def test_build_submit_tasks_replays_every_mv_via_union_all_for_mv_replay_plan() -> None:
    plan = make_plan(
        execution={
            "mode": "mv_replay",
            "sourceTarget": "app.events",
            "mvReplayQueries": [
                "SELECT id FROM app.web_events",
                "SELECT id FROM app.api_events",
            ],
            "targetColumns": ["id"],
            "requireIdempotencyToken": True,
        }
    )

    first = build_submit_tasks(plan)[0]
    assert first.sql.count("INSERT INTO app.events") == 1
    assert "FROM app.web_events" in first.sql
    assert "FROM app.api_events" in first.sql
    assert first.sql.count("UNION ALL") == 1


# ---------- parse_submit_input ----------


def test_parse_submit_input_parses_a_valid_target() -> None:
    parsed = parse_submit_input({"--target": "app.events"})
    assert parsed.opts.target == "app.events"


def test_parse_submit_input_raises_when_target_is_missing() -> None:
    with pytest.raises(ValueError, match="--target"):
        parse_submit_input({})


def test_parse_submit_input_raises_when_target_is_not_database_table() -> None:
    with pytest.raises(ValueError, match="--target"):
        parse_submit_input({"--target": "events"})


def test_parse_submit_input_coerces_a_byte_size_suffix() -> None:
    parsed = parse_submit_input(
        {"--target": "app.events", "--max-chunk-bytes": "500M"}
    )
    assert parsed.opts.max_chunk_bytes == 500 * 1024**2


def test_parse_submit_input_normalizes_from_to_timestamps_to_iso() -> None:
    parsed = parse_submit_input({"--target": "app.events", "--from": "2026-01-01"})
    assert parsed.opts.from_ == "2026-01-01T00:00:00.000Z"


def test_parse_submit_input_raises_on_an_invalid_timestamp() -> None:
    with pytest.raises(ValueError, match="--from"):
        parse_submit_input({"--target": "app.events", "--from": "not-a-date"})


def test_parse_submit_input_accepts_a_valid_concurrency() -> None:
    parsed = parse_submit_input({"--target": "app.events", "--concurrency": "4"})
    assert parsed.concurrency == 4


def test_parse_submit_input_rejects_an_out_of_range_concurrency() -> None:
    with pytest.raises(ValueError, match="--concurrency"):
        parse_submit_input({"--target": "app.events", "--concurrency": "100"})


def test_parse_submit_input_passes_through_a_title() -> None:
    parsed = parse_submit_input({"--target": "app.events", "--title": "My backfill"})
    assert parsed.title == "My backfill"


def test_parse_submit_input_applies_the_backfill_plugin_options_like_the_local_plan() -> None:
    parsed = parse_submit_input(
        {"--target": "app.events"},
        PluginConfig.model_validate(
            {
                "stateDir": "state/backfill",
                "maxChunkBytes": 1024,
                "requireIdempotencyToken": False,
                "insertSettings": {"max_insert_threads": 4},
            }
        ),
    )
    assert parsed.opts.target == "app.events"
    assert parsed.opts.state_dir == "state/backfill"
    assert parsed.opts.max_chunk_bytes == 1024
    assert parsed.opts.require_idempotency_token is False


def test_parse_submit_input_lets_flags_override_the_backfill_plugin_options() -> None:
    parsed = parse_submit_input(
        {"--target": "app.events", "--max-chunk-bytes": "500M", "--from": "2026-01-01"},
        PluginConfig.model_validate({"stateDir": "state/backfill", "maxChunkBytes": 1024}),
    )
    assert parsed.opts.max_chunk_bytes == 500 * 1024**2
    assert parsed.opts.from_ == "2026-01-01T00:00:00.000Z"
    assert parsed.opts.state_dir == "state/backfill"


# ---------- handle_submit (planner / executor / jobs client monkeypatched) ----------


class _UnusedExecutor:
    """Stand-in remote executor; the faked planner never queries it. It answers
    only the insert settings checks a submit runs: the server lists no aliases,
    and accepts the settings."""

    def query(self, sql: str, settings: Any = None) -> Any:
        if "FROM system.settings" in sql or sql.startswith("SELECT 1 SETTINGS "):
            return SimpleNamespace(rows=[])
        msg = "remote executor must not be queried when the planner is faked"
        raise AssertionError(msg)


def _submit_context(
    *,
    flags: dict[str, Any],
    msgs: list[Any],
    json_mode: bool = False,
    config_dir: Path | None = None,
) -> SubmitContext:
    return SubmitContext(
        flags=flags,
        config_path=str(config_dir / "cfg.py") if config_dir else "cfg.py",
        json_mode=json_mode,
        config=SimpleNamespace(meta_dir="meta") if config_dir else None,
        print=msgs.append,
        credentials=Credentials(access_token="tok", base_url=BASE),
        service_slug="svc-1",
    )


def _patch_submit_pipeline(
    monkeypatch: pytest.MonkeyPatch, submitted: list[dict[str, Any]]
) -> None:
    monkeypatch.setattr(
        backfill_submit_module,
        "create_remote_executor",
        lambda _creds, *, service_slug: _UnusedExecutor(),
    )
    monkeypatch.setattr(
        backfill_submit_module,
        "build_backfill_plan",
        lambda **kwargs: BuildBackfillPlanOutput(
            plan=make_plan(), plan_path="/state/plans/abcdef0123456789.json"
        ),
    )

    def fake_jobs_submit(_creds: Credentials, **kwargs: Any) -> str:
        submitted.append(kwargs)
        return "job-9"

    monkeypatch.setattr(backfill_submit_module, "jobs_submit", fake_jobs_submit)


def test_handle_submit_success_submits_tasks_and_prints_console_url(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    submitted: list[dict[str, Any]] = []
    _patch_submit_pipeline(monkeypatch, submitted)

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--target": "app.events", "--title": "My backfill"},
            msgs=msgs,
            config_dir=tmp_path,
        )
    )

    assert code == 0
    [call] = submitted
    assert call["service_slug"] == "svc-1"
    assert call["target"] == "app.events"
    assert [t.id for t in call["tasks"]] == ["c1", "c2"]
    assert call["title"] == "My backfill"
    assert call["metadata"] == {
        "planId": "abcdef0123456789",
        "mode": "copy",
        "source": "chkit",
        "submissionId": ANY,
    }
    [message] = msgs
    assert "Submitted backfill job job-9 for app.events (2 tasks)." in message
    assert f"{BASE}/svc-1/jobs/job-9" in message


def test_handle_submit_plans_under_the_parallel_replicas_name_every_version_accepts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    submitted: list[dict[str, Any]] = []
    _patch_submit_pipeline(monkeypatch, submitted)
    sent: list[Any] = []

    def fake_build_backfill_plan(**kwargs: Any) -> BuildBackfillPlanOutput:
        sent.append(kwargs["query_settings"])
        return BuildBackfillPlanOutput(
            plan=make_plan(), plan_path="/state/plans/abcdef0123456789.json"
        )

    monkeypatch.setattr(
        backfill_submit_module, "build_backfill_plan", fake_build_backfill_plan
    )

    code = handle_submit(
        _submit_context(
            flags={"--target": "app.events"}, msgs=[], config_dir=tmp_path
        )
    )

    assert code == 0
    # enable_parallel_replicas is only an alias from 24.10 on.
    assert sent == [{"allow_experimental_parallel_reading_from_replicas": 0}]


def test_handle_submit_success_json_mode_emits_envelope(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    submitted: list[dict[str, Any]] = []
    _patch_submit_pipeline(monkeypatch, submitted)

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--target": "app.events"},
            msgs=msgs,
            json_mode=True,
            config_dir=tmp_path,
        )
    )

    assert code == 0
    [payload] = msgs
    assert payload == {
        "ok": True,
        "command": "backfill submit",
        "jobId": "job-9",
        "target": "app.events",
        "taskCount": 2,
        "url": f"{BASE}/svc-1/jobs/job-9",
    }


def test_handle_submit_records_the_job_id_so_check_does_not_wait_for_a_local_run(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    submitted: list[dict[str, Any]] = []
    _patch_submit_pipeline(monkeypatch, submitted)

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(flags={"--target": "app.events"}, msgs=msgs, config_dir=tmp_path)
    )

    assert code == 0
    submission_path = (
        tmp_path / "meta" / "backfill" / "submissions" / "abcdef0123456789.json"
    )
    submission = json.loads(submission_path.read_text(encoding="utf-8"))
    assert submission["planId"] == "abcdef0123456789"
    assert submission["target"] == "app.events"
    assert submission["jobId"] == "job-9"


def test_handle_submit_plans_and_records_the_submission_in_the_backfill_plugin_state_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    submitted: list[dict[str, Any]] = []
    _patch_submit_pipeline(monkeypatch, submitted)
    planned: list[dict[str, Any]] = []

    def fake_build_backfill_plan(**kwargs: Any) -> BuildBackfillPlanOutput:
        planned.append(kwargs)
        return BuildBackfillPlanOutput(
            plan=make_plan(), plan_path="/state/plans/abcdef0123456789.json"
        )

    monkeypatch.setattr(
        backfill_submit_module, "build_backfill_plan", fake_build_backfill_plan
    )

    code = handle_submit(
        SubmitContext(
            flags={"--target": "app.events"},
            config_path=str(tmp_path / "cfg.py"),
            json_mode=True,
            config=SimpleNamespace(
                meta_dir="meta", plugins=[backfill({"stateDir": "state/backfill"})]
            ),
            print=lambda _value: None,
            credentials=Credentials(access_token="tok", base_url=BASE),
            service_slug="svc-1",
        )
    )

    assert code == 0
    [call] = planned
    assert call["opts"].state_dir == "state/backfill"
    assert (
        tmp_path / "state" / "backfill" / "submissions" / "abcdef0123456789.json"
    ).is_file()
    assert not (tmp_path / "meta" / "backfill").exists()


def test_handle_submit_invalid_input_returns_error_exit_code() -> None:
    msgs: list[Any] = []
    code = handle_submit(_submit_context(flags={}, msgs=msgs))

    assert code == 1
    [message] = msgs
    assert "Backfill submit failed:" in message
    assert "--target" in message


def test_handle_submit_json_mode_emits_structured_error() -> None:
    msgs: list[Any] = []
    code = handle_submit(_submit_context(flags={}, msgs=msgs, json_mode=True))

    assert code == 1
    [payload] = msgs
    assert payload["ok"] is False
    assert payload["command"] == "backfill submit"
    assert "--target" in payload["error"]


def test_handle_submit_session_expiry_prints_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        backfill_submit_module,
        "create_remote_executor",
        lambda _creds, *, service_slug: _UnusedExecutor(),
    )

    def raise_expired(**_kwargs: Any) -> BuildBackfillPlanOutput:
        raise SessionExpiredError

    monkeypatch.setattr(backfill_submit_module, "build_backfill_plan", raise_expired)

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(flags={"--target": "app.events"}, msgs=msgs)
    )

    assert code == 1
    [message] = msgs
    assert "Session expired" in message


# ---------- parse_resubmit_input ----------


def test_parse_resubmit_input_accepts_a_plan_id_with_job_settings() -> None:
    parsed = parse_resubmit_input(
        {"--plan-id": "abcdef0123456789", "--title": "Retry", "--concurrency": "2"}
    )
    assert parsed == ParsedResubmitInput(
        plan_id="abcdef0123456789", title="Retry", concurrency=2
    )


def test_parse_resubmit_input_rejects_a_malformed_plan_id() -> None:
    with pytest.raises(ValueError, match="Invalid value for --plan-id"):
        parse_resubmit_input({"--plan-id": "not-a-plan"})


def test_parse_resubmit_input_rejects_planning_flags_next_to_plan_id() -> None:
    with pytest.raises(ValueError, match="cannot be combined with --target, --from"):
        parse_resubmit_input(
            {
                "--plan-id": "abcdef0123456789",
                "--target": "app.events",
                "--from": "2026-01-01",
            }
        )


# ---------- handle_submit --plan-id (jobs API monkeypatched) ----------

PLAN_ID = "abcdef0123456789"


def _setup_saved_plan(
    tmp_path: Path, *, job_id: str | None = None, plan: BackfillPlanState | None = None
) -> Path:
    """Save ``plan`` (``make_plan()``) as ``backfill plan`` would; optionally its marker."""
    plan = plan or make_plan()
    write_json(
        tmp_path / "meta/backfill/plans" / f"{PLAN_ID}.json",
        plan.model_copy(
            update={"chunk_plan": encode_chunk_plan_for_persistence(plan.chunk_plan)}
        ),
    )
    if job_id is not None:
        record_backfill_submission(
            plan_id=PLAN_ID,
            target="app.events",
            job_id=job_id,
            config_path=tmp_path / "cfg.py",
            config=SimpleNamespace(meta_dir="meta"),
        )
    return tmp_path / "meta/backfill/submissions" / f"{PLAN_ID}.json"


def _patch_jobs_api(
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    done_task_ids: tuple[str, ...] = (),
) -> list[tuple[str, dict[str, Any]]]:
    """``jobs_get`` answers with a job in ``status`` whose tasks ``done_task_ids``
    finished; ``jobs_submit`` returns job-new.
    """
    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_jobs_get(_creds: Credentials, *, job_id: str) -> JobDetail:
        calls.append(("jobs/get", {"job_id": job_id}))
        return JobDetail.model_validate(
            {
                "id": job_id,
                "serviceId": "svc-1",
                "type": "backfill",
                "target": "app.events",
                "status": status,
                "concurrency": 4,
                "totalTasks": 2,
                "completedTasks": len(done_task_ids),
                "failedTasks": 0,
                "createdAt": "2026-03-29T00:00:00Z",
                "updatedAt": "2026-03-29T01:00:00Z",
                "maxRetries": 3,
                "tasks": [
                    {
                        "id": task_id,
                        "taskIndex": index,
                        "runs": [
                            {
                                "type": "insert",
                                "status": "done"
                                if task_id in done_task_ids
                                else "failed",
                            }
                        ],
                    }
                    for index, task_id in enumerate(("c1", "c2"))
                ],
            }
        )

    def fake_jobs_submit(_creds: Credentials, **kwargs: Any) -> str:
        calls.append(("jobs/submit", kwargs))
        return "job-new"

    def no_planning(**_kwargs: Any) -> BuildBackfillPlanOutput:
        msg = "submit --plan-id must not build a new plan"
        raise AssertionError(msg)

    monkeypatch.setattr(backfill_resubmit_module, "jobs_get", fake_jobs_get)
    monkeypatch.setattr(
        backfill_submit_module,
        "create_remote_executor",
        lambda _creds, *, service_slug: _UnusedExecutor(),
    )
    monkeypatch.setattr(backfill_submit_module, "jobs_submit", fake_jobs_submit)
    monkeypatch.setattr(backfill_submit_module, "build_backfill_plan", no_planning)
    return calls


def test_handle_submit_plan_id_resubmits_a_failed_job_and_replaces_its_marker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    submission_path = _setup_saved_plan(tmp_path, job_id="job-old")
    calls = _patch_jobs_api(monkeypatch, "failed")

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID, "--title": "Retry"},
            msgs=msgs,
            json_mode=True,
            config_dir=tmp_path,
        )
    )

    assert code == 0
    assert [procedure for procedure, _ in calls] == ["jobs/get", "jobs/submit"]
    assert calls[0][1] == {"job_id": "job-old"}
    submitted = calls[1][1]
    assert submitted["target"] == "app.events"
    assert submitted["title"] == "Retry"
    assert [t.id for t in submitted["tasks"]] == ["c1", "c2"]
    assert submitted["metadata"] == {
        "planId": PLAN_ID,
        "mode": "copy",
        "source": "chkit",
        "submissionId": ANY,
    }
    assert msgs == [
        {
            "ok": True,
            "command": "backfill submit",
            "jobId": "job-new",
            "target": "app.events",
            "taskCount": 2,
            "url": f"{BASE}/svc-1/jobs/job-new",
            "planId": PLAN_ID,
            "replacedJobId": "job-old",
            "skippedChunks": 0,
        }
    ]
    marker = json.loads(submission_path.read_text(encoding="utf-8"))
    assert (marker["planId"], marker["target"], marker["jobId"]) == (
        PLAN_ID,
        "app.events",
        "job-new",
    )
    assert "status" not in marker


def test_handle_submit_plan_id_leaves_out_chunks_that_finished_in_the_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old")
    calls = _patch_jobs_api(monkeypatch, "cancelled", ("c1",))

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(flags={"--plan-id": PLAN_ID}, msgs=msgs, config_dir=tmp_path)
    )

    assert code == 0
    [submitted] = [args for procedure, args in calls if procedure == "jobs/submit"]
    assert [t.id for t in submitted["tasks"]] == ["c2"]
    assert msgs == [
        f"Re-submitted backfill plan {PLAN_ID} as job job-new for app.events"
        " (1 task), replacing cancelled job job-old.\n"
        "Skipped 1 chunk that already finished.\n"
        f"Track progress: {BASE}/svc-1/jobs/job-new"
    ]


def test_handle_submit_plan_id_across_a_chain_never_resends_a_finished_chunk(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Mirror of the TS chain test: each owed chunk is sent until it finishes,
    and no chunk that finished in any earlier job is sent again."""
    plan = make_plan()
    chunks = plan.chunk_plan.chunks
    plan = plan.model_copy(
        update={
            "chunk_plan": plan.chunk_plan.model_copy(
                update={"chunks": [*chunks, chunks[1].model_copy(update={"id": "c3"})]}
            )
        }
    )
    submission_path = _setup_saved_plan(tmp_path, job_id="job-1", plan=plan)
    # What each job carried, and how it ended: its status and the insert runs of each task.
    jobs: dict[str, dict[str, Any]] = {"job-1": {"task_ids": ["c1", "c2", "c3"]}}
    submitted: list[list[str]] = []

    def fake_jobs_get(_creds: Credentials, *, job_id: str) -> JobDetail:
        job = jobs[job_id]
        return JobDetail.model_validate(
            {
                "id": job_id,
                "serviceId": "svc-1",
                "type": "backfill",
                "target": "app.events",
                "status": job["status"],
                "concurrency": 4,
                "totalTasks": len(job["task_ids"]),
                "completedTasks": 0,
                "failedTasks": 0,
                "createdAt": "2026-03-29T00:00:00Z",
                "updatedAt": "2026-03-29T01:00:00Z",
                "maxRetries": 3,
                "tasks": [
                    {
                        "id": task_id,
                        "taskIndex": index,
                        "runs": [
                            {"type": "insert", "status": status}
                            for status in job["runs"].get(task_id, [])
                        ],
                    }
                    for index, task_id in enumerate(job["task_ids"])
                ],
            }
        )

    def fake_jobs_submit(_creds: Credentials, **kwargs: Any) -> str:
        task_ids = [task.id for task in kwargs["tasks"]]
        submitted.append(task_ids)
        job_id = f"job-{len(submitted) + 1}"
        jobs[job_id] = {"task_ids": task_ids}
        return job_id

    _patch_jobs_api(monkeypatch, "failed")
    monkeypatch.setattr(backfill_resubmit_module, "jobs_get", fake_jobs_get)
    monkeypatch.setattr(backfill_submit_module, "jobs_submit", fake_jobs_submit)

    finished: set[str] = set()

    def end_job_and_resubmit(
        job_id: str, status: str, runs: dict[str, list[str]]
    ) -> tuple[int, Any]:
        jobs[job_id].update(status=status, runs=runs)
        finished.update(task_id for task_id, s in runs.items() if "done" in s)
        before = len(submitted)
        msgs: list[Any] = []
        code = handle_submit(
            _submit_context(
                flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
            )
        )
        # A re-submit never sends a chunk that already finished in any job.
        for task_ids in submitted[before:]:
            assert [t for t in task_ids if t in finished] == []
        return code, msgs[0]

    # job-1: c1 finished on its retry; c2 was still running and c3 never started.
    hop1 = end_job_and_resubmit("job-1", "failed", {"c1": ["failed", "done"], "c2": ["running"]})
    # job-2: c2 finished; c3 was still pending when the job was cancelled.
    hop2 = end_job_and_resubmit("job-2", "cancelled", {"c2": ["done"], "c3": ["pending"]})
    # job-3: c3 failed again.
    hop3 = end_job_and_resubmit("job-3", "failed", {"c3": ["failed"]})
    # job-4: c3 finished, so nothing is owed any more.
    hop4 = end_job_and_resubmit("job-4", "failed", {"c3": ["done"]})

    assert submitted == [["c2", "c3"], ["c3"], ["c3"]]
    for (code, msg), job_id, replaced, task_count, skipped in [
        (hop1, "job-2", "job-1", 2, 1),
        (hop2, "job-3", "job-2", 1, 2),
        (hop3, "job-4", "job-3", 1, 2),
    ]:
        assert code == 0
        assert (msg["jobId"], msg["replacedJobId"], msg["taskCount"], msg["skippedChunks"]) == (
            job_id,
            replaced,
            task_count,
            skipped,
        )
    assert hop4[0] == 1
    assert f"Every chunk of plan {PLAN_ID} already finished" in hop4[1]["error"]
    assert json.loads(submission_path.read_text(encoding="utf-8"))["jobId"] == "job-4"


@pytest.mark.parametrize("task_ids", [("c1",), ("c1", "unknown")])
def test_handle_submit_plan_id_refuses_an_incomplete_task_list(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, task_ids: tuple[str, ...]
) -> None:
    """A chunk missing from the response, also behind an unknown task, is not
    taken as finished."""
    submission_path = _setup_saved_plan(tmp_path, job_id="job-old")
    before = submission_path.read_text(encoding="utf-8")
    calls = _patch_jobs_api(monkeypatch, "failed")
    real_get = vars(backfill_resubmit_module)["jobs_get"]  # the fake set above

    def partial_get(creds: Credentials, *, job_id: str) -> JobDetail:
        job: JobDetail = real_get(creds, job_id=job_id)
        return job.model_copy(
            update={"tasks": [{**job.tasks[0], "id": task_id} for task_id in task_ids]}
        )

    monkeypatch.setattr(backfill_resubmit_module, "jobs_get", partial_get)

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )

    assert code == 1
    assert msgs[0]["error"] == (
        f"Job job-old for plan {PLAN_ID} lists 1 of its 2 tasks, so its unfinished"
        " chunks are unknown. Nothing was re-submitted."
    )
    assert [procedure for procedure, _ in calls] == ["jobs/get"]
    assert submission_path.read_text(encoding="utf-8") == before


def test_handle_submit_plan_id_refuses_when_every_chunk_finished_in_the_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old")
    calls = _patch_jobs_api(monkeypatch, "failed", ("c1", "c2"))

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )

    assert code == 1
    assert f"Every chunk of plan {PLAN_ID} already finished" in msgs[0]["error"]
    assert [procedure for procedure, _ in calls] == ["jobs/get"]


@pytest.mark.parametrize(
    "status", ["pending", "running", "draining", "paused", "completed"]
)
def test_handle_submit_plan_id_refuses_unless_the_job_failed_or_was_cancelled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, status: str
) -> None:
    submission_path = _setup_saved_plan(tmp_path, job_id="job-old")
    before = submission_path.read_text(encoding="utf-8")
    calls = _patch_jobs_api(monkeypatch, status)

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )

    assert code == 1
    [payload] = msgs
    assert payload["ok"] is False
    assert payload["command"] == "backfill submit"
    assert f"Job job-old for plan {PLAN_ID} is {status}" in payload["error"]
    assert [procedure for procedure, _ in calls] == ["jobs/get"]
    assert submission_path.read_text(encoding="utf-8") == before


def test_handle_submit_plan_id_refuses_an_unknown_plan_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old")
    calls = _patch_jobs_api(monkeypatch, "failed")

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": "0000000000000000"},
            msgs=msgs,
            json_mode=True,
            config_dir=tmp_path,
        )
    )

    assert code == 1
    assert "Backfill plan 0000000000000000 not found" in msgs[0]["error"]
    assert calls == []


def test_handle_submit_plan_id_refuses_a_plan_that_was_never_submitted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    submission_path = _setup_saved_plan(tmp_path)
    calls = _patch_jobs_api(monkeypatch, "failed")

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )

    assert code == 1
    assert f"Backfill plan {PLAN_ID} was never submitted" in msgs[0]["error"]
    assert calls == []
    assert not submission_path.exists()


def test_handle_submit_plan_id_refuses_planning_flags_before_the_api(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old")
    calls = _patch_jobs_api(monkeypatch, "failed")

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID, "--target": "app.events"},
            msgs=msgs,
            json_mode=True,
            config_dir=tmp_path,
        )
    )

    assert code == 1
    assert "cannot be combined with --target" in msgs[0]["error"]
    assert calls == []


@dataclass
class _FakeJob:
    task_ids: list[str]
    metadata: dict[str, Any]
    status: str = "running"
    done_task_ids: list[str] = field(default_factory=list)

    def detail(self, job_id: str) -> dict[str, Any]:
        return {
            "id": job_id,
            "serviceId": "svc-1",
            "type": "backfill",
            "target": "app.events",
            "status": self.status,
            "concurrency": 4,
            "totalTasks": len(self.task_ids),
            "completedTasks": len(self.done_task_ids),
            "failedTasks": 0,
            "createdAt": "2026-03-29T00:00:00Z",
            "updatedAt": "2026-03-29T01:00:00Z",
            "maxRetries": 3,
            "metadata": self.metadata,
            "tasks": [
                {
                    "id": task_id,
                    "runs": [
                        {
                            "type": "insert",
                            "status": "done" if task_id in self.done_task_ids else "failed",
                        }
                    ],
                }
                for task_id in self.task_ids
            ],
        }


class _FakeJobsBackend:
    def __init__(self, monkeypatch: pytest.MonkeyPatch, has_marker: bool = True) -> None:
        self.jobs = (
            {"job-1": _FakeJob(["c1", "c2"], {"planId": PLAN_ID}, "failed")}
            if has_marker
            else {}
        )
        self.calls: list[str] = []
        self.listed_services: list[str] = []
        self.submitted: list[_FakeJob] = []
        self.before_send: Callable[[_FakeJob], None] | None = None
        self.after_send: Callable[[], None] | None = None
        monkeypatch.setattr(jobs_api, "_rpc_post", self.rpc_post)
        monkeypatch.setattr(backfill_submit_module, "jobs_submit", self.jobs_submit)
        monkeypatch.setattr(
            backfill_submit_module,
            "create_remote_executor",
            lambda _creds, *, service_slug: _UnusedExecutor(),
        )
        monkeypatch.setattr(
            backfill_submit_module,
            "build_backfill_plan",
            lambda **_kwargs: BuildBackfillPlanOutput(plan=make_plan(), plan_path=""),
        )

    def rpc_post(
        self, _creds: Credentials, procedure: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.calls.append(procedure)
        if procedure == "jobs/get":
            job_id = payload["jobId"]
            return self.jobs[job_id].detail(job_id)
        assert procedure == "jobs/list", procedure
        self.listed_services.append(payload["serviceSlug"])
        listed = [job.detail(job_id) for job_id, job in self.jobs.items()]
        return {"jobs": listed, "total": len(listed)}

    def jobs_submit(self, _creds: Credentials, **kwargs: Any) -> str:
        self.calls.append("jobs/submit")
        job = _FakeJob([task.id for task in kwargs["tasks"]], kwargs["metadata"])
        if self.before_send is not None:
            self.before_send(job)
        job_id = self.commit(job)
        if self.after_send is not None:
            self.after_send()
        return job_id

    def commit(self, job: _FakeJob) -> str:
        job_id = f"job-{len(self.jobs) + 1}"
        self.jobs[job_id] = job
        self.submitted.append(job)
        return job_id


def _submit(tmp_path: Path, **flags: str) -> tuple[int, Any]:
    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags=flags or {"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )
    [message] = msgs
    return code, message


def _fail_marker_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        backfill_submit_module,
        "record_backfill_submission",
        Mock(side_effect=RuntimeError("marker write failed")),
    )


@pytest.mark.parametrize("flag", ["--plan-id", "--target"])
def test_locks_a_plan_during_submit_with(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, flag: str
) -> None:
    has_marker = flag == "--plan-id"
    marker = _setup_saved_plan(tmp_path, job_id="job-1" if has_marker else None)
    backend = _FakeJobsBackend(monkeypatch, has_marker)
    entered, finish = Event(), Event()

    def pause_send(_job: _FakeJob) -> None:
        backend.before_send = None
        entered.set()
        assert finish.wait(timeout=5)

    backend.before_send = pause_send
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(_submit, tmp_path, **{flag: PLAN_ID if has_marker else "app.events"})
        try:
            assert entered.wait(timeout=5)
            code, second = _submit(tmp_path)
            pending = marker.with_suffix(".pending.json").exists()
        finally:
            finish.set()

    assert code == 1
    assert "is locked by another run, resume, cancel or submit" in second["error"]
    assert pending
    assert first.result()[0] == 0
    assert len(backend.submitted) == 1


def test_adopts_a_job_after_the_marker_write_fails_and_retries_only_its_unfinished_chunks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    plan = make_plan()
    plan.chunk_plan.chunks.append(plan.chunk_plan.chunks[1].model_copy(update={"id": "c3"}))
    marker = _setup_saved_plan(tmp_path, job_id="job-1", plan=plan)
    backend = _FakeJobsBackend(monkeypatch)
    old = backend.jobs["job-1"]
    old.task_ids.append("c3")
    old.done_task_ids = ["c1"]

    with monkeypatch.context() as crash:
        _fail_marker_once(crash)
        code, message = _submit(tmp_path)
    assert code == 1
    assert message["error"] == "marker write failed"
    assert json.loads(marker.read_text())["jobId"] == "job-1"

    code, message = _submit(tmp_path)
    assert code == 1
    assert f"Job job-2 for plan {PLAN_ID} is running" in message["error"]
    assert json.loads(marker.read_text())["jobId"] == "job-2"
    assert len(backend.submitted) == 1

    adopted = backend.jobs["job-2"]
    adopted.status = "failed"
    adopted.done_task_ids = ["c2"]
    code, message = _submit(tmp_path)
    assert code == 0
    assert message["replacedJobId"] == "job-2"
    assert message["skippedChunks"] == 2
    assert [job.task_ids for job in backend.submitted] == [["c2", "c3"], ["c3"]]


def test_recovers_a_job_that_landed_even_though_the_send_failed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)
    backend.after_send = Mock(side_effect=RuntimeError("connection lost"))

    code, message = _submit(tmp_path)
    assert code == 1
    assert (
        f"The job may have been created; `chkit plugin backfill submit --plan-id {PLAN_ID}` "
        "finds it instead of sending the chunks again."
    ) in message["error"]
    path = marker.with_suffix(".pending.json")
    intent = json.loads(path.read_text())
    assert re.fullmatch(r"\d{4}-.*Z", intent["startedAt"])
    assert intent == {
        "planId": PLAN_ID,
        "submissionId": backend.submitted[0].metadata["submissionId"],
        "replacesJobId": "job-1",
        "startedAt": ANY,
        "serviceSlug": "svc-1",
    }

    code, message = _submit(tmp_path)
    assert code == 1
    assert f"Job job-2 for plan {PLAN_ID} is running" in message["error"]
    saved = json.loads(marker.read_text())
    assert saved["jobId"] == "job-2"
    assert saved["submissionId"] == backend.submitted[0].metadata["submissionId"]
    assert len(backend.submitted) == 1
    assert not path.exists()


def test_retries_once_from_the_marker_when_the_failed_send_created_no_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)
    backend.before_send = Mock(side_effect=RuntimeError("send failed"))
    path = marker.with_suffix(".pending.json")

    assert _submit(tmp_path)[0] == 1
    assert backend.submitted == []
    backend.before_send = None
    assert _submit(tmp_path)[0] == 1
    assert backend.submitted == []
    path.unlink()
    code, message = _submit(tmp_path)
    assert code == 0
    assert message["replacedJobId"] == "job-1"
    assert backend.calls == ["jobs/get", "jobs/submit", "jobs/list", "jobs/get", "jobs/submit"]
    assert len(backend.submitted) == 1
    assert not path.exists()


def test_adopts_the_job_from_a_first_submit_whose_marker_write_failed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path)
    backend = _FakeJobsBackend(monkeypatch, has_marker=False)

    with monkeypatch.context() as crash:
        _fail_marker_once(crash)
        assert _submit(tmp_path, **{"--target": "app.events"})[0] == 1
    assert not marker.exists()

    code, message = _submit(tmp_path)
    assert code == 1
    assert f"Job job-1 for plan {PLAN_ID} is running" in message["error"]
    assert json.loads(marker.read_text())["jobId"] == "job-1"
    assert len(backend.submitted) == 1


def test_refuses_an_unmatched_intent_even_when_the_complete_list_shows_the_marker_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)
    timed_out = Mock(side_effect=RuntimeError("send timed out"))
    backend.before_send = timed_out
    marker_before = marker.read_text()
    path = marker.with_suffix(".pending.json")

    assert _submit(tmp_path)[0] == 1
    assert backend.submitted == []
    intent = path.read_text()
    started_at = json.loads(intent)["startedAt"]
    backend.before_send = None
    code, message = _submit(tmp_path)
    assert code == 1
    assert message == {
        "ok": False,
        "command": "backfill submit",
        "error": (
            f"An earlier submit of plan {PLAN_ID} (started {started_at}) may have created a "
            "job on service svc-1, and its job list shows none from that submit. Nothing was "
            f"submitted. A request that timed out can still create its job: once the console "
            f"shows no job for plan {PLAN_ID} created since {started_at}, delete {path} and re-run."
        ),
    }
    assert backend.calls == ["jobs/get", "jobs/submit", "jobs/list"]
    assert path.read_text() == intent
    assert marker.read_text() == marker_before
    delayed = timed_out.call_args.args[0]
    assert backend.commit(delayed) == "job-2"
    assert "job-2" in _submit(tmp_path)[1]["error"]
    assert backend.submitted == [delayed]


def test_does_not_match_a_listed_job_whose_metadata_lacks_submission_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)
    backend.jobs["job-2"] = _FakeJob(["c1", "c2"], {"planId": PLAN_ID})
    path = marker.with_suffix(".pending.json")
    write_json(
        path,
        {
            "planId": PLAN_ID,
            "submissionId": "aaaabbbbccccdddd",
            "startedAt": "2026-06-30T00:00:00.000Z",
        },
    )
    intent = path.read_text()

    code, message = _submit(tmp_path)
    assert code == 1
    assert "its job list shows none from that submit" in message["error"]
    assert backend.calls == ["jobs/list"]
    assert path.read_text() == intent
    assert json.loads(marker.read_text())["jobId"] == "job-1"


def test_refuses_an_unreadable_intent_without_listing_jobs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)
    path = marker.with_suffix(".pending.json")
    path.write_text("{}")

    code, message = _submit(tmp_path)
    assert code == 1
    assert message == {
        "ok": False,
        "command": "backfill submit",
        "error": (
            f"The submission record {path} of plan {PLAN_ID} cannot be read. "
            f"Nothing was submitted. If the console lists no job for plan {PLAN_ID} "
            f"created by the interrupted submit, delete {path} and re-run."
        ),
    }
    assert backend.calls == []
    assert path.read_text() == "{}"
    assert json.loads(marker.read_text())["jobId"] == "job-1"


def test_lists_jobs_on_the_service_the_intent_was_sent_to(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)
    submission_id = "aaaabbbbccccdddd"
    metadata = {"planId": PLAN_ID, "submissionId": submission_id}
    backend.jobs["job-2"] = _FakeJob(["c1", "c2"], metadata)
    path = marker.with_suffix(".pending.json")
    write_json(path, {**metadata, "startedAt": "2026-06-30T00:00:00.000Z", "serviceSlug": "other"})

    code, message = _submit(tmp_path)
    assert code == 1
    assert f"Job job-2 for plan {PLAN_ID} is running" in message["error"]
    assert backend.listed_services == ["other"]
    assert backend.calls == ["jobs/list", "jobs/get"]
    saved = json.loads(marker.read_text())
    assert saved["jobId"] == "job-2"
    assert saved["submissionId"] == submission_id
    assert not path.exists()


def test_settles_locally_after_the_marker_write_when_intent_cleanup_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)
    path = marker.with_suffix(".pending.json")
    with monkeypatch.context() as crash:
        crash.setattr(
            backfill_submit_module,
            "clear_submission_intent",
            Mock(side_effect=RuntimeError("intent cleanup failed")),
        )
        code, message = _submit(tmp_path)
    assert code == 1
    assert message["error"] == "intent cleanup failed"
    saved = json.loads(marker.read_text())
    assert saved["jobId"] == "job-2"
    assert saved["submissionId"] == json.loads(path.read_text())["submissionId"]

    code, message = _submit(tmp_path)
    assert code == 1
    assert f"Job job-2 for plan {PLAN_ID} is running" in message["error"]
    assert backend.calls == ["jobs/get", "jobs/submit", "jobs/get"]
    assert len(backend.submitted) == 1
    assert not path.exists()


@pytest.mark.parametrize("outcome", ["fails", "succeeds"])
def test_preserves_the_outcome_when_submit_and_lock_release_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    outcome: str,
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)
    if outcome == "fails":
        backend.before_send = Mock(side_effect=RuntimeError("send failed"))
    lock_path = marker.parent.parent / "runs" / f"{PLAN_ID}.lock"
    monkeypatch.setattr(RunLock, "release", Mock(side_effect=RuntimeError("release failed")))
    warning = (
        f"The lock {lock_path} could not be removed (release failed): delete it "
        "once no run, resume, cancel or submit of this plan runs."
    )

    code, message = _submit(tmp_path)
    assert lock_path.exists()
    if outcome == "fails":
        assert code == 1
        assert message == {
            "ok": False,
            "command": "backfill submit",
            "error": (
                f"send failed The job may have been created; `chkit plugin backfill submit "
                f"--plan-id {PLAN_ID}` finds it instead of sending the chunks again. {warning}"
            ),
        }
        assert capsys.readouterr().err == ""
    else:
        assert code == 0
        assert message == {
            "ok": True,
            "command": "backfill submit",
            "jobId": "job-2",
            "target": "app.events",
            "taskCount": 2,
            "url": f"{BASE}/svc-1/jobs/job-2",
            "planId": PLAN_ID,
            "replacedJobId": "job-1",
            "skippedChunks": 0,
        }
        assert capsys.readouterr().err == f"{warning}\n"


def test_leaves_the_lock_in_place_when_submit_raises_keyboard_interrupt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)
    backend.before_send = Mock(side_effect=KeyboardInterrupt)

    with pytest.raises(KeyboardInterrupt):
        _submit(tmp_path)
    assert (marker.parent.parent / "runs" / f"{PLAN_ID}.lock").exists()
    assert marker.with_suffix(".pending.json").exists()
    assert backend.calls == ["jobs/get", "jobs/submit"]


def test_clears_the_intent_on_success_and_sends_a_16_hex_submission_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    marker = _setup_saved_plan(tmp_path, job_id="job-1")
    backend = _FakeJobsBackend(monkeypatch)

    assert _submit(tmp_path)[0] == 0
    [job] = backend.submitted
    assert job.metadata == {
        "planId": PLAN_ID, "mode": "copy", "source": "chkit", "submissionId": ANY
    }
    assert re.fullmatch(r"[a-f0-9]{16}", job.metadata["submissionId"])
    assert not marker.with_suffix(".pending.json").exists()
