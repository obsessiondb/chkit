"""Parse and reconcile CLI + schema rename mappings for ``chkit generate``.

1:1 port of ``packages/cli/src/commands/generate/rename-mappings.ts``.

Two kinds of mapping:
  - Table:  ``old_db.old_name = new_db.new_name``
  - Column: ``db.table.old_col = new_col``

Sources: ``--rename-table`` / ``--rename-column`` CLI flags (``source='cli'``)
and schema-declared ``renamed_from`` metadata (``source='schema'``).

This module is pure (no I/O, no side effects); it only manipulates lists
of frozen dataclasses, so it is trivial to unit test against the TS
behaviour.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from chkit.core.model import SchemaDefinition, TableDefinition

_TWO_PARTS = 2
_THREE_PARTS = 3


@dataclass(frozen=True, slots=True)
class TableRenameMapping:
    old_database: str
    old_name: str
    new_database: str
    new_name: str
    source: Literal["cli", "schema"]


@dataclass(frozen=True, slots=True)
class ColumnRenameMapping:
    database: str
    table: str
    from_: str
    to: str
    source: Literal["cli", "schema"]


@dataclass(frozen=True, slots=True)
class SchemaRenameMappings:
    table_mappings: list[TableRenameMapping]
    column_mappings: list[ColumnRenameMapping]


def parse_rename_table_mappings(values: list[str]) -> list[TableRenameMapping]:
    """Parse ``--rename-table`` values into mappings.

    Each value must match ``old_db.old_table=new_db.new_table``. Whitespace
    around the parts is tolerated; missing/extra ``=`` segments error.
    """
    result: list[TableRenameMapping] = []
    for mapping in values:
        parts = [part.strip() for part in mapping.split("=")]
        if len(parts) != _TWO_PARTS or not all(parts):
            msg = (
                f'Invalid --rename-table mapping "{mapping}". '
                f"Expected format: old_db.old_table=new_db.new_table"
            )
            raise ValueError(msg)
        from_raw, to_raw = parts
        from_db, from_name = _parse_qualified_table(from_raw)
        to_db, to_name = _parse_qualified_table(to_raw)
        result.append(
            TableRenameMapping(
                old_database=from_db,
                old_name=from_name,
                new_database=to_db,
                new_name=to_name,
                source="cli",
            )
        )
    return result


def parse_rename_column_mappings(values: list[str]) -> list[ColumnRenameMapping]:
    """Parse ``--rename-column`` values into mappings.

    Each value must match ``db.table.old_column=new_column``.
    """
    result: list[ColumnRenameMapping] = []
    for mapping in values:
        parts = [part.strip() for part in mapping.split("=")]
        if len(parts) != _TWO_PARTS or not all(parts):
            msg = (
                f'Invalid --rename-column mapping "{mapping}". '
                f"Expected format: db.table.old_column=new_column"
            )
            raise ValueError(msg)
        from_raw, to_raw = parts
        triple = [part.strip() for part in from_raw.split(".")]
        if len(triple) != _THREE_PARTS or not all(triple):
            msg = (
                f'Invalid --rename-column source "{from_raw}". '
                f"Expected format: db.table.old_column"
            )
            raise ValueError(msg)
        result.append(
            ColumnRenameMapping(
                database=triple[0],
                table=triple[1],
                from_=triple[2],
                to=to_raw,
                source="cli",
            )
        )
    return result


def collect_schema_rename_mappings(
    definitions: Sequence[SchemaDefinition],
) -> SchemaRenameMappings:
    """Walk definitions, harvest ``renamed_from`` metadata into mappings."""
    table_mappings: list[TableRenameMapping] = []
    column_mappings: list[ColumnRenameMapping] = []

    for definition in definitions:
        if not isinstance(definition, TableDefinition):
            continue
        if definition.renamed_from is not None:
            table_mappings.append(
                TableRenameMapping(
                    old_database=definition.renamed_from.database or definition.database,
                    old_name=definition.renamed_from.name,
                    new_database=definition.database,
                    new_name=definition.name,
                    source="schema",
                )
            )
        for column in definition.columns:
            if column.renamed_from is None:
                continue
            column_mappings.append(
                ColumnRenameMapping(
                    database=definition.database,
                    table=definition.name,
                    from_=column.renamed_from,
                    to=column.name,
                    source="schema",
                )
            )

    return SchemaRenameMappings(
        table_mappings=table_mappings, column_mappings=column_mappings
    )


def merge_table_mappings(
    schema_mappings: Sequence[TableRenameMapping],
    cli_mappings: Sequence[TableRenameMapping],
) -> list[TableRenameMapping]:
    """CLI mappings displace schema mappings sharing a source or target key."""
    merged = list(schema_mappings)
    for cli_mapping in cli_mappings:
        cli_old_key = f"{cli_mapping.old_database}.{cli_mapping.old_name}"
        cli_new_key = f"{cli_mapping.new_database}.{cli_mapping.new_name}"
        # Iterate back-to-front so deletions don't invalidate indices.
        for index in range(len(merged) - 1, -1, -1):
            entry = merged[index]
            old_key = f"{entry.old_database}.{entry.old_name}"
            new_key = f"{entry.new_database}.{entry.new_name}"
            if old_key == cli_old_key or new_key == cli_new_key:
                merged.pop(index)
        merged.append(cli_mapping)
    return merged


def merge_column_mappings(
    schema_mappings: Sequence[ColumnRenameMapping],
    cli_mappings: Sequence[ColumnRenameMapping],
) -> list[ColumnRenameMapping]:
    """CLI mappings displace schema mappings sharing a source or target key."""
    merged = list(schema_mappings)
    for cli_mapping in cli_mappings:
        cli_from_key = (
            f"{cli_mapping.database}.{cli_mapping.table}.{cli_mapping.from_}"
        )
        cli_to_key = f"{cli_mapping.database}.{cli_mapping.table}.{cli_mapping.to}"
        for index in range(len(merged) - 1, -1, -1):
            entry = merged[index]
            from_key = f"{entry.database}.{entry.table}.{entry.from_}"
            to_key = f"{entry.database}.{entry.table}.{entry.to}"
            if from_key == cli_from_key or to_key == cli_to_key:
                merged.pop(index)
        merged.append(cli_mapping)
    return merged


def resolve_active_table_mappings(
    previous_definitions: Sequence[SchemaDefinition],
    next_definitions: Sequence[SchemaDefinition],
    mappings: Sequence[TableRenameMapping],
) -> list[TableRenameMapping]:
    """Keep only mappings whose source exists in old and target exists in new."""
    return [
        mapping
        for mapping in mappings
        if _table_exists(previous_definitions, mapping.old_database, mapping.old_name)
        and _table_exists(next_definitions, mapping.new_database, mapping.new_name)
    ]


def assert_no_conflicting_table_mappings(
    mappings: Sequence[TableRenameMapping],
) -> None:
    """Reject duplicate sources, duplicate targets, and chained/cyclic mappings."""
    by_old: dict[str, TableRenameMapping] = {}
    by_new: dict[str, TableRenameMapping] = {}

    for mapping in mappings:
        old_key = f"{mapping.old_database}.{mapping.old_name}"
        new_key = f"{mapping.new_database}.{mapping.new_name}"

        existing_old = by_old.get(old_key)
        if existing_old is not None and (
            existing_old.new_database != mapping.new_database
            or existing_old.new_name != mapping.new_name
        ):
            msg = f'Conflicting table rename source mapping for "{old_key}".'
            raise ValueError(msg)
        by_old[old_key] = mapping

        existing_new = by_new.get(new_key)
        if existing_new is not None and (
            existing_new.old_database != mapping.old_database
            or existing_new.old_name != mapping.old_name
        ):
            msg = f'Conflicting table rename target mapping for "{new_key}".'
            raise ValueError(msg)
        by_new[new_key] = mapping

    for key in by_old:
        if key in by_new:
            msg = (
                f'Unsupported chained or cyclic table rename mapping involving "{key}". '
                f"Use direct one-step mappings only."
            )
            raise ValueError(msg)


def assert_no_conflicting_column_mappings(
    mappings: Sequence[ColumnRenameMapping],
) -> None:
    """Reject conflicting CLI column renames (same source mapped twice, etc.)."""
    by_from: dict[str, ColumnRenameMapping] = {}
    by_to: dict[str, ColumnRenameMapping] = {}

    for mapping in mappings:
        from_key = f"{mapping.database}.{mapping.table}.{mapping.from_}"
        to_key = f"{mapping.database}.{mapping.table}.{mapping.to}"

        existing_from = by_from.get(from_key)
        if existing_from is not None and existing_from.to != mapping.to:
            msg = f'Conflicting column rename source mapping for "{from_key}".'
            raise ValueError(msg)
        by_from[from_key] = mapping

        existing_to = by_to.get(to_key)
        if existing_to is not None and existing_to.from_ != mapping.from_:
            msg = f'Conflicting column rename target mapping for "{to_key}".'
            raise ValueError(msg)
        by_to[to_key] = mapping


def assert_cli_table_mappings_resolvable(
    cli_mappings: Sequence[TableRenameMapping],
    previous_definitions: Sequence[SchemaDefinition],
    next_definitions: Sequence[SchemaDefinition],
) -> None:
    """Every CLI table mapping must reference a real source and target."""
    for mapping in cli_mappings:
        has_old = _table_exists(
            previous_definitions, mapping.old_database, mapping.old_name
        )
        has_new = _table_exists(
            next_definitions, mapping.new_database, mapping.new_name
        )
        if has_old and has_new:
            continue
        spec = (
            f"{mapping.old_database}.{mapping.old_name}"
            f"={mapping.new_database}.{mapping.new_name}"
        )
        if not has_old and not has_new:
            msg = (
                f'--rename-table mapping "{spec}" is invalid: source table is missing '
                f"from previous snapshot and target table is missing from current schema."
            )
            raise ValueError(msg)
        if not has_old:
            msg = (
                f'--rename-table mapping "{spec}" is invalid: source table is missing '
                f"from previous snapshot."
            )
            raise ValueError(msg)
        msg = (
            f'--rename-table mapping "{spec}" is invalid: target table is missing '
            f"from current schema."
        )
        raise ValueError(msg)


def remap_old_definitions_for_table_renames(
    previous_definitions: Sequence[SchemaDefinition],
    mappings: Sequence[TableRenameMapping],
) -> list[SchemaDefinition]:
    """Rewrite old TableDefinition entries to use the new database/name.

    Used by the diff engine so that an explicit rename doesn't appear as
    a drop + create pair.
    """
    if not mappings:
        return list(previous_definitions)

    mapping_by_old: dict[str, TableRenameMapping] = {}
    for mapping in mappings:
        mapping_by_old[f"{mapping.old_database}.{mapping.old_name}"] = mapping

    remapped: list[SchemaDefinition] = []
    for definition in previous_definitions:
        if not isinstance(definition, TableDefinition):
            remapped.append(definition)
            continue
        match = mapping_by_old.get(f"{definition.database}.{definition.name}")
        if match is None:
            remapped.append(definition)
            continue
        remapped.append(
            definition.model_copy(
                update={
                    "database": match.new_database,
                    "name": match.new_name,
                }
            )
        )
    return remapped


def _parse_qualified_table(input_: str) -> tuple[str, str]:
    parts = [part.strip() for part in input_.split(".")]
    if len(parts) != _TWO_PARTS or not all(parts):
        msg = f'Invalid table reference "{input_}". Expected format: database.table'
        raise ValueError(msg)
    return parts[0], parts[1]


def _table_exists(
    definitions: Sequence[SchemaDefinition], database: str, name: str
) -> bool:
    return any(
        isinstance(d, TableDefinition) and d.database == database and d.name == name
        for d in definitions
    )
