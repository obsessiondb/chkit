"""Backfill plugin/options tests not covered by ``test_backfill_plugin.py``.

Ports the ``packages/plugin-backfill/src/plugin.test.ts`` cases (command
order, factory options carried into runtime option resolution, root vs sdk
module surface) and the ``packages/plugin-backfill/src/options.test.ts``
cases missing from ``test_backfill_plugin.py`` (byte-size parsing edge
cases, full schema defaults, resume/check defaults, flag-vs-factory
resolution, plugin config parsing).

Python has no generic ``resolve_options`` helper (TS ``@chkit/core``); the
equivalent pipeline is ``_options_from_flags`` + ``_with_factory_defaults``
+ Pydantic validation, which these tests exercise directly.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

import chkit_plugin_backfill
from chkit.plugins import ChxPluginManifest
from chkit_plugin_backfill import sdk
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.options import (
    PLAN_FLAG_MAP,
    RUN_FLAG_MAP,
    CheckOptions,
    PlanOptions,
    PluginConfig,
    ResumeOptions,
    RunOptions,
    parse_byte_size,
)
from chkit_plugin_backfill.plugin import (
    _options_from_flags,
    _with_factory_defaults,
    backfill,
    create_backfill_plugin,
)

# ---------- plugin surface (plugin.test.ts) ----------


def test_plugin_exposes_commands_in_ts_order() -> None:
    plugin = create_backfill_plugin()
    registration = backfill({"maxParallelChunks": 4})

    assert plugin.manifest == ChxPluginManifest(name="backfill", api_version=1)
    assert plugin.commands is not None
    assert [command.name for command in plugin.commands] == [
        "plan",
        "submit",
        "run",
        "resume",
        "status",
        "cancel",
        "doctor",
    ]
    assert registration.manifest.name == "backfill"


def test_create_backfill_plugin_carries_factory_options_into_runtime_options() -> None:
    factory = PluginConfig.model_validate(
        {"maxParallelChunks": 4, "stateDir": "./state"}
    )

    plugin_result = PluginConfig.model_validate({"maxParallelChunks": 4})
    plan_result = PlanOptions.model_validate(
        _with_factory_defaults(
            set(PlanOptions.model_fields), factory, {"target": "app.events"}
        )
    )
    run_result = RunOptions.model_validate(
        _with_factory_defaults(
            set(RunOptions.model_fields), factory, {"plan_id": "0123456789abcdef"}
        )
    )

    assert plugin_result.max_parallel_chunks == 4
    assert plan_result.max_parallel_chunks == 4
    assert plan_result.state_dir == "./state"
    assert run_result.state_dir == "./state"


def test_keeps_internals_off_the_package_root_and_exposes_them_via_sdk() -> None:
    assert not hasattr(chkit_plugin_backfill, "analyze_and_chunk")
    assert not hasattr(chkit_plugin_backfill, "execute_backfill")

    assert hasattr(sdk, "analyze_and_chunk")
    assert hasattr(sdk, "generate_chunk_plan")
    assert hasattr(sdk, "get_backfill_logger")
    assert hasattr(sdk, "execute_backfill")
    assert hasattr(sdk, "build_chunk_execution_sql")
    assert hasattr(sdk, "build_where_clause_from_chunk")
    assert hasattr(sdk, "encode_chunk_plan_for_persistence")
    assert hasattr(sdk, "decode_chunk_plan_from_persistence")
    assert hasattr(sdk, "generate_idempotency_token")


def test_root_and_sdk_declare_separate_public_surfaces() -> None:
    """Python analog of the TS package-exports test: the root package and the
    ``sdk`` module keep distinct ``__all__`` surfaces."""
    assert "analyze_and_chunk" not in chkit_plugin_backfill.__all__
    assert "execute_backfill" not in chkit_plugin_backfill.__all__
    assert "backfill" in chkit_plugin_backfill.__all__
    assert "analyze_and_chunk" in sdk.__all__
    assert "execute_backfill" in sdk.__all__


# ---------- parse_byte_size (options.test.ts) ----------


def test_parse_byte_size_parses_kilobytes() -> None:
    assert parse_byte_size("256K") == 256 * 1024


def test_parse_byte_size_parses_plain_number_as_bytes() -> None:
    assert parse_byte_size("1048576") == 1048576


def test_parse_byte_size_is_case_insensitive() -> None:
    assert parse_byte_size("10g") == 10 * 1024**3
    assert parse_byte_size("500m") == 500 * 1024**2


def test_parse_byte_size_trims_whitespace() -> None:
    assert parse_byte_size("  10G  ") == 10 * 1024**3


def test_parse_byte_size_raises_on_invalid_input() -> None:
    with pytest.raises(BackfillConfigError, match="Invalid byte size"):
        parse_byte_size("abc")
    with pytest.raises(BackfillConfigError, match="Invalid byte size"):
        parse_byte_size("")
    with pytest.raises(BackfillConfigError, match="Invalid byte size"):
        parse_byte_size("10X")


# ---------- schema defaults (options.test.ts) ----------


def test_plan_options_applies_all_documented_defaults() -> None:
    opts = PlanOptions.model_validate({"target": "default.events"})

    assert opts.max_chunk_bytes == 10 * 1024**3
    assert opts.max_parallel_chunks == 1
    assert opts.max_retries_per_chunk == 3
    assert opts.require_idempotency_token is True
    assert opts.require_explicit_window is True
    assert opts.block_overlapping_runs is True
    assert opts.require_dry_run_before_run is True
    assert opts.fail_check_on_required_pending_backfill is True
    assert opts.max_window_hours == 720
    assert opts.min_chunk_minutes == 15
    assert opts.time_column is None


def test_plan_options_overrides_work() -> None:
    opts = PlanOptions.model_validate(
        {
            "target": "default.events",
            "maxChunkBytes": 5 * 1024**3,
            "requireIdempotencyToken": False,
        }
    )

    assert opts.max_chunk_bytes == 5 * 1024**3
    assert opts.require_idempotency_token is False


def test_resume_options_extends_run_options_with_replay_failed() -> None:
    opts = ResumeOptions.model_validate({"planId": "abc123def456789a"})

    assert opts.force_environment is False
    assert opts.concurrency == 3
    assert opts.poll_interval_ms == 5000
    assert opts.replay_failed is False


# ---------- flag + factory resolution (options.test.ts resolveOptions) ----------


def test_cli_flags_override_factory_options() -> None:
    factory = PluginConfig.model_validate({"maxChunkBytes": 8 * 1024**3})
    flag_options = _options_from_flags(
        {"--target": "app.events", "--max-chunk-bytes": "20G"}, PLAN_FLAG_MAP
    )
    opts = PlanOptions.model_validate(
        _with_factory_defaults(set(PlanOptions.model_fields), factory, flag_options)
    )

    assert opts.target == "app.events"
    assert opts.max_chunk_bytes == 20 * 1024**3


def test_factory_options_apply_when_no_cli_override() -> None:
    factory = PluginConfig.model_validate({"stateDir": "./state"})
    flag_options = _options_from_flags(
        {"--plan-id": "abc123def456789a"}, RUN_FLAG_MAP
    )
    opts = RunOptions.model_validate(
        _with_factory_defaults(set(RunOptions.model_fields), factory, flag_options)
    )

    assert opts.state_dir == "./state"


def test_schema_defaults_apply_when_no_override_provided() -> None:
    flag_options = _options_from_flags(
        {"--plan-id": "abc123def456789a"}, RUN_FLAG_MAP
    )
    opts = RunOptions.model_validate(
        _with_factory_defaults(
            set(RunOptions.model_fields), PluginConfig(), flag_options
        )
    )

    assert opts.concurrency == 3
    assert opts.poll_interval_ms == 5000
    assert opts.force_environment is False


def test_validation_raises_on_missing_required_options() -> None:
    with pytest.raises(ValidationError):
        PlanOptions.model_validate(
            _with_factory_defaults(set(PlanOptions.model_fields), PluginConfig(), {})
        )


# ---------- PluginConfig + CheckOptions (options.test.ts) ----------


def test_plugin_config_accepts_empty_config() -> None:
    config = PluginConfig.model_validate({})
    assert config.model_dump(exclude_none=True) == {}


def test_plugin_config_accepts_flat_config_fields() -> None:
    config = PluginConfig.model_validate(
        {
            "maxRetriesPerChunk": 5,
            "blockOverlappingRuns": False,
            "maxWindowHours": 48,
        }
    )

    assert config.max_retries_per_chunk == 5
    assert config.block_overlapping_runs is False
    assert config.max_window_hours == 48


def test_check_options_defaults_fail_check_on_required_pending_backfill_true() -> None:
    opts = CheckOptions.model_validate({})
    assert opts.fail_check_on_required_pending_backfill is True
