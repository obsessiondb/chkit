"""Validation rules for schema definitions."""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Final

from chkit.core.canonical import definition_key
from chkit.core.codec import canonicalize_codec, is_general_codec, is_raw_codec
from chkit.core.key_clause import is_plain_column_reference, normalize_key_columns
from chkit.core.model import (
    ChxValidationError,
    ColumnDefinition,
    DictionaryDefinition,
    MaterializedViewDefinition,
    SchemaDefinition,
    TableDefinition,
    ValidationIssue,
    ValidationIssueCode,
)
from chkit.core.projection import is_index_projection, normalize_projection_index


def _push(
    issues: list[ValidationIssue],
    definition: SchemaDefinition,
    code: ValidationIssueCode,
    message: str,
) -> None:
    issues.append(
        ValidationIssue(
            code=code,
            kind=definition.kind,
            database=definition.database,
            name=definition.name,
            message=message,
        )
    )


def _validate_column_codec(
    definition: TableDefinition, column: ColumnDefinition, issues: list[ValidationIssue]
) -> None:
    if column.codec is None:
        return
    steps = canonicalize_codec(column.codec)
    if len(steps) == 0:
        _push(
            issues,
            definition,
            "codec_chain_empty",
            f'Table {definition.database}.{definition.name} column "{column.name}" '
            f"codec chain is empty; provide at least one codec or omit the field",
        )
        return

    general_count = 0
    general_index = -1
    for i, step in enumerate(steps):
        if is_raw_codec(step):
            continue
        if is_general_codec(step):
            general_count += 1
            general_index = i

    if general_count > 1:
        _push(
            issues,
            definition,
            "codec_chain_multiple_general",
            f'Table {definition.database}.{definition.name} column "{column.name}" '
            f"codec chain has more than one general codec; only one general codec is "
            f"allowed at the end of a chain",
        )
        return

    if len(steps) > 1 and general_count == 1 and general_index != len(steps) - 1:
        _push(
            issues,
            definition,
            "codec_chain_must_end_with_general",
            f'Table {definition.database}.{definition.name} column "{column.name}" '
            f"codec chain must end with a general codec "
            f"(NONE, LZ4, LZ4HC, ZSTD, T64, GCD, ALP)",
        )


def _validate_table(definition: TableDefinition, issues: list[ValidationIssue]) -> None:
    column_seen: set[str] = set()
    column_set: set[str] = set()
    for column in definition.columns:
        if column.name in column_seen:
            _push(
                issues,
                definition,
                "duplicate_column_name",
                f'Table {definition.database}.{definition.name} '
                f'has duplicate column name "{column.name}"',
            )
            continue
        column_seen.add(column.name)
        column_set.add(column.name)
        _validate_column_codec(definition, column, issues)

    index_seen: set[str] = set()
    for index in definition.indexes or []:
        if index.name in index_seen:
            _push(
                issues,
                definition,
                "duplicate_index_name",
                f'Table {definition.database}.{definition.name} '
                f'has duplicate index name "{index.name}"',
            )
            continue
        index_seen.add(index.name)

    projection_seen: set[str] = set()
    for projection in definition.projections or []:
        if projection.name in projection_seen:
            _push(
                issues,
                definition,
                "duplicate_projection_name",
                f'Table {definition.database}.{definition.name} '
                f'has duplicate projection name "{projection.name}"',
            )
            continue
        projection_seen.add(projection.name)

        # A projection carrying both keys satisfies the model, so Pydantic
        # admits it. Renders as index-only and drops the SELECT body on the
        # floor.
        if projection.index is not None and projection.query is not None:
            _push(
                issues,
                definition,
                "projection_ambiguous_kind",
                f'Table {definition.database}.{definition.name} projection '
                f'"{projection.name}" sets both "query" and "index"; use '
                f'"query" for a SELECT projection or "index"/"type" for an '
                f"index-only projection",
            )
            continue

        if (
            is_index_projection(projection)
            and normalize_projection_index(projection.index or "") == ""
        ):
            _push(
                issues,
                definition,
                "projection_empty_index",
                f'Table {definition.database}.{definition.name} projection '
                f'"{projection.name}" has an empty index expression',
            )

    for col in normalize_key_columns(definition.primary_key):
        if is_plain_column_reference(col) and col not in column_set:
            _push(
                issues,
                definition,
                "primary_key_missing_column",
                f"Table {definition.database}.{definition.name} primaryKey "
                f'references missing column "{col}"',
            )

    for col in normalize_key_columns(definition.order_by):
        if is_plain_column_reference(col) and col not in column_set:
            _push(
                issues,
                definition,
                "order_by_missing_column",
                f"Table {definition.database}.{definition.name} orderBy "
                f'references missing column "{col}"',
            )


_INTERVAL_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^\s*\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)"
    r"(\s+\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR))*\s*$",
    re.IGNORECASE,
)

_REPLICATED_ENGINE_PATTERN: Final[re.Pattern[str]] = re.compile(r"^(Shared|Replicated)")


def _validate_interval(
    definition: MaterializedViewDefinition,
    issues: list[ValidationIssue],
    field: str,
    value: str | None,
) -> None:
    if value is None:
        return
    if _INTERVAL_PATTERN.match(value) is None:
        _push(
            issues,
            definition,
            "refresh_interval_format",
            f"Materialized view {definition.database}.{definition.name} "
            f'refresh.{field} "{value}" is not a valid interval '
            f'(expected e.g. "1 HOUR", "30 SECOND")',
        )


def _validate_materialized_view(
    definition: MaterializedViewDefinition,
    issues: list[ValidationIssue],
    definitions: list[SchemaDefinition],
) -> None:
    refresh = definition.refresh
    if refresh is None:
        return

    has_every = refresh.every is not None and len(refresh.every) > 0
    has_after = refresh.after is not None and len(refresh.after) > 0
    if not has_every and not has_after:
        _push(
            issues,
            definition,
            "refresh_requires_every_or_after",
            f"Materialized view {definition.database}.{definition.name} refresh "
            f'requires exactly one of "every" or "after"',
        )
    elif has_every and has_after:
        _push(
            issues,
            definition,
            "refresh_every_after_mutually_exclusive",
            f"Materialized view {definition.database}.{definition.name} refresh "
            f'specifies both "every" and "after"; choose one',
        )

    _validate_interval(definition, issues, "every", refresh.every)
    _validate_interval(definition, issues, "after", refresh.after)
    _validate_interval(definition, issues, "offset", refresh.offset)
    _validate_interval(definition, issues, "randomize", refresh.randomize)

    if (
        refresh.depends_on is not None
        and len(refresh.depends_on) > 0
        and has_after
        and not has_every
    ):
        _push(
            issues,
            definition,
            "refresh_depends_on_requires_every",
            f"Materialized view {definition.database}.{definition.name} uses "
            f"DEPENDS ON with REFRESH AFTER; ClickHouse only allows DEPENDS ON "
            f"with REFRESH EVERY.",
        )

    if not refresh.append:
        target: TableDefinition | None = None
        for other in definitions:
            if (
                isinstance(other, TableDefinition)
                and other.database == definition.to.database
                and other.name == definition.to.name
            ):
                target = other
                break
        if target is not None and _REPLICATED_ENGINE_PATTERN.match(target.engine) is not None:
            _push(
                issues,
                definition,
                "refresh_append_required_for_replicated_target",
                f"Materialized view {definition.database}.{definition.name} refreshes "
                f"a replicated target {target.database}.{target.name} ({target.engine}) "
                f"without APPEND. ClickHouse rejects this combination. Set "
                f"refresh.append = true, or target a non-replicated table.",
            )


def _validate_dictionary(  # noqa: PLR0912
    definition: DictionaryDefinition, issues: list[ValidationIssue]
) -> None:
    attribute_seen: set[str] = set()
    attribute_set: set[str] = set()
    for attribute in definition.attributes:
        if attribute.name in attribute_seen:
            _push(
                issues,
                definition,
                "duplicate_column_name",
                f"Dictionary {definition.database}.{definition.name} "
                f'has duplicate attribute name "{attribute.name}"',
            )
            continue
        attribute_seen.add(attribute.name)
        attribute_set.add(attribute.name)

        if attribute.default is not None and attribute.expression is not None:
            _push(
                issues,
                definition,
                "dictionary_attribute_default_expression_exclusive",
                f"Dictionary {definition.database}.{definition.name} attribute "
                f'"{attribute.name}" sets both "default" and "expression"; choose one',
            )

        if attribute.bidirectional and not attribute.hierarchical:
            _push(
                issues,
                definition,
                "dictionary_bidirectional_requires_hierarchical",
                f"Dictionary {definition.database}.{definition.name} attribute "
                f'"{attribute.name}" sets "bidirectional" without "hierarchical"; '
                f"bidirectional only applies to hierarchical attributes",
            )

    if len(definition.primary_key) == 0:
        _push(
            issues,
            definition,
            "dictionary_missing_primary_key",
            f"Dictionary {definition.database}.{definition.name} "
            f"requires a non-empty primaryKey",
        )
    else:
        for column in definition.primary_key:
            if column not in attribute_set:
                _push(
                    issues,
                    definition,
                    "dictionary_primary_key_missing_attribute",
                    f"Dictionary {definition.database}.{definition.name} primaryKey "
                    f'references missing attribute "{column}"',
                )

    if len(definition.source.strip()) == 0:
        _push(
            issues,
            definition,
            "dictionary_missing_source",
            f"Dictionary {definition.database}.{definition.name} "
            f'requires a non-empty "source"',
        )

    if len(definition.layout.strip()) == 0:
        _push(
            issues,
            definition,
            "dictionary_missing_layout",
            f"Dictionary {definition.database}.{definition.name} "
            f'requires a non-empty "layout"',
        )

    if len(definition.lifetime.strip()) == 0:
        _push(
            issues,
            definition,
            "dictionary_missing_lifetime",
            f"Dictionary {definition.database}.{definition.name} "
            f'requires a non-empty "lifetime"',
        )

    if definition.range is not None:
        for column in (definition.range.min, definition.range.max):
            if column not in attribute_set:
                _push(
                    issues,
                    definition,
                    "dictionary_range_missing_attribute",
                    f"Dictionary {definition.database}.{definition.name} range "
                    f'references missing attribute "{column}"',
                )


def validate_definitions(definitions: Iterable[SchemaDefinition]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    object_keys: set[str] = set()
    materialized: list[SchemaDefinition] = list(definitions)
    for definition in materialized:
        key = definition_key(definition)
        if key in object_keys:
            _push(
                issues,
                definition,
                "duplicate_object_name",
                f'Duplicate schema object definition '
                f'"{definition.kind}:{definition.database}.{definition.name}"',
            )
            continue
        object_keys.add(key)

        if isinstance(definition, TableDefinition):
            _validate_table(definition, issues)
        elif isinstance(definition, MaterializedViewDefinition):
            _validate_materialized_view(definition, issues, materialized)
        elif isinstance(definition, DictionaryDefinition):
            _validate_dictionary(definition, issues)

    return issues


def assert_valid_definitions(definitions: Iterable[SchemaDefinition]) -> None:
    issues = validate_definitions(definitions)
    if len(issues) > 0:
        raise ChxValidationError(issues)
