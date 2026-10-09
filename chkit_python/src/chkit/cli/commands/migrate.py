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
- ``--json``                   Emit JSON instead of human text.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

import typer
from typer.exceptions import TyperException

from chkit.cli.commands.migrate_abandon import (
    JournalStateStore,
    abandon_migration_state,
    abandon_report,
    read_abandonable_state,
)
from chkit.cli.commands.migrate_apply import ApplyMigrationInput, apply_migration
from chkit.cli.commands.migrate_empty import find_empty_migrations
from chkit.cli.commands.migrate_errors import (
    EMPTY_MIGRATIONS_SUMMARY,
    MigrateError,
    empty_migrations_error,
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
from chkit.cli.config_loader import load_config
from chkit.cli.journal_store import JournalStore
from chkit.cli.json_output import emit_json_error
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
    table_keys_from_definitions,
)
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxConfigEnv, ChxResolvedConfig
from chkit.plugins import ChxPlugin


@dataclass(slots=True)
class _MigrateContext:
    """Shared state resolved once and threaded through the phases."""

    json_mode: bool
    execute_requested: bool
    allow_destructive: bool
    mode: str
    migrations_dir: Path
    meta_dir: Path
    client: ClickHouseClient
    journal_store: JournalStore
    config: ChxResolvedConfig
    plugin_runtime: PluginRuntime
    table_scope: TableScope
    files: list[str]
    applied_names: set[str]
    pending_all: list[str]
    retry_target: str | None


@dataclass(frozen=True, slots=True)
class AbandonContext:
    """The parts of the migrate context that --abandon reads."""

    json_mode: bool
    execute_requested: bool
    journal_store: JournalStateStore
    applied_names: set[str]
    files: list[str]
    meta_dir: Path


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
    apply: Annotated[
        bool,
        typer.Option(
            "--apply",
            help="Apply pending migrations on ClickHouse (no prompt).",
        ),
    ] = False,
    execute: Annotated[
        bool,
        typer.Option("--execute", help="Alias for --apply."),
    ] = False,
    allow_destructive: Annotated[
        bool,
        typer.Option(
            "--allow-destructive",
            help="Allow destructive migrations tagged with risk=danger.",
        ),
    ] = False,
    table_selector: Annotated[
        str | None,
        typer.Option(
            "--table",
            "-t",
            help=(
                "Restrict migrations to those touching the matched tables. "
                "Examples: events, events_*, analytics.events."
            ),
        ),
    ] = None,
    retry: Annotated[
        str | None,
        typer.Option(
            "--retry",
            metavar="<migration>",
            help=(
                "Resume a failed migration after editing its file "
                "(skips completed statements)."
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
                "statement 1 (journal only; previews without --apply)."
            ),
        ),
    ] = None,
    output_json: Annotated[
        bool,
        typer.Option("--json", help="Emit a JSON-formatted summary."),
    ] = False,
    # Accepted so existing scripts keep working; only generate and snapshot
    # rebuild run the on_schema_loaded hooks that read them (as in TS).
    force_shared_engines: ForceSharedEnginesOption = False,  # noqa: ARG001
    no_shared_engines: NoSharedEnginesOption = False,  # noqa: ARG001
) -> None:
    try:
        _run(
            config_path=config_path,
            execute_requested=apply or execute,
            allow_destructive=allow_destructive,
            table_selector=table_selector,
            retry=retry,
            abandon=abandon,
            output_json=output_json,
        )
    except (typer.Exit, typer.Abort, TyperException):
        raise
    except Exception as error:
        # Like the TS CLI's top-level handler: in --json mode stdout carries a
        # parseable error envelope (with the stable code of a MigrateError);
        # the message always goes to stderr.
        code = error.code if isinstance(error, MigrateError) else "error"
        if output_json:
            emit_json_error("migrate", {"code": code, "message": str(error)})
        typer.secho(str(error), fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1) from error


def _run(
    *,
    config_path: Path | None,
    execute_requested: bool,
    allow_destructive: bool,
    table_selector: str | None,
    retry: str | None,
    abandon: str | None,
    output_json: bool,
) -> None:
    # Usage errors surface before any connection is made.
    targets = resolve_recovery_targets(
        retry=retry,
        abandon=abandon,
        table=table_selector,
        allow_destructive=allow_destructive,
    )
    config = load_config(config_path, ChxConfigEnv(command="migrate"))
    if config.clickhouse is None:
        msg = "clickhouse.config.py must include a `clickhouse` block to migrate."
        raise typer.BadParameter(msg)

    plugin_runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )

    migrations_dir = Path(config.migrations_dir)
    migrations_dir.mkdir(parents=True, exist_ok=True)
    meta_dir = Path(config.meta_dir)
    files = list_migration_filenames(migrations_dir)

    # --abandon only changes the journal and rejects --table, so it does not
    # read snapshot.json: a conflicted snapshot cannot block it.
    snapshot = read_snapshot(meta_dir) if targets.abandon_target is None else None
    snapshot_defs = list(snapshot.definitions) if snapshot is not None else []
    table_scope = resolve_table_scope(
        table_selector, table_keys_from_definitions(snapshot_defs)
    )

    if targets.retry_target is not None and targets.retry_target not in files:
        msg = (
            f"--retry: no migration file named {targets.retry_target} in "
            f"{migrations_dir}. To reset the journal state of a migration whose "
            f"file was deleted, use chkit migrate --abandon {targets.retry_target}."
        )
        raise MigrateError("migration_not_found", msg)

    with ClickHouseClient.connect(config.clickhouse) as client:
        # ``cluster`` opts the journal into ReplicatedReplacingMergeTree
        # created ``ON CLUSTER`` so history stays consistent across nodes.
        journal_store = JournalStore(client, cluster=config.clickhouse.cluster)
        journal = journal_store.read_journal(project_files=files)
        applied_names = {entry.name for entry in journal.applied}
        ctx = _MigrateContext(
            json_mode=output_json,
            execute_requested=execute_requested,
            allow_destructive=allow_destructive,
            mode="execute" if execute_requested else "plan",
            migrations_dir=migrations_dir,
            meta_dir=meta_dir,
            client=client,
            journal_store=journal_store,
            config=config,
            plugin_runtime=plugin_runtime,
            table_scope=table_scope,
            files=files,
            applied_names=applied_names,
            pending_all=[f for f in files if f not in applied_names],
            retry_target=targets.retry_target,
        )
        if targets.abandon_target is not None:
            run_abandon(
                targets.abandon_target,
                AbandonContext(
                    json_mode=output_json,
                    execute_requested=execute_requested,
                    journal_store=journal_store,
                    applied_names=applied_names,
                    files=files,
                    meta_dir=meta_dir,
                ),
            )
            return

        _run_checksum_gate(ctx, journal)
        plan = _resolve_pending_plan(ctx)
        if not plan.pending:
            _render_nothing_pending(ctx, plan)
            return
        if _render_plan(ctx, plan):
            return
        _run_empty_migration_gate(ctx, plan.empty_migrations)
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
            _echo_json({"mode": "plan", "abandon": report.to_payload()})
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
        abandon_migration_state(state, journal_store=ctx.journal_store)
        typer.echo(f"Abandoned in-progress migration {migration}.")
        return

    abandon_migration_state(state, journal_store=ctx.journal_store)
    if ctx.json_mode:
        _echo_json({"mode": "execute", "abandon": report.to_payload()})
        return
    render_abandon_text(
        report, performed=True, file_exists=file_exists, snapshot_file=snapshot_file
    )


def _run_checksum_gate(ctx: _MigrateContext, journal: MigrationJournal) -> None:
    """Block when applied migrations no longer match their recorded checksum."""
    checksum_mismatches = find_checksum_mismatches(ctx.migrations_dir, journal)
    if not checksum_mismatches:
        return
    if ctx.json_mode:
        _echo_json(
            {
                "mode": ctx.mode,
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
            _echo_json(
                {
                    "mode": ctx.mode,
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
        _echo_json(
            {"mode": ctx.mode, "pending": [], "applied": [], **_retry_field(plan.retry)}
        )
        return
    typer.echo("No pending migrations.")
    render_retry_notice(plan.retry)


def _render_plan(ctx: _MigrateContext, plan: _PendingPlan) -> bool:
    """Render the pending plan. True when the JSON plan ended the run."""
    if ctx.json_mode and not ctx.execute_requested:
        payload: dict[str, object] = {"mode": ctx.mode, "pending": plan.pending}
        if plan.undetermined:
            payload["undeterminedMigrations"] = plan.undetermined
        if plan.empty_migrations:
            payload["emptyMigrations"] = plan.empty_migrations
        payload.update(_retry_field(plan.retry))
        _echo_json(payload)
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
        _echo_json(
            {
                "mode": ctx.mode,
                "error": EMPTY_MIGRATIONS_SUMMARY,
                "emptyMigrations": empty_migrations,
            }
        )
        raise typer.Exit(code=1)
    typer.secho(str(empty_migrations_error(empty_migrations)), fg=typer.colors.RED, err=True)
    raise typer.Exit(code=1)


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
        _echo_json(
            {
                "mode": "execute",
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
    """Apply each pending migration, journal it, and emit the final summary."""
    # Progress lines go to stderr in --json mode, so stdout stays one JSON document.
    def log(line: str) -> None:
        typer.echo(line, err=ctx.json_mode)

    def warn(line: str) -> None:
        if not ctx.json_mode:
            typer.secho(line, fg=typer.colors.YELLOW, err=True)

    retry = plan.retry
    applied_now: list[MigrationJournalEntry] = []
    for filename in plan.pending:
        if not ctx.json_mode:
            meta = extract_migration_metadata(
                (ctx.migrations_dir / filename).read_text(encoding="utf-8")
            )
            if meta.log:
                typer.echo(f"  {meta.log}")
            typer.echo(f"  Applying {filename}")
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
                warn=warn,
            )
        )
        applied_now.append(entry)
        if not ctx.json_mode:
            typer.echo(f"Applied: {filename}")

    if ctx.json_mode:
        payload: dict[str, object] = {
            "mode": "execute",
            "applied": [e.model_dump() for e in applied_now],
        }
        if plan.undetermined:
            payload["undeterminedMigrations"] = plan.undetermined
        payload.update(_retry_field(retry))
        _echo_json(payload)
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


def _echo_json(payload: dict[str, object]) -> None:
    typer.echo(json.dumps(payload, indent=2))
