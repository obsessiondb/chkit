"""`chkit status` — show applied vs. pending migrations and checksum mismatches.

Output format mirrors the TypeScript ``statusCommand`` verbatim:

    Migrations directory: <dir>
    Total migrations:     <N>
    Applied:              <N>
    Pending:              <N>

Followed by lists of pending filenames and any detected checksum mismatches.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.command_target import (
    ServiceOption,
    exit_no_target,
    open_client,
    resolve_plugin_executor,
)
from chkit.cli.commands.migrate_apply import preview_statement
from chkit.cli.commands.migrate_recovery import InProgressMigration, describe_in_progress
from chkit.cli.commands.migrate_statement_state import (
    Abandoned,
    AwaitingReplicas,
    Failed,
    Interrupted,
    Running,
)
from chkit.cli.config_loader import load_config
from chkit.cli.hook_flags import passed_flags
from chkit.cli.journal_store import JournalStore
from chkit.cli.json_output import emit_json
from chkit.cli.migration_store import (
    checksum_sql,
    find_checksum_mismatches,
    list_migration_filenames,
)
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.shared_engine_flags import ForceSharedEnginesOption, NoSharedEnginesOption
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
    # Accepted so existing scripts keep working, and handed to on_init and
    # get_context; only generate and snapshot rebuild run the on_schema_loaded
    # hooks that act on them (as in TS).
    force_shared_engines: ForceSharedEnginesOption = False,
    no_shared_engines: NoSharedEnginesOption = False,
    service: ServiceOption = None,
) -> None:
    config = load_config(config_path, ChxConfigEnv(command="status"))
    executor = resolve_plugin_executor(
        load_plugin_runtime([p for p in config.plugins if isinstance(p, ChxPlugin)]),
        config,
        command="status",
        config_path=str(config_path or "clickhouse.config.py"),
        json_mode=output_json,
        service=service,
        # As in TS, the hooks get the flags that were passed, keyed by long name.
        flags=passed_flags(
            {
                "--config": str(config_path) if config_path is not None else None,
                "--json": output_json,
                "--force-shared-engines": force_shared_engines,
                "--no-shared-engines": no_shared_engines,
                "--service": service,
            }
        ),
    )
    if executor is None and config.clickhouse is None:
        msg = "clickhouse config is required for status (journal is stored in ClickHouse)"
        exit_no_target("status", msg, json_mode=output_json)

    # Absolute, as TS ``resolveDirs`` resolves them, so the printed
    # ``migrationsDir`` reads the same in both CLIs.
    migrations_dir = Path(os.path.abspath(config.migrations_dir))
    migrations_dir.mkdir(parents=True, exist_ok=True)
    files = list_migration_filenames(migrations_dir)

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
        pending = [f for f in files if f not in applied_names]
        mismatches = find_checksum_mismatches(migrations_dir, journal)
        # A migration that failed part-way stays pending; scoped to this
        # project's files like Applied.
        in_progress = [
            describe_in_progress(
                state, checksum_sql((migrations_dir / state.name).read_text(encoding="utf-8"))
            )
            for state in store.read_in_progress()
            if state.name in pending
        ]

    payload: dict[str, object] = {
        "migrationsDir": str(migrations_dir),
        "total": len(files),
        "applied": len(applied),
        "pending": len(pending),
        "pendingMigrations": pending,
        "inProgressMigrations": [m.to_payload() for m in in_progress],
        "checksumMismatchCount": len(mismatches),
        "checksumMismatches": [m.model_dump() for m in mismatches],
    }
    database = config.clickhouse.database if config.clickhouse else None
    if database_missing:
        payload["databaseMissing"] = True
        if database is not None:
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
    if in_progress:
        typer.echo("")
        typer.echo("In progress (failed part-way, still pending):")
        for migration in in_progress:
            for line in _format_in_progress(migration):
                typer.echo(line)
    if mismatches:
        typer.echo("")
        typer.echo("Checksum mismatches on applied migrations:")
        for m in mismatches:
            typer.echo(f"- {m.name}")


def _format_in_progress(migration: InProgressMigration) -> list[str]:
    count = migration.completed_statements
    lines = [f"- {migration.name}: {count} statement{'' if count == 1 else 's'} completed"]
    for entry in migration.statements:
        statement = f"Statement {entry.statement}"
        match entry.state:
            case Failed(error=error):
                reason = error.split("\n")[0].strip()
                lines.append(
                    f"  {statement} failed: {preview_statement(reason, 200)}"
                    if reason
                    else f"  {statement} failed."
                )
            case Interrupted():
                lines.append(f"  {statement} was interrupted while it ran.")
            case Running(query_id=query_id):
                lines.append(
                    f"  {statement} may still be running on the server (query_id {query_id})."
                )
            case AwaitingReplicas():
                lines.append(f"  {statement} ran; it has not reached every replica yet.")
            case Abandoned(was=was):
                lines.append(f"  {statement} was abandoned (it had {was}).")
    if migration.file_changed:
        lines.append("  The file changed since its last failed attempt.")
    lines.append(f"  Next: {', then '.join(migration.next_steps)}")
    return lines
