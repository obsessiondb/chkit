"""`chkit generate` — diff current schema vs. last snapshot and emit a migration.

Flag set matches the TypeScript ``generateCommand``:

- ``--name``           Migration name (sanitized via ``safe_name``; default "auto").
- ``--migration-id``   Override the timestamp prefix in the migration filename.
- ``--rename-table``   Explicit table rename (``old_db.old_t=new_db.new_t``); repeatable.
- ``--rename-column``  Explicit column rename (``db.t.old=new``); repeatable.
- ``--dryrun``         Print the plan without writing artifacts.
- ``--json``           Emit a JSON-formatted summary instead of human text.
- ``--config``         Path to the config file (default ``clickhouse.config.py``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from chkit import __version__
from chkit.cli.commands.dictionary_password_warnings import (
    detect_dictionary_password_warnings,
)
from chkit.cli.commands.generate_plan_pipeline import (
    apply_explicit_dictionary_renames,
    apply_explicit_table_renames,
    apply_selected_rename_suggestions,
    assert_cli_column_mappings_resolvable,
    build_explicit_column_rename_suggestions,
)
from chkit.cli.commands.generate_rename_mappings import (
    ColumnRenameMapping,
    DictionaryRenameMapping,
    TableRenameMapping,
    assert_cli_dictionary_mappings_resolvable,
    assert_cli_table_mappings_resolvable,
    assert_no_conflicting_column_mappings,
    assert_no_conflicting_dictionary_mappings,
    assert_no_conflicting_table_mappings,
    collect_schema_rename_mappings,
    merge_column_mappings,
    merge_dictionary_mappings,
    merge_table_mappings,
    parse_rename_column_mappings,
    parse_rename_dictionary_mappings,
    parse_rename_table_mappings,
    remap_old_definitions_for_dictionary_renames,
    remap_old_definitions_for_table_renames,
    resolve_active_dictionary_mappings,
    resolve_active_table_mappings,
)
from chkit.cli.config_loader import load_config
from chkit.cli.migration_store import (
    read_snapshot,
    write_migration,
    write_snapshot,
)
from chkit.cli.plugin_runtime import PluginRuntime, load_plugin_runtime
from chkit.cli.schema_loader import load_schema
from chkit.cli.table_scope import (
    TableScope,
    build_scoped_snapshot_definitions,
    filter_plan_by_table_scope,
    resolve_table_scope,
    table_keys_from_definitions,
)
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ChxConfigEnv, ChxResolvedConfig, ChxValidationError, SchemaDefinition
from chkit.core.on_cluster import apply_on_cluster_to_plan
from chkit.core.planner import plan_diff
from chkit.core.snapshot import create_snapshot
from chkit.core.validate import validate_definitions
from chkit.plugins import (
    ChxOnConfigLoadedContext,
    ChxOnPlanCreatedContext,
    ChxOnSchemaLoadedContext,
    ChxPlugin,
    ChxPluginCommandContext,
    PluginContext,
)


def _run_codegen_integration(
    *,
    plugin_runtime: PluginRuntime,
    config: ChxResolvedConfig,
    config_path: str,
    table_scope: TableScope,
    output_json: bool,
) -> None:
    """Auto-invoke the codegen plugin (if registered + run_on_generate not disabled).

    Mirrors the TS ``generate/command.ts`` integration: looks up the ``codegen``
    plugin, checks its ``run_on_generate`` option, and if both are positive
    dispatches its ``codegen`` command with no flags. Failures bubble up as
    ``typer.Exit(1)``.
    """
    codegen_entry = next(
        (e for e in plugin_runtime.plugins if e.plugin.manifest.name == "codegen"),
        None,
    )
    if codegen_entry is None:
        return
    # Read from the hook's captured options first (where the codegen() factory
    # parked them), falling back to the LoadedPlugin's options dict for runtimes
    # that DO thread factory options through.
    hook_options = getattr(codegen_entry.plugin.hooks, "options", None)
    factory_options: dict[str, object] = {}
    if hook_options is not None and hasattr(hook_options, "model_dump"):
        factory_options = hook_options.model_dump(exclude_none=True, by_alias=False)
    merged_options: dict[str, object] = {**factory_options, **codegen_entry.options}
    raw_run_on_generate = merged_options.get(
        "run_on_generate", merged_options.get("runOnGenerate")
    )
    if raw_run_on_generate is False:
        return
    ctx = ChxPluginCommandContext(
        plugin_name="codegen",
        config=config,
        config_path=config_path,
        json_mode=output_json,
        args=[],
        flags={},
        options=dict(codegen_entry.options),
        raw_options=dict(codegen_entry.raw_options),
        table_scope=table_scope,
        print=lambda _v: None,
        plugin_runtime=plugin_runtime,
        plugin_context=PluginContext(executor=None, has_executor=False),
    )
    exit_code = plugin_runtime.run_plugin_command("codegen", "codegen", ctx)
    if exit_code != 0:
        msg = (
            f'Plugin "codegen" failed in generate integration with exit '
            f"code {exit_code}."
        )
        raise typer.Exit(code=1) from RuntimeError(msg)


def _scope_to_payload(scope: TableScope) -> dict[str, object]:
    payload: dict[str, object] = {
        "enabled": scope.enabled,
        "matchedTables": list(scope.matched_tables),
        "matchCount": scope.match_count,
    }
    if scope.selector is not None:
        payload["selector"] = scope.selector
    return payload


def _apply_rename_mappings(
    *,
    old_defs: list[SchemaDefinition],
    canonical: list[SchemaDefinition],
    rename_table: list[str] | None,
    rename_column: list[str] | None,
    rename_dictionary: list[str] | None,
) -> tuple[
    list[SchemaDefinition],
    list[TableRenameMapping],
    list[ColumnRenameMapping],
    list[ColumnRenameMapping],
    list[DictionaryRenameMapping],
]:
    """Parse rename flags, reconcile with schema metadata.

    Returns:
        (remapped_old_defs, active_table_mappings, cli_column_mappings,
        column_mappings, active_dictionary_mappings)
    """
    cli_table_mappings = parse_rename_table_mappings(rename_table or [])
    cli_column_mappings = parse_rename_column_mappings(rename_column or [])
    cli_dictionary_mappings = parse_rename_dictionary_mappings(rename_dictionary or [])
    schema_mappings = collect_schema_rename_mappings(canonical)
    table_mappings = merge_table_mappings(
        schema_mappings.table_mappings, cli_table_mappings
    )
    column_mappings = merge_column_mappings(
        schema_mappings.column_mappings, cli_column_mappings
    )
    dictionary_mappings = merge_dictionary_mappings(
        schema_mappings.dictionary_mappings, cli_dictionary_mappings
    )

    assert_no_conflicting_table_mappings(table_mappings)
    assert_no_conflicting_column_mappings(column_mappings)
    assert_no_conflicting_dictionary_mappings(dictionary_mappings)
    assert_cli_table_mappings_resolvable(cli_table_mappings, old_defs, canonical)
    assert_cli_dictionary_mappings_resolvable(
        cli_dictionary_mappings, old_defs, canonical
    )

    active_table_mappings = resolve_active_table_mappings(
        old_defs, canonical, table_mappings
    )
    active_dictionary_mappings = resolve_active_dictionary_mappings(
        old_defs, canonical, dictionary_mappings
    )
    remapped_old_defs = remap_old_definitions_for_dictionary_renames(
        remap_old_definitions_for_table_renames(old_defs, active_table_mappings),
        active_dictionary_mappings,
    )
    return (
        remapped_old_defs,
        active_table_mappings,
        cli_column_mappings,
        column_mappings,
        active_dictionary_mappings,
    )


def run(  # noqa: PLR0911, PLR0912, PLR0915, PLR0917
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
    table_selector: Annotated[
        str | None,
        typer.Option(
            "--table",
            "-t",
            help=(
                "Restrict migration to a single table or trailing-wildcard prefix. "
                "Examples: events, events_*, analytics.events."
            ),
        ),
    ] = None,
    rename_table: Annotated[
        list[str] | None,
        typer.Option(
            "--rename-table",
            help=(
                "Explicit table rename mapping old_db.old_table=new_db.new_table. "
                "Repeatable."
            ),
        ),
    ] = None,
    rename_column: Annotated[
        list[str] | None,
        typer.Option(
            "--rename-column",
            help=(
                "Explicit column rename mapping db.table.old_column=new_column. "
                "Repeatable."
            ),
        ),
    ] = None,
    rename_dictionary: Annotated[
        list[str] | None,
        typer.Option(
            "--rename-dictionary",
            help=(
                "Explicit dictionary rename mapping old_db.old_dict=new_db.new_dict. "
                "Repeatable."
            ),
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
    config = load_config(config_path, ChxConfigEnv(command="generate"))
    plugin_runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )
    plugin_runtime.run_on_config_loaded(
        ChxOnConfigLoadedContext(
            command="generate",
            config=config,
            table_scope=TableScope(enabled=False),
            flags={},
            config_path=str(config_path or "clickhouse.config.py"),
            options={},
        )
    )

    schema_globs = config.schema_
    definitions = load_schema(schema_globs)
    canonical = canonicalize_definitions(definitions)

    # Allow plugins to mutate the definitions in-place.
    threaded_defs = plugin_runtime.run_on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            config=config,
            table_scope=TableScope(enabled=False),
            flags={},
            definitions=list(canonical),
            json_mode=output_json,
        )
    )
    canonical = canonicalize_definitions(list(threaded_defs))

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

    (
        remapped_old_defs,
        active_table_mappings,
        cli_column_mappings,
        column_mappings,
        active_dictionary_mappings,
    ) = _apply_rename_mappings(
        old_defs=old_defs,
        canonical=canonical,
        rename_table=rename_table,
        rename_column=rename_column,
        rename_dictionary=rename_dictionary,
    )

    available_keys = sorted(
        set(table_keys_from_definitions(old_defs))
        | set(table_keys_from_definitions(canonical))
    )
    table_scope = resolve_table_scope(table_selector, available_keys)
    if table_scope.enabled and table_scope.match_count == 0:
        warning = (
            f'No tables matched selector "{table_scope.selector or ""}". No changes planned.'
        )
        if output_json:
            typer.echo(
                json.dumps(
                    {
                        "scope": _scope_to_payload(table_scope),
                        "mode": "plan" if dryrun else "apply",
                        "operationCount": 0,
                        "riskSummary": {"safe": 0, "caution": 0, "danger": 0},
                        "operations": [],
                        "renameSuggestions": [],
                        "warning": warning,
                    },
                    indent=2,
                )
            )
        else:
            typer.echo(warning)
        return

    # Mirror TS ``generate.command``: surface validation failures as a
    # structured JSON envelope rather than letting them escape as a stack
    # trace. ``plan_diff`` itself may raise a ChxValidationError if the
    # post-rename canonical state still has invariant violations.
    try:
        plan = plan_diff(remapped_old_defs, canonical)
        plan = apply_explicit_table_renames(plan, active_table_mappings)
        plan = apply_explicit_dictionary_renames(plan, active_dictionary_mappings)
        assert_cli_column_mappings_resolvable(cli_column_mappings, plan, canonical)
        plan = apply_selected_rename_suggestions(
            plan,
            build_explicit_column_rename_suggestions(plan, column_mappings),
        )
    except ChxValidationError as error:
        if output_json:
            typer.echo(
                json.dumps(
                    {
                        "error": "validation_failed",
                        "issues": [i.model_dump(mode="json") for i in error.issues],
                    },
                    indent=2,
                )
            )
            raise typer.Exit(code=1) from error
        raise

    if table_scope.enabled:
        # TableRenameMapping is structurally compatible with table_scope's
        # internal _RenameMapping Protocol but mypy can't infer that without help.
        filtered = filter_plan_by_table_scope(
            plan,
            set(table_scope.matched_tables),
            rename_mappings=active_table_mappings,  # type: ignore[arg-type]
        )
        plan = filtered.plan

    # Plugins may rewrite the plan (e.g. inject pre/post statements).
    plan = plugin_runtime.run_on_plan_created(
        ChxOnPlanCreatedContext(
            command="generate",
            config=config,
            table_scope=table_scope,
            flags={},
            plan=plan,
        )
    )

    # Cluster mode: stamp ``ON CLUSTER <name>`` onto every DDL statement as a
    # final post-pass, after all plan transforms (renames, plugins, scope
    # filtering) — so plugin-injected SQL is also covered. ``migrate`` never
    # re-runs this: the clause is baked into the migration file at generate
    # time and applied verbatim.
    plan = apply_on_cluster_to_plan(
        plan, config.clickhouse.cluster if config.clickhouse else None
    )

    dictionary_password_warnings = detect_dictionary_password_warnings(plan)

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
                        "scope": _scope_to_payload(table_scope),
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
                        "scope": _scope_to_payload(table_scope),
                        "warnings": dictionary_password_warnings,
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
        for warning in dictionary_password_warnings:
            typer.secho(f"Warning: {warning}", fg=typer.colors.YELLOW, err=True)
        return

    artifact_definitions = (
        build_scoped_snapshot_definitions(
            previous_definitions=old_defs,
            next_definitions=canonical,
            matched_tables=set(table_scope.matched_tables),
            rename_mappings=active_table_mappings,  # type: ignore[arg-type]
        )
        if table_scope.enabled
        else canonical
    )

    artifact = write_migration(
        migrations_dir,
        meta_dir,
        artifact_definitions,
        plan,
        migration_name=migration_name,
        migration_id=migration_id,
        cli_version=__version__,
    )
    snapshot = create_snapshot(artifact_definitions)
    snapshot_path = write_snapshot(meta_dir, snapshot)

    if artifact is None:
        # plan.operations was non-empty above, so this branch is unreachable;
        # guarding for type safety.
        return

    _run_codegen_integration(
        plugin_runtime=plugin_runtime,
        config=config,
        config_path=str(config_path),
        table_scope=table_scope,
        output_json=output_json,
    )

    if output_json:
        typer.echo(
            json.dumps(
                {
                    "migrationFile": str(artifact.sql_path),
                    "snapshotFile": str(snapshot_path),
                    "operationCount": len(plan.operations),
                    "riskSummary": plan.risk_summary.model_dump(),
                    "warnings": dictionary_password_warnings,
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
    for warning in dictionary_password_warnings:
        typer.secho(f"Warning: {warning}", fg=typer.colors.YELLOW, err=True)
