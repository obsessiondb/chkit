"""`chkit status` — show applied vs. pending migrations and checksum mismatches.

Output format mirrors the TypeScript ``statusCommand`` verbatim:

    Migrations directory: <dir>
    Total migrations:     <N>
    Applied:              <N>
    Pending:              <N>

Followed by lists of pending filenames and any detected checksum mismatches.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.command_target import exit_no_target, open_client, resolve_plugin_executor
from chkit.cli.commands.migrate_scope import filter_pending_by_scope
from chkit.cli.config_loader import load_config
from chkit.cli.journal_store import JournalStore
from chkit.cli.json_output import emit_json
from chkit.cli.migration_store import (
    find_checksum_mismatches,
    list_migration_filenames,
    read_snapshot,
)
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.shared_engine_flags import ForceSharedEnginesOption, NoSharedEnginesOption
from chkit.cli.table_scope import (
    resolve_table_scope,
    table_keys_from_definitions,
)
from chkit.core.model import ChxConfigEnv
from chkit.plugins import ChxPlugin


def run(
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    output_json: Annotated[
        bool, typer.Option("--json", help="Emit a JSON-formatted summary.")
    ] = False,
    table_selector: Annotated[
        str | None,
        typer.Option(
            "--table",
            "-t",
            help=(
                "Filter pending list to migrations touching the matched tables. "
                "Examples: events, events_*, analytics.events."
            ),
        ),
    ] = None,
    # Accepted so existing scripts keep working; only generate and snapshot
    # rebuild run the on_schema_loaded hooks that read them (as in TS).
    force_shared_engines: ForceSharedEnginesOption = False,  # noqa: ARG001
    no_shared_engines: NoSharedEnginesOption = False,  # noqa: ARG001
) -> None:
    config = load_config(config_path, ChxConfigEnv(command="status"))
    executor = resolve_plugin_executor(
        load_plugin_runtime([p for p in config.plugins if isinstance(p, ChxPlugin)]),
        config,
        command="status",
        config_path=str(config_path or "clickhouse.config.py"),
        json_mode=output_json,
    )
    if executor is None and config.clickhouse is None:
        msg = (
            "clickhouse.config.py must include a `clickhouse` block or select an "
            "ObsessionDB service (journal lives in ClickHouse)."
        )
        exit_no_target("status", msg, json_mode=output_json)

    migrations_dir = Path(config.migrations_dir)
    meta_dir = Path(config.meta_dir)
    migrations_dir.mkdir(parents=True, exist_ok=True)
    files = list_migration_filenames(migrations_dir)

    snapshot = read_snapshot(meta_dir)
    snapshot_defs = list(snapshot.definitions) if snapshot is not None else []
    table_scope = resolve_table_scope(
        table_selector, table_keys_from_definitions(snapshot_defs)
    )

    with open_client(executor, config.clickhouse) as client:
        store = JournalStore(
            client, cluster=config.clickhouse.cluster if config.clickhouse else None
        )
        journal = store.read_journal(project_files=files)
        database_missing = store.database_missing
        applied_names = {entry.name for entry in journal.applied}
        # Scope "applied" to files present in this project's migrations dir.
        # The journal table can be shared across tenants (ObsessionDB pattern)
        # so journal.applied may include rows from other projects whose
        # filenames live elsewhere. Intersecting with `files` keeps the count
        # consistent with what `chkit migrate` will see. Mirrors TS status #31.
        applied = [f for f in files if f in applied_names]
        pending_all = [f for f in files if f not in applied_names]
        mismatches = find_checksum_mismatches(migrations_dir, journal)

    if table_scope.enabled:
        scoped = filter_pending_by_scope(
            migrations_dir, pending_all, set(table_scope.matched_tables)
        )
        pending = scoped.in_scope
    else:
        pending = pending_all

    payload: dict[str, object] = {
        "migrationsDir": str(migrations_dir),
        "total": len(files),
        "applied": len(applied),
        "pending": len(pending),
        "pendingMigrations": pending,
        "checksumMismatchCount": len(mismatches),
        "checksumMismatches": [m.model_dump() for m in mismatches],
    }
    database = config.clickhouse.database if config.clickhouse else None
    if database_missing:
        payload["databaseMissing"] = True
        payload["database"] = database

    if output_json:
        emit_json("status", payload)
        return

    if database_missing:
        typer.echo(
            f'⚠ Database "{database or ""}" '
            f"does not exist on the target server."
        )
        typer.echo("  It will be created when you run: chkit migrate --apply\n")

    typer.echo(f"Migrations directory: {migrations_dir}")
    typer.echo(f"Total migrations:     {len(files)}")
    typer.echo(f"Applied:              {len(applied)}")
    typer.echo(f"Pending:              {len(pending)}")

    if pending:
        typer.echo("")
        typer.echo("Pending migrations:")
        for filename in pending:
            typer.echo(f"- {filename}")
    if mismatches:
        typer.echo("")
        typer.echo("Checksum mismatches on applied migrations:")
        for m in mismatches:
            typer.echo(f"- {m.name}")
