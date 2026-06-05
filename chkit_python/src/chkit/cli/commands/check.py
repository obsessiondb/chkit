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

from chkit.cli.config_loader import load_config
from chkit.cli.journal_store import JournalStore
from chkit.cli.migration_store import (
    find_checksum_mismatches,
    list_migration_filenames,
    read_snapshot,
)
from chkit.cli.schema_loader import load_schema
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.canonical import canonicalize_definitions
from chkit.core.planner import plan_diff
from chkit.core.validate import validate_definitions


def run(
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    strict: Annotated[
        bool,
        typer.Option("--strict", help="Enable all policy checks."),
    ] = False,
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
    meta_dir = Path(config.meta_dir)
    migrations_dir.mkdir(parents=True, exist_ok=True)

    schema_defs = canonicalize_definitions(load_schema(config.schema_))
    issues = [i.model_dump(mode="json") for i in validate_definitions(schema_defs)]
    files = list_migration_filenames(migrations_dir)
    snapshot = read_snapshot(meta_dir)
    drift_ops: list[str] = []
    if snapshot is not None:
        plan = plan_diff(list(snapshot.definitions), schema_defs)
        drift_ops = [op.key for op in plan.operations]

    with ClickHouseClient.connect(config.clickhouse) as client:
        store = JournalStore(client)
        journal = store.read_journal()
        applied_names = {entry.name for entry in journal.applied}
        pending = [f for f in files if f not in applied_names]
        mismatches = find_checksum_mismatches(migrations_dir, journal)

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
    if fail_on_drift and drift_ops:
        failed_checks.append("drift")
    ok = not failed_checks

    summary = {
        "strict": strict,
        "ok": ok,
        "failedChecks": failed_checks,
        "issues": issues,
        "pendingCount": len(pending),
        "pendingMigrations": pending,
        "checksumMismatchCount": len(mismatches),
        "checksumMismatches": [m.model_dump() for m in mismatches],
        "drifted": bool(drift_ops),
        "driftOperations": drift_ops,
    }

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
