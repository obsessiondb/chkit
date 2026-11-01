"""Managed backfill submit — port of ``packages/plugin-obsessiondb/src/backfill/submit.ts``.

Builds the same chunk plan the local executor would run, maps each chunk to a
jobs-backend task carrying the exact ``INSERT … SELECT`` SQL + idempotency
token, and posts the list via ``jobs/submit``.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from chkit.core.jsnum import parse_js_number
from chkit_plugin_backfill.chunking.types import QuerySettings
from chkit_plugin_backfill.options import PlanOptions, PluginConfig, parse_byte_size
from chkit_plugin_backfill.sdk import (
    BackfillPlanState,
    build_backfill_plan,
    build_chunk_execution_sql,
    generate_idempotency_token,
    record_backfill_submission,
)
from chkit_plugin_obsessiondb.api_client import is_session_expired_error
from chkit_plugin_obsessiondb.backfill_plugin_options import (
    resolve_backfill_plugin_options,
)
from chkit_plugin_obsessiondb.backfill_resubmit import (
    ReplacedJob,
    load_plan_for_resubmit,
)
from chkit_plugin_obsessiondb.console_url import build_job_console_url
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.jobs_api import JobSubmitTask, jobs_submit
from chkit_plugin_obsessiondb.remote_executor import create_remote_executor

_TARGET_RE = re.compile(r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")
_PLAN_ID_RE = re.compile(r"^[a-f0-9]{16}$")
# Flags that choose the rows of a new plan; a saved plan has already fixed them.
_PLANNING_FLAGS = ("--target", "--cutover", "--from", "--to", "--max-chunk-bytes")
_MAX_CONCURRENCY = 48


def build_submit_tasks(
    plan: BackfillPlanState,
    insert_settings: Mapping[str, str | int | float | bool] | None = None,
) -> list[JobSubmitTask]:
    """Map a backfill plan into the task list the jobs backend expects. Each
    chunk renders the exact same ``INSERT … SELECT`` the local executor would
    run, so the algorithm is identical — only the execution venue differs.
    """
    return [
        JobSubmitTask(
            id=chunk.id,
            sql=build_chunk_execution_sql(
                insert_settings=insert_settings,
                plan_id=plan.plan_id,
                chunk=chunk,
                target=plan.target,
                source_target=plan.execution.source_target,
                table=plan.chunk_plan.table,
                mv_replay_queries=plan.execution.mv_replay_queries,
                target_columns=plan.execution.target_columns,
                cutover_key=plan.execution.cutover_key,
                idempotency_token=(
                    generate_idempotency_token(plan.plan_id, chunk.id)
                    if plan.execution.require_idempotency_token
                    else ""
                ),
            ),
            group=chunk.partition_id,
            estimated_bytes=chunk.estimate.bytes_compressed,
            estimated_bytes_uncompressed=chunk.estimate.bytes_uncompressed,
            max_retries=plan.options.max_retries_per_chunk,
        )
        for chunk in plan.chunk_plan.chunks
    ]


@dataclass(frozen=True)
class ParsedSubmitInput:
    opts: PlanOptions
    title: str | None = None
    concurrency: int | None = None


def _flag_string(flags: dict[str, Any], name: str) -> str | None:
    value = flags.get(name)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _coerce_timestamp(raw: str | None, flag: str) -> str | None:
    if raw is None:
        return None
    from chkit_plugin_backfill.options import (  # noqa: PLC0415
        _normalize_timestamp,
    )

    try:
        return _normalize_timestamp(raw, flag)
    except Exception as error:
        msg = f"Invalid timestamp for {flag}: {raw}"
        raise ValueError(msg) from error


def parse_submit_input(
    flags: dict[str, Any], plugin_options: PluginConfig | None = None
) -> ParsedSubmitInput:
    """``plugin_options`` are the backfill plugin's options (see
    ``resolve_backfill_plugin_options``). The flags override them, as for the
    local ``plan``, and the plan and its submission marker land in their
    ``stateDir``.
    """
    target = _flag_string(flags, "--target")
    cutover = _flag_string(flags, "--cutover")
    named = target if target is not None else cutover
    if named is None or (target and cutover) or _TARGET_RE.match(named) is None:
        msg = "backfill submit requires --target <database.table> or --cutover <database.table>"
        raise ValueError(msg)

    raw_bytes = _flag_string(flags, "--max-chunk-bytes")
    plan_fields: dict[str, Any] = {
        key: value
        for key, value in (plugin_options or PluginConfig())
        .model_dump(exclude_none=True)
        .items()
        if key in PlanOptions.model_fields
    }
    plan_fields["target"] = target or ""
    if cutover:
        plan_fields["cutover"] = cutover
    from_value = _coerce_timestamp(_flag_string(flags, "--from"), "--from")
    to_value = _coerce_timestamp(_flag_string(flags, "--to"), "--to")
    if from_value is not None:
        plan_fields["from_"] = from_value
    if to_value is not None:
        plan_fields["to"] = to_value
    if raw_bytes is not None:
        plan_fields["max_chunk_bytes"] = parse_byte_size(raw_bytes)

    opts = PlanOptions.model_validate(plan_fields)

    title, concurrency = _parse_job_flags(flags)
    return ParsedSubmitInput(opts=opts, title=title, concurrency=concurrency)


@dataclass(frozen=True)
class ParsedResubmitInput:
    plan_id: str
    title: str | None = None
    concurrency: int | None = None


def parse_resubmit_input(flags: dict[str, Any]) -> ParsedResubmitInput:
    """``submit --plan-id <id>``: re-submit a saved plan instead of planning."""
    plan_id = _flag_string(flags, "--plan-id")
    if plan_id is None or _PLAN_ID_RE.match(plan_id) is None:
        msg = "Invalid value for --plan-id. Expected a 16-char lowercase hex id."
        raise ValueError(msg)
    planning_flags = [name for name in _PLANNING_FLAGS if flags.get(name) is not None]
    if planning_flags:
        msg = (
            "--plan-id re-submits a saved plan and cannot be combined with"
            f" {', '.join(planning_flags)}."
        )
        raise ValueError(msg)
    title, concurrency = _parse_job_flags(flags)
    return ParsedResubmitInput(plan_id=plan_id, title=title, concurrency=concurrency)


def _parse_job_flags(flags: dict[str, Any]) -> tuple[str | None, int | None]:
    """Job settings accepted both for a new plan and for a re-submitted one."""
    raw_concurrency = _flag_string(flags, "--concurrency")
    concurrency: int | None = None
    if raw_concurrency is not None:
        # TS `Number(raw)` grammar — the shared JS-Number emulation rejects
        # `3_0` and accepts `0x10` exactly as the TS parser does.
        parsed = parse_js_number(raw_concurrency)
        if (
            math.isnan(parsed)
            or not math.isfinite(parsed)
            or not parsed.is_integer()
            or parsed <= 0
            or parsed > _MAX_CONCURRENCY
        ):
            msg = (
                "Invalid value for --concurrency."
                " Expected an integer between 1 and 48."
            )
            raise ValueError(msg)
        concurrency = int(parsed)
    return _flag_string(flags, "--title"), concurrency


@dataclass(frozen=True)
class SubmitContext:
    flags: dict[str, Any]
    config_path: str
    json_mode: bool
    config: Any  # needs .meta_dir + .schema_ (ChxResolvedConfig-compatible)
    print: Callable[[Any], None]
    credentials: Credentials
    service_slug: str


def handle_submit(context: SubmitContext) -> int:
    """Run the managed submit flow; returns the exit code (always handled)."""
    try:
        plugin_options = resolve_backfill_plugin_options(
            getattr(context.config, "plugins", None)
        )
        prepared = (
            _prepare_resubmit(context, plugin_options)
            if context.flags.get("--plan-id") is not None
            else _prepare_new_plan(context, plugin_options)
        )
        plan = prepared.plan

        # Same INSERT settings the local executor applies (backfill({insertSettings})).
        tasks = build_submit_tasks(plan, plugin_options.insert_settings)
        job_id = jobs_submit(
            context.credentials,
            service_slug=context.service_slug,
            target=plan.target,
            tasks=tasks,
            title=prepared.title,
            concurrency=prepared.concurrency,
            metadata={
                "planId": plan.plan_id,
                "mode": plan.execution.mode,
                "source": "chkit",
            },
        )
        # The job runs server-side and never writes a local run, so mark the
        # plan as submitted; otherwise `chkit check` counts it as pending forever.
        # A re-submission replaces the marker of the failed or cancelled job.
        record_backfill_submission(
            plan_id=plan.plan_id,
            target=plan.target,
            job_id=job_id,
            config_path=context.config_path,
            config=context.config,
            state_dir=prepared.state_dir,
        )

        url = build_job_console_url(
            context.credentials.base_url, context.service_slug, job_id
        )
        replaced = prepared.replaced_job
        task_label = f"{len(tasks)} task{'' if len(tasks) == 1 else 's'}"
        if context.json_mode:
            payload: dict[str, Any] = {
                "ok": True,
                "command": "backfill submit",
                "jobId": job_id,
                "target": plan.target,
                "taskCount": len(tasks),
                "url": url,
            }
            if replaced is not None:
                payload["planId"] = plan.plan_id
                payload["replacedJobId"] = replaced.id
                payload["skippedChunks"] = prepared.skipped_chunks
            context.print(payload)
        elif replaced is not None:
            skipped = prepared.skipped_chunks
            skipped_line = (
                f"Skipped {skipped} chunk{'' if skipped == 1 else 's'} that already"
                " finished.\n"
                if skipped
                else ""
            )
            context.print(
                f"Re-submitted backfill plan {plan.plan_id} as job {job_id} for "
                f"{plan.target} ({task_label}), replacing {replaced.status} job "
                f"{replaced.id}.\n"
                f"{skipped_line}"
                f"Track progress: {url}"
            )
        else:
            context.print(
                f"Submitted backfill job {job_id} for {plan.target} "
                f"({task_label}).\n"
                f"Track progress: {url}"
            )
        return 0
    except Exception as error:
        if is_session_expired_error(error):
            context.print(str(error))
            return 1
        message = str(error)
        if context.json_mode:
            context.print(
                {"ok": False, "command": "backfill submit", "error": message}
            )
        else:
            context.print(f"Backfill submit failed: {message}")
        return 1


@dataclass(frozen=True)
class _PreparedSubmission:
    plan: BackfillPlanState
    title: str | None = None
    concurrency: int | None = None
    state_dir: str | None = None
    # The failed or cancelled job that a `--plan-id` re-submission replaces.
    replaced_job: ReplacedJob | None = None
    # Chunks a re-submission leaves out because they finished in the replaced job.
    skipped_chunks: int = 0


def _prepare_new_plan(
    context: SubmitContext, plugin_options: PluginConfig
) -> _PreparedSubmission:
    parsed = parse_submit_input(context.flags, plugin_options)

    executor = create_remote_executor(
        context.credentials,
        service_slug=context.service_slug,
    )

    def clickhouse_query(
        sql: str, settings: QuerySettings | None
    ) -> list[dict[str, object]]:
        return executor.query(
            sql, dict(settings) if settings is not None else None
        ).rows

    output = build_backfill_plan(
        opts=parsed.opts,
        config_path=context.config_path,
        config=context.config,
        clickhouse_query=clickhouse_query,
        # ObsessionDB enables parallel replicas by default, which inflates
        # aggregate results used for chunk sizing. Disable for planning.
        query_settings={"enable_parallel_replicas": 0},
    )
    return _PreparedSubmission(
        plan=output.plan,
        title=parsed.title,
        concurrency=parsed.concurrency,
        state_dir=parsed.opts.state_dir,
    )


def _prepare_resubmit(
    context: SubmitContext, plugin_options: PluginConfig
) -> _PreparedSubmission:
    parsed = parse_resubmit_input(context.flags)
    # The saved plan and its marker live in the backfill plugin's stateDir.
    state_dir = plugin_options.state_dir
    loaded = load_plan_for_resubmit(
        plan_id=parsed.plan_id,
        config_path=context.config_path,
        config=context.config,
        credentials=context.credentials,
        state_dir=state_dir,
    )
    return _PreparedSubmission(
        plan=loaded.plan,
        title=parsed.title,
        concurrency=parsed.concurrency,
        state_dir=state_dir,
        replaced_job=loaded.replaced_job,
        skipped_chunks=loaded.skipped_chunks,
    )


__all__ = [
    "ParsedResubmitInput",
    "ParsedSubmitInput",
    "SubmitContext",
    "build_submit_tasks",
    "handle_submit",
    "parse_resubmit_input",
    "parse_submit_input",
]
