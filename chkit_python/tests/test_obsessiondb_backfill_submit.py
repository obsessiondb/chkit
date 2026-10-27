"""Managed backfill submit tests.

1:1 port of ``packages/plugin-obsessiondb/src/backfill/submit.test.ts``
(``buildSubmitTasks`` + ``parseSubmitInput``), plus direct ``handle_submit``
flow tests with the jobs client / remote executor / planner monkeypatched.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from chkit_plugin_backfill.chunking.boundary_codec import (
    encode_chunk_plan_for_persistence,
)
from chkit_plugin_backfill.executed_chunks import ExecutedChunks
from chkit_plugin_backfill.options import PluginConfig
from chkit_plugin_backfill.planner import BuildBackfillPlanOutput
from chkit_plugin_backfill.plugin import backfill
from chkit_plugin_backfill.state import record_backfill_submission, write_json
from chkit_plugin_backfill.types import BackfillPlanState
from chkit_plugin_obsessiondb import backfill_resubmit as backfill_resubmit_module
from chkit_plugin_obsessiondb import backfill_submit as backfill_submit_module
from chkit_plugin_obsessiondb.api_client import SessionExpiredError
from chkit_plugin_obsessiondb.backfill_resubmit import ResubmitRefusedError
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
    """Stand-in remote executor; the faked planner never queries it."""

    def query(self, sql: str, settings: Any = None) -> Any:
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
    }
    [message] = msgs
    assert "Submitted backfill job job-9 for app.events (2 tasks)." in message
    assert f"{BASE}/svc-1/jobs/job-9" in message


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
    with pytest.raises(ResubmitRefusedError, match="Invalid value for --plan-id"):
        parse_resubmit_input({"--plan-id": "not-a-plan"})


def test_parse_resubmit_input_rejects_planning_flags_next_to_plan_id() -> None:
    with pytest.raises(
        ResubmitRefusedError, match="cannot be combined with --target, --from"
    ):
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
    tmp_path: Path, *, job_id: str | None = None, confirmed: bool = False
) -> Path:
    """Save ``make_plan()`` as ``backfill plan`` would; optionally its marker."""
    plan = make_plan()
    write_json(
        tmp_path / "meta/backfill/plans" / f"{PLAN_ID}.json",
        plan.model_copy(
            update={"chunk_plan": encode_chunk_plan_for_persistence(plan.chunk_plan)}
        ),
    )
    submission_path = tmp_path / "meta/backfill/submissions" / f"{PLAN_ID}.json"
    if job_id is not None:
        record_backfill_submission(
            plan_id=PLAN_ID,
            target="app.events",
            job_id=job_id,
            config_path=tmp_path / "cfg.py",
            config=SimpleNamespace(meta_dir="meta"),
        )
    if confirmed:
        marker = json.loads(submission_path.read_text(encoding="utf-8"))
        write_json(
            submission_path,
            {**marker, "status": "completed", "confirmedAt": "2026-01-02T00:00:00.000Z"},
        )
    return submission_path


def _patch_jobs_api(
    monkeypatch: pytest.MonkeyPatch,
    status: str | Exception,
    executed: ExecutedChunks | Exception | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    """``jobs_get`` answers with ``status`` (or raises it); ``jobs_submit`` returns
    job-new; the query-log lookup of chunks that already ran answers ``executed``.
    """
    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_find_executed_chunks(**kwargs: Any) -> ExecutedChunks:
        calls.append(("find_executed_chunks", kwargs))
        if isinstance(executed, Exception):
            raise executed
        return executed or ExecutedChunks(finished=[], running=[])

    def fake_jobs_get(_creds: Credentials, *, job_id: str) -> JobDetail:
        calls.append(("jobs/get", {"job_id": job_id}))
        if isinstance(status, Exception):
            raise status
        return JobDetail.model_validate(
            {
                "id": job_id,
                "serviceId": "svc-1",
                "type": "backfill",
                "target": "app.events",
                "status": status,
                "concurrency": 4,
                "totalTasks": 2,
                "completedTasks": 0,
                "failedTasks": 0,
                "createdAt": "2026-03-29T00:00:00Z",
                "updatedAt": "2026-03-29T01:00:00Z",
                "maxRetries": 3,
                "tasks": [],
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
        backfill_resubmit_module, "find_executed_chunks", fake_find_executed_chunks
    )
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
    assert [procedure for procedure, _ in calls] == [
        "jobs/get",
        "find_executed_chunks",
        "jobs/submit",
    ]
    assert calls[0][1] == {"job_id": "job-old"}
    assert calls[1][1]["plan_id"] == PLAN_ID
    assert calls[1][1]["since"] == "2026-06-30T00:00:00.000Z"
    submitted = calls[2][1]
    assert submitted["target"] == "app.events"
    assert submitted["title"] == "Retry"
    assert [t.id for t in submitted["tasks"]] == ["c1", "c2"]
    assert submitted["metadata"] == {"planId": PLAN_ID, "mode": "copy", "source": "chkit"}
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


def test_handle_submit_plan_id_resubmits_a_cancelled_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old")
    _patch_jobs_api(monkeypatch, "cancelled")

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(flags={"--plan-id": PLAN_ID}, msgs=msgs, config_dir=tmp_path)
    )

    assert code == 0
    assert msgs == [
        f"Re-submitted backfill plan {PLAN_ID} as job job-new for app.events"
        " (2 tasks), replacing cancelled job job-old.\n"
        f"Track progress: {BASE}/svc-1/jobs/job-new"
    ]


def test_handle_submit_plan_id_leaves_out_chunks_that_already_finished(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old")
    calls = _patch_jobs_api(
        monkeypatch, "cancelled", ExecutedChunks(finished=["c1"], running=[])
    )

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
        "Skipped 1 chunk that already finished on the service.\n"
        f"Track progress: {BASE}/svc-1/jobs/job-new"
    ]


def test_handle_submit_plan_id_refuses_while_chunk_queries_still_run(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    submission_path = _setup_saved_plan(tmp_path, job_id="job-old")
    before = submission_path.read_text(encoding="utf-8")
    calls = _patch_jobs_api(
        monkeypatch, "cancelled", ExecutedChunks(finished=["c1"], running=["c2"])
    )

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )

    assert code == 1
    assert msgs[0]["code"] == "backfill_resubmit_chunks_running"
    assert f"1 chunk query of plan {PLAN_ID} (job job-old) still run" in msgs[0]["error"]
    assert "jobs/submit" not in [procedure for procedure, _ in calls]
    assert submission_path.read_text(encoding="utf-8") == before


def test_handle_submit_plan_id_refuses_when_every_chunk_already_finished(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old")
    calls = _patch_jobs_api(
        monkeypatch, "failed", ExecutedChunks(finished=["c1", "c2"], running=[])
    )

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )

    assert code == 1
    assert msgs[0]["code"] == "backfill_resubmit_nothing_to_run"
    assert "jobs/submit" not in [procedure for procedure, _ in calls]


def test_handle_submit_plan_id_refuses_when_executed_chunks_cannot_be_read(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old")
    calls = _patch_jobs_api(
        monkeypatch, "failed", RuntimeError("Not enough privileges")
    )

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )

    assert code == 1
    assert msgs[0]["code"] == "backfill_resubmit_chunks_unverified"
    assert "Not enough privileges." in msgs[0]["error"]
    assert "jobs/submit" not in [procedure for procedure, _ in calls]


@pytest.mark.parametrize("status", ["pending", "running", "draining", "paused"])
def test_handle_submit_plan_id_refuses_while_the_job_is_active(
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
    assert payload["code"] == "backfill_resubmit_job_active"
    assert f"Job job-old for plan {PLAN_ID} is {status}" in payload["error"]
    assert [procedure for procedure, _ in calls] == ["jobs/get"]
    assert submission_path.read_text(encoding="utf-8") == before


def test_handle_submit_plan_id_refuses_when_the_job_already_completed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old")
    calls = _patch_jobs_api(monkeypatch, "completed")

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )

    assert code == 1
    assert msgs[0]["code"] == "backfill_resubmit_job_completed"
    assert [procedure for procedure, _ in calls] == ["jobs/get"]


def test_handle_submit_plan_id_refuses_a_confirmed_submission_without_the_api(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _setup_saved_plan(tmp_path, job_id="job-old", confirmed=True)
    calls = _patch_jobs_api(monkeypatch, "failed")

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--plan-id": PLAN_ID}, msgs=msgs, json_mode=True, config_dir=tmp_path
        )
    )

    assert code == 1
    assert msgs[0]["code"] == "backfill_resubmit_job_completed"
    assert calls == []


def test_handle_submit_plan_id_refuses_when_the_job_status_cannot_be_read(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    submission_path = _setup_saved_plan(tmp_path, job_id="job-old")
    before = submission_path.read_text(encoding="utf-8")
    calls = _patch_jobs_api(monkeypatch, SessionExpiredError())

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(flags={"--plan-id": PLAN_ID}, msgs=msgs, config_dir=tmp_path)
    )

    assert code == 1
    [message] = msgs
    assert "Backfill submit failed: Cannot read the status of job job-old" in message
    assert "Session expired" in message
    assert "Not re-submitting" in message
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
    assert msgs[0]["code"] == "backfill_resubmit_plan_not_found"
    assert calls == []


def test_handle_submit_plan_id_refuses_a_plan_without_a_submission_marker(
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
    assert msgs[0]["code"] == "backfill_resubmit_not_submitted"
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
    assert msgs[0]["code"] == "backfill_resubmit_invalid_flags"
    assert calls == []
