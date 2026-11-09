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
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol, TypeAlias

from chkit.cli.commands.drift_diff import (
    diff_by_name,
    diff_named_shape_maps,
    diff_settings,
)
from chkit.cli.logging_setup import debug
from chkit.clickhouse.create_dictionary_parser import (
    parse_attribute_list_text_from_create_dictionary_query,
    parse_dictionary_primary_key_from_create_dictionary_query,
    parse_dictionary_range_from_create_dictionary_query,
    parse_dictionary_settings_from_create_dictionary_query,
    parse_layout_from_create_dictionary_query,
    parse_lifetime_from_create_dictionary_query,
    parse_source_from_create_dictionary_query,
    replace_source_in_create_dictionary_query,
)
from chkit.clickhouse.introspect import (
    IntrospectedDictionary,
    IntrospectedTable,
    IntrospectedView,
    SchemaObjectKind,
)
from chkit.clickhouse.replicas import string_literal
from chkit.core.column_default import literal_default_fingerprint, render_default
from chkit.core.constraint import constraint_expression, constraint_kind
from chkit.core.jsnum import js_number_to_string
from chkit.core.kafka import is_kafka_engine, kafka_setting_fingerprint, parse_kafka_settings
from chkit.core.key_clause import key_clause_fingerprint, split_top_level_comma
from chkit.core.model import (
    ColumnDefinition,
    DictionaryDefinition,
    MaterializedViewDefinition,
    ProjectionDefinition,
    SkipIndexDefinition,
    SkipIndexRaw,
    SkipIndexVectorSimilarity,
    TableConstraintDefinition,
    TableDefinition,
    ViewDefinition,
)
from chkit.core.projection import is_index_projection, normalize_projection_index
from chkit.core.sql import (
    column_codec_fingerprint,
    column_type_fingerprint,
    render_dictionary_sql,
    render_key_clause_columns,
)
from chkit.core.sql_lexer import (
    SQLToken,
    identifier_name,
    is_trivia,
    js_trim,
    string_literal_value,
    tokenize_sql,
)
from chkit.core.sql_normalizer import (
    is_synthetic_ephemeral_default,
    normalize_engine,
    normalize_sql_fragment,
    sql_expression_fingerprint,
)
from chkit.core.sql_scan import find_matching_paren
from chkit.core.table_settings import DEFAULT_INDEX_GRANULARITY, with_default_index_granularity
from chkit.core.text_index import render_text_index_type, text_index_fingerprint
from chkit.core.vector_index import render_vector_index_type

ObjectDriftReasonCode: TypeAlias = Literal[
    "missing_object",
    "extra_object",
    "kind_mismatch",
    "query_mismatch",
    "target_mismatch",
    "comment_mismatch",
    "source_mismatch",
    "structure_mismatch",
    "layout_mismatch",
    "lifetime_mismatch",
    "dictionary_setting_mismatch",
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
    "constraint_mismatch",
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
    comment: str | None = None


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
    # Any code that compares two values: the schema's value and the live one.
    expected: str | None = None
    actual: str | None = None


# What ClickHouse stores in place of a secret in a view's query or a dictionary's source.
_HIDDEN_SECRET = "'[HIDDEN]'"


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
    constraint_diffs: list[str]


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


def compare_object_comments(
    expected_objects: list[SchemaObjectShape],
    actual_objects: list[SchemaObjectShape],
) -> list[ObjectDriftDetail]:
    """Compare the comment of every object that exists on both sides with the same kind.

    Covers tables, views, materialized views and dictionaries. The live comment
    is ``system.tables.comment``, which ClickHouse has already decoded.
    """
    actual_comments = {_schema_object_key(item): item.comment for item in actual_objects}
    drift: list[ObjectDriftDetail] = []
    for item in expected_objects:
        actual = actual_comments.get(_schema_object_key(item))
        if actual is None:
            continue
        expected_comment = js_trim(item.comment or "")
        actual_comment = js_trim(actual)
        if expected_comment == actual_comment:
            continue
        drift.append(
            ObjectDriftDetail(
                code="comment_mismatch",
                object=f"{item.database}.{item.name}",
                expected=expected_comment,
                actual=actual_comment,
            )
        )
    return drift


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
        else (literal_default_fingerprint(rendered) or sql_expression_fingerprint(rendered))
    )

    # Introspection unwraps Nullable(T) into type=T plus nullable=True, and
    # ClickHouse spaces the type its own way (``Decimal(10, 2)``).
    parts = [
        f"type={column_type_fingerprint(column)}",
        f"default={normalized_default}",
        f"defaultKind={column.default_kind or 'DEFAULT'}",
        f"comment={(column.comment or '').strip()}",
        f"codec={column_codec_fingerprint(column)}",
    ]
    return "|".join(parts)


def _render_index_type_fingerprint(index: SkipIndexDefinition) -> str:  # noqa: PLR0911
    if index.type == "text":
        return render_text_index_type(index)
    if isinstance(index, SkipIndexVectorSimilarity):
        return render_vector_index_type(index)
    if isinstance(index, SkipIndexRaw):
        return normalize_sql_fragment(index.raw_type)
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


def _index_expression_base(index: SkipIndexDefinition) -> str:
    """The index expression without the parentheses that enclose all of it.

    chkit renders ``INDEX name (expr)``. Stock ClickHouse drops those
    parentheses, ObsessionDB keeps one pair (#512), and a schema may write more
    (``((s))``). Every such pair is peeled, reading the SQL with the shared
    lexer so ``(a) + (b)`` and the parentheses inside a string, quoted name or
    heredoc (``$$)$$``) stay intact.
    """
    expression = normalize_sql_fragment(index.expression)
    while True:
        tokens = [token for token in tokenize_sql(expression) if not is_trivia(token)]
        if not tokens or tokens[0].text != "(" or tokens[-1].text != ")":
            return expression
        depth = 0
        for i, token in enumerate(tokens):
            if token.text == "(":
                depth += 1
            elif token.text == ")":
                depth -= 1
            if depth == 0 and i < len(tokens) - 1:
                return expression
        expression = js_trim(expression[tokens[0].end : tokens[-1].start])


def _normalize_index_shape(
    index: SkipIndexDefinition, canonicalizer: SqlCanonicalizer | None = None
) -> str:
    if index.type == "text":
        return text_index_fingerprint(index)
    expression = _canonicalize_expression(_index_expression_base(index), canonicalizer)
    return "|".join(
        [
            f"expr={expression}",
            # A raw type is compared as ClickHouse formats it, so a structured
            # index on one side and the same type written raw on the other match.
            "type="
            + _canonicalize_expression(_render_index_type_fingerprint(index), canonicalizer),
            f"granularity={index.granularity}",
        ]
    )


def _normalize_constraint_shape(
    constraint: TableConstraintDefinition, canonicalizer: SqlCanonicalizer | None = None
) -> str:
    # ClickHouse re-formats a constraint expression when it stores it, e.g.
    # `s IN ('a','b') AND (id+1)*2 > 0` comes back as
    # `(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)`, so both sides go through the
    # canonicalizer.
    expression = _canonicalize_expression(
        normalize_sql_fragment(constraint_expression(constraint)), canonicalizer
    )
    return f"{constraint_kind(constraint)} {expression}"


def _normalize_projection_shape(
    projection: ProjectionDefinition, canonicalizer: SqlCanonicalizer | None = None
) -> str:
    if is_index_projection(projection):
        type_text = js_trim(projection.type) if projection.type is not None else ""
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
# Tokens are joined by single spaces, and only a ``)`` token ends in `` )``.
_WRAPPED_TOKENS_RE = re.compile(r"\( (.+) \)")


def _normalize_clause(value: str | None, canonicalizer: SqlCanonicalizer | None = None) -> str:
    # Key and partition clauses are compared as SQL: comments are removed while
    # quoted names still carry their backticks (#232). Then each side is
    # compared by its tokens, where a name matches however ClickHouse re-quotes
    # it and keeps its commas and spaces: `a, b` quoted is one column, not `a`
    # and `b` (#558). One pair of parentheses around the whole clause is
    # dropped. A canonicalizer sees each element while its names are still
    # quoted, since unquoted, `user--id` would read as `user` followed by a
    # comment.
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
    tokens = key_clause_fingerprint(canonical)
    wrapped = _WRAPPED_TOKENS_RE.fullmatch(tokens)
    return wrapped.group(1) if wrapped is not None else tokens


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
    expressions.extend(
        _render_index_type_fingerprint(index)
        for index in [*(expected.indexes or []), *actual.indexes]
        if index.type != "text"
    )
    expressions.extend(
        normalize_sql_fragment(constraint_expression(constraint))
        for constraint in [*(expected.constraints or []), *(actual.constraints or [])]
    )
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
    index_granularity: int = DEFAULT_INDEX_GRANULARITY,
) -> TableDriftDetail | None:
    """Compare every shape-bearing field on the table. Returns None if identical.

    ``index_granularity`` is ``clickhouse.indexGranularity``, for a live table
    that does not show index_granularity."""
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
        actual_engine = actual.engine or expected.engine
        setting_diffs = diff_settings(
            expected.settings or {},
            with_default_index_granularity(actual_engine, dict(actual.settings), index_granularity)
            or {},
        )

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

    constraint_diffs = diff_named_shape_maps(
        {
            c.name: _normalize_constraint_shape(c, canonicalizer)
            for c in (expected.constraints or [])
        },
        {
            c.name: _normalize_constraint_shape(c, canonicalizer)
            for c in (actual.constraints or [])
        },
    )

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
    if constraint_diffs:
        reason_codes.append("constraint_mismatch")

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
        constraint_diffs=constraint_diffs,
    )


def collect_view_sql_queries(
    expected: ViewDefinition | MaterializedViewDefinition, actual: IntrospectedView
) -> list[str]:
    """The view and materialized view queries ``compare_view_shape`` will look up."""
    # Formatting the schema's query would log its secret in ``system.query_log``.
    if _HIDDEN_SECRET in actual.query:
        return []
    return [normalize_sql_fragment(expected.as_), normalize_sql_fragment(actual.query)]


def compare_view_shape(
    expected: ViewDefinition | MaterializedViewDefinition,
    actual: IntrospectedView,
    current_database: str,
    canonicalizer: SqlCanonicalizer | None = None,
) -> list[ObjectDriftDetail]:
    """Compare a view query with the live one, and a materialized view's ``TO`` target.

    ClickHouse stores the query reformatted, so the queries are compared only
    as its formatter renders them: when either side can't be formatted, the
    query is not compared, rather than reporting drift on a query that may be
    the same. Nor is a query in which ClickHouse replaced a secret (a table
    function's password) with ``'[HIDDEN]'``: it never matches the schema, and
    the schema's side would print the secret.
    """
    obj = f"{expected.database}.{expected.name}"
    drift: list[ObjectDriftDetail] = []
    if canonicalizer is not None and _HIDDEN_SECRET not in actual.query:
        expected_query = canonicalizer.query(normalize_sql_fragment(expected.as_))
        actual_query = canonicalizer.query(normalize_sql_fragment(actual.query))
        if expected_query and actual_query:
            expected_shape = _strip_database_qualifier(expected_query, current_database)
            actual_shape = _strip_database_qualifier(actual_query, current_database)
            if expected_shape != actual_shape:
                drift.append(
                    ObjectDriftDetail(
                        code="query_mismatch",
                        object=obj,
                        expected=expected_shape,
                        actual=actual_shape,
                    )
                )
    if isinstance(expected, MaterializedViewDefinition):
        expected_to = f"{expected.to.database}.{expected.to.name}"
        # A live materialized view with an inner table has no ``TO``.
        actual_to = "" if actual.to is None else f"{actual.to[0]}.{actual.to[1]}"
        if expected_to != actual_to:
            drift.append(
                ObjectDriftDetail(
                    code="target_mismatch", object=obj, expected=expected_to, actual=actual_to
                )
            )
    return drift


def _strip_database_qualifier(sql: str, database: str) -> str:
    """Remove ``<database>.`` in front of names.

    ClickHouse qualifies every table name in a view's query with the database
    the view was created from, so a schema's ``FROM events`` is stored as
    ``FROM analytics.events``, and the dictionary name in
    ``dictGet('users', …)`` as ``'analytics.users'``. Both sides drop that
    qualifier, which names the same object as no qualifier.
    """
    tokens = tokenize_sql(sql)
    qualified_literal = f"'{database}."
    out: list[str] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        dictionary_name = (
            token.kind == "string"
            and token.text.startswith(qualified_literal)
            and i > 1
            and tokens[i - 1].text == "("
            and (identifier_name(tokens[i - 2]) or "").lower().startswith("dict")
        )
        if dictionary_name:
            out.append("'" + token.text[len(qualified_literal) :])
            i += 1
            continue
        qualifier = (
            identifier_name(token) == database
            and (i == 0 or tokens[i - 1].text != ".")
            and i + 2 < len(tokens)
            and tokens[i + 1].text == "."
            and identifier_name(tokens[i + 2]) is not None
        )
        if qualifier:
            i += 2
            continue
        out.append(token.text)
        i += 1
    return "".join(out)


# Source keys whose whole value is a secret: the keys ClickHouse hides, and the
# keys newer ClickHouse versions hide but 26.3 stores in clear. Drift hides them
# on both sides, so ``expected`` never shows one.
_SECRET_SOURCE_KEYS = frozenset(
    {
        "PASSWORD",
        "HEADERS",
        "HEADER",
        "CONNECTION_STRING",
        "DATASOURCE",
        "OAUTH_TOKEN",
        "SSL_CA_PEM",
        "SSL_CERT_PEM",
        "SSL_KEY_PEM",
        "SSL_KEY_PASSPHRASE",
        "SSLROOTCERT_PEM",
        "SSLCERT_PEM",
        "SSLKEY_PEM",
    }
)

# The user info of a URL. ClickHouse 26.3 hides only the password of a MongoDB
# ``URI`` and stores an HTTP ``URL`` in clear; drift hides the user info of every
# URL on both sides.
_URL_USERINFO = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/?#]+@")
_URL_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")

# Query parameters whose value is a secret, as ClickHouse after 26.3 hides them
# in a URL: the name, percent-decoded and in lower case, contains one of these
# words, or is ``sig``. ClickHouse 26.3 stores them in clear.
_SECRET_PARAMETER_WORDS = (
    "secret",
    "password",
    "passwd",
    "token",
    "credential",
    "signature",
    "key",
)
_PERCENT_ESCAPE = re.compile(r"%([0-9a-fA-F]{2})")
_HEX_PAIR = re.compile(r"[0-9a-fA-F]{2}")
# ClickHouse drops the backslash before a control character (code 0-31).
_LAST_CONTROL_CHAR = 31

# The C escapes ClickHouse reads in a quoted string, by the letter after the backslash.
_QUOTED_STRING_ESCAPES = {
    "a": "\x07",
    "b": "\b",
    "e": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "0": "\0",
}

# The characters ClickHouse escapes when it writes a quoted string, and the
# letter it writes after the backslash.
_QUOTED_STRING_LETTERS = {
    "\b": "b",
    "\f": "f",
    "\n": "n",
    "\r": "r",
    "\t": "t",
    "\0": "0",
    "\\": "\\",
    "'": "'",
}


@dataclass(frozen=True, slots=True)
class DictionarySqlQueries:
    """The two statements ``compare_dictionary_shape`` formats, and the live SOURCE it compares.

    Both statements have ``SOURCE(NULL())`` and no comment.
    """

    expected: str
    actual: str
    actual_source: str


@dataclass(frozen=True, slots=True)
class _SourcePair:
    """A ``SOURCE`` key and its value: a literal, or a group of pairs in parentheses."""

    key: str
    value: str | list[_SourcePair]


def collect_dictionary_sql_queries(
    expected: DictionaryDefinition, actual: IntrospectedDictionary
) -> DictionarySqlQueries | None:
    """The statements ``compare_dictionary_shape`` formats.

    None when the live ``SOURCE`` can't be parsed.
    """
    actual_source = parse_source_from_create_dictionary_query(actual.create_query)
    actual_query = replace_source_in_create_dictionary_query(actual.create_query, "NULL()")
    if actual_source is None or actual_query is None:
        return None
    definition = expected.model_copy(update={"source": "NULL()", "comment": None})
    return DictionarySqlQueries(
        expected=render_dictionary_sql(definition).removesuffix(";"),
        actual=_without_comment(actual_query),
        actual_source=actual_source,
    )


def compare_dictionary_shape(
    expected: DictionaryDefinition,
    queries: DictionarySqlQueries | None,
    canonicalizer: SqlCanonicalizer | None = None,
) -> list[ObjectDriftDetail]:
    """Compare a dictionary with the live one, clause by clause.

    ``queries`` is what ``collect_dictionary_sql_queries`` returned for the pair.

    The attributes, primary key and ``RANGE`` (together the structure),
    ``LAYOUT``, ``LIFETIME`` and ``SETTINGS`` are compared as ClickHouse's
    formatter renders them, as view queries are: when either statement can't be
    formatted, they are not compared. Both statements reach the formatter with
    ``SOURCE(NULL())``, because the formatter shows secrets and logs its input
    in ``system.query_log``.

    ``SOURCE`` is compared locally, with its keys in any order. Both sides are
    rendered as ClickHouse stores a source, with secret values replaced by
    ``[HIDDEN]``, so ``expected`` never shows a schema secret and a change to a
    secret alone is not drift. ``SOURCE`` is not compared when ClickHouse hid a
    value that drift does not hide, or when a value is a function call, which
    ClickHouse stores evaluated. When the live ``SOURCE`` can't be parsed, the
    dictionary is not compared.
    """
    obj = f"{expected.database}.{expected.name}"
    if queries is None:
        debug("drift", f"{obj}: live SOURCE not parsed, dictionary not compared")
        return []
    actual_source = queries.actual_source
    drift: list[ObjectDriftDetail] = []
    expected_source = _normalize_dictionary_source(expected.source)
    actual_source_shape = _normalize_dictionary_source(actual_source)
    unhidden_masks = _normalize_dictionary_source(actual_source.replace("[HIDDEN]", "x"))
    if expected_source is None or actual_source_shape is None:
        debug("drift", f"{obj}: SOURCE not compared, it holds a function call or another shape")
    elif unhidden_masks is None or actual_source_shape[1] != unhidden_masks[1]:
        debug("drift", f"{obj}: SOURCE not compared, ClickHouse hid a value drift does not hide")
    elif expected_source[1] != actual_source_shape[1]:
        drift.append(
            ObjectDriftDetail(
                code="source_mismatch",
                object=obj,
                expected=expected_source[0],
                actual=actual_source_shape[0],
            )
        )
    expected_formatted = canonicalizer.query(queries.expected) if canonicalizer else None
    actual_formatted = canonicalizer.query(queries.actual) if canonicalizer else None
    if not expected_formatted or not actual_formatted:
        debug("drift", f"{obj}: dictionary clauses not compared, the server could not format them")
        return drift
    for code, read in _DICTIONARY_CLAUSES:
        expected_clause = read(expected_formatted)
        actual_clause = read(actual_formatted)
        if expected_clause != actual_clause:
            drift.append(
                ObjectDriftDetail(
                    code=code, object=obj, expected=expected_clause, actual=actual_clause
                )
            )
    return drift


def _dictionary_structure(query: str) -> str:
    attributes = parse_attribute_list_text_from_create_dictionary_query(query) or ""
    primary_key = ", ".join(parse_dictionary_primary_key_from_create_dictionary_query(query))
    range_ = parse_dictionary_range_from_create_dictionary_query(query)
    range_text = "" if range_ is None else f" RANGE(MIN {range_[0]} MAX {range_[1]})"
    return f"({attributes}) PRIMARY KEY {primary_key}{range_text}"


def _dictionary_settings(query: str) -> str:
    """Sorted by name: the snapshot sorts dictionary settings, ClickHouse keeps them as written."""
    settings = parse_dictionary_settings_from_create_dictionary_query(query) or {}
    return ", ".join(
        f"{key} = {string_literal(value) if isinstance(value, str) else js_number_to_string(value)}"
        for key, value in sorted(settings.items())
    )


# The clauses ``compare_dictionary_shape`` reads from both formatted statements, by drift code.
_DICTIONARY_CLAUSES: tuple[tuple[ObjectDriftReasonCode, Callable[[str], str]], ...] = (
    ("structure_mismatch", _dictionary_structure),
    ("layout_mismatch", lambda query: parse_layout_from_create_dictionary_query(query) or ""),
    ("lifetime_mismatch", lambda query: parse_lifetime_from_create_dictionary_query(query) or ""),
    ("dictionary_setting_mismatch", _dictionary_settings),
)


def _normalize_dictionary_source(source: str) -> tuple[str, str] | None:
    """A dictionary ``SOURCE`` body as ClickHouse stores it, and the same sorted.

    The first string has the keys and the source name in upper case, strings
    quoted with backslashes, and secret values replaced by ``[HIDDEN]``. The
    second has the pairs of each group in sorted order, for comparing:
    ClickHouse keeps the order as written. None when the source is not a list
    of ``KEY value`` pairs, or a value is a function call.
    """
    tokens = [token for token in tokenize_sql(source) if not is_trivia(token)]
    parsed = _parse_source_pairs(source, tokens, 0)
    if parsed is None or parsed[1] != len(tokens):
        return None
    return (
        _render_source_pairs(parsed[0], sorted_=False),
        _render_source_pairs(parsed[0], sorted_=True),
    )


def _parse_source_pairs(
    source: str, tokens: list[SQLToken], start: int
) -> tuple[list[_SourcePair], int] | None:
    """The pairs from ``tokens[start]`` up to the ``)`` that closes their group, or the end."""
    pairs: list[_SourcePair] = []
    i = start
    while i < len(tokens) and tokens[i].text != ")":
        key_token = tokens[i]
        if key_token.kind != "identifier" or i + 1 >= len(tokens) or tokens[i + 1].text == ")":
            return None
        key = key_token.text.upper()
        value_token = tokens[i + 1]
        if value_token.text == "(":
            close_at = find_matching_paren(source, value_token.start)
            close = next((j for j, token in enumerate(tokens) if token.start == close_at), None)
            if close is None:
                return None
            if key in _SECRET_SOURCE_KEYS:
                pairs.append(_SourcePair(key, "('[HIDDEN]')"))
            else:
                group = _parse_source_pairs(source, tokens, i + 2)
                if group is None or group[1] != close:
                    return None
                pairs.append(_SourcePair(key, group[0]))
            i = close + 1
            continue
        # A signed number, such as ``PRIORITY -1``, stored without the space.
        signed = (
            value_token.text in ("-", "+")
            and i + 2 < len(tokens)
            and tokens[i + 2].kind == "number"
        )
        value_end = i + 2 if signed else i + 1
        # A function call, such as ``DB currentDatabase()``: ClickHouse stores its result.
        if value_end + 1 < len(tokens) and tokens[value_end + 1].text == "(":
            return None
        if signed:
            value = f"{'-' if value_token.text == '-' else ''}{tokens[i + 2].text}"
        else:
            value = _source_value_text(value_token)
        pairs.append(_SourcePair(key, _HIDDEN_SECRET if key in _SECRET_SOURCE_KEYS else value))
        i = value_end + 1
    return (pairs, i)


def _render_source_pairs(pairs: list[_SourcePair], *, sorted_: bool, nested: bool = False) -> str:
    """``NAME(`` for the source name, ``KEY (`` for a nested group, as ClickHouse prints them."""
    rendered = [
        f"{pair.key} {pair.value}"
        if isinstance(pair.value, str)
        else f"{pair.key}{' ' if nested else ''}"
        f"({_render_source_pairs(pair.value, sorted_=sorted_, nested=True)})"
        for pair in pairs
    ]
    return " ".join(sorted(rendered) if sorted_ else rendered)


def _source_value_text(token: SQLToken) -> str:
    if token.kind != "string" or not token.terminated:
        return token.text
    value = (
        _read_quoted_string(token.text)
        if token.text.startswith("'")
        else string_literal_value(token)
    )
    return token.text if value is None else _write_quoted_string(_mask_url_credentials(value))


def _read_quoted_string(text: str) -> str:
    """The value of a ``'...'`` literal, decoded as ClickHouse reads it.

    ``\\n``, ``\\t`` and the other C escapes, ``\\xHH``, and a doubled quote are
    decoded. A backslash before a character that needs no escape stays, so
    ``'a\\%'`` is ``a\\%``.
    """
    body = text[1:-1]
    out: list[str] = []
    i = 0
    while i < len(body):
        char = body[i]
        if char == "'" and body[i + 1 : i + 2] == "'":
            out.append("'")
            i += 1
        elif char != "\\" or i + 1 == len(body):
            out.append(char)
        elif body[i + 1] == "x" and _HEX_PAIR.fullmatch(body[i + 2 : i + 4]):
            out.append(chr(int(body[i + 2 : i + 4], 16)))
            i += 3
        else:
            following = body[i + 1]
            decoded = _QUOTED_STRING_ESCAPES.get(following, following)
            kept = decoded not in "\\'\"`/=" and ord(decoded) > _LAST_CONTROL_CHAR
            # ``\\N`` reads as nothing.
            if following != "N":
                out.append(f"\\{decoded}" if kept else decoded)
            i += 1
        i += 1
    return "".join(out)


def _write_quoted_string(value: str) -> str:
    """A ``'...'`` literal as ClickHouse writes it."""
    escaped = "".join(
        f"\\{_QUOTED_STRING_LETTERS[char]}" if char in _QUOTED_STRING_LETTERS else char
        for char in value
    )
    return f"'{escaped}'"


def _without_comment(query: str) -> str:
    """The statement without its trailing ``COMMENT '...'``: its text could look like a clause."""
    tokens = [token for token in tokenize_sql(query) if not is_trivia(token)]
    keyword, comment = [None, None, *tokens][-2:]
    if (
        keyword is not None
        and comment is not None
        and keyword.kind == "identifier"
        and keyword.text.upper() == "COMMENT"
        and comment.kind == "string"
    ):
        return query[: keyword.start].rstrip()
    return query


def _mask_url_credentials(value: str) -> str:
    """A URL with its user info and its secret query parameter values replaced by ``[HIDDEN]``."""
    if _URL_SCHEME.match(value) is None:
        return value
    url = _URL_USERINFO.sub(r"\1[HIDDEN]@", value)
    question = url.find("?")
    if question == -1:
        return url
    parameters = []
    for parameter in url[question + 1 :].split("&"):
        equals = parameter.find("=")
        if equals == -1 or not _is_secret_parameter_name(parameter[:equals]):
            parameters.append(parameter)
        else:
            parameters.append(f"{parameter[:equals]}=[HIDDEN]")
    return f"{url[: question + 1]}{'&'.join(parameters)}"


def _is_secret_parameter_name(raw_name: str) -> bool:
    decoded = _PERCENT_ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), raw_name.replace("+", " "))
    name = decoded.lower()
    return name == "sig" or any(word in name for word in _SECRET_PARAMETER_WORDS)
