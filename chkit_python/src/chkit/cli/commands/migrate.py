"""`chkit migrate` — preview or apply pending migrations.

Default behaviour (no flags) is a **plan/preview**, matching the TS reference.
Pass ``--apply`` (or alias ``--execute``) to actually execute the SQL and
record entries in the ClickHouse ``_chkit_migrations`` journal.

Flags mirror the TypeScript ``migrateCommand``:

- ``--apply`` / ``--execute``  Apply pending migrations (no prompt).
- ``--allow-destructive``      Allow migrations whose plan includes
                               ``risk=danger`` operations.
- ``--json``                   Emit JSON instead of human text.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from chkit import __version__
from chkit.cli.commands.migrate_async_apply import (
    AsyncApplyInput,
    apply_async_statement,
)
from chkit.cli.commands.migrate_prompts import (
    confirm_apply,
    confirm_destructive_execution,
    is_background_or_ci,
    print_destructive_operation_details,
)
from chkit.cli.commands.migrate_scope import filter_pending_by_scope
from chkit.cli.config_loader import load_config
from chkit.cli.journal_store import JournalStore
from chkit.cli.migration_metadata import extract_migration_metadata
from chkit.cli.migration_store import (
    MigrationJournalEntry,
    checksum_sql,
    find_checksum_mismatches,
    list_migration_filenames,
    now_iso,
    read_snapshot,
)
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.safety_markers import (
    DestructiveOperationMarker,
    collect_destructive_operation_markers,
    collect_unmarked_destructive_statements,
    extract_migration_operation_summaries,
)
from chkit.cli.table_scope import (
    resolve_table_scope,
    table_keys_from_definitions,
)
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_ddl_propagation
from chkit.core.sql_splitter import extract_executable_statements
from chkit.plugins import (
    ChxOnAfterApplyContext,
    ChxOnBeforeApplyContext,
    ChxPlugin,
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


def run(
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
    output_json: Annotated[
        bool,
        typer.Option("--json", help="Emit a JSON-formatted summary."),
    ] = False,
) -> None:
    config = load_config(config_path)
    if config.clickhouse is None:
        msg = "clickhouse.config.py must include a `clickhouse` block to migrate."
        raise typer.BadParameter(msg)

    plugin_runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )

    migrations_dir = Path(config.migrations_dir)
    migrations_dir.mkdir(parents=True, exist_ok=True)
    execute_requested = apply or execute
    mode = "execute" if execute_requested else "plan"

    files = list_migration_filenames(migrations_dir)

    meta_dir = Path(config.meta_dir)
    snapshot = read_snapshot(meta_dir)
    snapshot_defs = list(snapshot.definitions) if snapshot is not None else []
    table_scope = resolve_table_scope(
        table_selector, table_keys_from_definitions(snapshot_defs)
    )

    with ClickHouseClient.connect(config.clickhouse) as client:
        journal_store = JournalStore(client)
        journal = journal_store.read_journal(project_files=files)
        applied_names = {entry.name for entry in journal.applied}
        pending_all = [f for f in files if f not in applied_names]
        checksum_mismatches = find_checksum_mismatches(migrations_dir, journal)

        if table_scope.enabled and table_scope.match_count == 0:
            warning = (
                f'No tables matched selector "{table_scope.selector or ""}". '
                f"No migrations selected."
            )
            if output_json:
                typer.echo(
                    json.dumps(
                        {
                            "mode": mode,
                            "pending": [],
                            "applied": [],
                            "warning": warning,
                        },
                        indent=2,
                    )
                )
            else:
                typer.echo(warning)
            return

        if table_scope.enabled:
            scoped = filter_pending_by_scope(
                migrations_dir, pending_all, set(table_scope.matched_tables)
            )
            pending = scoped.in_scope
            undetermined = scoped.undetermined
        else:
            pending = pending_all
            undetermined = []

        if checksum_mismatches:
            if output_json:
                typer.echo(
                    json.dumps(
                        {
                            "mode": mode,
                            "error": "Checksum mismatch detected on applied migrations",
                            "checksumMismatches": [
                                m.model_dump() for m in checksum_mismatches
                            ],
                        },
                        indent=2,
                    )
                )
                raise typer.Exit(code=1)
            names = ", ".join(m.name for m in checksum_mismatches)
            typer.secho(
                f"Checksum mismatch detected on applied migrations: {names}",
                fg=typer.colors.RED,
                err=True,
            )
            raise typer.Exit(code=1)

        if not pending:
            if output_json:
                typer.echo(
                    json.dumps(
                        {"mode": mode, "pending": [], "applied": []}, indent=2
                    )
                )
            else:
                typer.echo("No pending migrations.")
            return

        if not execute_requested:
            if output_json:
                payload: dict[str, object] = {"mode": mode, "pending": pending}
                if undetermined:
                    payload["undeterminedMigrations"] = undetermined
                typer.echo(json.dumps(payload, indent=2))
                return
            if table_scope.enabled:
                typer.echo(
                    f"Table scope: {table_scope.selector or ''} "
                    f"({table_scope.match_count} matched)"
                )
                for matched in table_scope.matched_tables:
                    typer.echo(f"- {matched}")
            if undetermined:
                typer.echo(
                    f"⚠ {len(undetermined)} pending migration(s) have no table "
                    "markers; including them because their target tables can't "
                    "be determined under --table:"
                )
                for filename in undetermined:
                    typer.echo(f"  - {filename}")
            typer.echo(f"Pending migrations: {len(pending)}")
            for filename in pending:
                typer.echo(f"- {filename}")
                meta = extract_migration_metadata(
                    (migrations_dir / filename).read_text(encoding="utf-8")
                )
                if meta.log:
                    typer.echo(f"    {meta.log}")

            if is_background_or_ci():
                typer.echo("")
                typer.echo(
                    "Plan only. Re-run with --apply to apply and journal these migrations."
                )
                return

            if not confirm_apply():
                typer.echo("Migration apply cancelled by user.")
                return

            # Fall through: user confirmed, treat as executed.
            execute_requested = True
            mode = "execute"

        destructive_markers = _collect_destructive_markers_for_pending(
            migrations_dir, pending
        )
        destructive_files = sorted({m.migration for m in destructive_markers})
        destructive_allowed = (
            allow_destructive or config.safety.allow_destructive
        )
        if destructive_markers and not destructive_allowed:
            error = (
                "Blocked destructive migration execution. "
                "Re-run with --allow-destructive or set safety.allowDestructive=true "
                "after review."
            )
            if output_json:
                typer.echo(
                    json.dumps(
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
                        },
                        indent=2,
                    )
                )
                raise typer.Exit(code=3)

            if is_background_or_ci():
                print_destructive_operation_details(destructive_markers)
                typer.secho(error, fg=typer.colors.RED, err=True)
                typer.echo(
                    f"Destructive migrations: {', '.join(destructive_files)}",
                    err=True,
                )
                typer.echo(
                    "Non-interactive run detected. Pass --allow-destructive to proceed.",
                    err=True,
                )
                raise typer.Exit(code=3)

            confirmed = confirm_destructive_execution(destructive_markers)
            if not confirmed:
                typer.secho(
                    f"Destructive migration cancelled by user. "
                    f"Destructive migrations: {', '.join(destructive_files)}",
                    fg=typer.colors.RED,
                    err=True,
                )
                raise typer.Exit(code=3)
            destructive_allowed = True

        applied_now: list[MigrationJournalEntry] = []
        for filename in pending:
            sql_text = (migrations_dir / filename).read_text(encoding="utf-8")
            if not output_json:
                meta = extract_migration_metadata(sql_text)
                if meta.log:
                    typer.echo(f"  {meta.log}")
                typer.echo(f"  Applying {filename}")
            parsed_statements = extract_executable_statements(sql_text)
            # Let plugins inspect / transform the statement list before execution.
            statements = list(
                plugin_runtime.run_on_before_apply(
                    ChxOnBeforeApplyContext(
                        command="migrate",
                        config=config,
                        table_scope=table_scope,
                        flags={},
                        migration=filename,
                        sql=sql_text,
                        statements=parsed_statements,
                    )
                )
            )
            ops = extract_migration_operation_summaries(sql_text)
            migration_checksum = checksum_sql(sql_text)
            for idx, statement in enumerate(statements):
                op = ops[idx] if idx < len(ops) else None
                if op is not None and op.mode == "async":
                    # Long-running ALTER / OPTIMIZE / INSERT: deterministic
                    # query_id + per-statement journal + poll until terminal.
                    apply_async_statement(
                        AsyncApplyInput(
                            client=client,
                            journal_store=journal_store,
                            sql=statement,
                            migration_name=filename,
                            migration_checksum=migration_checksum,
                            statement_index=idx,
                            operation_type=op.type,
                            operation_key=op.key,
                            before_retry=op.before_retry,
                            log=(
                                (lambda _line: None)
                                if output_json
                                else typer.echo
                            ),
                        )
                    )
                else:
                    client.execute(statement)
                # Poll system.tables / system.columns until the DDL is visible
                # on the live database. Critical for ReplicatedMergeTree and
                # ObsessionDB Shared engines where DDL is eventually consistent.
                if op is not None:
                    try:
                        wait_for_ddl_propagation(client, op.type, op.key)
                    except Exception as wait_error:
                        if not output_json:
                            typer.secho(
                                f"  ⚠ DDL propagation wait failed for "
                                f"{op.key}: {wait_error}",
                                fg=typer.colors.YELLOW,
                                err=True,
                            )
            entry = MigrationJournalEntry(
                name=filename,
                applied_at=now_iso(),
                checksum=checksum_sql(sql_text),
            )
            journal_store.append_entry(entry, chkit_version=__version__)
            applied_now.append(entry)
            plugin_runtime.run_on_after_apply(
                ChxOnAfterApplyContext(
                    command="migrate",
                    config=config,
                    table_scope=table_scope,
                    flags={},
                    migration=filename,
                    statements=statements,
                    applied_at=entry.applied_at,
                )
            )
            if not output_json:
                typer.echo(f"Applied: {filename}")

        if output_json:
            typer.echo(
                json.dumps(
                    {
                        "mode": "execute",
                        "applied": [e.model_dump() for e in applied_now],
                    },
                    indent=2,
                )
            )
            return
        typer.echo("")
        typer.echo("Migrations recorded in ClickHouse _chkit_migrations table.")
