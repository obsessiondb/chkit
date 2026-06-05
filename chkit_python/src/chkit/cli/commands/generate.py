"""`chkit generate` — diff current schema vs. last snapshot and emit a migration.

Flag set matches the TypeScript ``generateCommand``:

- ``--name``        Migration name (sanitized via ``safe_name``; default "auto").
- ``--migration-id``Override the timestamp prefix in the migration filename.
- ``--dryrun``      Print the plan without writing artifacts.
- ``--json``        Emit a JSON-formatted summary instead of human text.
- ``--config``      Path to the config file (default ``clickhouse.config.py``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from chkit import __version__
from chkit.cli.config_loader import load_config
from chkit.cli.migration_store import (
    read_snapshot,
    write_migration,
    write_snapshot,
)
from chkit.cli.schema_loader import load_schema
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ChxValidationError
from chkit.core.planner import plan_diff
from chkit.core.snapshot import create_snapshot
from chkit.core.validate import validate_definitions


def run(
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    migration_name: Annotated[
        str | None,
        typer.Option("--name", "-n", help="Migration name (sanitized)."),
    ] = None,
    migration_id: Annotated[
        str | None,
        typer.Option(
            "--migration-id",
            help="Override the default timestamp prefix in the migration filename.",
        ),
    ] = None,
    dryrun: Annotated[
        bool,
        typer.Option("--dryrun", help="Print plan without writing artifacts."),
    ] = False,
    output_json: Annotated[
        bool,
        typer.Option("--json", help="Emit a JSON-formatted summary."),
    ] = False,
) -> None:
    config = load_config(config_path)
    schema_globs = config.schema_
    definitions = load_schema(schema_globs)
    canonical = canonicalize_definitions(definitions)

    issues = validate_definitions(canonical)
    if issues:
        if output_json:
            typer.echo(
                json.dumps(
                    {
                        "error": "validation_failed",
                        "issues": [i.model_dump(mode="json") for i in issues],
                    },
                    indent=2,
                )
            )
            raise typer.Exit(code=1)
        raise ChxValidationError(issues)

    meta_dir = Path(config.meta_dir)
    migrations_dir = Path(config.migrations_dir)

    previous = read_snapshot(meta_dir)
    old_defs = list(previous.definitions) if previous is not None else []

    plan = plan_diff(old_defs, canonical)
    if not plan.operations:
        if output_json:
            typer.echo(
                json.dumps(
                    {
                        "mode": "plan" if dryrun else "apply",
                        "operationCount": 0,
                        "riskSummary": {"safe": 0, "caution": 0, "danger": 0},
                        "operations": [],
                        "renameSuggestions": [],
                    },
                    indent=2,
                )
            )
            return
        typer.echo("No schema changes detected.")
        return

    if dryrun:
        if output_json:
            typer.echo(
                json.dumps(
                    {
                        "mode": "plan",
                        "operationCount": len(plan.operations),
                        "riskSummary": plan.risk_summary.model_dump(),
                        "operations": [
                            op.model_dump(by_alias=True) for op in plan.operations
                        ],
                        "renameSuggestions": [
                            s.model_dump(by_alias=True) for s in plan.rename_suggestions
                        ],
                    },
                    indent=2,
                )
            )
            return
        typer.echo(f"Plan: {len(plan.operations)} operation(s)")
        for op in plan.operations:
            typer.echo(f"- [{op.risk}] {op.type} {op.key}")
        risks = plan.risk_summary
        typer.echo(
            f"Risk: safe={risks.safe} caution={risks.caution} danger={risks.danger}"
        )
        return

    artifact = write_migration(
        migrations_dir,
        meta_dir,
        canonical,
        plan,
        migration_name=migration_name,
        migration_id=migration_id,
        cli_version=__version__,
    )
    snapshot = create_snapshot(canonical)
    snapshot_path = write_snapshot(meta_dir, snapshot)

    if artifact is None:
        # plan.operations was non-empty above, so this branch is unreachable;
        # guarding for type safety.
        return

    if output_json:
        typer.echo(
            json.dumps(
                {
                    "migrationFile": str(artifact.sql_path),
                    "snapshotFile": str(snapshot_path),
                    "operationCount": len(plan.operations),
                    "riskSummary": plan.risk_summary.model_dump(),
                },
                indent=2,
            )
        )
        return

    typer.secho(f"Generated migration {artifact.id}", fg=typer.colors.GREEN)
    typer.echo(f"  SQL:      {artifact.sql_path}")
    typer.echo(f"  Snapshot: {snapshot_path}")
    typer.echo(f"  Operations: {len(plan.operations)}")
    risks = plan.risk_summary
    typer.echo(
        f"  Risk: safe={risks.safe} caution={risks.caution} danger={risks.danger}"
    )
