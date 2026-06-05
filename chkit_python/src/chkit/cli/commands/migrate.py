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
from chkit.cli.config_loader import load_config
from chkit.cli.journal_store import JournalStore
from chkit.cli.migration_store import (
    MigrationJournalEntry,
    checksum_sql,
    find_checksum_mismatches,
    list_migration_filenames,
    now_iso,
)
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.sql_splitter import extract_executable_statements

_DESTRUCTIVE_MARKER = "risk=danger"


def _is_destructive(sql_text: str) -> bool:
    """A migration is destructive if any operation has ``risk=danger``."""
    return _DESTRUCTIVE_MARKER in sql_text


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
    output_json: Annotated[
        bool,
        typer.Option("--json", help="Emit a JSON-formatted summary."),
    ] = False,
) -> None:
    config = load_config(config_path)
    if config.clickhouse is None:
        msg = "clickhouse.config.py must include a `clickhouse` block to migrate."
        raise typer.BadParameter(msg)

    migrations_dir = Path(config.migrations_dir)
    migrations_dir.mkdir(parents=True, exist_ok=True)
    execute_requested = apply or execute
    mode = "execute" if execute_requested else "plan"

    files = list_migration_filenames(migrations_dir)

    with ClickHouseClient.connect(config.clickhouse) as client:
        journal_store = JournalStore(client)
        journal = journal_store.read_journal()
        applied_names = {entry.name for entry in journal.applied}
        pending = [f for f in files if f not in applied_names]
        checksum_mismatches = find_checksum_mismatches(migrations_dir, journal)

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
                typer.echo(
                    json.dumps({"mode": mode, "pending": pending}, indent=2)
                )
                return
            typer.echo(f"Pending migrations: {len(pending)}")
            for filename in pending:
                typer.echo(f"- {filename}")
            typer.echo("")
            typer.echo(
                "Plan only. Re-run with --apply to apply and journal these migrations."
            )
            return

        destructive_files = [
            f
            for f in pending
            if _is_destructive((migrations_dir / f).read_text(encoding="utf-8"))
        ]
        destructive_allowed = (
            allow_destructive or config.safety.allow_destructive
        )
        if destructive_files and not destructive_allowed:
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
                        },
                        indent=2,
                    )
                )
                raise typer.Exit(code=3)
            typer.secho(error, fg=typer.colors.RED, err=True)
            typer.echo(
                f"Destructive migrations: {', '.join(destructive_files)}", err=True
            )
            raise typer.Exit(code=3)

        applied_now: list[MigrationJournalEntry] = []
        for filename in pending:
            sql_text = (migrations_dir / filename).read_text(encoding="utf-8")
            if not output_json:
                typer.echo(f"  Applying {filename}")
            for statement in extract_executable_statements(sql_text):
                client.execute(statement)
            entry = MigrationJournalEntry(
                name=filename,
                applied_at=now_iso(),
                checksum=checksum_sql(sql_text),
            )
            journal_store.append_entry(entry, chkit_version=__version__)
            applied_now.append(entry)
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
