"""`chkit check` — policy gate for CI / release pipelines.

Mirrors the TS ``checkCommand`` policy contract:

- ``--strict`` enables all policy checks (``failOnPending``, ``failOnChecksumMismatch``,
  ``failOnDrift``) regardless of config.
- Returns exit code 1 when any failing policy fires.

The Python version evaluates ``failOnDrift`` against the local snapshot vs.
current schema (i.e. snapshot drift), matching the pre-plan check used in CI.
The live-DB drift comparison from the TS port lives in ``chkit drift``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.commands.drift_compare import summarize_drift_reasons
from chkit.cli.commands.drift_payload import build_drift_payload
from chkit.cli.commands.migrate_scope import filter_pending_by_scope
from chkit.cli.config_loader import load_config
from chkit.cli.journal_store import JournalStore
from chkit.cli.migration_store import (
    find_checksum_mismatches,
    list_migration_filenames,
    read_snapshot,
)
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.schema_loader import load_schema
from chkit.cli.table_scope import (
    filter_plan_by_table_scope,
    resolve_table_scope,
    table_keys_from_definitions,
)
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.canonical import canonicalize_definitions
from chkit.core.planner import plan_diff
from chkit.core.validate import validate_definitions
from chkit.plugins import ChxOnCheckContext, ChxPlugin


def run(  # noqa: PLR0912, PLR0915
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    strict: Annotated[
        bool,
        typer.Option("--strict", help="Enable all policy checks."),
    ] = False,
    live: Annotated[
        bool,
        typer.Option(
            "--live",
            help=(
                "Evaluate failOnDrift against the live ClickHouse database instead of "
                "the on-disk snapshot. Mirrors the TS default behaviour."
            ),
        ),
    ] = False,
    output_json: Annotated[
        bool, typer.Option("--json", help="Emit a JSON-formatted summary.")
    ] = False,
    table_selector: Annotated[
        str | None,
        typer.Option(
            "--table",
            "-t",
            help=(
                "Scope policy checks to migrations / drift touching the matched tables."
            ),
        ),
    ] = None,
) -> None:
    config = load_config(config_path)
    plugin_runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )
    if config.clickhouse is None:
        msg = (
            "clickhouse.config.py must include a `clickhouse` block "
            "(journal lives in ClickHouse)."
        )
        raise typer.BadParameter(msg)

    migrations_dir = Path(config.migrations_dir)
    meta_dir = Path(config.meta_dir)
    migrations_dir.mkdir(parents=True, exist_ok=True)

    schema_defs = canonicalize_definitions(load_schema(config.schema_))
    issues = [i.model_dump(mode="json") for i in validate_definitions(schema_defs)]
    files = list_migration_filenames(migrations_dir)
    snapshot = read_snapshot(meta_dir)
    snapshot_defs = list(snapshot.definitions) if snapshot is not None else []

    available_keys = sorted(
        set(table_keys_from_definitions(snapshot_defs))
        | set(table_keys_from_definitions(schema_defs))
    )
    table_scope = resolve_table_scope(table_selector, available_keys)

    drift_ops: list[str] = []
    drift_reason_counts: dict[str, int] = {}
    if snapshot is not None:
        plan = plan_diff(snapshot_defs, schema_defs)
        if table_scope.enabled:
            filtered = filter_plan_by_table_scope(
                plan, set(table_scope.matched_tables)
            )
            plan = filtered.plan
        drift_ops = [op.key for op in plan.operations]

    live_drifted = False
    with ClickHouseClient.connect(config.clickhouse) as client:
        store = JournalStore(
            client, cluster=config.clickhouse.cluster if config.clickhouse else None
        )
        journal = store.read_journal(project_files=files)
        applied_names = {entry.name for entry in journal.applied}
        pending_all = [f for f in files if f not in applied_names]
        mismatches = find_checksum_mismatches(migrations_dir, journal)
        if live and snapshot is not None:
            payload = build_drift_payload(
                client=client,
                meta_dir=meta_dir,
                snapshot=snapshot,
                database=config.clickhouse.database,
                fail_on_extra_objects=False,
                scope=table_scope if table_scope.enabled else None,
            )
            live_drifted = payload.drifted
            reasons_summary = summarize_drift_reasons(
                payload.object_drift, payload.table_drift
            )
            drift_reason_counts = dict(reasons_summary.counts.items())

    if table_scope.enabled:
        pending = filter_pending_by_scope(
            migrations_dir, pending_all, set(table_scope.matched_tables)
        ).in_scope
    else:
        pending = pending_all

    fail_on_pending = True if strict else config.check.fail_on_pending
    fail_on_mismatch = True if strict else config.check.fail_on_checksum_mismatch
    fail_on_drift = True if strict else config.check.fail_on_drift

    failed_checks: list[str] = []
    if issues:
        failed_checks.append("validation")
    if fail_on_pending and pending:
        failed_checks.append("pending_migrations")
    if fail_on_mismatch and mismatches:
        failed_checks.append("checksum_mismatch")
    drift_fired = (
        bool(drift_ops) if not live else live_drifted or bool(drift_ops)
    )
    if fail_on_drift and drift_fired:
        # Match the TS finding code: ``schema_drift`` (was ``drift``).
        failed_checks.append("schema_drift")

    # Plugin-driven findings (e.g. codegen, backfill).
    plugin_results = plugin_runtime.run_on_check(
        ChxOnCheckContext(
            command="check",
            config=config,
            table_scope=table_scope,
            flags={},
            config_path=str(config_path or "clickhouse.config.py"),
            json_mode=output_json,
            options={},
        )
    )
    failed_checks.extend(
        f"plugin:{result.plugin}" for result in plugin_results if not result.ok
    )
    ok = not failed_checks

    # TS envelope: top-level ``policy`` + ``driftEvaluated`` + scope + plugins map.
    policy_payload: dict[str, bool] = {
        "failOnPending": fail_on_pending,
        "failOnChecksumMismatch": fail_on_mismatch,
        "failOnDrift": fail_on_drift,
    }
    scope_payload: dict[str, object] = {
        "enabled": table_scope.enabled,
        "matchedTables": list(table_scope.matched_tables),
        "matchCount": table_scope.match_count,
    }
    if table_scope.selector is not None:
        scope_payload["selector"] = table_scope.selector

    summary: dict[str, object] = {
        "strict": strict,
        "policy": policy_payload,
        "ok": ok,
        "failedChecks": failed_checks,
        "issues": issues,
        "pendingCount": len(pending),
        "pendingMigrations": pending,
        "checksumMismatchCount": len(mismatches),
        "checksumMismatches": [m.model_dump() for m in mismatches],
        "drifted": drift_fired,
        # TS exposes ``driftEvaluated`` so callers can distinguish "no snapshot
        # → drift unchecked" from "snapshot present → drift evaluated, none".
        "driftEvaluated": snapshot is not None,
        "driftOperations": drift_ops,
        "scope": scope_payload,
    }
    if live:
        summary["liveDrifted"] = live_drifted
        summary["driftReasonCounts"] = drift_reason_counts
        # Match TS shape: object with ``total`` / ``object`` / ``table`` keys
        # rather than a single integer sum.
        summary["driftReasonTotals"] = {
            "total": sum(drift_reason_counts.values()),
            "object": drift_reason_counts.get("object", 0),
            "table": drift_reason_counts.get("table", 0),
        }
    if plugin_results:
        # TS uses a ``plugins`` object map keyed by plugin name (the older
        # Python ``pluginCheckResults`` array is kept for back-compat).
        summary["plugins"] = {
            r.plugin: {
                "evaluated": r.evaluated,
                "ok": r.ok,
                "findingCodes": [f.code for f in r.findings],
                **(r.metadata or {}),
            }
            for r in plugin_results
        }
        summary["pluginCheckResults"] = [
            {
                "plugin": r.plugin,
                "evaluated": r.evaluated,
                "ok": r.ok,
                "findings": [
                    {"code": f.code, "message": f.message, "severity": f.severity}
                    for f in r.findings
                ],
            }
            for r in plugin_results
        ]

    if output_json:
        typer.echo(json.dumps(summary, indent=2))
    else:
        typer.echo(f"Validation issues:    {len(issues)}")
        typer.echo(f"Pending migrations:   {len(pending)}")
        typer.echo(f"Checksum mismatches:  {len(mismatches)}")
        typer.echo(f"Drift operations:     {len(drift_ops)}")
        if failed_checks:
            typer.echo("")
            typer.echo(f"Failed checks: {', '.join(failed_checks)}")
    if not ok:
        raise typer.Exit(code=1)
