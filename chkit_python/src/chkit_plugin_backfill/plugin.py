"""``backfill()`` plugin factory — Phase 1 surface.

Ships:

- ``backfill()`` factory + ``ChxPlugin`` with two functional commands:
  - ``status`` — reads ``<state_dir>/runs/<plan_id>.json`` and prints a
    summary (delegates to ``summarize_run_status``).
  - ``cancel`` — marks a run as ``cancelled`` in its on-disk state file.

- Stubs for ``plan`` / ``run`` / ``resume`` / ``doctor`` that print a
  Phase-2-pending message and return exit code 2. The
  ``chkit_plugin_obsessiondb.backfill_handler`` short-circuits before
  any of these for the remote-backfill case.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from chkit.plugins import (
    ChxPlugin,
    ChxPluginCommand,
    ChxPluginCommandContext,
    ChxPluginManifest,
)
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.options import (
    PLAN_FLAG_MAP,
    PLAN_ID_FLAG_MAP,
    PLAN_ID_FLAGS,
    PluginConfig,
)
from chkit_plugin_backfill.state import (
    backfill_paths,
    compute_backfill_state_dir,
    now_iso,
    read_plan,
    read_run,
    summarize_run_status,
    write_json,
)

_PHASE_2_MESSAGE = (
    "chkit_plugin_backfill: local `{command}` requires the chunking + execution "
    "engine, which is pending port (Phase 2). For ObsessionDB-managed jobs, run "
    "this with `--service-slug <slug>` or use the obsessiondb plugin's "
    "remote-backfill commands. See DRIFT.md > plugin-backfill."
)


def _str_flag(flags: dict[str, Any], name: str) -> str | None:
    value = flags.get(name)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


@dataclass
class _BackfillHooks:
    """Hook object reserved for the Phase 2 ``on_check`` implementation."""

    options: PluginConfig


def _resolve_state_dir(
    ctx: ChxPluginCommandContext, plugin_options: PluginConfig
) -> Path:
    state_dir_override = _str_flag(ctx.flags, "--state-dir") or plugin_options.state_dir
    return compute_backfill_state_dir(ctx.config, ctx.config_path, state_dir_override)


def _status_run(plugin_options: PluginConfig, ctx: ChxPluginCommandContext) -> int:
    plan_id = _str_flag(ctx.flags, "--plan-id")
    if plan_id is None:
        ctx.print("--plan-id is required for `backfill status`.")
        return 1
    try:
        plan, _plan_path, state_dir = read_plan(
            plan_id=plan_id,
            config_path=ctx.config_path,
            config=ctx.config,
            state_dir=plugin_options.state_dir,
        )
    except BackfillConfigError as error:
        ctx.print(str(error))
        return 1
    paths = backfill_paths(state_dir, plan_id)
    run = read_run(paths.run_path)
    if run is None:
        ctx.print(
            f"No run state for plan {plan_id} at {paths.run_path}. "
            "Plan exists but has not been executed yet."
        )
        return 1
    summary = summarize_run_status(run, paths.run_path, plan)
    payload = summary.model_dump(by_alias=True, exclude_none=True)
    if ctx.json_mode:
        ctx.print(payload)
        return 0
    ctx.print(
        f"plan {summary.plan_id} target={summary.target} status={summary.status} "
        f"done={summary.totals.done}/{summary.totals.total} "
        f"rows_written={summary.rows_written}"
    )
    if summary.last_error:
        ctx.print(f"last_error: {summary.last_error}")
    return 0


def _cancel_run(plugin_options: PluginConfig, ctx: ChxPluginCommandContext) -> int:
    plan_id = _str_flag(ctx.flags, "--plan-id")
    if plan_id is None:
        ctx.print("--plan-id is required for `backfill cancel`.")
        return 1
    try:
        _plan, _plan_path, state_dir = read_plan(
            plan_id=plan_id,
            config_path=ctx.config_path,
            config=ctx.config,
            state_dir=plugin_options.state_dir,
        )
    except BackfillConfigError as error:
        ctx.print(str(error))
        return 1
    paths = backfill_paths(state_dir, plan_id)
    run = read_run(paths.run_path)
    if run is None:
        ctx.print(f"No run to cancel for plan {plan_id}.")
        return 1
    run.status = "cancelled"
    run.updated_at = now_iso()
    write_json(paths.run_path, run)
    ctx.print(f"Cancelled plan {plan_id}.")
    return 0


def _phase_two_stub(command: str) -> ChxPluginCommand:
    def _run(ctx: ChxPluginCommandContext) -> int:
        ctx.print(_PHASE_2_MESSAGE.format(command=command))
        return 2

    return ChxPluginCommand(
        name=command,
        description=f"`{command}` is pending Phase 2 of the backfill plugin port.",
        run=_run,
    )


def create_backfill_plugin(
    options: PluginConfig | dict[str, Any] | None = None,
) -> ChxPlugin:
    """Build the ``backfill`` ChxPlugin (Phase 1 surface)."""
    if options is None:
        plugin_options = PluginConfig()
    elif isinstance(options, PluginConfig):
        plugin_options = options
    else:
        plugin_options = PluginConfig.model_validate(options)

    def _status(ctx: ChxPluginCommandContext) -> int:
        return _status_run(plugin_options, ctx)

    def _cancel(ctx: ChxPluginCommandContext) -> int:
        return _cancel_run(plugin_options, ctx)

    return ChxPlugin(
        manifest=ChxPluginManifest(name="backfill", api_version=1),
        hooks=_BackfillHooks(options=plugin_options),
        commands=[
            ChxPluginCommand(
                name="status",
                description="Show the current status of a backfill run.",
                run=_status,
                flags=list(PLAN_ID_FLAGS),
            ),
            ChxPluginCommand(
                name="cancel",
                description="Cancel a running backfill (marks state as cancelled).",
                run=_cancel,
                flags=list(PLAN_ID_FLAGS),
            ),
            _phase_two_stub("plan"),
            _phase_two_stub("run"),
            _phase_two_stub("resume"),
            _phase_two_stub("doctor"),
        ],
        options_schema=PluginConfig,
        extend_commands=[
            {"flag_mapping": {**PLAN_FLAG_MAP, **PLAN_ID_FLAG_MAP}},
        ],
    )


def backfill(
    options: PluginConfig | dict[str, Any] | None = None,
) -> ChxPlugin:
    """Public factory mirroring the TS ``backfill()`` registration helper."""
    return create_backfill_plugin(options)


__all__ = ["backfill", "create_backfill_plugin"]
