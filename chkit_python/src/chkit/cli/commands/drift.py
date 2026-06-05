"""`chkit drift` — compare the on-disk snapshot against the current schema.

Mirrors the TypeScript ``driftCommand`` for the snapshot-vs-schema check.
The TS port also reaches into ClickHouse to compare against the live database;
that full DB-side introspection is not in this first-base Python port, so the
command focuses on the snapshot/schema diff produced by ``plan_diff``.

Output (human):

    Expected operations: <N>
    Drifted:             <yes|no>
    <plan operations>

Output (``--json``):

    {
      "snapshotFile": "...",
      "drifted": true,
      "operations": [...],
      "renameSuggestions": [...]
    }
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.config_loader import load_config
from chkit.cli.migration_store import read_snapshot
from chkit.cli.schema_loader import load_schema
from chkit.core.canonical import canonicalize_definitions
from chkit.core.planner import plan_diff


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
    meta_dir = Path(config.meta_dir)
    snapshot = read_snapshot(meta_dir)
    if snapshot is None:
        msg = "Snapshot not found. Run `chkit generate` before drift checks."
        raise typer.Exit(code=1) from RuntimeError(msg)

    schema_defs = canonicalize_definitions(load_schema(config.schema_))
    plan = plan_diff(list(snapshot.definitions), schema_defs)
    snapshot_file = meta_dir / "snapshot.json"

    payload = {
        "snapshotFile": str(snapshot_file),
        "drifted": bool(plan.operations),
        "operations": [op.model_dump(by_alias=True) for op in plan.operations],
        "renameSuggestions": [
            s.model_dump(by_alias=True) for s in plan.rename_suggestions
        ],
    }

    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    typer.echo(f"Snapshot file:       {snapshot_file}")
    typer.echo(f"Expected operations: {len(plan.operations)}")
    typer.echo(f"Drifted:             {'yes' if plan.operations else 'no'}")
    if plan.operations:
        typer.echo("")
        typer.echo("Operations:")
        for op in plan.operations:
            typer.echo(f"- [{op.risk}] {op.type} {op.key}")
    if plan.rename_suggestions:
        typer.echo("")
        typer.echo("Rename suggestions:")
        for s in plan.rename_suggestions:
            typer.echo(
                f"- {s.database}.{s.table} {s.from_} -> {s.to} ({s.confidence})"
            )
