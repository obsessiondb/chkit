"""Compare expected (snapshot) vs. actual (introspected) schema shapes.

1:1 port of ``packages/cli/src/commands/drift/compare.ts``.

``compare_schema_objects`` operates on object refs (kind + db + name)
and produces missing/extra/kind-mismatch buckets.

``compare_table_shape`` produces a ``TableDriftDetail`` with per-aspect
mismatches (columns, settings, indexes, TTL, engine, keys, partition by,
projections). Returns ``None`` when shapes are identical.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Protocol, TypeAlias

from chkit.cli.commands.drift_diff import (
    diff_by_name,
    diff_named_shape_maps,
    diff_settings,
)
from chkit.clickhouse.introspect import IntrospectedTable, SchemaObjectKind
from chkit.core.column_default import render_default
from chkit.core.identifier import unquote_identifiers
from chkit.core.kafka import is_kafka_engine, kafka_setting_fingerprint, parse_kafka_settings
from chkit.core.key_clause import split_top_level_comma
from chkit.core.model import (
    ColumnDefinition,
    ProjectionDefinition,
    SkipIndexDefinition,
    TableDefinition,
)
from chkit.core.projection import is_index_projection, normalize_projection_index
from chkit.core.sql import render_key_clause_columns
from chkit.core.sql_lexer import JS_WHITESPACE_RUN, js_trim
from chkit.core.sql_normalizer import (
    is_synthetic_ephemeral_default,
    normalize_engine,
    normalize_sql_fragment,
    sql_expression_fingerprint,
)
from chkit.core.text_index import render_text_index_type, text_index_fingerprint

ObjectDriftReasonCode: TypeAlias = Literal[
    "missing_object", "extra_object", "kind_mismatch"
]

TableDriftReasonCode: TypeAlias = Literal[
    "missing_column",
    "extra_column",
    "changed_column",
    "setting_mismatch",
    "index_mismatch",
    "ttl_mismatch",
    "engine_mismatch",
    "primary_key_mismatch",
    "order_by_mismatch",
    "partition_by_mismatch",
    "unique_key_mismatch",
    "projection_mismatch",
]

DriftReasonCode: TypeAlias = ObjectDriftReasonCode | TableDriftReasonCode


class SqlCanonicalizer(Protocol):
    """Canonicalizes SQL fragments to the exact form ClickHouse stores.

    A schema fragment then compares equal to what a live table reports even when
    the two are spelled differently (``cityHash64(a,b)`` vs ``cityHash64(a, b)``,
    ``n*2+1`` vs ``(n * 2) + 1``, ``INTERVAL 5 YEAR`` vs ``toIntervalYear(5)``).
    Only ClickHouse's own formatter can produce this, so it is injected by the
    drift command; when it is absent (offline, or a fragment ClickHouse couldn't
    parse) each field falls back to plain string normalization (#195).
    """

    def expression(self, fragment: str) -> str | None: ...

    def query(self, fragment: str) -> str | None: ...


@dataclass(frozen=True, slots=True)
class MapSqlCanonicalizer:
    """A canonicalizer backed by pre-formatted fragment maps."""

    expressions: dict[str, str]
    queries: dict[str, str]

    def expression(self, fragment: str) -> str | None:
        return self.expressions.get(fragment)

    def query(self, fragment: str) -> str | None:
        return self.queries.get(fragment)


@dataclass(frozen=True, slots=True)
class TableSqlFragments:
    expressions: list[str]
    queries: list[str]


def _canonicalize_expression(base: str, canonicalizer: SqlCanonicalizer | None) -> str:
    if canonicalizer is None:
        return base
    canonical = canonicalizer.expression(base)
    return base if canonical is None else canonical


@dataclass(frozen=True, slots=True)
class SchemaObjectShape:
    kind: SchemaObjectKind
    database: str
    name: str


@dataclass(frozen=True, slots=True)
class KindMismatch:
    object: str
    expected: SchemaObjectKind
    actual: SchemaObjectKind


@dataclass(frozen=True, slots=True)
class ObjectDriftDetail:
    code: ObjectDriftReasonCode
    object: str
    expected_kind: SchemaObjectKind | None = None
    actual_kind: SchemaObjectKind | None = None


@dataclass(frozen=True, slots=True)
class CompareSchemaObjectsResult:
    missing: list[str]
    extra: list[str]
    kind_mismatches: list[KindMismatch]
    object_drift: list[ObjectDriftDetail]


@dataclass(frozen=True, slots=True)
class TableDriftDetail:
    table: str
    reason_codes: list[TableDriftReasonCode]
    missing_columns: list[str]
    extra_columns: list[str]
    changed_columns: list[str]
    setting_diffs: list[str]
    index_diffs: list[str]
    ttl_mismatch: bool
    engine_mismatch: bool
    primary_key_mismatch: bool
    order_by_mismatch: bool
    unique_key_mismatch: bool
    partition_by_mismatch: bool
    projection_diffs: list[str]


@dataclass(frozen=True, slots=True)
class DriftReasonSummary:
    counts: dict[DriftReasonCode, int]
    total: int
    object: int
    table: int


def _schema_object_key(item: SchemaObjectShape) -> str:
    return f"{item.kind}:{item.database}.{item.name}"


def compare_schema_objects(
    expected_objects: list[SchemaObjectShape],
    actual_objects: list[SchemaObjectShape],
) -> CompareSchemaObjectsResult:
    """Set-diff expected vs actual at the (kind, database, name) level."""
    expected_map = {_schema_object_key(item): item.kind for item in expected_objects}
    actual_map = {_schema_object_key(item): item.kind for item in actual_objects}

    missing: list[str] = []
    extra: list[str] = []
    kind_mismatches: list[KindMismatch] = []
    object_drift: list[ObjectDriftDetail] = []

    for key, expected_kind in expected_map.items():
        rest = key[key.index(":") + 1 :]
        if key in actual_map:
            continue

        same_object_different_kind: tuple[str, SchemaObjectKind] | None = None
        for actual_key, actual_kind in actual_map.items():
            if actual_key.endswith(f":{rest}"):
                same_object_different_kind = (actual_key, actual_kind)
                break

        if same_object_different_kind is not None:
            mismatch = KindMismatch(
                object=rest,
                expected=expected_kind,
                actual=same_object_different_kind[1],
            )
            kind_mismatches.append(mismatch)
            object_drift.append(
                ObjectDriftDetail(
                    code="kind_mismatch",
                    object=rest,
                    expected_kind=mismatch.expected,
                    actual_kind=mismatch.actual,
                )
            )
            continue

        missing.append(key)
        object_drift.append(
            ObjectDriftDetail(
                code="missing_object",
                object=key,
                expected_kind=expected_kind,
            )
        )

    for key, kind in actual_map.items():
        if key in expected_map:
            continue
        rest = key[key.index(":") + 1 :]
        if any(ek.endswith(f":{rest}") for ek in expected_map):
            continue
        extra.append(key)
        object_drift.append(
            ObjectDriftDetail(
                code="extra_object",
                object=key,
                actual_kind=kind,
            )
        )

    return CompareSchemaObjectsResult(
        missing=missing,
        extra=extra,
        kind_mismatches=kind_mismatches,
        object_drift=object_drift,
    )


def summarize_drift_reasons(
    object_drift: list[ObjectDriftDetail],
    table_drift: list[TableDriftDetail],
) -> DriftReasonSummary:
    """Aggregate per-reason counts across object and table drift."""
    counts: dict[DriftReasonCode, int] = {}
    object_count = 0
    table_count = 0

    for item in object_drift:
        counts[item.code] = counts.get(item.code, 0) + 1
        object_count += 1

    for table_item in table_drift:
        for code in table_item.reason_codes:
            counts[code] = counts.get(code, 0) + 1
            table_count += 1

    return DriftReasonSummary(
        counts=counts,
        total=object_count + table_count,
        object=object_count,
        table=table_count,
    )


def _normalize_column_shape(column: ColumnDefinition) -> str:
    rendered = None if column.default is None else render_default(column.default)
    # ClickHouse stores a bare EPHEMERAL column as defaultValueOfTypeName('<type>'),
    # which introspection reads back as no expression; an explicit one matches it.
    normalized_default = (
        ""
        if rendered is None
        or (column.default_kind == "EPHEMERAL" and is_synthetic_ephemeral_default(rendered))
        else sql_expression_fingerprint(rendered)
    )

    parts = [
        f"type={str(column.type).strip()}",
        f"nullable={'1' if column.nullable else '0'}",
        f"default={normalized_default}",
        f"defaultKind={column.default_kind or 'DEFAULT'}",
        f"comment={(column.comment or '').strip()}",
    ]
    return "|".join(parts)


def _render_index_type_fingerprint(index: SkipIndexDefinition) -> str:
    if index.type == "text":
        return render_text_index_type(index)
    if index.type == "minmax":
        return "minmax"
    if index.type == "set":
        return f"set({index.max_rows})"
    if index.type == "bloom_filter":
        return (
            f"bloom_filter({index.false_positive_rate})"
            if index.false_positive_rate is not None
            else "bloom_filter"
        )
    if index.type == "tokenbf_v1":
        return (
            f"tokenbf_v1({index.size_bytes}, "
            f"{index.hash_functions}, {index.random_seed})"
        )
    return (
        f"ngrambf_v1({index.ngram_size}, {index.size_bytes}, "
        f"{index.hash_functions}, {index.random_seed})"
    )


def _strip_enclosing_parens(value: str) -> str:
    """Drop one pair of parentheses only when it encloses the whole value.

    chkit renders ``INDEX name (expr)`` and ClickHouse keeps those parentheses
    in ``system.data_skipping_indices.expr``; ``(a) || (b)`` stays as written.
    """
    if not (value.startswith("(") and value.endswith(")")):
        return value
    depth = 0
    for i, ch in enumerate(value):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if depth == 0 and i < len(value) - 1:
            return value
    return value[1:-1].strip()


def _index_expression_base(index: SkipIndexDefinition) -> str:
    return _strip_enclosing_parens(normalize_sql_fragment(index.expression))


def _normalize_index_shape(
    index: SkipIndexDefinition, canonicalizer: SqlCanonicalizer | None = None
) -> str:
    if index.type == "text":
        return text_index_fingerprint(index)
    expression = _canonicalize_expression(_index_expression_base(index), canonicalizer)
    return "|".join(
        [
            f"expr={expression}",
            f"type={_render_index_type_fingerprint(index)}",
            f"granularity={index.granularity}",
        ]
    )


def _normalize_projection_shape(
    projection: ProjectionDefinition, canonicalizer: SqlCanonicalizer | None = None
) -> str:
    if is_index_projection(projection):
        type_text = projection.type.strip() if projection.type is not None else ""
        return "|".join(
            [
                f"index={normalize_projection_index(projection.index or '')}",
                f"type={type_text}",
            ]
        )
    base = normalize_sql_fragment(projection.query or "")
    canonical = canonicalizer.query(base) if canonicalizer is not None else None
    return f"query={base if canonical is None else canonical}"


_WRAPPED_RE = re.compile(r"^\((.*)\)$")


def _normalize_clause(value: str | None, canonicalizer: SqlCanonicalizer | None = None) -> str:
    # Key and partition clauses are compared as SQL: comments are removed while
    # quoted names still carry their backticks (#232), then the names are
    # unquoted, since ClickHouse re-renders identifiers with its own quoting and
    # escaping, and one pair of parentheses around the whole clause is dropped.
    # From there on only whitespace is collapsed: unquoted, `user--id` would
    # read as `user` followed by a comment. For the same reason a canonicalizer
    # sees each element while its names are still quoted.
    if not value:
        return ""
    sql = normalize_sql_fragment(value)
    canonical = (
        ", ".join(
            _canonicalize_expression(element, canonicalizer) for element in _clause_elements(sql)
        )
        if canonicalizer is not None
        else sql
    )
    unquoted = js_trim(JS_WHITESPACE_RUN.sub(" ", unquote_identifiers(canonical)))
    wrapped = _WRAPPED_RE.match(unquoted)
    return js_trim(wrapped.group(1)) if wrapped is not None and wrapped.group(1) else unquoted


def _clause_elements(sql: str) -> list[str]:
    """The elements of a key/partition clause, canonicalized one by one so a
    function expression (``cityHash64(a,b)``) matches ClickHouse's spelling."""
    wrapped = _WRAPPED_RE.match(sql)
    return split_top_level_comma(wrapped.group(1) if wrapped is not None else sql)


def _table_clauses(
    expected: TableDefinition, actual: IntrospectedTable
) -> dict[str, tuple[str | None, str | None]]:
    """The key/partition clauses compared for a table, schema side vs live side."""
    # ClickHouse derives PRIMARY KEY from ORDER BY when it is omitted, then
    # omits it from SHOW CREATE — so a table with only ORDER BY reports no
    # primary key. Mirror that on both sides (as canonical.py does for the
    # schema), else every such table drifts forever (#194).
    # Keys compare as chkit renders them (backticked names), so a comment
    # marker inside a column name (`user--id`) is not read as a comment (#232).
    column_names = {column.name for column in expected.columns}

    def rendered_keys(columns: list[str] | None) -> str:
        return render_key_clause_columns(columns or [], column_names)

    return {
        # `is not None` (not truthiness) mirrors TS `actual.primaryKey ?? actual.orderBy`:
        # an empty-string primary key must compare as-is, not fall back.
        "primary_key": (
            rendered_keys(expected.primary_key if expected.primary_key else expected.order_by),
            actual.primary_key if actual.primary_key is not None else actual.order_by,
        ),
        "order_by": (rendered_keys(expected.order_by), actual.order_by),
        "unique_key": (rendered_keys(expected.unique_key), actual.unique_key),
        "partition_by": (expected.partition_by, actual.partition_by),
    }


def _normalize_engine_for_compare(value: str | None) -> str:
    if not value:
        return ""
    return normalize_engine(normalize_sql_fragment(value)).lower()


def collect_table_sql_fragments(
    expected: TableDefinition, actual: IntrospectedTable
) -> TableSqlFragments:
    """Every SQL fragment ``compare_table_shape`` will look up in a canonicalizer.

    Collected at the exact granularity it looks them up (whole expressions for
    index/ttl, per-element for key/partition clauses, whole query for SELECT
    projections). The drift command collects these across all compared tables,
    formats them in one round-trip, and hands back a map-backed canonicalizer.
    """
    expressions = [
        _index_expression_base(index)
        for index in [*(expected.indexes or []), *actual.indexes]
        if index.type != "text"
    ]
    expressions.extend(normalize_sql_fragment(ttl) for ttl in (expected.ttl, actual.ttl) if ttl)
    for pair in _table_clauses(expected, actual).values():
        for clause in pair:
            if clause:
                expressions.extend(_clause_elements(normalize_sql_fragment(clause)))
    queries = [
        normalize_sql_fragment(projection.query or "")
        for projection in [*(expected.projections or []), *actual.projections]
        if not is_index_projection(projection)
    ]

    return TableSqlFragments(expressions=expressions, queries=queries)


def compare_table_shape(  # noqa: PLR0912, PLR0915
    expected: TableDefinition,
    actual: IntrospectedTable,
    canonicalizer: SqlCanonicalizer | None = None,
) -> TableDriftDetail | None:
    """Compare every shape-bearing field on the table. Returns None if identical."""
    column_diff = diff_by_name(
        expected.columns,
        [
            column.model_copy(update={"default": f"fn:{column.default}"})
            if isinstance(column.default, str) and not column.default.startswith("fn:")
            else column
            for column in actual.columns
        ],
        lambda c: c.name,
        _normalize_column_shape,
    )
    missing_columns = column_diff.missing
    extra_columns = column_diff.extra
    changed_columns = column_diff.changed

    if is_kafka_engine(expected.engine):
        expected_settings = {
            key: kafka_setting_fingerprint(value)
            for key, value in (expected.settings or {}).items()
        }
        actual_settings = {
            key: kafka_setting_fingerprint(value)
            for key, value in parse_kafka_settings(actual.settings).items()
        }
        setting_diffs = diff_settings(expected_settings, actual_settings)
    else:
        setting_diffs = diff_settings(expected.settings or {}, actual.settings)

    expected_indexes = {
        idx.name: _normalize_index_shape(idx, canonicalizer) for idx in (expected.indexes or [])
    }
    actual_indexes = {
        idx.name: _normalize_index_shape(idx, canonicalizer) for idx in actual.indexes
    }
    index_diffs = diff_named_shape_maps(expected_indexes, actual_indexes)

    expected_ttl = _canonicalize_expression(
        normalize_sql_fragment(expected.ttl) if expected.ttl else "", canonicalizer
    )
    actual_ttl = _canonicalize_expression(
        normalize_sql_fragment(actual.ttl) if actual.ttl else "", canonicalizer
    )
    ttl_mismatch = expected_ttl != actual_ttl

    engine_mismatch = _normalize_engine_for_compare(
        expected.engine
    ) != _normalize_engine_for_compare(actual.engine)

    clauses = _table_clauses(expected, actual)
    expected_pk = _normalize_clause(clauses["primary_key"][0], canonicalizer)
    actual_pk = _normalize_clause(clauses["primary_key"][1], canonicalizer)
    primary_key_mismatch = expected_pk != actual_pk

    expected_order_by = _normalize_clause(clauses["order_by"][0], canonicalizer)
    actual_order_by = _normalize_clause(clauses["order_by"][1], canonicalizer)
    order_by_mismatch = expected_order_by != actual_order_by

    expected_unique_key = _normalize_clause(clauses["unique_key"][0], canonicalizer)
    actual_unique_key = _normalize_clause(clauses["unique_key"][1], canonicalizer)
    unique_key_mismatch = expected_unique_key != actual_unique_key

    expected_partition_by = _normalize_clause(clauses["partition_by"][0], canonicalizer)
    actual_partition_by = _normalize_clause(clauses["partition_by"][1], canonicalizer)
    partition_by_mismatch = expected_partition_by != actual_partition_by

    expected_projections = {
        p.name: _normalize_projection_shape(p, canonicalizer)
        for p in (expected.projections or [])
    }
    actual_projections = {
        p.name: _normalize_projection_shape(p, canonicalizer) for p in actual.projections
    }
    projection_diffs = diff_named_shape_maps(expected_projections, actual_projections)

    reason_codes: list[TableDriftReasonCode] = []
    if missing_columns:
        reason_codes.append("missing_column")
    if extra_columns:
        reason_codes.append("extra_column")
    if changed_columns:
        reason_codes.append("changed_column")
    if setting_diffs:
        reason_codes.append("setting_mismatch")
    if index_diffs:
        reason_codes.append("index_mismatch")
    if ttl_mismatch:
        reason_codes.append("ttl_mismatch")
    if engine_mismatch:
        reason_codes.append("engine_mismatch")
    if primary_key_mismatch:
        reason_codes.append("primary_key_mismatch")
    if order_by_mismatch:
        reason_codes.append("order_by_mismatch")
    if unique_key_mismatch:
        reason_codes.append("unique_key_mismatch")
    if partition_by_mismatch:
        reason_codes.append("partition_by_mismatch")
    if projection_diffs:
        reason_codes.append("projection_mismatch")

    if not reason_codes:
        return None

    return TableDriftDetail(
        table=f"{expected.database}.{expected.name}",
        reason_codes=reason_codes,
        missing_columns=sorted(missing_columns),
        extra_columns=sorted(extra_columns),
        changed_columns=sorted(changed_columns),
        setting_diffs=setting_diffs,
        index_diffs=index_diffs,
        ttl_mismatch=ttl_mismatch,
        engine_mismatch=engine_mismatch,
        primary_key_mismatch=primary_key_mismatch,
        order_by_mismatch=order_by_mismatch,
        unique_key_mismatch=unique_key_mismatch,
        partition_by_mismatch=partition_by_mismatch,
        projection_diffs=projection_diffs,
    )
