"""Tests for chkit_plugin_backfill Phase 1.

Covers:
- Coercion helpers (timestamp / target / byte size / plan id).
- Option models (defaults match TS, alias parsing).
- State helpers (paths, fingerprint, environment match, status summary).
- Plugin command runners (``status``, ``cancel``, and Phase-2 stubs).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import (
    ChxPluginCommandContext,
    ChxPluginManifest,
    PluginContext,
)
from chkit_plugin_backfill import (
    BackfillConfigError,
    PluginConfig,
    backfill,
    backfill_paths,
    compute_backfill_state_dir,
    compute_environment_fingerprint,
    ensure_environment_match,
    parse_byte_size,
)
from chkit_plugin_backfill.options import (
    PlanOptions,
    RunOptions,
    _coerce_positive_int,
    _normalize_plan_id,
    _normalize_target,
    _normalize_timestamp,
)
from chkit_plugin_backfill.state import (
    plan_status_for,
    read_plan,
    read_run,
    summarize_run_status,
    write_json,
)
from chkit_plugin_backfill.types import (
    BackfillExecutionPlan,
    BackfillPlanLimits,
    BackfillPlanOptions,
    BackfillPlanPolicy,
    BackfillPlanState,
    BackfillRunState,
)

# ---------- helpers ----------


def _cfg(tmp_path: Path) -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=["./schema.py"],
        out_dir="./out",
        migrations_dir="./m",
        meta_dir=str(tmp_path / "meta"),
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


def _make_command_context(
    *,
    config: ChxResolvedConfig,
    tmp_path: Path,
    flags: dict[str, Any],
    options: dict[str, Any] | None = None,
    json_mode: bool = False,
    msgs: list[Any] | None = None,
) -> ChxPluginCommandContext:
    return ChxPluginCommandContext(
        plugin_name="backfill",
        config=config,
        config_path=str(tmp_path / "clickhouse.config.py"),
        json_mode=json_mode,
        args=[],
        flags=flags,
        options=options or {},
        raw_options=options or {},
        table_scope=TableScope(enabled=False),
        print=(msgs.append if msgs is not None else lambda _v: None),
        plugin_runtime=MagicMock(),
        plugin_context=PluginContext(executor=None, has_executor=False),
    )


def _make_chunk(chunk_id: str) -> dict[str, Any]:
    return {
        "id": chunk_id,
        "partitionId": "2026-01",
        "ranges": [],
        "estimate": {
            "rows": 100,
            "bytesCompressed": 1000,
            "bytesUncompressed": 2000,
            "confidence": "high",
            "reason": "partition-metadata",
        },
        "analysis": {"lineage": []},
    }


def _make_chunk_plan(
    plan_id: str, chunk_ids: list[str]
) -> dict[str, Any]:
    return {
        "planId": plan_id,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rowProbeStrategy": "count",
        "targetChunkBytes": 10 * 1024**3,
        "table": {"database": "events", "table": "actions", "sortKeys": []},
        "partitions": [
            {
                "partitionId": "2026-01",
                "rows": 100 * len(chunk_ids),
                "bytesCompressed": 1000 * len(chunk_ids),
                "bytesUncompressed": 2000 * len(chunk_ids),
                "minTime": "2026-01-01T00:00:00.000Z",
                "maxTime": "2026-01-02T00:00:00.000Z",
            }
        ],
        "chunks": [_make_chunk(chunk_id) for chunk_id in chunk_ids],
        "totalRows": 100 * len(chunk_ids),
        "totalBytesCompressed": 1000 * len(chunk_ids),
        "totalBytesUncompressed": 2000 * len(chunk_ids),
        "stats": {
            "totalPartitions": 1,
            "oversizedPartitions": 0,
            "focusedChunks": 0,
            "totalChunks": len(chunk_ids),
            "avgChunkBytes": 2000,
            "maxChunkBytes": 2000,
            "minChunkBytes": 2000,
        },
    }


def _make_plan(
    *,
    plan_id: str = "0123456789abcdef",
    chunk_ids: list[str] | None = None,
) -> BackfillPlanState:
    return BackfillPlanState.model_validate(
        {
            "planId": plan_id,
            "target": "events.actions",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "from": "2026-01-01T00:00:00.000Z",
            "to": "2026-01-02T00:00:00.000Z",
            "chunkPlan": _make_chunk_plan(plan_id, chunk_ids or ["c1", "c2"]),
            "execution": BackfillExecutionPlan(
                mode="copy",
                source_target="events.actions",
                require_idempotency_token=True,
            ).model_dump(by_alias=True),
            "options": BackfillPlanOptions(
                max_chunk_bytes=10 * 1024**3,
                max_parallel_chunks=1,
                max_retries_per_chunk=3,
                require_idempotency_token=True,
                sort_key_column=None,
            ).model_dump(by_alias=True, exclude_none=True),
            "policy": BackfillPlanPolicy(
                require_dry_run_before_run=True,
                require_explicit_window=True,
                block_overlapping_runs=True,
                fail_check_on_required_pending_backfill=True,
            ).model_dump(by_alias=True),
            "limits": BackfillPlanLimits(
                max_window_hours=720, min_chunk_minutes=15
            ).model_dump(by_alias=True),
        }
    )


# ---------- coercion ----------


def test_normalize_timestamp_accepts_iso8601() -> None:
    assert _normalize_timestamp("2026-06-25T12:34:56Z", "--from") == "2026-06-25T12:34:56.000Z"


def test_normalize_timestamp_accepts_naive_treats_as_utc() -> None:
    assert _normalize_timestamp("2026-06-25T12:34:56", "--from") == "2026-06-25T12:34:56.000Z"


def test_normalize_timestamp_rejects_empty() -> None:
    with pytest.raises(BackfillConfigError):
        _normalize_timestamp("   ", "--from")


def test_normalize_timestamp_rejects_garbage() -> None:
    with pytest.raises(BackfillConfigError):
        _normalize_timestamp("not-a-date", "--from")


def test_normalize_target_valid() -> None:
    assert _normalize_target("db.table") == "db.table"


def test_normalize_target_rejects_missing_dot() -> None:
    with pytest.raises(BackfillConfigError):
        _normalize_target("dbonly")


def test_parse_byte_size_units() -> None:
    assert parse_byte_size("1024") == 1024
    assert parse_byte_size("500M") == 500 * 1024**2
    assert parse_byte_size("10G") == 10 * 1024**3
    assert parse_byte_size("2T") == 2 * 1024**4
    assert parse_byte_size("1.5G") == int(1.5 * 1024**3)


def test_parse_byte_size_rejects_zero() -> None:
    with pytest.raises(BackfillConfigError):
        parse_byte_size("0")


def test_parse_byte_size_rejects_garbage() -> None:
    with pytest.raises(BackfillConfigError):
        parse_byte_size("garbage")


def test_normalize_plan_id_requires_16_hex() -> None:
    assert _normalize_plan_id("0123456789abcdef") == "0123456789abcdef"
    with pytest.raises(BackfillConfigError):
        _normalize_plan_id("SHORT")
    with pytest.raises(BackfillConfigError):
        _normalize_plan_id("0123456789ABCDEF")  # uppercase rejected


def test_coerce_positive_int_rejects_zero_and_floats() -> None:
    assert _coerce_positive_int("3", "--concurrency") == 3
    with pytest.raises(BackfillConfigError):
        _coerce_positive_int("0", "--concurrency")
    with pytest.raises(BackfillConfigError):
        _coerce_positive_int("3.5", "--concurrency")


# ---------- option models ----------


def test_plan_options_defaults_match_ts() -> None:
    opts = PlanOptions(target="db.table")
    assert opts.max_chunk_bytes == 10 * 1024**3
    assert opts.max_parallel_chunks == 1
    assert opts.max_retries_per_chunk == 3
    assert opts.require_idempotency_token is True
    assert opts.max_window_hours == 720
    assert opts.min_chunk_minutes == 15


def test_run_options_defaults_match_ts() -> None:
    opts = RunOptions.model_validate({"planId": "0123456789abcdef"})
    assert opts.plan_id == "0123456789abcdef"
    assert opts.concurrency == 3
    assert opts.poll_interval_ms == 5000
    assert opts.force_environment is False


def test_plugin_config_strips_unknown_keys() -> None:
    """TS PluginConfigSchema is non-strict zod: unknown keys are stripped."""
    cfg = PluginConfig.model_validate({"bogus": True, "maxParallelChunks": 2})
    assert cfg.max_parallel_chunks == 2
    assert not hasattr(cfg, "bogus")


# ---------- state ----------


def test_compute_environment_fingerprint_url_origin_only() -> None:
    fp = compute_environment_fingerprint(
        {"url": "https://ch.example.com:8443/some/path", "database": "events"}
    )
    assert fp is not None
    assert fp.url == "https://ch.example.com:8443"
    assert fp.database == "events"
    assert len(fp.fingerprint) == 16


def test_compute_environment_fingerprint_returns_none_for_missing_url() -> None:
    assert compute_environment_fingerprint(None) is None
    assert compute_environment_fingerprint({}) is None


def test_ensure_environment_match_raises_on_mismatch() -> None:
    plan = _make_plan()
    bound = plan.model_copy(
        update={"environment": compute_environment_fingerprint({"url": "https://a.com"})}
    )
    with pytest.raises(BackfillConfigError):
        ensure_environment_match(
            plan=bound,
            clickhouse={"url": "https://b.com"},
            force_environment=False,
        )


def test_ensure_environment_match_force_environment_bypasses() -> None:
    plan = _make_plan()
    bound = plan.model_copy(
        update={"environment": compute_environment_fingerprint({"url": "https://a.com"})}
    )
    # Should not raise.
    ensure_environment_match(
        plan=bound,
        clickhouse={"url": "https://b.com"},
        force_environment=True,
    )


def test_compute_backfill_state_dir_uses_meta_dir(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    state_dir = compute_backfill_state_dir(cfg, tmp_path / "x.config.py")
    assert state_dir == (Path(cfg.meta_dir) / "backfill").resolve()


def test_compute_backfill_state_dir_honors_override(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    state_dir = compute_backfill_state_dir(cfg, tmp_path / "x.config.py", "./.bf")
    assert state_dir.name == ".bf"


def test_backfill_paths_layout() -> None:
    paths = backfill_paths("/tmp/x", "0123456789abcdef")
    assert paths.plans_dir.endswith("plans")
    assert paths.runs_dir.endswith("runs")
    assert paths.plan_path.endswith("0123456789abcdef.json")


def test_write_json_handles_pydantic_models(tmp_path: Path) -> None:
    target = tmp_path / "x.json"
    write_json(target, _make_plan())
    raw = json.loads(target.read_text(encoding="utf-8"))
    assert raw["planId"] == "0123456789abcdef"


def test_read_plan_round_trip(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    plan = _make_plan()
    paths = backfill_paths(
        compute_backfill_state_dir(cfg, tmp_path / "x.config.py"), plan.plan_id
    )
    write_json(paths.plan_path, plan)
    out, _path, _state_dir = read_plan(
        plan_id=plan.plan_id,
        config_path=tmp_path / "x.config.py",
        config=cfg,
    )
    assert out.plan_id == plan.plan_id


def test_read_plan_raises_when_missing(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    with pytest.raises(BackfillConfigError):
        read_plan(
            plan_id="0123456789abcdef",
            config_path=tmp_path / "x.config.py",
            config=cfg,
        )


def test_read_plan_raises_on_legacy_layout(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    state_dir = compute_backfill_state_dir(cfg, tmp_path / "x.config.py")
    paths = backfill_paths(state_dir, "0123456789abcdef")
    Path(paths.plan_path).parent.mkdir(parents=True, exist_ok=True)
    # Missing both `chunkPlan` and `chunk_plan` → legacy layout.
    Path(paths.plan_path).write_text(json.dumps({"planId": "0123456789abcdef"}), encoding="utf-8")
    with pytest.raises(BackfillConfigError):
        read_plan(
            plan_id="0123456789abcdef",
            config_path=tmp_path / "x.config.py",
            config=cfg,
        )


def test_summarize_run_status_counts_done_and_pending(tmp_path: Path) -> None:
    plan = _make_plan(chunk_ids=["c1", "c2", "c3"])
    run = BackfillRunState(
        planId="0123456789abcdef",
        target="events.actions",
        status="running",
        startedAt="2026-01-01T00:00:00.000Z",
        updatedAt="2026-01-01T01:00:00.000Z",
        progress={
            "c1": {"status": "done", "writtenRows": 100},  # type: ignore[dict-item]
            "c2": {"status": "submitted"},  # type: ignore[dict-item]
        },
    )
    summary = summarize_run_status(run, "/run.json", plan)
    assert summary.totals.total == 3
    assert summary.totals.done == 1
    assert summary.totals.submitted == 1
    assert summary.totals.pending == 1
    assert summary.rows_written == 100


def test_plan_status_for_returns_run_status_verbatim() -> None:
    """Aligned with TS ``summarizeRunStatus``: derived status equals persisted
    ``run.status``; chunk-based ``completed`` derivation is the engine's job.
    """
    run = BackfillRunState(
        planId="x" * 16,
        target="t",
        status="running",
        startedAt="2026-01-01T00:00:00.000Z",
        updatedAt="2026-01-01T00:01:00.000Z",
    )
    counters = {"pending": 0, "submitted": 0, "running": 0, "done": 5, "failed": 0}
    # Even with all chunks done, the helper now returns the persisted status —
    # the engine is responsible for flipping run.status to "completed".
    assert plan_status_for(run, total_chunks=5, counters=counters) == "running"


def test_read_run_returns_none_when_missing(tmp_path: Path) -> None:
    assert read_run(tmp_path / "missing.json") is None


# ---------- plugin factory ----------


def test_backfill_plugin_factory_shape() -> None:
    plugin = backfill()
    assert plugin.manifest == ChxPluginManifest(name="backfill", api_version=1)
    assert plugin.commands is not None
    names = [c.name for c in plugin.commands]
    assert set(names) == {
        "status",
        "cancel",
        "submit",
        "plan",
        "run",
        "resume",
        "doctor",
    }


def test_submit_without_backend_prints_managed_backend_error(tmp_path: Path) -> None:
    plugin = backfill()
    assert plugin.commands is not None
    cmd = next(c for c in plugin.commands if c.name == "submit")
    msgs: list[Any] = []
    code = cmd.run(
        _make_command_context(
            config=_cfg(tmp_path), tmp_path=tmp_path, flags={}, msgs=msgs
        )
    )
    assert code == 2
    assert any("Backfill submit failed:" in str(m) for m in msgs)
    assert any("managed job backend" in str(m) for m in msgs)


def test_plan_without_clickhouse_reports_config_error(tmp_path: Path) -> None:
    plugin = backfill()
    assert plugin.commands is not None
    cmd = next(c for c in plugin.commands if c.name == "plan")
    msgs: list[Any] = []
    code = cmd.run(
        _make_command_context(
            config=_cfg(tmp_path),
            tmp_path=tmp_path,
            flags={"--target": "events.actions"},
            msgs=msgs,
        )
    )
    assert code == 2
    assert any("Backfill plan failed:" in str(m) for m in msgs)
    assert any("ClickHouse connection is required" in str(m) for m in msgs)


def test_plan_requires_target(tmp_path: Path) -> None:
    plugin = backfill()
    assert plugin.commands is not None
    cmd = next(c for c in plugin.commands if c.name == "plan")
    msgs: list[Any] = []
    code = cmd.run(
        _make_command_context(
            config=_cfg(tmp_path), tmp_path=tmp_path, flags={}, msgs=msgs
        )
    )
    assert code == 2
    assert any("--target" in str(m) for m in msgs)


def test_run_and_resume_require_plan_id(tmp_path: Path) -> None:
    plugin = backfill()
    assert plugin.commands is not None
    for name in ("run", "resume"):
        cmd = next(c for c in plugin.commands if c.name == name)
        msgs: list[Any] = []
        code = cmd.run(
            _make_command_context(
                config=_cfg(tmp_path), tmp_path=tmp_path, flags={}, msgs=msgs
            )
        )
        assert code == 2
        assert any("--plan-id" in str(m) for m in msgs)


def test_status_command_requires_plan_id(tmp_path: Path) -> None:
    plugin = backfill()
    assert plugin.commands is not None
    cmd = next(c for c in plugin.commands if c.name == "status")
    msgs: list[Any] = []
    code = cmd.run(
        _make_command_context(
            config=_cfg(tmp_path), tmp_path=tmp_path, flags={}, msgs=msgs
        )
    )
    assert code == 2
    assert any("--plan-id" in str(m) for m in msgs)


def test_status_command_reports_planned_when_no_run(tmp_path: Path) -> None:
    """Aligned with TS ``getBackfillStatus``: a plan without a run summarizes
    as ``planned`` with all chunks pending (exit 0), not an error."""
    cfg = _cfg(tmp_path)
    plan = _make_plan()
    paths = backfill_paths(
        compute_backfill_state_dir(cfg, tmp_path / "x.config.py"), plan.plan_id
    )
    write_json(paths.plan_path, plan)
    plugin = backfill()
    assert plugin.commands is not None
    status_cmd = next(c for c in plugin.commands if c.name == "status")
    msgs: list[Any] = []
    code = status_cmd.run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            flags={"--plan-id": plan.plan_id},
            json_mode=True,
            msgs=msgs,
        )
    )
    assert code == 0
    payload = msgs[0]
    assert payload["status"] == "planned"
    assert payload["chunkCounts"]["pending"] == 2
    assert payload["chunkCounts"]["total"] == 2


def test_status_command_prints_summary_on_existing_run(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    plan = _make_plan()
    paths = backfill_paths(
        compute_backfill_state_dir(cfg, tmp_path / "x.config.py"), plan.plan_id
    )
    write_json(paths.plan_path, plan)
    run = BackfillRunState(
        planId=plan.plan_id,
        target=plan.target,
        status="running",
        startedAt="2026-01-01T00:00:00.000Z",
        updatedAt="2026-01-01T01:00:00.000Z",
    )
    write_json(paths.run_path, run)
    plugin = backfill()
    assert plugin.commands is not None
    cmd = next(c for c in plugin.commands if c.name == "status")
    msgs: list[Any] = []
    code = cmd.run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            flags={"--plan-id": plan.plan_id},
            json_mode=True,
            msgs=msgs,
        )
    )
    assert code == 0
    payload = msgs[0]
    assert payload["planId"] == plan.plan_id
    assert payload["command"] == "status"
    assert payload["status"] == "running"


def test_cancel_command_marks_run_cancelled(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    plan = _make_plan()
    paths = backfill_paths(
        compute_backfill_state_dir(cfg, tmp_path / "x.config.py"), plan.plan_id
    )
    write_json(paths.plan_path, plan)
    run = BackfillRunState(
        planId=plan.plan_id,
        target=plan.target,
        status="running",
        startedAt="2026-01-01T00:00:00.000Z",
        updatedAt="2026-01-01T01:00:00.000Z",
    )
    write_json(paths.run_path, run)
    plugin = backfill()
    assert plugin.commands is not None
    cmd = next(c for c in plugin.commands if c.name == "cancel")
    code = cmd.run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            flags={"--plan-id": plan.plan_id},
        )
    )
    assert code == 0
    reread = read_run(paths.run_path)
    assert reread is not None
    assert reread.status == "cancelled"
    assert reread.completed_at is not None
    assert reread.last_error == "Cancelled by operator"


def test_cancel_command_when_no_run(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    plan = _make_plan()
    paths = backfill_paths(
        compute_backfill_state_dir(cfg, tmp_path / "x.config.py"), plan.plan_id
    )
    write_json(paths.plan_path, plan)
    plugin = backfill()
    assert plugin.commands is not None
    cmd = next(c for c in plugin.commands if c.name == "cancel")
    msgs: list[Any] = []
    code = cmd.run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            flags={"--plan-id": plan.plan_id},
            msgs=msgs,
        )
    )
    assert code == 2
    assert any("Backfill cancel failed:" in str(m) for m in msgs)
    assert any("Run state not found" in str(m) for m in msgs)


def test_doctor_reports_plan_missing_run(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    plan = _make_plan()
    paths = backfill_paths(
        compute_backfill_state_dir(cfg, tmp_path / "x.config.py"), plan.plan_id
    )
    write_json(paths.plan_path, plan)
    plugin = backfill()
    assert plugin.commands is not None
    cmd = next(c for c in plugin.commands if c.name == "doctor")
    msgs: list[Any] = []
    code = cmd.run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            flags={"--plan-id": plan.plan_id},
            json_mode=True,
            msgs=msgs,
        )
    )
    assert code == 1
    payload = msgs[0]
    assert payload["issueCodes"] == ["backfill_plan_missing"]
    assert any("backfill run --plan-id" in r for r in payload["recommendations"])
