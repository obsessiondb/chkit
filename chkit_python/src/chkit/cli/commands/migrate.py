"""`chkit migrate` — preview or apply pending migrations.

Default behaviour (no flags) is a **plan/preview**, matching the TS reference.
Pass ``--apply`` (or alias ``--execute``) to actually execute the SQL and
record entries in the ClickHouse ``_chkit_migrations`` journal.

Flags mirror the TypeScript ``migrateCommand``:

- ``--apply`` / ``--execute``  Apply pending migrations (no prompt).
- ``--allow-destructive``      Allow migrations whose plan includes
                               ``risk=danger`` operations.
- ``--retry <migration>``      Resume a failed migration after editing its
                               file (skips completed statements).
- ``--abandon <migration>``    Reset a failed migration so the next apply
                               runs it from statement 1 (journal only;
                               previews without ``--apply``).
- ``--setting <name=value>``   ClickHouse query setting sent with each
                               migration statement (repeatable).
- ``--json``                   Emit JSON instead of human text.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Annotated, Any, TypeVar, cast

import typer
from typer.exceptions import TyperException

from chkit.cli.command_target import (
    ServiceOption,
    assert_index_granularity_matches_server,
    exit_no_target,
    open_client,
    resolve_plugin_executor,
)
from chkit.cli.commands.migrate_abandon import (
    AbandonReport,
    JournalStateStore,
    abandon_migration_state,
    abandon_report,
    read_abandonable_state,
)
from chkit.cli.commands.migrate_apply import ApplyMigrationInput, apply_migration
from chkit.cli.commands.migrate_barrier import find_pending_non_select_barriers
from chkit.cli.commands.migrate_empty import find_empty_migrations
from chkit.cli.commands.migrate_errors import (
    EMPTY_MIGRATIONS_SUMMARY,
    MigrateError,
    empty_migrations_error,
    journal_changed_error,
    non_select_barrier_error,
)
from chkit.cli.commands.migrate_lock import (
    GuardedClient,
    LockTarget,
    MigrateLock,
    acquire_migrate_lock,
    migrate_lock_disabled,
)
from chkit.cli.commands.migrate_output import (
    render_abandon_plan_only_notice,
    render_abandon_text,
    render_empty_migrations_warning,
    render_retry_notice,
)
from chkit.cli.commands.migrate_prompts import (
    confirm_abandon,
    confirm_apply,
    confirm_destructive_execution,
    is_background_or_ci,
    print_destructive_operation_details,
)
from chkit.cli.commands.migrate_recovery import resolve_recovery_targets
from chkit.cli.commands.migrate_retry import (
    RetryResolution,
    RetryResume,
    resolve_retry,
    retry_payload,
)
from chkit.cli.commands.migrate_scope import filter_pending_by_scope
from chkit.cli.commands.migrate_settings import parse_setting_flags
from chkit.cli.config_loader import load_config
from chkit.cli.help import TABLE_FLAG_HELP
from chkit.cli.hook_flags import passed_flags
from chkit.cli.journal_store import JournalStore, MigrationRowState
from chkit.cli.json_output import emit_json, emit_json_error, json_error_code
from chkit.cli.migration_metadata import extract_migration_metadata
from chkit.cli.migration_store import (
    MigrationJournal,
    MigrationJournalEntry,
    find_checksum_mismatches,
    list_migration_filenames,
    read_snapshot,
)
from chkit.cli.plugin_runtime import PluginRuntime, load_plugin_runtime
from chkit.cli.safety_markers import (
    DestructiveOperationMarker,
    collect_destructive_operation_markers,
    collect_unmarked_destructive_statements,
)
from chkit.cli.shared_engine_flags import ForceSharedEnginesOption, NoSharedEnginesOption
from chkit.cli.table_scope import (
    TableScope,
    resolve_table_scope,
    scope_to_payload,
    table_keys_from_definitions,
)
from chkit.clickhouse.client import ClickHouseClient, clickhouse_error_message
from chkit.core.model import ChxConfigEnv, ChxResolvedConfig, configured_index_granularity
from chkit.plugins import ChxOnConfigLoadedContext, ChxPlugin


@dataclass(slots=True)
class _MigrateContext:
    """Shared state resolved once and threaded through the phases."""

    json_mode: bool
    execute_requested: bool
    allow_destructive: bool
    # --setting values, sent with every migration statement.
    settings: dict[str, str] | None
    mode: str
    migrations_dir: Path
    meta_dir: Path
    client: ClickHouseClient
    journal_store: JournalStore
    config: ChxResolvedConfig
    plugin_runtime: PluginRuntime
    table_scope: TableScope
    # The parsed flags the plugin hooks get, keyed as in TS.
    flags: dict[str, Any]
    files: list[str]
    applied_names: set[str]
    pending_all: list[str]
    retry_target: str | None
    # Runs ``fn`` holding the migrate lock (#716).
    with_lock: WithLock


_T = TypeVar("_T")


class WithLock:
    """Runs a function holding the migrate lock (#716)."""

    def __call__(self, fn: Callable[[], _T]) -> _T:
        return fn()


@dataclass(frozen=True, slots=True)
class AbandonContext:
    """The parts of the migrate context that --abandon reads."""

    json_mode: bool
    execute_requested: bool
    journal_store: JournalStateStore
    table_scope: TableScope
    applied_names: set[str]
    files: list[str]
    meta_dir: Path
    with_lock: WithLock | None = None


@dataclass(slots=True)
class _PendingPlan:
    """What this run would apply, resolved before any gate."""

    # --table matched no table, so no migration is selected.
    no_scope_match: bool
    pending: list[str]
    undetermined: list[str]
    empty_migrations: list[str]
    retry: RetryResolution | None = None


def run(  # noqa: PLR0917
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    table_selector: Annotated[
        str | None,
        typer.Option("--table", "-t", metavar="<selector>", help=TABLE_FLAG_HELP),
    ] = None,
    apply: Annotated[
        bool,
        typer.Option(
            "--apply",
            help="Apply pending migrations on ClickHouse (no prompt)",
        ),
    ] = False,
    execute: Annotated[
        bool,
        typer.Option("--execute", help="Alias for --apply"),
    ] = False,
    allow_destructive: Annotated[
        bool,
        typer.Option(
            "--allow-destructive",
            help="Allow destructive migrations tagged with risk=danger",
        ),
    ] = False,
    retry: Annotated[
        str | None,
        typer.Option(
            "--retry",
            metavar="<migration>",
            help=(
                "Resume a failed migration after editing its file "
                "(skips completed statements)"
            ),
        ),
    ] = None,
    abandon: Annotated[
        str | None,
        typer.Option(
            "--abandon",
            metavar="<migration>",
            help=(
                "Reset a failed migration so the next apply runs it from "
                "statement 1 (journal only; previews without --apply)"
            ),
        ),
    ] = None,
    break_lock: Annotated[
        str | None,
        typer.Option(
            "--break-lock",
            metavar="<claim>",
            help=(
                "Release the migrate lock claim of a run that is no longer running, "
                "then take the lock"
            ),
        ),
    ] = None,
    setting: Annotated[
        list[str] | None,
        typer.Option(
            "--setting",
            metavar="<name=value>",
            help=(
                "ClickHouse query setting sent with each migration statement, "
                "e.g. max_table_size_to_drop=0 (repeatable)"
            ),
        ),
    ] = None,
    output_json: Annotated[
        bool,
        typer.Option("--json", help="Emit a JSON-formatted summary."),
    ] = False,
    # Accepted so existing scripts keep working; only generate and snapshot
    # rebuild run the on_schema_loaded hooks that act on them (as in TS).
    force_shared_engines: ForceSharedEnginesOption = False,
    no_shared_engines: NoSharedEnginesOption = False,
    service: ServiceOption = None,
) -> None:
    # As in TS, every hook gets the flags that were passed, keyed by long name.
    hook_flags = passed_flags(
        {
            "--config": str(config_path) if config_path is not None else None,
            "--apply": apply,
            "--execute": execute,
            "--allow-destructive": allow_destructive,
            "--table": table_selector,
            "--retry": retry,
            "--abandon": abandon,
            "--break-lock": break_lock,
            "--setting": setting,
            "--json": output_json,
            "--force-shared-engines": force_shared_engines,
            "--no-shared-engines": no_shared_engines,
            "--service": service,
        }
    )
    try:
        _run(
            config_path=config_path,
            execute_requested=apply or execute,
            allow_destructive=allow_destructive,
            table_selector=table_selector,
            retry=retry,
            abandon=abandon,
            break_lock=break_lock,
            setting=setting,
            output_json=output_json,
            service=service,
            hook_flags=hook_flags,
        )
    except (typer.Exit, typer.Abort, TyperException):
        raise
    except Exception as error:
        # Like the TS CLI's top-level handler: in --json mode stdout carries a
        # parseable error envelope (with the error's stable code, if it has
        # one); the message always goes to stderr.
        message = clickhouse_error_message(error)
        if output_json:
            emit_json_error("migrate", {"code": json_error_code(error), "message": message})
        typer.secho(message, fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1) from error


def _run(
    *,
    config_path: Path | None,
    execute_requested: bool,
    allow_destructive: bool,
    table_selector: str | None,
    retry: str | None,
    abandon: str | None,
    break_lock: str | None,
    setting: list[str] | None,
    output_json: bool,
    service: str | None,
    hook_flags: dict[str, Any],
) -> None:
    # Usage errors surface before any connection is made.
    targets = resolve_recovery_targets(
        retry=retry,
        abandon=abandon,
        table=table_selector,
        allow_destructive=allow_destructive,
    )
    settings = parse_setting_flags(setting)
    config = load_config(config_path, ChxConfigEnv(command="migrate"))
    plugin_runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )
    executor = resolve_plugin_executor(
        plugin_runtime,
        config,
        command="migrate",
        config_path=str(config_path or "clickhouse.config.py"),
        json_mode=output_json,
        service=service,
        flags=hook_flags,
    )
    if executor is None and config.clickhouse is None:
        msg = "clickhouse config is required for migrate (journal is stored in ClickHouse)"
        exit_no_target("migrate", msg, json_mode=output_json)

    migrations_dir = Path(os.path.abspath(config.migrations_dir))
    meta_dir = Path(os.path.abspath(config.meta_dir))

    # --abandon only changes the journal and rejects --table, so it does not
    # read snapshot.json: a conflicted snapshot cannot block it.
    snapshot = (
        read_snapshot(meta_dir, index_granularity=configured_index_granularity(config))
        if targets.abandon_target is None
        else None
    )
    snapshot_defs = list(snapshot.definitions) if snapshot is not None else []
    table_scope = resolve_table_scope(
        table_selector, table_keys_from_definitions(snapshot_defs)
    )

    # As in TS, the on_config_loaded hooks run after the scope is resolved and
    # before the migrations are listed.
    plugin_runtime.run_on_config_loaded(
        ChxOnConfigLoadedContext(
            command="migrate",
            config=config,
            table_scope=table_scope,
            flags=hook_flags,
            config_path=str(config_path or "clickhouse.config.py"),
            options={},
        )
    )

    migrations_dir.mkdir(parents=True, exist_ok=True)
    files = list_migration_filenames(migrations_dir)

    if targets.retry_target is not None and targets.retry_target not in files:
        msg = (
            f"--retry: no migration file named {targets.retry_target} in "
            f"{migrations_dir}. To reset the journal state of a migration whose "
            f"file was deleted, use chkit migrate --abandon {targets.retry_target}."
        )
        raise MigrateError("migration_not_found", msg)

    with open_client(executor, config.clickhouse) as raw_client:
        # Every request of the run, journal writes included, first checks
        # that the run still holds the migrate lock, once it took it (#716).
        lock_holder = _LockHolder()
        client = cast(ClickHouseClient, GuardedClient(raw_client, lock_holder.check))
        # ``cluster`` opts the journal into ReplicatedReplacingMergeTree
        # created ``ON CLUSTER`` so history stays consistent across nodes.
        journal_store = JournalStore(
            client, cluster=config.clickhouse.cluster if config.clickhouse else None
        )
        journal = journal_store.read_journal(project_files=files)
        applied_names = {entry.name for entry in journal.applied}
        ctx = _MigrateContext(
            json_mode=output_json,
            execute_requested=execute_requested,
            allow_destructive=allow_destructive,
            settings=settings,
            mode="execute" if execute_requested else "plan",
            migrations_dir=migrations_dir,
            meta_dir=meta_dir,
            client=client,
            journal_store=journal_store,
            config=config,
            plugin_runtime=plugin_runtime,
            table_scope=table_scope,
            flags=hook_flags,
            files=files,
            applied_names=applied_names,
            pending_all=[f for f in files if f not in applied_names],
            retry_target=targets.retry_target,
            with_lock=_MigrateLockRunner(
                raw_client=raw_client,
                journal_store=journal_store,
                holder=lock_holder,
                break_lock=break_lock,
                json_mode=output_json,
            ),
        )
        if targets.abandon_target is not None:
            run_abandon(
                targets.abandon_target,
                AbandonContext(
                    json_mode=output_json,
                    execute_requested=execute_requested,
                    journal_store=journal_store,
                    table_scope=table_scope,
                    applied_names=applied_names,
                    files=files,
                    meta_dir=meta_dir,
                    with_lock=ctx.with_lock,
                ),
            )
            return
        # A migration generated for another index_granularity default would
        # create tables unlike the ones chkit planned for (#466).
        assert_index_granularity_matches_server("migrate", client, config, json_mode=output_json)

        _run_checksum_gate(ctx, journal)
        plan = _resolve_pending_plan(ctx)
        if not plan.pending:
            _render_nothing_pending(ctx, plan)
            return
        if _render_plan(ctx, plan):
            return
        _run_empty_migration_gate(ctx, plan.empty_migrations)
        _run_barrier_gate(ctx, plan.pending)
        if not _run_confirm_gate(ctx):
            return
        _run_destructive_gate(ctx, plan.pending)
        _apply_pending(ctx, plan)


def run_abandon(
    migration: str,
    ctx: AbandonContext,
    *,
    is_interactive: Callable[[], bool] | None = None,
    confirm: Callable[[str], bool] = confirm_abandon,
) -> None:
    """--abandon <migration>: reset a failed migration's journal state.

    The next apply runs it from statement 1. Without --apply it only
    previews, like the rest of migrate, or asks first in an interactive
    terminal. Runs before every other gate and applies nothing.
    """
    interactive = is_interactive or (lambda: not is_background_or_ci())
    state = read_abandonable_state(
        migration=migration,
        applied_names=ctx.applied_names,
        journal_store=ctx.journal_store,
    )
    report = abandon_report(state)
    file_exists = migration in ctx.files
    snapshot_file = os.path.relpath(ctx.meta_dir / "snapshot.json", Path.cwd())

    if not ctx.execute_requested:
        if ctx.json_mode:
            _emit_abandon_json("plan", ctx.table_scope, report)
            return
        render_abandon_text(
            report, performed=False, file_exists=file_exists, snapshot_file=snapshot_file
        )
        if not interactive():
            render_abandon_plan_only_notice()
            return
        if not confirm(migration):
            typer.echo("Abandon cancelled by user.")
            return
        _abandon_under_lock(ctx, migration, state)
        typer.echo(f"Abandoned in-progress migration {migration}.")
        return

    _abandon_under_lock(ctx, migration, state)
    if ctx.json_mode:
        _emit_abandon_json("execute", ctx.table_scope, report)
        return
    render_abandon_text(
        report, performed=True, file_exists=file_exists, snapshot_file=snapshot_file
    )


def _abandon_under_lock(ctx: AbandonContext, migration: str, state: MigrationRowState) -> None:
    """Resets the state the user saw, holding the migrate lock, so --abandon
    never rewrites a migration that a running apply is recording (#716)."""

    def abandon() -> None:
        current = read_abandonable_state(
            migration=migration,
            applied_names=ctx.applied_names,
            journal_store=ctx.journal_store,
        )
        if current.applied_at != state.applied_at:
            raise journal_changed_error(
                f"the journal state of {migration} is no longer the one shown"
            )
        abandon_migration_state(current, journal_store=ctx.journal_store)

    if ctx.with_lock is None:
        abandon()
    else:
        ctx.with_lock(abandon)


def _run_checksum_gate(ctx: _MigrateContext, journal: MigrationJournal) -> None:
    """Block when applied migrations no longer match their recorded checksum."""
    checksum_mismatches = find_checksum_mismatches(ctx.migrations_dir, journal)
    if not checksum_mismatches:
        return
    if ctx.json_mode:
        emit_json(
            "migrate",
            {
                "mode": ctx.mode,
                "scope": scope_to_payload(ctx.table_scope),
                "error": "Checksum mismatch detected on applied migrations",
                "checksumMismatches": [m.model_dump() for m in checksum_mismatches],
            }
        )
        raise typer.Exit(code=1)
    names = ", ".join(m.name for m in checksum_mismatches)
    typer.secho(
        f"Checksum mismatch detected on applied migrations: {names}",
        fg=typer.colors.RED,
        err=True,
    )
    raise typer.Exit(code=1)


def _resolve_pending_plan(ctx: _MigrateContext) -> _PendingPlan:
    """Filter by scope, find empty files, and resolve --retry before any gate.

    --retry is resolved even when nothing is pending, so every run reports
    what it did.
    """
    plan = _resolve_pending_scope(ctx)
    plan.empty_migrations = find_empty_migrations(ctx.migrations_dir, plan.pending)
    if ctx.retry_target is not None:
        plan.retry = resolve_retry(
            migration=ctx.retry_target,
            migrations_dir=ctx.migrations_dir,
            pending=plan.pending,
            empty_migrations=plan.empty_migrations,
            applied_names=ctx.applied_names,
            journal_store=ctx.journal_store,
            plugins_rewrite_statements=ctx.plugin_runtime.rewrites_statements(),
        )
    return plan


def _resolve_pending_scope(ctx: _MigrateContext) -> _PendingPlan:
    scope = ctx.table_scope
    if not scope.enabled:
        return _PendingPlan(
            no_scope_match=False, pending=ctx.pending_all, undetermined=[], empty_migrations=[]
        )
    if scope.match_count == 0:
        return _PendingPlan(
            no_scope_match=True, pending=[], undetermined=[], empty_migrations=[]
        )
    scoped = filter_pending_by_scope(
        ctx.migrations_dir, ctx.pending_all, set(scope.matched_tables)
    )
    return _PendingPlan(
        no_scope_match=False,
        pending=scoped.in_scope,
        undetermined=scoped.undetermined,
        empty_migrations=[],
    )


def _render_nothing_pending(ctx: _MigrateContext, plan: _PendingPlan) -> None:
    """Nothing to apply: say why, with what --retry did."""
    if plan.no_scope_match:
        selector = ctx.table_scope.selector or ""
        if ctx.json_mode:
            emit_json(
                "migrate",
                {
                    "mode": ctx.mode,
                    "scope": scope_to_payload(ctx.table_scope),
                    "pending": [],
                    "applied": [],
                    "warning": f'No tables matched selector "{selector}".',
                    **_retry_field(plan.retry),
                }
            )
            return
        typer.echo(f'No tables matched selector "{selector}". No migrations selected.')
        render_retry_notice(plan.retry)
        return
    if ctx.json_mode:
        emit_json(
            "migrate",
            {
                "mode": ctx.mode,
                "scope": scope_to_payload(ctx.table_scope),
                "pending": [],
                "applied": [],
                **_retry_field(plan.retry),
            },
        )
        return
    typer.echo("No pending migrations.")
    render_retry_notice(plan.retry)


def _render_plan(ctx: _MigrateContext, plan: _PendingPlan) -> bool:
    """Render the pending plan. True when the JSON plan ended the run."""
    if ctx.json_mode and not ctx.execute_requested:
        payload: dict[str, object] = {
            "mode": ctx.mode,
            "scope": scope_to_payload(ctx.table_scope),
            "pending": plan.pending,
        }
        if plan.undetermined:
            payload["undeterminedMigrations"] = plan.undetermined
        if plan.empty_migrations:
            payload["emptyMigrations"] = plan.empty_migrations
        payload.update(_retry_field(plan.retry))
        emit_json("migrate", payload)
        return True
    if ctx.json_mode:
        return False

    scope = ctx.table_scope
    if scope.enabled:
        typer.echo(f"Table scope: {scope.selector or ''} ({scope.match_count} matched)")
        for matched in scope.matched_tables:
            typer.echo(f"- {matched}")
    if plan.undetermined:
        typer.echo(
            f"⚠ {len(plan.undetermined)} pending migration(s) have no table "
            "markers; including them because their target tables can't "
            "be determined under --table:"
        )
        for filename in plan.undetermined:
            typer.echo(f"  - {filename}")
    empty = set(plan.empty_migrations)
    typer.echo(f"Pending migrations: {len(plan.pending)}")
    for filename in plan.pending:
        typer.echo(
            f"- {filename}  (no executable statements)"
            if filename in empty
            else f"- {filename}"
        )
        meta = extract_migration_metadata(
            (ctx.migrations_dir / filename).read_text(encoding="utf-8")
        )
        if meta.log:
            typer.echo(f"    {meta.log}")
    render_empty_migrations_warning(plan.empty_migrations)
    render_retry_notice(plan.retry)
    return False


def _run_empty_migration_gate(ctx: _MigrateContext, empty_migrations: list[str]) -> None:
    """Refuse to apply pending files without statements; a plan-only run warns."""
    if not empty_migrations:
        return
    # A JSON plan already returned from _render_plan, so json_mode means --apply.
    apply_possible = ctx.execute_requested or (
        not ctx.json_mode and not is_background_or_ci()
    )
    if not apply_possible:
        return
    if ctx.json_mode:
        emit_json(
            "migrate",
            {
                "mode": ctx.mode,
                "scope": scope_to_payload(ctx.table_scope),
                "error": EMPTY_MIGRATIONS_SUMMARY,
                "emptyMigrations": empty_migrations,
            }
        )
        raise typer.Exit(code=1)
    typer.secho(str(empty_migrations_error(empty_migrations)), fg=typer.colors.RED, err=True)
    raise typer.Exit(code=1)


def _run_barrier_gate(ctx: _MigrateContext, pending: list[str]) -> None:
    """Refuse to apply when a pending file marks a statement other than a
    SELECT ``mode=barrier`` (#634), before any migration runs; a plan-only
    run does not check."""
    apply_possible = ctx.execute_requested or (
        not ctx.json_mode and not is_background_or_ci()
    )
    if not apply_possible:
        return
    barriers = find_pending_non_select_barriers(ctx.migrations_dir, pending)
    if barriers:
        raise non_select_barrier_error(barriers)


def _run_confirm_gate(ctx: _MigrateContext) -> bool:
    """In plan mode, stop unless the user confirms an interactive apply."""
    if ctx.execute_requested:
        return True
    if is_background_or_ci() or ctx.json_mode:
        if not ctx.json_mode:
            typer.echo("")
            typer.echo(
                "Plan only. Re-run with --apply to apply and journal these migrations."
            )
        return False
    if not confirm_apply():
        typer.echo("Migration apply cancelled by user.")
        return False
    ctx.execute_requested = True
    ctx.mode = "execute"
    return True


def _run_destructive_gate(ctx: _MigrateContext, pending: list[str]) -> None:
    """Block destructive migrations unless allowed, confirmed, or forced."""
    destructive_markers = _collect_destructive_markers_for_pending(
        ctx.migrations_dir, pending
    )
    destructive_files = sorted({m.migration for m in destructive_markers})
    destructive_allowed = ctx.allow_destructive or ctx.config.safety.allow_destructive
    if not destructive_markers or destructive_allowed:
        return
    error = (
        "Blocked destructive migration execution. "
        "Re-run with --allow-destructive or set safety.allowDestructive=true "
        "after review."
    )
    if ctx.json_mode:
        emit_json(
            "migrate",
            {
                "mode": "execute",
                "scope": scope_to_payload(ctx.table_scope),
                "error": error,
                "destructiveMigrations": destructive_files,
                "destructiveOperations": [
                    {
                        "migration": m.migration,
                        "type": m.type,
                        "key": m.key,
                        "risk": m.risk,
                        "warningCode": m.warning_code,
                        "reason": m.reason,
                        "impact": m.impact,
                        "recommendation": m.recommendation,
                        "summary": m.summary,
                    }
                    for m in destructive_markers
                ],
            }
        )
        raise typer.Exit(code=3)

    if is_background_or_ci():
        print_destructive_operation_details(destructive_markers)
        typer.secho(error, fg=typer.colors.RED, err=True)
        typer.echo(f"Destructive migrations: {', '.join(destructive_files)}", err=True)
        typer.echo(
            "Non-interactive run detected. Pass --allow-destructive to proceed.",
            err=True,
        )
        raise typer.Exit(code=3)

    if not confirm_destructive_execution(destructive_markers):
        typer.secho(
            f"Destructive migration cancelled by user. "
            f"Destructive migrations: {', '.join(destructive_files)}",
            fg=typer.colors.RED,
            err=True,
        )
        raise typer.Exit(code=3)


def _apply_pending(ctx: _MigrateContext, plan: _PendingPlan) -> None:
    """Apply each pending migration holding the migrate lock (#716), journal
    it, and emit the final summary."""
    ctx.with_lock(lambda: _apply_plan(ctx, _replan_under_lock(ctx, plan)))


def _replan_under_lock(ctx: _MigrateContext, plan: _PendingPlan) -> _PendingPlan:
    """The plan again, from the journal as it is now that this run holds the
    lock: a run that held it meanwhile may have applied some of the pending
    migrations, which this run then skips. Anything the plan the user saw
    does not cover stops the run."""
    journal = ctx.journal_store.read_journal(project_files=ctx.files)
    applied_names = {entry.name for entry in journal.applied}
    mismatches = find_checksum_mismatches(ctx.migrations_dir, journal)
    if mismatches:
        names = ", ".join(item.name for item in mismatches)
        raise journal_changed_error(f"the journal now records {names} with another checksum")
    current = _resolve_pending_plan(
        replace(
            ctx,
            applied_names=applied_names,
            pending_all=[f for f in ctx.files if f not in applied_names],
        )
    )
    added = [f for f in current.pending if f not in plan.pending]
    if added:
        raise journal_changed_error(f"{', '.join(added)} became pending")
    if current.retry != plan.retry:
        raise journal_changed_error(f"--retry {ctx.retry_target} now resolves differently")
    skipped = [f for f in plan.pending if f not in current.pending]
    if skipped:
        pronoun = "it" if len(skipped) == 1 else "them"
        typer.echo(
            f"Skipping {', '.join(skipped)}: another migrate run applied {pronoun} meanwhile.",
            err=ctx.json_mode,
        )
    return current


class _LockHolder:
    """The migrate lock this run holds, if any, checked before each request."""

    __slots__ = ("lock",)

    def __init__(self) -> None:
        self.lock: MigrateLock | None = None

    def check(self) -> None:
        if self.lock is not None:
            self.lock.assert_held()


class _MigrateLockRunner(WithLock):
    """Runs a function holding the migrate lock, as TS's ``withLock``."""

    def __init__(
        self,
        *,
        raw_client: Any,
        journal_store: JournalStore,
        holder: _LockHolder,
        break_lock: str | None,
        json_mode: bool,
    ) -> None:
        self._raw_client = raw_client
        self._journal_store = journal_store
        self._holder = holder
        self._break_lock = break_lock
        self._json_mode = json_mode

    def __call__(self, fn: Callable[[], _T]) -> _T:
        if migrate_lock_disabled():
            typer.echo(
                "⚠ CHKIT_MIGRATE_LOCK is off: this run takes no migrate lock, so a "
                "concurrent migrate can apply the same statements.",
                err=True,
            )
            return fn()
        found = self._journal_store.lock_target()
        if found is None:
            typer.echo(
                "⚠ The target database does not exist yet, so the journal cannot hold the "
                "migrate lock: this run takes none. Do not start another migrate against "
                "this target until it finishes.",
                err=True,
            )
            return fn()
        database, table, fanout = found
        # The heartbeat runs while the run's own requests are in flight; a
        # client with an HTTP session takes one query at a time.
        open_concurrent = getattr(self._raw_client, "open_concurrent", None)
        heartbeat_client = open_concurrent() if callable(open_concurrent) else None

        def log(line: str) -> None:
            typer.echo(line, err=self._json_mode)

        try:
            lock = acquire_migrate_lock(
                self._raw_client,
                LockTarget(database=database, journal_table=table, fanout=fanout),
                break_lock=self._break_lock,
                log=log,
                heartbeat_client=heartbeat_client,
            )
            self._holder.lock = lock
            try:
                return fn()
            except BaseException:
                # A step that retries or wraps the guard's error (a poll loop,
                # a statement error) reports the lost lock, with its code.
                lock.assert_held()
                raise
            finally:
                self._holder.lock = None
                lock.release()
        finally:
            if heartbeat_client is not None:
                heartbeat_client.close()


def _apply_plan(ctx: _MigrateContext, plan: _PendingPlan) -> None:
    # Progress lines go to stderr in --json mode, so stdout stays one JSON document.
    def log(line: str) -> None:
        typer.echo(line, err=ctx.json_mode)

    retry = plan.retry
    applied_now: list[MigrationJournalEntry] = []
    for filename in plan.pending:
        if not ctx.json_mode:
            meta = extract_migration_metadata(
                (ctx.migrations_dir / filename).read_text(encoding="utf-8")
            )
            if meta.log:
                typer.echo(f"  {meta.log}")
        entry = apply_migration(
            ApplyMigrationInput(
                client=ctx.client,
                journal_store=ctx.journal_store,
                plugin_runtime=ctx.plugin_runtime,
                config=ctx.config,
                table_scope=ctx.table_scope,
                migrations_dir=ctx.migrations_dir,
                file=filename,
                retry=(
                    retry
                    if isinstance(retry, RetryResume) and retry.migration == filename
                    else None
                ),
                log=log,
                settings=ctx.settings,
                flags=ctx.flags,
            )
        )
        applied_now.append(entry)
        if not ctx.json_mode:
            typer.echo(f"Applied: {filename}")

    if ctx.json_mode:
        payload: dict[str, object] = {
            "mode": "execute",
            "scope": scope_to_payload(ctx.table_scope),
            "applied": [
                {"name": e.name, "appliedAt": e.applied_at, "checksum": e.checksum}
                for e in applied_now
            ],
        }
        if plan.undetermined:
            payload["undeterminedMigrations"] = plan.undetermined
        payload.update(_retry_field(retry))
        emit_json("migrate", payload)
        return
    typer.echo("")
    typer.echo(
        f"Migrations recorded in ClickHouse {ctx.journal_store.table_name} table."
    )


def _collect_destructive_markers_for_pending(
    migrations_dir: Path, pending: list[str]
) -> list[DestructiveOperationMarker]:
    """Combine planner markers + synthesized markers across every pending migration."""
    out: list[DestructiveOperationMarker] = []
    for filename in pending:
        sql = (migrations_dir / filename).read_text(encoding="utf-8")
        out.extend(collect_destructive_operation_markers(filename, sql))
        out.extend(collect_unmarked_destructive_statements(filename, sql))
    return out


def _retry_field(retry: RetryResolution | None) -> dict[str, object]:
    return {} if retry is None else {"retry": retry_payload(retry)}


def _emit_abandon_json(mode: str, scope: TableScope, report: AbandonReport) -> None:
    emit_json(
        "migrate", {"mode": mode, "scope": scope_to_payload(scope), "abandon": report.to_payload()}
    )
