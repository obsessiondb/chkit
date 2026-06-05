"""`chkit status` — show applied vs. pending migrations and checksum mismatches.

Output format mirrors the TypeScript ``statusCommand`` verbatim:

    Migrations directory: <dir>
    Total migrations:     <N>
    Applied:              <N>
    Pending:              <N>

Followed by lists of pending filenames and any detected checksum mismatches.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.config_loader import load_config
from chkit.cli.journal_store import JournalStore
from chkit.cli.migration_store import (
    find_checksum_mismatches,
    list_migration_filenames,
)
from chkit.clickhouse.client import ClickHouseClient


def run(
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    output_json: Annotated[
        bool, typer.Option("--json", help="Emit a JSON-formatted summary.")
    ] = False,
) -> None:
    config = load_config(config_path)
    if config.clickhouse is None:
        msg = (
            "clickhouse.config.py must include a `clickhouse` block "
            "(journal lives in ClickHouse)."
        )
        raise typer.BadParameter(msg)

    migrations_dir = Path(config.migrations_dir)
    migrations_dir.mkdir(parents=True, exist_ok=True)
    files = list_migration_filenames(migrations_dir)

    with ClickHouseClient.connect(config.clickhouse) as client:
        store = JournalStore(client)
        journal = store.read_journal()
        database_missing = store.database_missing
        applied_names = {entry.name for entry in journal.applied}
        pending = [f for f in files if f not in applied_names]
        mismatches = find_checksum_mismatches(migrations_dir, journal)

    payload: dict[str, object] = {
        "migrationsDir": str(migrations_dir),
        "total": len(files),
        "applied": len(journal.applied),
        "pending": len(pending),
        "pendingMigrations": pending,
        "checksumMismatchCount": len(mismatches),
        "checksumMismatches": [m.model_dump() for m in mismatches],
    }
    if database_missing:
        payload["databaseMissing"] = True
        payload["database"] = config.clickhouse.database

    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    if database_missing:
        typer.echo(
            f'⚠ Database "{config.clickhouse.database}" '
            f"does not exist on the target server."
        )
        typer.echo("  It will be created when you run: chkit migrate --apply\n")

    typer.echo(f"Migrations directory: {migrations_dir}")
    typer.echo(f"Total migrations:     {len(files)}")
    typer.echo(f"Applied:              {len(journal.applied)}")
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
