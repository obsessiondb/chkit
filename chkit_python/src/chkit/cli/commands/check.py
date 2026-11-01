"""`chkit check` — policy gate for CI / release pipelines.

Mirrors the TS ``checkCommand`` policy contract:

- ``--strict`` enables all policy checks (``failOnPending``, ``failOnChecksumMismatch``,
  ``failOnDrift``) regardless of config.
- Returns exit code 1 when any failing policy fires.

As in TS, ``failOnDrift`` is evaluated against the live database: the drift
payload of ``chkit drift`` (snapshot vs. ClickHouse). Without a snapshot, drift
is not evaluated. ``--live`` is accepted for scripts written when it was
required.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.command_target import (
    ServiceOption,
    exit_no_target,
    open_client,
    resolve_plugin_executor,
)
from chkit.cli.commands.drift_compare import summarize_drift_reasons
from chkit.cli.commands.drift_payload import build_drift_payload
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
from chkit.cli.schema_loader import load_schema
from chkit.cli.shared_engine_flags import ForceSharedEnginesOption, NoSharedEnginesOption
from chkit.cli.table_scope import (
    TableScope,
    resolve_table_scope,
    scope_to_payload,
    table_keys_from_definitions,
)
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ChxConfigEnv
from chkit.core.validate import validate_definitions
from chkit.plugins import ChxOnCheckContext, ChxPlugin


def run(  # noqa: PLR0912, PLR0915, PLR0917
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    strict: Annotated[
        bool,
        typer.Option("--strict", help="Enable all policy checks."),
    ] = False,
    live: Annotated[  # noqa: ARG001
        bool,
        typer.Option(
            "--live",
            help="No-op, kept for existing scripts: check always reads the live server.",
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
    # Accepted so existing scripts keep working; only generate and snapshot
    # rebuild run the on_schema_loaded hooks that read them (as in TS).
    force_shared_engines: ForceSharedEnginesOption = False,  # noqa: ARG001
    no_shared_engines: NoSharedEnginesOption = False,  # noqa: ARG001
    service: ServiceOption = None,
) -> None:
    config = load_config(config_path, ChxConfigEnv(command="check"))
    plugin_runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )
    resolved_config_path = str(config_path or "clickhouse.config.py")
    executor = resolve_plugin_executor(
        plugin_runtime,
        config,
        command="check",
        config_path=resolved_config_path,
        json_mode=output_json,
        service=service,
    )
    if executor is None and config.clickhouse is None:
        msg = (
            "clickhouse.config.py must include a `clickhouse` block or select an "
            "ObsessionDB service (journal lives in ClickHouse)."
        )
        exit_no_target("check", msg, json_mode=output_json)

    migrations_dir = Path(config.migrations_dir)
    meta_dir = Path(config.meta_dir)
    migrations_dir.mkdir(parents=True, exist_ok=True)

    schema_defs = canonicalize_definitions(load_schema(config.schema_))
    issues = [i.model_dump(mode="json") for i in validate_definitions(schema_defs)]
    files = list_migration_filenames(migrations_dir)
    snapshot = read_snapshot(meta_dir)
    table_scope = resolve_table_scope(
        table_selector,
        table_keys_from_definitions(snapshot.definitions if snapshot is not None else []),
    )

    drifted = False
    drift_reasons = summarize_drift_reasons([], [])
    with open_client(executor, config.clickhouse) as client:
        store = JournalStore(
            client, cluster=config.clickhouse.cluster if config.clickhouse else None
        )
        journal = store.read_journal(project_files=files)
        database_missing = store.database_missing
        applied_names = {entry.name for entry in journal.applied}
        pending_all = [f for f in files if f not in applied_names]
        mismatches = find_checksum_mismatches(migrations_dir, journal)
        if table_scope.enabled and table_scope.match_count == 0:
            _emit_scope_no_op(strict, table_scope, output_json=output_json)
            return
        if snapshot is not None:
            payload = build_drift_payload(
                client=client,
                meta_dir=meta_dir,
                snapshot=snapshot,
                database=config.clickhouse.database if config.clickhouse else None,
                fail_on_extra_objects=config.check.fail_on_extra_objects,
                scope=table_scope if table_scope.enabled else None,
            )
            drifted = payload.drifted
            drift_reasons = summarize_drift_reasons(payload.object_drift, payload.table_drift)

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
    if fail_on_drift and drifted:
        # Match the TS finding code: ``schema_drift`` (was ``drift``).
        failed_checks.append("schema_drift")

    # Plugin-driven findings (e.g. codegen, backfill).
    plugin_results = plugin_runtime.run_on_check(
        ChxOnCheckContext(
            command="check",
            config=config,
            table_scope=table_scope,
            flags={},
            config_path=resolved_config_path,
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
        "drifted": drifted,
        # TS exposes ``driftEvaluated`` so callers can distinguish "no snapshot
        # → drift unchecked" from "snapshot present → drift evaluated, none".
        "driftEvaluated": snapshot is not None,
        "driftReasonCounts": dict(drift_reasons.counts),
        "driftReasonTotals": {
            "total": drift_reasons.total,
            "object": drift_reasons.object,
            "table": drift_reasons.table,
        },
        "scope": scope_to_payload(table_scope),
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
    database = config.clickhouse.database if config.clickhouse else None
    if database_missing:
        summary["databaseMissing"] = True
        summary["database"] = database

    if output_json:
        emit_json("check", summary)
    else:
        if database_missing:
            typer.echo(
                f'⚠ Database "{database or ""}" '
                f"does not exist on the target server."
            )
            typer.echo("  It will be created when you run: chkit migrate --apply\n")
        typer.echo(f"Validation issues:    {len(issues)}")
        typer.echo(f"Pending migrations:   {len(pending)}")
        typer.echo(f"Checksum mismatches:  {len(mismatches)}")
        if snapshot is None:
            typer.echo("Schema drift: not evaluated (missing snapshot or clickhouse config)")
        else:
            typer.echo(f"Schema drift: {'yes' if drifted else 'no'}")
            typer.echo(
                f"Drift reasons: total={drift_reasons.total}, "
                f"object={drift_reasons.object}, table={drift_reasons.table}"
            )
        if failed_checks:
            typer.echo("")
            typer.echo(f"Failed checks: {', '.join(failed_checks)}")
    if not ok:
        raise typer.Exit(code=1)


def _emit_scope_no_op(strict: bool, table_scope: TableScope, *, output_json: bool) -> None:
    """TS: a ``--table`` selector that matches no snapshot table makes check a no-op."""
    warning = f'No tables matched selector "{table_scope.selector or ""}".'
    if not output_json:
        typer.echo(f"{warning} Check is a no-op.")
        return
    emit_json(
        "check",
        {
            "strict": strict,
            "ok": True,
            "failedChecks": [],
            "pendingCount": 0,
            "checksumMismatchCount": 0,
            "drifted": False,
            "driftEvaluated": False,
            "driftReasonCounts": {},
            "driftReasonTotals": {"total": 0, "object": 0, "table": 0},
            "plugins": {},
            "scope": scope_to_payload(table_scope),
            "warning": warning,
        },
    )
