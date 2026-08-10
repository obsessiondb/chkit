"""``backfill()`` plugin factory — full Phase-2 surface.

Port of ``packages/plugin-backfill/src/plugin.ts``: real ``plan`` / ``run`` /
``resume`` / ``status`` / ``cancel`` / ``doctor`` command handlers plus the
``on_check`` hook. ``submit`` keeps the TS local-handler behaviour (clear
error when no managed backend intercepts via the ObsessionDB plugin).
"""

from __future__ import annotations

import threading
from typing import Any

from chkit.clickhouse.client import ClickHouseClient, QueryStatus
from chkit.core.model import ChxResolvedClickHouseConfig, ChxResolvedConfig
from chkit.plugins import (
    ChxOnCheckContext,
    ChxOnCheckReportContext,
    ChxOnCheckResult,
    ChxPlugin,
    ChxPluginCommand,
    ChxPluginCommandContext,
    ChxPluginManifest,
)
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.check import evaluate_backfill_check
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import QuerySettings
from chkit_plugin_backfill.chunking.utils.ids import generate_idempotency_token
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.logging_utils import format_bytes
from chkit_plugin_backfill.options import (
    PLAN_FLAG_MAP,
    PLAN_FLAGS,
    PLAN_ID_FLAG_MAP,
    PLAN_ID_FLAGS,
    RESUME_FLAG_MAP,
    RESUME_FLAGS,
    RUN_FLAG_MAP,
    RUN_FLAGS,
    SUBMIT_FLAG_MAP,
    SUBMIT_FLAGS,
    CheckOptions,
    PlanOptions,
    PluginConfig,
    ResumeOptions,
    RunOptions,
    StatusOptions,
)
from chkit_plugin_backfill.payload import (
    cancel_payload,
    doctor_payload,
    plan_payload,
    status_payload,
)
from chkit_plugin_backfill.planner import build_backfill_plan
from chkit_plugin_backfill.queries import (
    cancel_backfill_run,
    get_backfill_doctor_report,
    get_backfill_status,
)
from chkit_plugin_backfill.state import (
    backfill_paths,
    ensure_environment_match,
    now_iso,
    read_plan,
    read_run,
    summarize_run_status,
    write_json,
)
from chkit_plugin_backfill.types import (
    BackfillProgress,
    BackfillRunState,
)

_ZERO_ROWS_WARNING = (
    "Warning: 0 rows written across all chunks. Verify that source data exists"
    " in the time range and passes the query's WHERE filters."
)


def _options_from_flags(
    flags: dict[str, Any], flag_map: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """Promote parsed CLI flags into an option dict via a flag mapping
    (mirrors the TS plugin runner's ``flagMapping`` step)."""
    options: dict[str, Any] = {}
    for flag_name, mapping in flag_map.items():
        if flag_name not in flags:
            continue
        value = flags[flag_name]
        if value is None:
            continue
        coerce = mapping.get("coerce")
        options[mapping["key"]] = (
            coerce(value) if coerce is not None and isinstance(value, str) else value
        )
    return options


def _with_factory_defaults(
    model_fields: set[str],
    factory_options: PluginConfig,
    flag_options: dict[str, Any],
) -> dict[str, Any]:
    """TS ``withFactoryDefaults``: factory options act as schema defaults,
    explicit CLI values override them."""
    defaults = {
        key: value
        for key, value in factory_options.model_dump(exclude_none=True).items()
        if key in model_fields
    }
    return {**defaults, **flag_options}


def _clickhouse_dict(
    clickhouse: ChxResolvedClickHouseConfig,
) -> dict[str, str]:
    return {"url": clickhouse.url, "database": clickhouse.database}


class _ThreadLocalExecutor:
    """Thread-safe executor for the backfill run loop.

    ``clickhouse-connect`` clients auto-generate an HTTP session id, and
    concurrent queries within one session error out — so each worker thread
    gets its own connection. This preserves the TS loop's server-side
    parallelism (N concurrent INSERTs) with unchanged checkpoint semantics.
    """

    def __init__(self, config: ChxResolvedClickHouseConfig) -> None:
        self._config = config
        self._local = threading.local()
        self._clients: list[ClickHouseClient] = []
        self._clients_lock = threading.Lock()

    def _client(self) -> ClickHouseClient:
        client = getattr(self._local, "client", None)
        if client is None:
            client = ClickHouseClient.connect(self._config)
            self._local.client = client
            with self._clients_lock:
                self._clients.append(client)
        return client

    def submit(self, statement: str, query_id: str | None = None) -> str:
        return self._client().submit(statement, query_id)

    def query_status(
        self, query_id: str, *, after_time: str | None = None
    ) -> QueryStatus:
        return self._client().query_status(query_id, after_time=after_time)

    def query(self, statement: str) -> object:
        return self._client().query(statement)

    def close(self) -> None:
        with self._clients_lock:
            clients = list(self._clients)
            self._clients.clear()
        for client in clients:
            client.close()


def _require_clickhouse(
    ctx: ChxPluginCommandContext, purpose: str
) -> ChxResolvedClickHouseConfig:
    clickhouse = ctx.config.clickhouse
    if clickhouse is None:
        msg = (
            f"ClickHouse connection is required for backfill {purpose}. "
            "Configure clickhouse in your clickhouse.config.py."
        )
        raise BackfillConfigError(msg)
    return clickhouse


def _run_backfill(  # noqa: PLR0915 — mirrors TS runBackfill
    *,
    plan_id: str,
    force_environment: bool,
    concurrency: int,
    poll_interval_ms: int,
    state_dir: str | None,
    config_path: str,
    config: ChxResolvedConfig,
    clickhouse: ChxResolvedClickHouseConfig,
    print_fn: Any,
    json_mode: bool,
    resume_from: BackfillProgress | None = None,
    replay_failed: bool = False,
) -> int:
    plan, _plan_path, resolved_state_dir = read_plan(
        plan_id=plan_id,
        config_path=config_path,
        config=config,
        state_dir=state_dir,
    )

    ensure_environment_match(
        plan=plan,
        clickhouse=_clickhouse_dict(clickhouse),
        force_environment=force_environment,
    )

    paths = backfill_paths(resolved_state_dir, plan.plan_id)

    # Check for existing run state
    existing_run = read_run(paths.run_path)

    if existing_run is not None and resume_from is None:
        # `run` command (no resume_from) must not silently continue an existing
        # run. Users should use `backfill resume` instead.
        status = existing_run.status
        if status == "completed":
            msg = f"Run already completed for plan {plan.plan_id}. Nothing to do."
            raise BackfillConfigError(msg)
        if status == "cancelled":
            msg = (
                f"Run is cancelled for plan {plan.plan_id}. "
                "Create a new plan or inspect with backfill doctor."
            )
            raise BackfillConfigError(msg)
        msg = (
            f"A run already exists for plan {plan.plan_id} (status: {status}). "
            "Use backfill resume to continue."
        )
        raise BackfillConfigError(msg)

    db = _ThreadLocalExecutor(clickhouse)

    try:
        run_state = BackfillRunState(
            plan_id=plan.plan_id,
            target=plan.target,
            status="running",
            started_at=(
                existing_run.started_at if existing_run is not None else now_iso()
            ),
            updated_at=now_iso(),
            progress=resume_from if resume_from is not None else {},
        )

        write_json(paths.run_path, run_state)

        chunk_by_id = {chunk.id: chunk for chunk in plan.chunk_plan.chunks}

        def build_query(chunk_id: str) -> str:
            plan_chunk = chunk_by_id.get(chunk_id)
            if plan_chunk is None:
                msg = f"Chunk {chunk_id} not found in plan"
                raise RuntimeError(msg)
            return build_chunk_execution_sql(
                plan_id=plan.plan_id,
                chunk=plan_chunk,
                target=plan.target,
                source_target=plan.execution.source_target,
                table=plan.chunk_plan.table,
                mv_replay_queries=plan.execution.mv_replay_queries,
                target_columns=plan.execution.target_columns,
                idempotency_token=(
                    generate_idempotency_token(plan.plan_id, plan_chunk.id)
                    if plan.execution.require_idempotency_token
                    else ""
                ),
            )

        def on_progress(progress: BackfillProgress) -> None:
            run_state.progress = progress
            run_state.updated_at = now_iso()
            write_json(paths.run_path, run_state)

        result = execute_backfill(
            executor=db,
            plan_id=plan.plan_id,
            chunk_ids=[chunk.id for chunk in plan.chunk_plan.chunks],
            build_query=build_query,
            concurrency=concurrency,
            poll_interval_ms=poll_interval_ms,
            resume_from=resume_from,
            replay_failed=replay_failed,
            on_progress=on_progress,
        )

        run_state.status = "failed" if result.failed > 0 else "completed"
        run_state.completed_at = now_iso()
        run_state.updated_at = now_iso()
        run_state.progress = result.progress
        if result.failed > 0:
            failed_entry = next(
                (
                    chunk
                    for chunk in result.progress.values()
                    if chunk.status == "failed"
                ),
                None,
            )
            run_state.last_error = (
                failed_entry.error
                if failed_entry is not None and failed_entry.error is not None
                else "One or more chunks failed"
            )
        write_json(paths.run_path, run_state)

        summary = summarize_run_status(run_state, paths.run_path, plan)

        if json_mode:
            payload: dict[str, Any] = {
                "ok": result.failed == 0,
                "planId": plan.plan_id,
                "status": run_state.status,
                "chunkCounts": summary.totals.model_dump(),
                "rowsWritten": summary.rows_written,
                "runPath": paths.run_path,
            }
            if run_state.last_error is not None:
                payload["lastError"] = run_state.last_error
            print_fn(payload)
        else:
            line = (
                f"Backfill {plan.plan_id}: {run_state.status} "
                f"(done={summary.totals.done}/{summary.totals.total}, "
                f"{summary.rows_written} rows written)"
            )
            if run_state.last_error:
                line += f" — {run_state.last_error}"
            print_fn(line)
            if run_state.status == "completed" and summary.rows_written == 0:
                print_fn(_ZERO_ROWS_WARNING)

        return 1 if result.failed > 0 else 0
    finally:
        db.close()


def create_backfill_plugin(  # noqa: PLR0915 — command table, mirrors TS factory
    options: PluginConfig | dict[str, Any] | None = None,
) -> ChxPlugin:
    """Build the ``backfill`` ChxPlugin."""
    if options is None:
        plugin_options = PluginConfig()
    elif isinstance(options, PluginConfig):
        plugin_options = options
    else:
        plugin_options = PluginConfig.model_validate(options)

    def _parse_plan_options(flags: dict[str, Any]) -> PlanOptions:
        flag_options = _options_from_flags(flags, PLAN_FLAG_MAP)
        merged = _with_factory_defaults(
            set(PlanOptions.model_fields), plugin_options, flag_options
        )
        if "target" not in merged:
            msg = "backfill plan requires --target <database.table>"
            raise BackfillConfigError(msg)
        return PlanOptions.model_validate(merged)

    def _parse_run_options(
        flags: dict[str, Any], *, resume: bool
    ) -> RunOptions | ResumeOptions:
        flag_map = RESUME_FLAG_MAP if resume else RUN_FLAG_MAP
        model: type[RunOptions] = ResumeOptions if resume else RunOptions
        flag_options = _options_from_flags(flags, flag_map)
        merged = _with_factory_defaults(
            set(model.model_fields), plugin_options, flag_options
        )
        if "plan_id" not in merged:
            command = "resume" if resume else "run"
            msg = f"backfill {command} requires --plan-id <id>"
            raise BackfillConfigError(msg)
        return model.model_validate(merged)

    def _parse_status_options(flags: dict[str, Any], command: str) -> StatusOptions:
        flag_options = _options_from_flags(flags, PLAN_ID_FLAG_MAP)
        merged = _with_factory_defaults(
            set(StatusOptions.model_fields), plugin_options, flag_options
        )
        if "plan_id" not in merged:
            msg = f"backfill {command} requires --plan-id <id>"
            raise BackfillConfigError(msg)
        return StatusOptions.model_validate(merged)

    def _plan(ctx: ChxPluginCommandContext) -> int:
        opts = _parse_plan_options(ctx.flags)
        clickhouse = _require_clickhouse(ctx, "planning")

        db = ClickHouseClient.connect(clickhouse)

        try:

            def clickhouse_query(
                sql: str, settings: QuerySettings | None
            ) -> list[dict[str, object]]:
                return db.query(
                    sql, dict(settings) if settings is not None else None
                ).rows

            output = build_backfill_plan(
                opts=opts,
                config_path=ctx.config_path,
                config=ctx.config,
                clickhouse=_clickhouse_dict(clickhouse),
                clickhouse_query=clickhouse_query,
                # ObsessionDB enables parallel replicas by default, which
                # inflates aggregate results (count, GROUP BY). Disable for
                # planning queries until ObsessionDB handles it at the profile
                # level.
                query_settings={"enable_parallel_replicas": 0},
            )

            payload = plan_payload(output)
            if ctx.json_mode:
                ctx.print(payload)
            else:
                partition_count = len(output.plan.chunk_plan.partitions)
                total_bytes = format_bytes(
                    output.plan.chunk_plan.total_bytes_compressed
                )
                sort_keys = output.plan.chunk_plan.table.sort_keys
                primary_sort_key = sort_keys[0] if sort_keys else None
                sort_key_label = (
                    f", sort key: {primary_sort_key.name}"
                    f" ({primary_sort_key.category})"
                    if primary_sort_key is not None
                    else ""
                )
                ctx.print(
                    f"Backfill plan {payload['planId']} for {payload['target']} "
                    f"({payload['chunkCount']} chunks across {partition_count} "
                    f"partitions, ~{total_bytes}{sort_key_label})"
                    f" -> {payload['planPath']}"
                )

            return 0
        finally:
            db.close()

    def _submit(ctx: ChxPluginCommandContext) -> int:
        # Reaching this handler means no managed backend intercepted the
        # command. The ObsessionDB plugin handles `submit` via its
        # on_before_plugin_command hook when a service is selected; without
        # one there is nowhere to submit to.
        _ = ctx
        msg = (
            "backfill submit requires a managed job backend. Log in and select "
            "an ObsessionDB service (`chkit obsessiondb login`, then "
            "`chkit obsessiondb service select`), or use "
            "`chkit backfill run --local` to execute the backfill against a "
            "direct connection."
        )
        raise BackfillConfigError(msg)

    def _run(ctx: ChxPluginCommandContext) -> int:
        opts = _parse_run_options(ctx.flags, resume=False)
        clickhouse = _require_clickhouse(ctx, "execution")

        return _run_backfill(
            plan_id=opts.plan_id,
            force_environment=opts.force_environment,
            concurrency=opts.concurrency,
            poll_interval_ms=opts.poll_interval_ms,
            state_dir=opts.state_dir,
            config_path=ctx.config_path,
            config=ctx.config,
            clickhouse=clickhouse,
            print_fn=ctx.print,
            json_mode=ctx.json_mode,
        )

    def _resume(ctx: ChxPluginCommandContext) -> int:
        opts = _parse_run_options(ctx.flags, resume=True)
        assert isinstance(opts, ResumeOptions)
        clickhouse = _require_clickhouse(ctx, "execution")

        _plan, _plan_path, resolved_state_dir = read_plan(
            plan_id=opts.plan_id,
            config_path=ctx.config_path,
            config=ctx.config,
            state_dir=opts.state_dir,
        )
        paths = backfill_paths(resolved_state_dir, opts.plan_id)
        existing_run = read_run(paths.run_path)
        if existing_run is None:
            msg = (
                f"Run state not found for plan {opts.plan_id}. "
                "Start with backfill run before resume."
            )
            raise BackfillConfigError(msg)
        if existing_run.status == "completed":
            if ctx.json_mode:
                ctx.print(
                    {
                        "ok": True,
                        "noop": True,
                        "planId": opts.plan_id,
                        "status": "completed",
                        "message": "Run already completed. Nothing to resume.",
                    }
                )
            else:
                ctx.print(
                    f"Backfill {opts.plan_id}: already completed. Nothing to resume."
                )
            return 0

        return _run_backfill(
            plan_id=opts.plan_id,
            force_environment=opts.force_environment,
            concurrency=opts.concurrency,
            poll_interval_ms=opts.poll_interval_ms,
            state_dir=opts.state_dir,
            resume_from=existing_run.progress,
            replay_failed=opts.replay_failed,
            config_path=ctx.config_path,
            config=ctx.config,
            clickhouse=clickhouse,
            print_fn=ctx.print,
            json_mode=ctx.json_mode,
        )

    def _status(ctx: ChxPluginCommandContext) -> int:
        opts = _parse_status_options(ctx.flags, "status")
        summary = get_backfill_status(
            plan_id=opts.plan_id,
            config=ctx.config,
            config_path=ctx.config_path,
            state_dir=opts.state_dir,
        )
        payload = status_payload(summary)
        if ctx.json_mode:
            ctx.print(payload)
        else:
            counts = summary.totals
            line = (
                f"Backfill status {payload['planId']}: {payload['status']} "
                f"(done={counts.done}/{counts.total}, failed={counts.failed}, "
                f"{payload['rowsWritten']} rows written)"
            )
            if payload.get("lastError"):
                line += f" — {payload['lastError']}"
            ctx.print(line)
            if payload["status"] == "completed" and payload["rowsWritten"] == 0:
                ctx.print(_ZERO_ROWS_WARNING)
        return 0 if payload["ok"] else 1

    def _cancel(ctx: ChxPluginCommandContext) -> int:
        opts = _parse_status_options(ctx.flags, "cancel")
        summary = cancel_backfill_run(
            plan_id=opts.plan_id,
            config=ctx.config,
            config_path=ctx.config_path,
            state_dir=opts.state_dir,
        )
        payload = cancel_payload(summary)
        if ctx.json_mode:
            ctx.print(payload)
        else:
            counts = summary.totals
            ctx.print(
                f"Backfill cancel {payload['planId']}: {payload['status']} "
                f"(done={counts.done}/{counts.total})"
            )
        return 0 if payload["ok"] else 1

    def _doctor(ctx: ChxPluginCommandContext) -> int:
        opts = _parse_status_options(ctx.flags, "doctor")
        report = get_backfill_doctor_report(
            plan_id=opts.plan_id,
            config=ctx.config,
            config_path=ctx.config_path,
            state_dir=opts.state_dir,
        )
        payload = doctor_payload(report)
        if ctx.json_mode:
            ctx.print(payload)
        else:
            issue_label = (
                "ok"
                if len(payload["issueCodes"]) == 0
                else ", ".join(payload["issueCodes"])
            )
            ctx.print(f"Backfill doctor {payload['planId']}: {issue_label}")
            for recommendation in payload["recommendations"]:
                ctx.print(f"- {recommendation}")
        return 0 if payload["ok"] else 1

    def _guarded(run: Any, command: str, label: str) -> Any:
        """Wrap a command handler in the TS ``wrapPluginRun`` envelope: json
        ``{ok: false, command, error}`` / text ``"<Label> failed: <msg>"``,
        exit 2 for config errors and 1 for anything else."""

        def wrapped(ctx: ChxPluginCommandContext) -> int:
            try:
                return int(run(ctx))
            except Exception as error:  # mirrors wrapPluginRun catch-all
                message = str(error)
                if ctx.json_mode:
                    ctx.print({"ok": False, "command": command, "error": message})
                else:
                    ctx.print(f"{label} failed: {message}")
                return 2 if isinstance(error, BackfillConfigError) else 1

        return wrapped

    hooks = _BackfillHooks(options=plugin_options)

    return ChxPlugin(
        manifest=ChxPluginManifest(name="backfill", api_version=1),
        hooks=hooks,
        commands=[
            ChxPluginCommand(
                name="plan",
                description=(
                    "Build a deterministic backfill plan and persist immutable"
                    " plan state"
                ),
                run=_guarded(_plan, "plan", "Backfill plan"),
                flags=list(PLAN_FLAGS),
            ),
            ChxPluginCommand(
                name="submit",
                description=(
                    "Submit a backfill plan to a managed job backend "
                    "(e.g. ObsessionDB) instead of running it locally"
                ),
                run=_guarded(_submit, "submit", "Backfill submit"),
                flags=list(SUBMIT_FLAGS),
            ),
            ChxPluginCommand(
                name="run",
                description=(
                    "Execute a planned backfill with async query submission"
                    " and polling"
                ),
                run=_guarded(_run, "run", "Backfill run"),
                flags=list(RUN_FLAGS),
            ),
            ChxPluginCommand(
                name="resume",
                description="Resume a backfill run from last checkpoint",
                run=_guarded(_resume, "resume", "Backfill resume"),
                flags=list(RESUME_FLAGS),
            ),
            ChxPluginCommand(
                name="status",
                description="Show checkpoint and chunk progress for a backfill run",
                run=_guarded(_status, "status", "Backfill status"),
                flags=list(PLAN_ID_FLAGS),
            ),
            ChxPluginCommand(
                name="cancel",
                description=(
                    "Cancel an in-progress backfill run and prevent further"
                    " chunk execution"
                ),
                run=_guarded(_cancel, "cancel", "Backfill cancel"),
                flags=list(PLAN_ID_FLAGS),
            ),
            ChxPluginCommand(
                name="doctor",
                description=(
                    "Provide actionable remediation steps for failed or pending"
                    " backfill runs"
                ),
                run=_guarded(_doctor, "doctor", "Backfill doctor"),
                flags=list(PLAN_ID_FLAGS),
            ),
        ],
        options_schema=PluginConfig,
        extend_commands=[
            {
                "flag_mapping": {
                    **PLAN_FLAG_MAP,
                    **PLAN_ID_FLAG_MAP,
                    **SUBMIT_FLAG_MAP,
                }
            },
        ],
    )


class _BackfillHooks:
    """Lifecycle hooks (``on_check`` / ``on_check_report``)."""

    def __init__(self, options: PluginConfig) -> None:
        self.options = options

    def on_check(self, context: ChxOnCheckContext) -> ChxOnCheckResult:
        merged = {
            key: value
            for key, value in self.options.model_dump(exclude_none=True).items()
            if key in CheckOptions.model_fields
        }
        merged.update(
            {
                key: value
                for key, value in context.options.items()
                if key in CheckOptions.model_fields and value is not None
            }
        )
        opts = CheckOptions.model_validate(merged)
        return evaluate_backfill_check(
            config_path=context.config_path,
            config=context.config,
            state_dir=opts.state_dir,
            fail_check_on_required_pending_backfill=(
                opts.fail_check_on_required_pending_backfill
            ),
        )

    def on_check_report(self, context: ChxOnCheckReportContext) -> None:
        finding_codes = [finding.code for finding in context.result.findings]
        if context.result.ok:
            context.print("backfill check: ok")
            return
        suffix = f" ({', '.join(finding_codes)})" if finding_codes else ""
        context.print(f"backfill check: failed{suffix}")


def backfill(
    options: PluginConfig | dict[str, Any] | None = None,
) -> ChxPlugin:
    """Public factory mirroring the TS ``backfill()`` registration helper."""
    return create_backfill_plugin(options)


__all__ = ["backfill", "create_backfill_plugin"]
