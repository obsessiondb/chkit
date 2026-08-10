"""Canonicalize definitions for stable comparison and key derivation."""

from __future__ import annotations

import re
from collections.abc import Iterable
from operator import attrgetter
from typing import Final, TypeVar

from chkit.core.codec import canonicalize_codec
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
    TableDefinition,
    TableRef,
    TableRenamedFrom,
    ViewDefinition,
)
from chkit.core.projection import canonicalize_projection
from chkit.core.sql_normalizer import normalize_engine, normalize_sql_fragment

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


def _canonicalize_column(column: ColumnDefinition) -> ColumnDefinition:
    type_value = column.type
    canon_type = type_value.strip() if isinstance(type_value, str) else type_value
    return column.model_copy(
        update={
            "name": column.name.strip(),
            "renamed_from": column.renamed_from.strip()
            if column.renamed_from is not None
            else None,
            "type": canon_type,
            "comment": column.comment.strip() if column.comment is not None else None,
            "codec": canonicalize_codec(column.codec) if column.codec is not None else None,
        }
    )


def _canonicalize_index(index: SkipIndexDefinition) -> SkipIndexDefinition:
    return index.model_copy(update={"expression": normalize_sql_fragment(index.expression)})


def _sorted_settings(
    settings: dict[str, str | int | float | bool] | None,
) -> dict[str, str | int | float | bool] | None:
    if settings is None:
        return None
    return {k: settings[k] for k in sorted(settings.keys())}


def _canonicalize_table(definition: TableDefinition) -> TableDefinition:
    settings = _sorted_settings(definition.settings)
    indexes = (
        [_canonicalize_index(idx) for idx in _sort_by_name(definition.indexes)]
        if definition.indexes is not None
        else None
    )
    projections = (
        [canonicalize_projection(p) for p in _sort_by_name(definition.projections)]
        if definition.projections is not None
        else None
    )
    renamed_from: TableRenamedFrom | None = None
    if definition.renamed_from is not None:
        renamed_from = TableRenamedFrom(
            database=definition.renamed_from.database.strip()
            if definition.renamed_from.database is not None
            else None,
            name=definition.renamed_from.name.strip(),
        )

    normalized_order_by = normalize_key_columns(definition.order_by)
    normalized_primary_key = normalize_key_columns(definition.primary_key)
    # TS canonical.ts: when primary_key is empty, fall back to order_by.
    # Without this, a snapshot written by TS (where omitted PK == order_by)
    # would never match a Python snapshot (where omitted PK == []).
    if not normalized_primary_key:
        normalized_primary_key = list(normalized_order_by)
    return definition.model_copy(
        update={
            "database": definition.database.strip(),
            "name": definition.name.strip(),
            "renamed_from": renamed_from,
            "engine": normalize_engine(definition.engine),
            "columns": [_canonicalize_column(c) for c in definition.columns],
            "primary_key": normalized_primary_key,
            "order_by": normalized_order_by,
            "unique_key": normalize_key_columns(definition.unique_key)
            if definition.unique_key is not None
            else None,
            "partition_by": normalize_sql_fragment(definition.partition_by)
            if definition.partition_by is not None
            else None,
            "ttl": normalize_sql_fragment(definition.ttl) if definition.ttl is not None else None,
            "settings": settings,
            "indexes": indexes,
            "projections": projections,
            "comment": definition.comment.strip() if definition.comment is not None else None,
        }
    )


def _canonicalize_view(definition: ViewDefinition) -> ViewDefinition:
    return definition.model_copy(
        update={
            "database": definition.database.strip(),
            "name": definition.name.strip(),
            "as_": normalize_sql_fragment(definition.as_),
            "comment": definition.comment.strip() if definition.comment is not None else None,
        }
    )


_INTERVAL_UNIT_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\b(second|minute|hour|day|week|month|year)s?\b", re.IGNORECASE
)


def _canonicalize_interval(value: str | None) -> str | None:
    if value is None:
        return None
    collapsed = re.sub(r"\s+", " ", value).strip()

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
                TableRef(database=dep.database.strip(), name=dep.name.strip())
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
            "database": definition.database.strip(),
            "name": definition.name.strip(),
            "to": TableRef(
                database=definition.to.database.strip(),
                name=definition.to.name.strip(),
            ),
            "as_": normalize_sql_fragment(definition.as_),
            "comment": definition.comment.strip() if definition.comment is not None else None,
            "refresh": canonical_refresh,
        }
    )


def _canonicalize_dictionary_attribute(
    attribute: DictionaryAttribute,
) -> DictionaryAttribute:
    type_value = attribute.type
    canon_type = type_value.strip() if isinstance(type_value, str) else type_value
    return attribute.model_copy(
        update={"name": attribute.name.strip(), "type": canon_type}
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
            database=definition.renamed_from.database.strip()
            if definition.renamed_from.database is not None
            else None,
            name=definition.renamed_from.name.strip(),
        )

    return definition.model_copy(
        update={
            "database": definition.database.strip(),
            "name": definition.name.strip(),
            "renamed_from": renamed_from,
            "attributes": [
                _canonicalize_dictionary_attribute(a) for a in definition.attributes
            ],
            "primary_key": normalize_key_columns(definition.primary_key),
            "source": normalize_sql_fragment(definition.source),
            "layout": normalize_sql_fragment(definition.layout),
            "lifetime": normalize_sql_fragment(definition.lifetime),
            "range": DictionaryRange(
                min=definition.range.min.strip(), max=definition.range.max.strip()
            )
            if definition.range is not None
            else None,
            "settings": settings,
            "comment": definition.comment.strip()
            if definition.comment is not None
            else None,
        }
    )


def canonicalize_definition(definition: SchemaDefinition) -> SchemaDefinition:
    if isinstance(definition, TableDefinition):
        return _canonicalize_table(definition)
    if isinstance(definition, ViewDefinition):
        return _canonicalize_view(definition)
    if isinstance(definition, DictionaryDefinition):
        return _canonicalize_dictionary(definition)
    return _canonicalize_materialized_view(definition)


def definition_key(definition: SchemaDefinition) -> str:
    return f"{definition.kind}:{definition.database}.{definition.name}"


def canonicalize_definitions(definitions: Iterable[SchemaDefinition]) -> list[SchemaDefinition]:
    dedup: dict[str, SchemaDefinition] = {}
    for definition in definitions:
        normalized = canonicalize_definition(definition)
        dedup[definition_key(normalized)] = normalized

    return sorted(
        dedup.values(),
        key=lambda d: (_sort_kind(d.kind), d.database, d.name),
    )
