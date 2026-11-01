"""`chkit drift` — compare the snapshot against the current schema or live DB.

The default inspects local schema changes; ``--live`` compares the snapshot
against ClickHouse, matching the TypeScript command's default behavior.

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

import os
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
from chkit.cli.commands.drift_compare import ObjectDriftDetail, TableDriftDetail
from chkit.cli.commands.drift_payload import build_drift_payload
from chkit.cli.commands.snapshot_drift import plan_snapshot_drift
from chkit.cli.config_loader import load_config
from chkit.cli.json_output import emit_json, emit_json_error
from chkit.cli.migration_store import read_snapshot
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.schema_loader import load_schema
from chkit.cli.shared_engine_flags import ForceSharedEnginesOption, NoSharedEnginesOption
from chkit.cli.table_scope import (
    TableScope,
    resolve_table_scope,
    table_keys_from_definitions,
)
from chkit.core.canonical import canonicalize_definitions
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
    live: Annotated[
        bool,
        typer.Option(
            "--live",
            help=(
                "Compare snapshot against live ClickHouse instead of the local "
                "schema. Requires a clickhouse block in the config or a selected "
                "ObsessionDB service."
            ),
        ),
    ] = False,
    # Accepted so existing scripts keep working; only generate and snapshot
    # rebuild run the on_schema_loaded hooks that read them (as in TS).
    force_shared_engines: ForceSharedEnginesOption = False,  # noqa: ARG001
    no_shared_engines: NoSharedEnginesOption = False,  # noqa: ARG001
    service: ServiceOption = None,
) -> None:
    config = load_config(config_path, ChxConfigEnv(command="drift"))
    # Absolute, as TS resolves it, so ``snapshotFile`` reads the same in both CLIs.
    meta_dir = Path(os.path.abspath(config.meta_dir))
    snapshot = read_snapshot(meta_dir)
    if snapshot is None:
        msg = "Snapshot not found. Run `chkit generate` before drift checks."
        if output_json:
            emit_json_error("drift", {"code": "error", "message": msg})
        typer.echo(msg, err=True)
        raise typer.Exit(code=1)

    schema_defs = canonicalize_definitions(load_schema(config.schema_))
    snapshot_defs = list(snapshot.definitions)
    available_keys = sorted(
        set(table_keys_from_definitions(snapshot_defs))
        | set(table_keys_from_definitions(schema_defs))
    )
    table_scope = resolve_table_scope(table_selector, available_keys)

    if live:
        if table_scope.enabled and table_scope.match_count == 0:
            warning = f'No tables matched selector "{table_scope.selector or ""}".'
            if output_json:
                emit_json("drift", {
                    "scope": _scope_json(table_scope),
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
                })
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
                "ObsessionDB service for --live drift."
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
            "scope": _scope_json(table_scope),
            "snapshotFile": payload_obj.snapshot_file,
            "expectedCount": payload_obj.expected_count,
            "actualCount": payload_obj.actual_count,
            "drifted": payload_obj.drifted,
        }
        if payload_obj.database_missing:
            payload_dict["databaseMissing"] = True
            if payload_obj.database is not None:
                payload_dict["database"] = payload_obj.database
        payload_dict.update({
            "missing": payload_obj.missing,
            "extra": payload_obj.extra,
            "kindMismatches": [asdict(m) for m in payload_obj.kind_mismatches],
            "objectDrift": [_object_drift_json(d) for d in payload_obj.object_drift],
            "tableDrift": [_table_drift_json(d) for d in payload_obj.table_drift],
        })
        if output_json:
            emit_json("drift", payload_dict)
            return
        if payload_obj.database_missing:
            typer.echo(
                f'⚠ Database "{payload_obj.database or ""}" does not exist on the target server.'
            )
            typer.echo("  It will be created when you run: chkit migrate --apply\n")
        typer.echo(f"Expected objects: {payload_obj.expected_count}")
        typer.echo(f"Actual objects:   {payload_obj.actual_count}")
        typer.echo(f"Drifted:          {'yes' if payload_obj.drifted else 'no'}")
        if table_scope.enabled:
            typer.echo(
                f"Table scope:      {table_scope.selector or ''} "
                f"({table_scope.match_count} matched)"
            )
            for matched in table_scope.matched_tables:
                typer.echo(f"- {matched}")
        if payload_obj.missing:
            typer.echo("")
            typer.echo("Missing objects:")
            for item in payload_obj.missing:
                typer.echo(f"- {item}")
        if payload_obj.extra:
            typer.echo("")
            typer.echo("Unexpected objects:")
            for item in payload_obj.extra:
                typer.echo(f"- {item}")
        if payload_obj.kind_mismatches:
            typer.echo("")
            typer.echo("Kind mismatches:")
            for m in payload_obj.kind_mismatches:
                typer.echo(f"- {m.object}: expected={m.expected} actual={m.actual}")
        if payload_obj.object_drift:
            typer.echo("")
            typer.echo("Object drift reasons:")
            for d in payload_obj.object_drift:
                if d.code == "kind_mismatch":
                    typer.echo(
                        f"- {d.code} {d.object}: expected={d.expected_kind or ''} "
                        f"actual={d.actual_kind or ''}"
                    )
                    continue
                typer.echo(f"- {d.code} {d.object}")
                if d.code in ("query_mismatch", "target_mismatch"):
                    typer.echo(f"  expected={d.expected or ''}")
                    typer.echo(f"  actual={d.actual or ''}")
        if payload_obj.table_drift:
            typer.echo("")
            typer.echo("Table shape drift:")
            for detail in payload_obj.table_drift:
                _echo_table_drift(detail)
        return

    plan, issues = plan_snapshot_drift(snapshot_defs, schema_defs, table_scope)
    drifted = bool(plan.operations or issues)
    snapshot_file = meta_dir / "snapshot.json"

    payload = {
        "snapshotFile": str(snapshot_file),
        "drifted": drifted,
        "operations": [op.model_dump(by_alias=True) for op in plan.operations],
        "renameSuggestions": [s.model_dump(by_alias=True) for s in plan.rename_suggestions],
    }
    if issues:
        payload["issues"] = [issue.model_dump(mode="json") for issue in issues]

    if output_json:
        emit_json("drift", payload)
        return

    typer.echo(f"Snapshot file:       {snapshot_file}")
    typer.echo(f"Expected operations: {len(plan.operations)}")
    typer.echo(f"Drifted:             {'yes' if drifted else 'no'}")
    for issue in issues:
        typer.echo(f"- [{issue.code}] {issue.message}")
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


def _scope_json(scope: TableScope) -> dict[str, object]:
    """The TS ``TableScope`` shape and key order."""
    payload: dict[str, object] = {"enabled": scope.enabled}
    if scope.selector is not None:
        payload["selector"] = scope.selector
    payload["matchedTables"] = list(scope.matched_tables)
    payload["matchCount"] = scope.match_count
    return payload


def _object_drift_json(detail: ObjectDriftDetail) -> dict[str, object]:
    """camelCase keys; unset fields are left out, as TS does, not written as null."""
    fields: dict[str, object] = {
        "code": detail.code,
        "object": detail.object,
        "expectedKind": detail.expected_kind,
        "actualKind": detail.actual_kind,
        "expected": detail.expected,
        "actual": detail.actual,
    }
    return {key: value for key, value in fields.items() if value is not None}


def _table_drift_json(detail: TableDriftDetail) -> dict[str, object]:
    """camelCase keys in the TS ``TableDriftDetail`` order."""
    return {
        "table": detail.table,
        "reasonCodes": detail.reason_codes,
        "missingColumns": detail.missing_columns,
        "extraColumns": detail.extra_columns,
        "changedColumns": detail.changed_columns,
        "settingDiffs": detail.setting_diffs,
        "indexDiffs": detail.index_diffs,
        "ttlMismatch": detail.ttl_mismatch,
        "engineMismatch": detail.engine_mismatch,
        "primaryKeyMismatch": detail.primary_key_mismatch,
        "orderByMismatch": detail.order_by_mismatch,
        "uniqueKeyMismatch": detail.unique_key_mismatch,
        "partitionByMismatch": detail.partition_by_mismatch,
        "projectionDiffs": detail.projection_diffs,
        "constraintDiffs": detail.constraint_diffs,
    }


def _echo_table_drift(detail: TableDriftDetail) -> None:
    typer.echo(f"- {detail.table}")
    lists = {
        "missingColumns": detail.missing_columns,
        "extraColumns": detail.extra_columns,
        "changedColumns": detail.changed_columns,
        "settingDiffs": detail.setting_diffs,
        "indexDiffs": detail.index_diffs,
    }
    for name, values in lists.items():
        if values:
            typer.echo(f"  {name}={','.join(values)}")
    flags = {
        "ttlMismatch": detail.ttl_mismatch,
        "engineMismatch": detail.engine_mismatch,
        "primaryKeyMismatch": detail.primary_key_mismatch,
        "orderByMismatch": detail.order_by_mismatch,
        "uniqueKeyMismatch": detail.unique_key_mismatch,
        "partitionByMismatch": detail.partition_by_mismatch,
    }
    for name, flag in flags.items():
        if flag:
            typer.echo(f"  {name}=true")
    if detail.projection_diffs:
        typer.echo(f"  projectionDiffs={','.join(detail.projection_diffs)}")
    if detail.constraint_diffs:
        typer.echo(f"  constraintDiffs={','.join(detail.constraint_diffs)}")
    typer.echo(f"  reasonCodes={','.join(detail.reason_codes)}")
