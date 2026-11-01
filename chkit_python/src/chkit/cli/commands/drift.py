"""`chkit drift` — compare the snapshot against the live ClickHouse database.

Mirrors ``packages/cli/src/commands/drift/command.ts``: it needs a snapshot and
a target (a ``clickhouse`` block or a selected ObsessionDB service). ``--live``
is accepted for scripts written when it was required.
"""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.command_target import (
    ServiceOption,
    exit_no_target,
    open_client,
    resolve_plugin_executor,
)
from chkit.cli.commands.drift_payload import build_drift_payload
from chkit.cli.config_loader import load_config
from chkit.cli.json_output import emit_json, emit_json_error
from chkit.cli.migration_store import read_snapshot
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.shared_engine_flags import ForceSharedEnginesOption, NoSharedEnginesOption
from chkit.cli.table_scope import (
    resolve_table_scope,
    scope_to_payload,
    table_keys_from_definitions,
)
from chkit.core.model import ChxConfigEnv
from chkit.plugins import ChxPlugin


def run(  # noqa: PLR0912, PLR0915, PLR0917
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
    live: Annotated[  # noqa: ARG001
        bool,
        typer.Option(
            "--live",
            help="No-op, kept for existing scripts: drift always reads the live server.",
        ),
    ] = False,
    # Accepted so existing scripts keep working; only generate and snapshot
    # rebuild run the on_schema_loaded hooks that read them (as in TS).
    force_shared_engines: ForceSharedEnginesOption = False,  # noqa: ARG001
    no_shared_engines: NoSharedEnginesOption = False,  # noqa: ARG001
    service: ServiceOption = None,
) -> None:
    config = load_config(config_path, ChxConfigEnv(command="drift"))
    meta_dir = Path(config.meta_dir)
    snapshot = read_snapshot(meta_dir)
    if snapshot is None:
        msg = "Snapshot not found. Run `chkit generate` before drift checks."
        if output_json:
            emit_json_error("drift", {"code": "error", "message": msg})
        typer.echo(msg, err=True)
        raise typer.Exit(code=1)

    table_scope = resolve_table_scope(
        table_selector, table_keys_from_definitions(snapshot.definitions)
    )
    if table_scope.enabled and table_scope.match_count == 0:
        warning = f'No tables matched selector "{table_scope.selector or ""}".'
        if output_json:
            emit_json(
                "drift",
                {
                    "scope": scope_to_payload(table_scope),
                    "snapshotFile": str(meta_dir / "snapshot.json"),
                    "expectedCount": 0,
                    "actualCount": 0,
                    "drifted": False,
                    "missing": [],
                    "extra": [],
                    "kindMismatches": [],
                    "objectDrift": [],
                    "tableDrift": [],
                    "warning": warning,
                },
            )
            return
        typer.echo(f"{warning} Drift check is a no-op.")
        return

    executor = resolve_plugin_executor(
        load_plugin_runtime([p for p in config.plugins if isinstance(p, ChxPlugin)]),
        config,
        command="drift",
        config_path=str(config_path or "clickhouse.config.py"),
        json_mode=output_json,
        service=service,
    )
    if executor is None and config.clickhouse is None:
        msg = (
            "clickhouse.config.py must include a `clickhouse` block or select an "
            "ObsessionDB service for drift checks."
        )
        exit_no_target("drift", msg, json_mode=output_json)
    with open_client(executor, config.clickhouse) as client:
        payload_obj = build_drift_payload(
            client=client,
            meta_dir=meta_dir,
            snapshot=snapshot,
            database=config.clickhouse.database if config.clickhouse else None,
            fail_on_extra_objects=config.check.fail_on_extra_objects,
            scope=table_scope if table_scope.enabled else None,
        )

    payload_dict: dict[str, object] = {
        "scope": scope_to_payload(table_scope),
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
        emit_json("drift", payload_dict)
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
    view_drift = [
        d for d in payload_obj.object_drift if d.code in ("query_mismatch", "target_mismatch")
    ]
    if view_drift:
        typer.echo("")
        typer.echo("View drift:")
        for d in view_drift:
            typer.echo(f"- {d.code} {d.object}")
            typer.echo(f"  expected={d.expected or ''}")
            typer.echo(f"  actual={d.actual or ''}")
    if payload_obj.table_drift:
        typer.echo("")
        typer.echo("Table shape drift:")
        for detail in payload_obj.table_drift:
            typer.echo(f"- {detail.table}: {', '.join(detail.reason_codes)}")
