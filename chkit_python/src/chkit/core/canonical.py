"""Canonicalize definitions for stable comparison and key derivation."""

from __future__ import annotations

import re
from collections.abc import Iterable
from operator import attrgetter
from typing import Final, TypeVar

from chkit.core.codec import canonicalize_codec
from chkit.core.column_default import canonicalize_column_default
from chkit.core.constraint import canonicalize_constraint
from chkit.core.key_clause import normalize_key_columns
from chkit.core.model import (
    ColumnDefinition,
    DictionaryAttribute,
    DictionaryDefinition,
    DictionaryRange,
    MaterializedViewDefinition,
    MaterializedViewRefresh,
    SchemaDefinition,
    SchemaKind,
    SkipIndexDefinition,
    SkipIndexRaw,
    TableDefinition,
    TableRef,
    TableRenamedFrom,
    ViewDefinition,
)
from chkit.core.projection import canonicalize_projection
from chkit.core.sql_lexer import JS_WHITESPACE_RUN, js_trim
from chkit.core.sql_normalizer import normalize_engine, normalize_sql_fragment
from chkit.core.table_settings import (
    DEFAULT_INDEX_GRANULARITY,
    with_default_index_granularity,
    without_auto_minmax_indexes,
)
from chkit.core.text_index import canonicalize_text_index

_T = TypeVar("_T")


def _sort_by_name(items: list[_T]) -> list[_T]:
    # Items always carry a `name: str` attribute (enforced at construction time
    # by the Pydantic models that flow through here).
    return sorted(items, key=attrgetter("name"))


def _sort_kind(kind: SchemaKind) -> int:
    if kind == "table":
        return 0
    if kind == "view":
        return 1
    if kind == "materialized_view":
        return 2
    return 3


def _canonicalize_comment(comment: str | None) -> str | None:
    # An empty comment is no comment: ClickHouse stores both as ''. Trimmed as
    # TS ``String.prototype.trim`` does.
    return (js_trim(comment) or None) if comment is not None else None


def _canonicalize_column(column: ColumnDefinition) -> ColumnDefinition:
    type_value = column.type
    canon_type = js_trim(type_value) if isinstance(type_value, str) else type_value
    return column.model_copy(
        update={
            "default_kind": None if column.default_kind == "DEFAULT" else column.default_kind,
            "name": js_trim(column.name),
            "renamed_from": js_trim(column.renamed_from)
            if column.renamed_from is not None
            else None,
            "type": canon_type,
            "comment": _canonicalize_comment(column.comment),
            "codec": canonicalize_codec(column.codec) if column.codec is not None else None,
            # `SQLExpression` becomes the legacy `fn:` string, so snapshots,
            # plans, drift and chkit (TS) share one representation (#234).
            "default": canonicalize_column_default(column.default)
            if column.default is not None
            else None,
        }
    )


def _canonicalize_index(index: SkipIndexDefinition) -> SkipIndexDefinition:
    if index.type == "text":
        return canonicalize_text_index(index)
    if isinstance(index, SkipIndexRaw):
        return index.model_copy(
            update={
                "expression": normalize_sql_fragment(index.expression),
                "raw_type": normalize_sql_fragment(index.raw_type),
            }
        )
    return index.model_copy(update={"expression": normalize_sql_fragment(index.expression)})


def _sorted_settings(
    settings: dict[str, str | int | float | bool] | None,
) -> dict[str, str | int | float | bool] | None:
    if settings is None:
        return None
    return {k: settings[k] for k in sorted(settings.keys())}


def _normalize_optional_clause(value: str | None) -> str | None:
    # A clause that is only comments is no clause: `ttl='-- ts + INTERVAL 1 DAY'`
    # must render `REMOVE TTL`, not `MODIFY TTL ;`.
    if not value:
        return None
    return normalize_sql_fragment(value) or None


def _canonicalize_table(
    definition: TableDefinition, index_granularity: int | None
) -> TableDefinition:
    settings = _sorted_settings(
        with_default_index_granularity(
            definition.engine,
            definition.settings,
            DEFAULT_INDEX_GRANULARITY if index_granularity is None else index_granularity,
        )
    )
    declared_indexes = without_auto_minmax_indexes(definition.indexes, settings)
    indexes = (
        [_canonicalize_index(idx) for idx in _sort_by_name(declared_indexes)]
        if declared_indexes is not None
        else None
    )
    projections = (
        [canonicalize_projection(p) for p in _sort_by_name(definition.projections)]
        if definition.projections is not None
        else None
    )
    constraints = (
        [canonicalize_constraint(c) for c in _sort_by_name(definition.constraints)]
        if definition.constraints is not None
        else None
    )
    renamed_from: TableRenamedFrom | None = None
    if definition.renamed_from is not None:
        renamed_from = TableRenamedFrom(
            database=js_trim(definition.renamed_from.database)
            if definition.renamed_from.database is not None
            else None,
            name=js_trim(definition.renamed_from.name),
        )

    column_names = {js_trim(column.name) for column in definition.columns}
    normalized_order_by = normalize_key_columns(definition.order_by, column_names)
    normalized_primary_key = normalize_key_columns(definition.primary_key, column_names)
    # TS canonical.ts: when primary_key is empty, fall back to order_by.
    # Without this, a snapshot written by TS (where omitted PK == order_by)
    # would never match a Python snapshot (where omitted PK == []).
    if not normalized_primary_key:
        normalized_primary_key = list(normalized_order_by)
    return definition.model_copy(
        update={
            "database": js_trim(definition.database),
            "name": js_trim(definition.name),
            "renamed_from": renamed_from,
            "engine": normalize_engine(definition.engine),
            "columns": [_canonicalize_column(c) for c in definition.columns],
            "primary_key": normalized_primary_key,
            "order_by": normalized_order_by,
            "unique_key": normalize_key_columns(definition.unique_key, column_names)
            if definition.unique_key is not None
            else None,
            "partition_by": _normalize_optional_clause(definition.partition_by),
            "ttl": _normalize_optional_clause(definition.ttl),
            "settings": settings,
            "indexes": indexes,
            "projections": projections,
            "constraints": constraints,
            "comment": _canonicalize_comment(definition.comment),
        }
    )


def _canonicalize_view(definition: ViewDefinition) -> ViewDefinition:
    return definition.model_copy(
        update={
            "database": js_trim(definition.database),
            "name": js_trim(definition.name),
            "as_": normalize_sql_fragment(definition.as_),
            "comment": _canonicalize_comment(definition.comment),
        }
    )


_INTERVAL_UNIT_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\b(second|minute|hour|day|week|month|year)s?\b", re.IGNORECASE
)


def _canonicalize_interval(value: str | None) -> str | None:
    if value is None:
        return None
    collapsed = JS_WHITESPACE_RUN.sub(" ", js_trim(value))

    def _upper_singular(match: re.Match[str]) -> str:
        token = match.group(0).upper()
        return token.removesuffix("S") if token.endswith("S") else token

    return _INTERVAL_UNIT_PATTERN.sub(_upper_singular, collapsed)


def _canonicalize_refresh(
    refresh: MaterializedViewRefresh | None,
) -> MaterializedViewRefresh | None:
    if refresh is None:
        return None

    depends_on: list[TableRef] | None = None
    if refresh.depends_on is not None:
        depends_on = sorted(
            (
                TableRef(database=js_trim(dep.database), name=js_trim(dep.name))
                for dep in refresh.depends_on
            ),
            key=lambda ref: f"{ref.database}.{ref.name}",
        )

    settings: dict[str, str | int | float] | None = None
    if refresh.settings is not None:
        settings = {k: refresh.settings[k] for k in sorted(refresh.settings.keys())}

    every = _canonicalize_interval(refresh.every)
    after = _canonicalize_interval(refresh.after)
    offset = _canonicalize_interval(refresh.offset)
    randomize = _canonicalize_interval(refresh.randomize)

    payload: dict[str, object] = {}
    if every is not None:
        payload["every"] = every
    if after is not None:
        payload["after"] = after
    if offset is not None:
        payload["offset"] = offset
    if randomize is not None:
        payload["randomize"] = randomize
    if depends_on is not None and len(depends_on) > 0:
        # Use the camelCase alias key for the canonical dict so callers that
        # compare the raw dict to a TS-emitted snapshot see matching keys.
        # ``model_validate`` accepts both forms thanks to
        # ``populate_by_name=True``; ``by_alias=True`` on the inner dump
        # future-proofs us if TableRef ever grows an alias.
        payload["dependsOn"] = [
            d.model_dump(by_alias=True) for d in depends_on
        ]
    if settings is not None and len(settings) > 0:
        payload["settings"] = settings
    if refresh.append:
        payload["append"] = True
    if refresh.empty:
        payload["empty"] = True
    return MaterializedViewRefresh.model_validate(payload)


def _canonicalize_materialized_view(
    definition: MaterializedViewDefinition,
) -> MaterializedViewDefinition:
    canonical_refresh = _canonicalize_refresh(definition.refresh)
    return definition.model_copy(
        update={
            "database": js_trim(definition.database),
            "name": js_trim(definition.name),
            "to": TableRef(
                database=js_trim(definition.to.database),
                name=js_trim(definition.to.name),
            ),
            "as_": normalize_sql_fragment(definition.as_),
            "comment": _canonicalize_comment(definition.comment),
            "refresh": canonical_refresh,
        }
    )


def _canonicalize_dictionary_attribute(
    attribute: DictionaryAttribute,
) -> DictionaryAttribute:
    type_value = attribute.type
    canon_type = js_trim(type_value) if isinstance(type_value, str) else type_value
    return attribute.model_copy(
        update={"name": js_trim(attribute.name), "type": canon_type}
    )


def _canonicalize_dictionary(definition: DictionaryDefinition) -> DictionaryDefinition:
    settings: dict[str, str | int | float] | None = None
    if definition.settings is not None:
        settings = {k: definition.settings[k] for k in sorted(definition.settings)}
        if len(settings) == 0:
            settings = None

    renamed_from: TableRenamedFrom | None = None
    if definition.renamed_from is not None:
        renamed_from = TableRenamedFrom(
            database=js_trim(definition.renamed_from.database)
            if definition.renamed_from.database is not None
            else None,
            name=js_trim(definition.renamed_from.name),
        )

    return definition.model_copy(
        update={
            "database": js_trim(definition.database),
            "name": js_trim(definition.name),
            "renamed_from": renamed_from,
            "attributes": [
                _canonicalize_dictionary_attribute(a) for a in definition.attributes
            ],
            "primary_key": normalize_key_columns(
                definition.primary_key,
                {js_trim(attribute.name) for attribute in definition.attributes},
            ),
            "source": normalize_sql_fragment(definition.source),
            "layout": normalize_sql_fragment(definition.layout),
            "lifetime": normalize_sql_fragment(definition.lifetime),
            "range": DictionaryRange(
                min=js_trim(definition.range.min), max=js_trim(definition.range.max)
            )
            if definition.range is not None
            else None,
            "settings": settings,
            "comment": _canonicalize_comment(definition.comment),
        }
    )


def canonicalize_definition(
    definition: SchemaDefinition, *, index_granularity: int | None = None
) -> SchemaDefinition:
    """``index_granularity`` is what a MergeTree table that does not declare it
    gets: the server's MergeTree default, ``clickhouse.indexGranularity`` (8192
    when None)."""
    if isinstance(definition, TableDefinition):
        return _canonicalize_table(definition, index_granularity)
    if isinstance(definition, ViewDefinition):
        return _canonicalize_view(definition)
    if isinstance(definition, DictionaryDefinition):
        return _canonicalize_dictionary(definition)
    return _canonicalize_materialized_view(definition)


def definition_key(definition: SchemaDefinition) -> str:
    return f"{definition.kind}:{definition.database}.{definition.name}"


def canonicalize_definitions(
    definitions: Iterable[SchemaDefinition], *, index_granularity: int | None = None
) -> list[SchemaDefinition]:
    dedup: dict[str, SchemaDefinition] = {}
    for definition in definitions:
        normalized = canonicalize_definition(definition, index_granularity=index_granularity)
        dedup[definition_key(normalized)] = normalized

    return sorted(
        dedup.values(),
        key=lambda d: (_sort_kind(d.kind), d.database, d.name),
    )
