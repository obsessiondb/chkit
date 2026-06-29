"""Compare expected (snapshot) vs. actual (introspected) schema shapes.

1:1 port of ``packages/cli/src/commands/drift/compare.ts``.

``compare_schema_objects`` operates on object refs (kind + db + name)
and produces missing/extra/kind-mismatch buckets.

``compare_table_shape`` produces a ``TableDriftDetail`` with per-aspect
mismatches (columns, settings, indexes, TTL, engine, keys, partition by,
projections). Returns ``None`` when shapes are identical.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypeAlias

from chkit.cli.commands.drift_diff import (
    diff_by_name,
    diff_named_shape_maps,
    diff_settings,
)
from chkit.clickhouse.introspect import IntrospectedTable, SchemaObjectKind
from chkit.core.model import (
    ColumnDefinition,
    ProjectionDefinition,
    SkipIndexDefinition,
    TableDefinition,
)
from chkit.core.sql_normalizer import normalize_engine, normalize_sql_fragment

_MIN_QUOTED_LEN = 2

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
    def _normalize_default_value(value: str) -> str:
        normalized = normalize_sql_fragment(value)
        if (
            len(normalized) >= _MIN_QUOTED_LEN
            and normalized[0] == "'"
            and normalized[-1] == "'"
        ):
            inner = normalized[1:-1]
            return inner.replace("''", "'")
        return normalized

    if column.default is None:
        normalized_default = ""
    else:
        as_string = str(column.default)
        if as_string.startswith("fn:"):
            normalized_default = _normalize_default_value(as_string[3:])
        else:
            normalized_default = _normalize_default_value(as_string)

    parts = [
        f"type={str(column.type).strip()}",
        f"nullable={'1' if column.nullable else '0'}",
        f"default={normalized_default}",
        f"comment={(column.comment or '').strip()}",
    ]
    return "|".join(parts)


def _render_index_type_fingerprint(index: SkipIndexDefinition) -> str:
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


def _normalize_index_shape(index: SkipIndexDefinition) -> str:
    return "|".join(
        [
            f"expr={normalize_sql_fragment(index.expression)}",
            f"type={_render_index_type_fingerprint(index)}",
            f"granularity={index.granularity}",
        ]
    )


def _normalize_projection_shape(projection: ProjectionDefinition) -> str:
    return f"query={normalize_sql_fragment(projection.query)}"


def _normalize_clause(value: str | None) -> str:
    if not value:
        return ""
    normalized = normalize_sql_fragment(value).replace("`", "")
    if (
        len(normalized) >= _MIN_QUOTED_LEN
        and normalized.startswith("(")
        and normalized.endswith(")")
    ):
        return normalize_sql_fragment(normalized[1:-1])
    return normalized


def _normalize_engine_for_compare(value: str | None) -> str:
    if not value:
        return ""
    return normalize_engine(normalize_sql_fragment(value)).lower()


def compare_table_shape(  # noqa: PLR0912, PLR0915
    expected: TableDefinition, actual: IntrospectedTable
) -> TableDriftDetail | None:
    """Compare every shape-bearing field on the table. Returns None if identical."""
    column_diff = diff_by_name(
        expected.columns,
        actual.columns,
        lambda c: c.name,
        _normalize_column_shape,
    )
    missing_columns = column_diff.missing
    extra_columns = column_diff.extra
    changed_columns = column_diff.changed

    setting_diffs = diff_settings(expected.settings or {}, actual.settings)

    expected_indexes = {
        idx.name: _normalize_index_shape(idx) for idx in (expected.indexes or [])
    }
    actual_indexes = {idx.name: _normalize_index_shape(idx) for idx in actual.indexes}
    index_diffs = diff_named_shape_maps(expected_indexes, actual_indexes)

    expected_ttl = normalize_sql_fragment(expected.ttl) if expected.ttl else ""
    actual_ttl = normalize_sql_fragment(actual.ttl) if actual.ttl else ""
    ttl_mismatch = expected_ttl != actual_ttl

    engine_mismatch = _normalize_engine_for_compare(
        expected.engine
    ) != _normalize_engine_for_compare(actual.engine)

    expected_pk = _normalize_clause(", ".join(expected.primary_key))
    actual_pk = _normalize_clause(actual.primary_key)
    primary_key_mismatch = expected_pk != actual_pk

    expected_order_by = _normalize_clause(", ".join(expected.order_by))
    actual_order_by = _normalize_clause(actual.order_by)
    order_by_mismatch = expected_order_by != actual_order_by

    expected_unique_key = _normalize_clause(", ".join(expected.unique_key or []))
    actual_unique_key = _normalize_clause(actual.unique_key)
    unique_key_mismatch = expected_unique_key != actual_unique_key

    expected_partition_by = _normalize_clause(expected.partition_by)
    actual_partition_by = _normalize_clause(actual.partition_by)
    partition_by_mismatch = expected_partition_by != actual_partition_by

    expected_projections = {
        p.name: _normalize_projection_shape(p) for p in (expected.projections or [])
    }
    actual_projections = {
        p.name: _normalize_projection_shape(p) for p in actual.projections
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
