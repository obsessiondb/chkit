"""Managed backfill submit — port of ``packages/plugin-obsessiondb/src/backfill/submit.ts``.

Builds the same chunk plan the local executor would run, maps each chunk to a
jobs-backend task carrying the exact ``INSERT … SELECT`` SQL + idempotency
token, and posts the list via ``jobs/submit``.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from chkit_plugin_backfill.chunking.types import QuerySettings
from chkit_plugin_backfill.chunking.utils.jsnum import parse_js_number
from chkit_plugin_backfill.options import PlanOptions, parse_byte_size
from chkit_plugin_backfill.sdk import (
    BackfillPlanState,
    build_backfill_plan,
    build_chunk_execution_sql,
    generate_idempotency_token,
)
from chkit_plugin_obsessiondb.api_client import is_session_expired_error
from chkit_plugin_obsessiondb.console_url import build_job_console_url
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.jobs_api import JobSubmitTask, jobs_submit
from chkit_plugin_obsessiondb.remote_executor import create_remote_executor

_TARGET_RE = re.compile(r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")
_MAX_CONCURRENCY = 48


def build_submit_tasks(plan: BackfillPlanState) -> list[JobSubmitTask]:
    """Map a backfill plan into the task list the jobs backend expects. Each
    chunk renders the exact same ``INSERT … SELECT`` the local executor would
    run, so the algorithm is identical — only the execution venue differs.
    """
    return [
        JobSubmitTask(
            id=chunk.id,
            sql=build_chunk_execution_sql(
                plan_id=plan.plan_id,
                chunk=chunk,
                target=plan.target,
                source_target=plan.execution.source_target,
                table=plan.chunk_plan.table,
                mv_replay_queries=plan.execution.mv_replay_queries,
                target_columns=plan.execution.target_columns,
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


def parse_submit_input(flags: dict[str, Any]) -> ParsedSubmitInput:
    target = _flag_string(flags, "--target")
    if target is None or _TARGET_RE.match(target) is None:
        msg = "backfill submit requires --target <database.table>"
        raise ValueError(msg)

    raw_bytes = _flag_string(flags, "--max-chunk-bytes")
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

    plan_fields: dict[str, Any] = {"target": target}
    from_value = _coerce_timestamp(_flag_string(flags, "--from"), "--from")
    to_value = _coerce_timestamp(_flag_string(flags, "--to"), "--to")
    if from_value is not None:
        plan_fields["from"] = from_value
    if to_value is not None:
        plan_fields["to"] = to_value
    if raw_bytes is not None:
        plan_fields["maxChunkBytes"] = parse_byte_size(raw_bytes)

    opts = PlanOptions.model_validate(plan_fields)

    return ParsedSubmitInput(
        opts=opts, title=_flag_string(flags, "--title"), concurrency=concurrency
    )


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
        parsed = parse_submit_input(context.flags)

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
        plan = output.plan

        tasks = build_submit_tasks(plan)
        job_id = jobs_submit(
            context.credentials,
            service_slug=context.service_slug,
            target=plan.target,
            tasks=tasks,
            title=parsed.title,
            concurrency=parsed.concurrency,
            metadata={
                "planId": plan.plan_id,
                "mode": plan.execution.mode,
                "source": "chkit",
            },
        )

        url = build_job_console_url(
            context.credentials.base_url, context.service_slug, job_id
        )
        if context.json_mode:
            context.print(
                {
                    "ok": True,
                    "command": "backfill submit",
                    "jobId": job_id,
                    "target": plan.target,
                    "taskCount": len(tasks),
                    "url": url,
                }
            )
        else:
            plural = "" if len(tasks) == 1 else "s"
            context.print(
                f"Submitted backfill job {job_id} for {plan.target} "
                f"({len(tasks)} task{plural}).\n"
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


__all__ = [
    "ParsedSubmitInput",
    "SubmitContext",
    "build_submit_tasks",
    "handle_submit",
    "parse_submit_input",
]
