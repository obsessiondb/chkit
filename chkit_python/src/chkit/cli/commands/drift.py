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
from dataclasses import asdict
from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.commands.drift_payload import build_drift_payload
from chkit.cli.config_loader import load_config
from chkit.cli.migration_store import read_snapshot
from chkit.cli.schema_loader import load_schema
from chkit.cli.table_scope import (
    filter_plan_by_table_scope,
    resolve_table_scope,
    table_keys_from_definitions,
)
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.canonical import canonicalize_definitions
from chkit.core.planner import plan_diff


def run(  # noqa: PLR0912, PLR0915
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
            help="Scope drift detection to tables matching the selector.",
        ),
    ] = None,
    live: Annotated[
        bool,
        typer.Option(
            "--live",
            help=(
                "Compare snapshot against live ClickHouse instead of the local "
                "schema. Requires a clickhouse block in the config."
            ),
        ),
    ] = False,
) -> None:
    config = load_config(config_path)
    meta_dir = Path(config.meta_dir)
    snapshot = read_snapshot(meta_dir)
    if snapshot is None:
        msg = "Snapshot not found. Run `chkit generate` before drift checks."
        raise typer.Exit(code=1) from RuntimeError(msg)

    schema_defs = canonicalize_definitions(load_schema(config.schema_))
    snapshot_defs = list(snapshot.definitions)
    available_keys = sorted(
        set(table_keys_from_definitions(snapshot_defs))
        | set(table_keys_from_definitions(schema_defs))
    )
    table_scope = resolve_table_scope(table_selector, available_keys)

    if live:
        if config.clickhouse is None:
            msg = "clickhouse.config.py must include a `clickhouse` block for --live drift."
            raise typer.BadParameter(msg)
        with ClickHouseClient.connect(config.clickhouse) as client:
            payload_obj = build_drift_payload(
                client=client,
                meta_dir=meta_dir,
                snapshot=snapshot,
                database=config.clickhouse.database,
                fail_on_extra_objects=False,
                scope=table_scope if table_scope.enabled else None,
            )

        payload_dict: dict[str, object] = {
            "snapshotFile": payload_obj.snapshot_file,
            "expectedCount": payload_obj.expected_count,
            "actualCount": payload_obj.actual_count,
            "drifted": payload_obj.drifted,
            "missing": payload_obj.missing,
            "extra": payload_obj.extra,
            "kindMismatches": [asdict(m) for m in payload_obj.kind_mismatches],
            "objectDrift": [asdict(d) for d in payload_obj.object_drift],
            "tableDrift": [asdict(d) for d in payload_obj.table_drift],
        }
        if payload_obj.database_missing:
            payload_dict["databaseMissing"] = True
            payload_dict["database"] = payload_obj.database
        if output_json:
            typer.echo(json.dumps(payload_dict, indent=2))
            return
        if payload_obj.database_missing:
            typer.echo(
                f'⚠ Database "{payload_obj.database or ""}" does not exist on the target server.'
            )
        typer.echo(f"Snapshot file:       {payload_obj.snapshot_file}")
        typer.echo(f"Expected objects:    {payload_obj.expected_count}")
        typer.echo(f"Actual objects:      {payload_obj.actual_count}")
        typer.echo(f"Drifted:             {'yes' if payload_obj.drifted else 'no'}")
        if payload_obj.missing:
            typer.echo("")
            typer.echo("Missing (in snapshot, not in DB):")
            for item in payload_obj.missing:
                typer.echo(f"- {item}")
        if payload_obj.extra:
            typer.echo("")
            typer.echo("Extra (in DB, not in snapshot):")
            for item in payload_obj.extra:
                typer.echo(f"- {item}")
        if payload_obj.kind_mismatches:
            typer.echo("")
            typer.echo("Kind mismatches:")
            for m in payload_obj.kind_mismatches:
                typer.echo(f"- {m.object}: expected {m.expected}, got {m.actual}")
        if payload_obj.table_drift:
            typer.echo("")
            typer.echo("Table shape drift:")
            for detail in payload_obj.table_drift:
                typer.echo(f"- {detail.table}: {', '.join(detail.reason_codes)}")
        return

    plan = plan_diff(snapshot_defs, schema_defs)
    if table_scope.enabled:
        filtered = filter_plan_by_table_scope(plan, set(table_scope.matched_tables))
        plan = filtered.plan
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
