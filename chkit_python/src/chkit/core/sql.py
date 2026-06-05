"""Render canonical schema definitions to ClickHouse DDL."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeAlias

from pydantic import TypeAdapter

from chkit.core.codec import render_codec
from chkit.core.key_clause import normalize_key_columns
from chkit.core.model import (
    ColumnDefinition,
    MaterializedViewDefinition,
    MaterializedViewRefresh,
    ProjectionDefinition,
    SchemaDefinition,
    SkipIndexBloomFilter,
    SkipIndexDefinition,
    SkipIndexMinmax,
    SkipIndexSet,
    SkipIndexTokenBF,
    TableDefinition,
    TableRef,
    ViewDefinition,
)
from chkit.core.validate import assert_valid_definitions

_COLUMN_ADAPTER: TypeAdapter[ColumnDefinition] = TypeAdapter(ColumnDefinition)
_INDEX_ADAPTER: TypeAdapter[SkipIndexDefinition] = TypeAdapter(SkipIndexDefinition)
_PROJECTION_ADAPTER: TypeAdapter[ProjectionDefinition] = TypeAdapter(ProjectionDefinition)

ColumnInput: TypeAlias = ColumnDefinition | Mapping[str, Any]
IndexInput: TypeAlias = SkipIndexDefinition | Mapping[str, Any]
ProjectionInput: TypeAlias = ProjectionDefinition | Mapping[str, Any]


def _normalize_column(column: ColumnInput) -> ColumnDefinition:
    if isinstance(column, Mapping):
        return _COLUMN_ADAPTER.validate_python(dict(column))
    return column


def _normalize_index(index: IndexInput) -> SkipIndexDefinition:
    if isinstance(index, Mapping):
        return _INDEX_ADAPTER.validate_python(dict(index))
    return index


def _normalize_projection(projection: ProjectionInput) -> ProjectionDefinition:
    if isinstance(projection, Mapping):
        return _PROJECTION_ADAPTER.validate_python(dict(projection))
    return projection


def _render_default(value: str | int | float | bool) -> str:
    if isinstance(value, str):
        if value.startswith("fn:"):
            return value[3:]
        escaped = value.replace("'", "''")
        return f"'{escaped}'"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _render_column(col: ColumnDefinition) -> str:
    type_text = f"Nullable({col.type})" if col.nullable else f"{col.type}"
    out = f"`{col.name}` {type_text}"
    if col.default is not None:
        out += f" DEFAULT {_render_default(col.default)}"
    if col.comment is not None and len(col.comment) > 0:
        escaped = col.comment.replace("'", "''")
        out += f" COMMENT '{escaped}'"
    if col.codec is not None:
        out += f" {render_codec(col.codec)}"
    return out


def _render_key_clause_columns(columns: list[str]) -> str:
    return ", ".join(f"`{c}`" for c in normalize_key_columns(columns))


def _render_index_type(idx: SkipIndexDefinition) -> str:
    if isinstance(idx, SkipIndexMinmax):
        return "minmax"
    if isinstance(idx, SkipIndexSet):
        return f"set({idx.max_rows})"
    if isinstance(idx, SkipIndexBloomFilter):
        if idx.false_positive_rate is not None:
            return f"bloom_filter({idx.false_positive_rate})"
        return "bloom_filter"
    if isinstance(idx, SkipIndexTokenBF):
        return f"tokenbf_v1({idx.size_bytes}, {idx.hash_functions}, {idx.random_seed})"
    # SkipIndexNgramBF is the only remaining variant in the discriminated union.
    return (
        f"ngrambf_v1({idx.ngram_size}, {idx.size_bytes}, {idx.hash_functions}, "
        f"{idx.random_seed})"
    )


def _render_setting_value(value: str | int | float | bool) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _render_settings_clause(settings: dict[str, str | int | float | bool]) -> str:
    parts = [f"{k} = {_render_setting_value(v)}" for k, v in settings.items()]
    return ", ".join(parts)


def _render_projection(p: ProjectionDefinition) -> str:
    return f"PROJECTION `{p.name}` ({p.query})"


def _render_index_line(idx: SkipIndexDefinition) -> str:
    return (
        f"INDEX `{idx.name}` ({idx.expression}) "
        f"TYPE {_render_index_type(idx)} GRANULARITY {idx.granularity}"
    )


def _render_table_sql(definition: TableDefinition) -> str:
    columns = [_render_column(c) for c in definition.columns]
    indexes_block = [_render_index_line(idx) for idx in (definition.indexes or [])]
    projections_block = [_render_projection(p) for p in (definition.projections or [])]
    body = ",\n  ".join(columns + indexes_block + projections_block)

    clauses: list[str] = []
    if definition.partition_by is not None:
        clauses.append(f"PARTITION BY {definition.partition_by}")
    clauses.append(f"PRIMARY KEY ({_render_key_clause_columns(definition.primary_key)})")
    clauses.append(f"ORDER BY ({_render_key_clause_columns(definition.order_by)})")
    if definition.unique_key is not None and len(definition.unique_key) > 0:
        clauses.append(f"UNIQUE KEY ({_render_key_clause_columns(definition.unique_key)})")
    if definition.ttl is not None:
        clauses.append(f"TTL {definition.ttl}")
    if definition.settings is not None and len(definition.settings) > 0:
        clauses.append(f"SETTINGS {_render_settings_clause(definition.settings)}")
    if definition.comment is not None and len(definition.comment) > 0:
        escaped = definition.comment.replace("'", "''")
        clauses.append(f"COMMENT '{escaped}'")

    return (
        f"CREATE TABLE IF NOT EXISTS {definition.database}.{definition.name}\n"
        f"(\n  {body}\n) ENGINE = {definition.engine}\n"
        f"{chr(10).join(clauses)};"
    )


def _render_view_sql(definition: ViewDefinition) -> str:
    return (
        f"CREATE VIEW IF NOT EXISTS {definition.database}.{definition.name} AS\n"
        f"{definition.as_};"
    )


def _render_refresh_settings(settings: dict[str, str | int | float]) -> str:
    parts: list[str] = []
    for k, v in settings.items():
        if isinstance(v, str):
            escaped = v.replace("'", "''")
            parts.append(f"{k} = '{escaped}'")
        else:
            parts.append(f"{k} = {v}")
    return ", ".join(parts)


def _render_depends_on(depends_on: list[TableRef]) -> str:
    return ", ".join(f"{d.database}.{d.name}" for d in depends_on)


def _render_refresh_clause(refresh: MaterializedViewRefresh) -> str:
    parts: list[str] = []
    if refresh.every is not None:
        parts.append(f"REFRESH EVERY {refresh.every}")
    elif refresh.after is not None:
        parts.append(f"REFRESH AFTER {refresh.after}")
    if refresh.offset is not None:
        parts.append(f"OFFSET {refresh.offset}")
    if refresh.randomize is not None:
        parts.append(f"RANDOMIZE FOR {refresh.randomize}")
    if refresh.depends_on is not None and len(refresh.depends_on) > 0:
        parts.append(f"DEPENDS ON {_render_depends_on(refresh.depends_on)}")
    if refresh.settings is not None and len(refresh.settings) > 0:
        parts.append(f"SETTINGS {_render_refresh_settings(refresh.settings)}")
    if refresh.append:
        parts.append("APPEND")
    return " ".join(parts)


def _render_materialized_view_sql(definition: MaterializedViewDefinition) -> str:
    header = (
        f"CREATE MATERIALIZED VIEW IF NOT EXISTS "
        f"{definition.database}.{definition.name}"
    )
    refresh_block = (
        f"\n{_render_refresh_clause(definition.refresh)}"
        if definition.refresh is not None
        else ""
    )
    to_clause = f" TO {definition.to.database}.{definition.to.name}"
    empty_clause = " EMPTY" if (definition.refresh is not None and definition.refresh.empty) else ""
    return (
        f"{header}{refresh_block}{to_clause}{empty_clause} AS\n{definition.as_};"
    )


def render_alter_modify_refresh(definition: MaterializedViewDefinition) -> str:
    if definition.refresh is None:
        msg = (
            f"Cannot render MODIFY REFRESH for "
            f"{definition.database}.{definition.name}: refresh is not set"
        )
        raise ValueError(msg)
    clause = _render_refresh_clause(definition.refresh)
    return f"ALTER TABLE {definition.database}.{definition.name} MODIFY {clause};"


def to_create_sql(definition: SchemaDefinition) -> str:
    assert_valid_definitions([definition])
    if isinstance(definition, TableDefinition):
        return _render_table_sql(definition)
    if isinstance(definition, ViewDefinition):
        return _render_view_sql(definition)
    return _render_materialized_view_sql(definition)


def render_alter_add_column(definition: TableDefinition, column: ColumnInput) -> str:
    normalized = _normalize_column(column)
    return (
        f"ALTER TABLE {definition.database}.{definition.name} "
        f"ADD COLUMN IF NOT EXISTS {_render_column(normalized)};"
    )


def render_alter_modify_column(definition: TableDefinition, column: ColumnInput) -> str:
    normalized = _normalize_column(column)
    return (
        f"ALTER TABLE {definition.database}.{definition.name} "
        f"MODIFY COLUMN {_render_column(normalized)};"
    )


def render_alter_drop_column(definition: TableDefinition, column_name: str) -> str:
    return (
        f"ALTER TABLE {definition.database}.{definition.name} "
        f"DROP COLUMN IF EXISTS `{column_name}`;"
    )


def render_alter_remove_codec(definition: TableDefinition, column_name: str) -> str:
    return (
        f"ALTER TABLE {definition.database}.{definition.name} "
        f"MODIFY COLUMN `{column_name}` REMOVE CODEC;"
    )


def render_alter_add_index(definition: TableDefinition, index: IndexInput) -> str:
    normalized = _normalize_index(index)
    return (
        f"ALTER TABLE {definition.database}.{definition.name} "
        f"ADD INDEX IF NOT EXISTS `{normalized.name}` ({normalized.expression}) "
        f"TYPE {_render_index_type(normalized)} GRANULARITY {normalized.granularity};"
    )


def render_alter_drop_index(definition: TableDefinition, index_name: str) -> str:
    return (
        f"ALTER TABLE {definition.database}.{definition.name} "
        f"DROP INDEX IF EXISTS `{index_name}`;"
    )


def render_alter_add_projection(
    definition: TableDefinition, projection: ProjectionInput
) -> str:
    normalized = _normalize_projection(projection)
    return (
        f"ALTER TABLE {definition.database}.{definition.name} "
        f"ADD PROJECTION IF NOT EXISTS `{normalized.name}` ({normalized.query});"
    )


def render_alter_drop_projection(definition: TableDefinition, projection_name: str) -> str:
    return (
        f"ALTER TABLE {definition.database}.{definition.name} "
        f"DROP PROJECTION IF EXISTS `{projection_name}`;"
    )


def render_alter_modify_setting(
    definition: TableDefinition, key: str, value: str | int | float | bool
) -> str:
    return (
        f"ALTER TABLE {definition.database}.{definition.name} "
        f"MODIFY SETTING {key} = {_render_setting_value(value)};"
    )


def render_alter_reset_setting(definition: TableDefinition, key: str) -> str:
    return f"ALTER TABLE {definition.database}.{definition.name} RESET SETTING {key};"


def render_alter_modify_ttl(definition: TableDefinition, ttl: str | None) -> str:
    if ttl is None:
        return f"ALTER TABLE {definition.database}.{definition.name} REMOVE TTL;"
    return f"ALTER TABLE {definition.database}.{definition.name} MODIFY TTL {ttl};"
