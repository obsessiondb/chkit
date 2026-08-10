"""`chkit pull` — introspect live ClickHouse and emit a Python schema file.

Simplified port of ``packages/plugin-pull/src/index.ts``. Uses the
ClickHouseClient + introspect helpers + view-parser + render-schema-py
modules to produce a ``.py`` file that, when loaded, round-trips back to
the live database's tables, views and materialized views.

Flags mirror the TS plugin:

- ``--out-file <path>``        Output file (default ``src/db/schema/pulled.py``).
- ``--database <name>``        Restrict pull to listed databases (repeatable).
                               Default: every non-system database with tables.
- ``--force`` / ``--overwrite``Overwrite the output file if it exists.
- ``--dryrun``                 Print the result instead of writing.

The custom-introspector hook (used by the obsessiondb plugin to route
through its API) is intentionally not ported here — that lives with the
obsessiondb plugin port.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.commands.pull_render import render_schema_file
from chkit.cli.commands.pull_view_parser import (
    MaterializedViewRefreshShape,
    parse_as_clause,
    parse_refresh_clause,
    parse_to_clause,
)
from chkit.cli.config_loader import load_config
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.table_scope import TableScope
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.create_dictionary_parser import (
    parse_comment_from_create_dictionary_query,
    parse_dictionary_attributes_from_create_dictionary_query,
    parse_dictionary_primary_key_from_create_dictionary_query,
    parse_dictionary_range_from_create_dictionary_query,
    parse_dictionary_settings_from_create_dictionary_query,
    parse_layout_from_create_dictionary_query,
    parse_lifetime_from_create_dictionary_query,
    parse_source_from_create_dictionary_query,
)
from chkit.clickhouse.introspect import (
    IntrospectedTable,
    infer_schema_kind_from_engine,
    list_schema_objects,
    list_table_details,
)
from chkit.core.model import (
    ChxConfigEnv,
    DictionaryDefinition,
    MaterializedViewDefinition,
    MaterializedViewRefresh,
    SchemaDefinition,
    SkipIndexBloomFilter,
    SkipIndexMinmax,
    SkipIndexNgramBF,
    SkipIndexSet,
    SkipIndexTokenBF,
    TableDefinition,
    TableRef,
    ViewDefinition,
    dictionary,
    materialized_view,
    table,
    view,
)
from chkit.plugins import ChxOnPullIntrospectContext, ChxPlugin


def _introspected_table_to_definition(
    item: IntrospectedTable,
) -> TableDefinition | None:
    """Turn an IntrospectedTable into a TableDefinition (lossy where types differ)."""
    if not item.columns:
        return None

    settings = {k: _coerce_setting_value(v) for k, v in (item.settings or {}).items()}

    indexes: list[
        SkipIndexMinmax
        | SkipIndexSet
        | SkipIndexBloomFilter
        | SkipIndexTokenBF
        | SkipIndexNgramBF
        | dict[str, object]
    ] = list(item.indexes)

    return table(
        database=item.database,
        name=item.name,
        engine=item.engine or "MergeTree",
        columns=list(item.columns),
        primary_key=_split_clause(item.primary_key) or [item.columns[0].name],
        order_by=_split_clause(item.order_by) or [item.columns[0].name],
        unique_key=_split_clause(item.unique_key) or None,
        partition_by=item.partition_by or None,
        ttl=item.ttl or None,
        settings=settings or None,
        indexes=indexes or None,
        projections=list(item.projections) or None,
    )


def _coerce_setting_value(value: str) -> str | int | float | bool:
    if value in {"true", "false"}:
        return value == "true"
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


def _split_clause(clause: str | None) -> list[str]:
    """Crude parser for ``(a, b, c)`` or ``a, b, c`` clauses returned by introspect."""
    if not clause:
        return []
    inner = clause.strip()
    if inner.startswith("(") and inner.endswith(")"):
        inner = inner[1:-1]
    return [
        part.strip().lstrip("`\"").rstrip("`\"")
        for part in inner.split(",")
        if part.strip()
    ]


def _refresh_shape_to_model(
    shape: MaterializedViewRefreshShape | None,
) -> MaterializedViewRefresh | None:
    if shape is None:
        return None
    settings: dict[str, str | int | float | bool] | None = None
    if shape.settings:
        settings = {k: _coerce_setting_value(str(v)) for k, v in shape.settings.items()}
    depends_on: list[TableRef] | None = None
    if shape.depends_on:
        depends_on = [TableRef(database=d.database, name=d.name) for d in shape.depends_on]
    return MaterializedViewRefresh(
        every=shape.every,
        after=shape.after,
        offset=shape.offset,
        randomize=shape.randomize,
        depends_on=depends_on,
        settings=settings,
        append=shape.append or None,
        empty=shape.empty or None,
    )


def _pull_definitions(
    client: object, databases: Sequence[str]
) -> list[SchemaDefinition]:
    """Combine introspect.list_table_details + view parsing into SchemaDefinitions."""
    introspected_tables = list_table_details(client, list(databases))
    table_defs: list[SchemaDefinition] = []
    for it in introspected_tables:
        td = _introspected_table_to_definition(it)
        if td is not None:
            table_defs.append(td)

    # Now pull views + MVs by querying system.tables for the relevant databases
    # and using view-parser on their create_table_query strings.
    if not databases:
        return table_defs
    quoted = ", ".join("'" + d.replace("'", "''") + "'" for d in databases)
    sql = (
        "SELECT database, name, engine, create_table_query "
        f"FROM system.tables WHERE is_temporary = 0 AND database IN ({quoted})"
    )
    raw_result = client.query(sql)  # type: ignore[attr-defined]
    view_defs: list[SchemaDefinition] = []
    for row in raw_result.rows:
        kind = infer_schema_kind_from_engine(str(row.get("engine", "")))
        ctq = row.get("create_table_query")
        ctq_str = str(ctq) if ctq is not None else None
        if kind == "view":
            as_clause = parse_as_clause(ctq_str)
            if as_clause is None:
                continue
            view_defs.append(
                view(
                    database=str(row["database"]),
                    name=str(row["name"]),
                    as_=as_clause,
                )
            )
        elif kind == "materialized_view":
            as_clause = parse_as_clause(ctq_str)
            to_shape = parse_to_clause(ctq_str, str(row["database"]))
            if as_clause is None or to_shape is None:
                continue
            refresh_shape = parse_refresh_clause(ctq_str)
            refresh_model = _refresh_shape_to_model(refresh_shape) if refresh_shape else None
            view_defs.append(
                materialized_view(
                    database=str(row["database"]),
                    name=str(row["name"]),
                    to=TableRef(database=to_shape.database, name=to_shape.name),
                    as_=as_clause,
                    refresh=refresh_model,
                )
            )
        elif kind == "dictionary":
            dictionary_def = _map_dictionary_row_to_definition(
                database=str(row["database"]),
                name=str(row["name"]),
                query=ctq_str,
            )
            if dictionary_def is not None:
                view_defs.append(dictionary_def)

    return table_defs + view_defs


def _map_dictionary_row_to_definition(
    *, database: str, name: str, query: str | None
) -> DictionaryDefinition | None:
    """Reconstruct a DictionaryDefinition from a CREATE DICTIONARY query."""
    attributes = parse_dictionary_attributes_from_create_dictionary_query(query)
    primary_key = parse_dictionary_primary_key_from_create_dictionary_query(query)
    source = parse_source_from_create_dictionary_query(query)
    layout = parse_layout_from_create_dictionary_query(query)
    lifetime = parse_lifetime_from_create_dictionary_query(query)
    if not attributes or not primary_key or not source or not layout or not lifetime:
        return None
    comment = parse_comment_from_create_dictionary_query(query)
    range_parts = parse_dictionary_range_from_create_dictionary_query(query)
    settings = parse_dictionary_settings_from_create_dictionary_query(query)
    return dictionary(
        database=database,
        name=name,
        attributes=[
            {
                key: value
                for key, value in {
                    "name": a.name,
                    "type": a.type,
                    "default": a.default,
                    "expression": a.expression,
                    "hierarchical": a.hierarchical,
                    "bidirectional": a.bidirectional,
                    "injective": a.injective,
                    "is_object_id": a.is_object_id,
                }.items()
                if value is not None
            }
            for a in attributes
        ],
        primary_key=primary_key,
        source=source,
        layout=layout,
        lifetime=lifetime,
        range={"min": range_parts[0], "max": range_parts[1]}
        if range_parts is not None
        else None,
        settings=settings,
        comment=comment,
    )


_PASSWORD_LITERAL_RE = re.compile(
    r"password\s+'(?!\[HIDDEN\])(?:[^'\\]|\\.)*'", re.IGNORECASE
)


def _dictionary_password_warnings(definitions: Sequence[SchemaDefinition]) -> list[str]:
    """Flag redacted or plain-text passwords in pulled dictionary sources.

    ClickHouse redacts a dictionary's SOURCE(...) password to ``[HIDDEN]`` on
    introspection by default, and offers no way to recover the real value via
    pull — flag it so the placeholder doesn't sit unnoticed in the schema
    file. That redaction can also be turned off server-side, in which case
    ClickHouse hands chkit the real password and it's written verbatim into
    the schema file — chkit has no way to detect or opt out of that, so flag
    it too.
    """
    warnings: list[str] = []
    for definition in definitions:
        if not isinstance(definition, DictionaryDefinition):
            continue
        if "[HIDDEN]" in definition.source:
            warnings.append(
                f'Dictionary "{definition.database}.{definition.name}" SOURCE(...) '
                f"password was redacted by ClickHouse to '[HIDDEN]' — chkit could "
                f"not recover the real value. Replace it in the generated schema "
                f"file before this dictionary's source can be diffed or migrated. "
                f"To have ClickHouse reveal real passwords on introspection "
                f'instead, grant the connecting user "displaySecretsInShowAndSelect" '
                f'and enable the server-side "display_secrets_in_show_and_select" '
                f"setting."
            )
        elif _PASSWORD_LITERAL_RE.search(definition.source):
            warnings.append(
                f'Dictionary "{definition.database}.{definition.name}" SOURCE(...) '
                f"has a plain-text password — ClickHouse returned the real "
                f"credential on introspection and it was written verbatim into "
                f"the generated schema file."
            )
    return warnings


def _summarize_skipped_objects(
    objects: list[object],
    definitions: list[SchemaDefinition],
    selected_databases: list[str],
) -> list[dict[str, object]]:
    """Mirror of TS ``summarizeSkippedObjects``: per-kind count of objects
    present in ``selected_databases`` that didn't end up in the emitted schema.

    Operates over duck-typed objects with ``kind`` / ``database`` / ``name``
    attributes (``SchemaObjectRef`` from the introspect module).
    """
    if not objects:
        return []
    selected = set(selected_databases)
    included = {
        f"{d.kind}:{d.database}.{d.name}" for d in definitions
    }
    counts: dict[str, int] = {}
    for obj in objects:
        kind = getattr(obj, "kind", None)
        database = getattr(obj, "database", None)
        name = getattr(obj, "name", None)
        if not isinstance(kind, str) or not isinstance(database, str) or not isinstance(name, str):
            continue
        if database not in selected:
            continue
        key = f"{kind}:{database}.{name}"
        if key in included:
            continue
        counts[kind] = counts.get(kind, 0) + 1
    return sorted(
        ({"kind": k, "count": v} for k, v in counts.items()),
        key=lambda item: str(item["kind"]),
    )


def _write_schema_file(out_file: Path, content: str, *, overwrite: bool) -> None:
    if out_file.exists() and not overwrite:
        msg = (
            f"Output file already exists: {out_file}. "
            f"Pass --force / --overwrite to replace it."
        )
        raise typer.BadParameter(msg)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    tmp_file = out_file.with_suffix(out_file.suffix + ".tmp")
    tmp_file.write_text(content, encoding="utf-8")
    tmp_file.replace(out_file)


def run(  # noqa: PLR0917
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    out_file: Annotated[
        Path,
        typer.Option(
            "--out-file",
            "-o",
            help="Where to write the pulled Python schema.",
        ),
    ] = Path("src/db/schema/pulled.py"),
    database: Annotated[
        list[str] | None,
        typer.Option(
            "--database",
            "-d",
            help="Restrict pull to these database names. Repeatable.",
        ),
    ] = None,
    overwrite: Annotated[
        bool,
        typer.Option(
            "--overwrite",
            "--force",
            "-f",
            help="Overwrite the output file if it already exists.",
        ),
    ] = False,
    dryrun: Annotated[
        bool,
        typer.Option(
            "--dryrun", help="Print the rendered schema instead of writing it."
        ),
    ] = False,
    output_json: Annotated[
        bool, typer.Option("--json", help="Emit a JSON-formatted summary.")
    ] = False,
) -> None:
    config = load_config(config_path, ChxConfigEnv(command="pull"))
    if config.clickhouse is None:
        msg = (
            "clickhouse.config.py must include a `clickhouse` block "
            "(pull connects to ClickHouse to read the live schema)."
        )
        raise typer.BadParameter(msg)

    selected = sorted({d.strip() for d in (database or []) if d.strip()})

    # Allow a registered plugin to bypass the SQL-based pull entirely
    # (e.g. ObsessionDB's metadata API). Plugins implement
    # ``on_pull_introspect`` and return a list of SchemaDefinition.
    plugin_runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )
    custom = plugin_runtime.run_on_pull_introspect(
        ChxOnPullIntrospectContext(
            command="pull",
            config=config,
            table_scope=TableScope(enabled=False),
            flags={},
            clickhouse=config.clickhouse,
            databases=selected,
        )
    )
    raw_objects: list[object] = []  # objects from system.tables (for skipped count)
    if custom is not None:
        definitions = list(custom)
    else:
        with ClickHouseClient.connect(config.clickhouse) as client:
            if not selected:
                objects = list_schema_objects(client)
                raw_objects = list(objects)
                selected = sorted({o.database for o in objects})
            else:
                # Capture objects so we can summarize what got skipped, even
                # when --database was passed explicitly.
                raw_objects = list(list_schema_objects(client))
            definitions = _pull_definitions(client, selected)

    content = render_schema_file(definitions)
    out_file_abs = (Path.cwd() / out_file).resolve()

    if not dryrun:
        _write_schema_file(out_file_abs, content, overwrite=overwrite)

    # Mirror TS ``summarizeSkippedObjects``: count per-kind objects present in
    # the selected databases that did NOT end up in the emitted schema.
    skipped_objects = _summarize_skipped_objects(
        raw_objects, definitions, selected
    )

    warnings = _dictionary_password_warnings(definitions)

    payload: dict[str, object] = {
        "command": "schema",
        "ok": True,
        "outFile": str(out_file_abs),
        "definitionCount": len(definitions),
        "tableCount": sum(1 for d in definitions if isinstance(d, TableDefinition)),
        "viewCount": sum(1 for d in definitions if isinstance(d, ViewDefinition)),
        "materializedViewCount": sum(
            1 for d in definitions if isinstance(d, MaterializedViewDefinition)
        ),
        "dictionaryCount": sum(
            1 for d in definitions if isinstance(d, DictionaryDefinition)
        ),
        "databases": selected,
        "dryrun": dryrun,
        "skippedObjects": skipped_objects,
        "warnings": warnings,
    }
    if dryrun:
        payload["content"] = content

    if output_json:
        typer.echo(json.dumps(payload, indent=2))
        return

    if dryrun:
        typer.echo(
            f"Pull preview: {payload['definitionCount']} objects from "
            f"{', '.join(selected) or '(none)'}"
        )
        typer.echo(content)
    else:
        typer.echo(
            f"Pulled {payload['definitionCount']} objects from "
            f"{', '.join(selected) or '(none)'} to {out_file_abs}"
        )
    for warning in warnings:
        typer.secho(f"Warning: {warning}", fg=typer.colors.YELLOW, err=True)
