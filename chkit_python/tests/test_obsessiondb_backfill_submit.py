"""Managed backfill submit tests.

1:1 port of ``packages/plugin-obsessiondb/src/backfill/submit.test.ts``
(``buildSubmitTasks`` + ``parseSubmitInput``), plus direct ``handle_submit``
flow tests with the jobs client / remote executor / planner monkeypatched.
"""

from __future__ import annotations

from typing import Any

import pytest

from chkit_plugin_backfill.planner import BuildBackfillPlanOutput
from chkit_plugin_backfill.types import BackfillPlanState
from chkit_plugin_obsessiondb import backfill_submit as backfill_submit_module
from chkit_plugin_obsessiondb.api_client import SessionExpiredError
from chkit_plugin_obsessiondb.backfill_submit import (
    SubmitContext,
    build_submit_tasks,
    handle_submit,
    parse_submit_input,
)
from chkit_plugin_obsessiondb.credentials import Credentials

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
) -> SubmitContext:
    return SubmitContext(
        flags=flags,
        config_path="cfg.py",
        json_mode=json_mode,
        config=None,
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
) -> None:
    submitted: list[dict[str, Any]] = []
    _patch_submit_pipeline(monkeypatch, submitted)

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(
            flags={"--target": "app.events", "--title": "My backfill"}, msgs=msgs
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
) -> None:
    submitted: list[dict[str, Any]] = []
    _patch_submit_pipeline(monkeypatch, submitted)

    msgs: list[Any] = []
    code = handle_submit(
        _submit_context(flags={"--target": "app.events"}, msgs=msgs, json_mode=True)
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
