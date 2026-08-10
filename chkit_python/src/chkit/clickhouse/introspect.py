"""Live ClickHouse introspection helpers.

1:1 port of the introspection surface from
``packages/clickhouse/src/index.ts`` (lines 100-320 + the
``listSchemaObjects`` / ``listTableDetails`` SQL helpers).

These primitives are the foundation for ``chkit drift`` (snapshot vs.
live DB) and ``chkit pull`` (live DB → schema files):

- ``infer_schema_kind_from_engine`` — engine name → ``table`` /
  ``view`` / ``materialized_view`` / None.
- ``normalize_column_from_system_row`` — ``system.columns`` row →
  ``ColumnDefinition`` (handles ``Nullable``, codecs, defaults, comments).
- ``normalize_index_from_system_row`` — ``system.data_skipping_indices``
  row → ``SkipIndexDefinition`` (parses minmax, bloom_filter, tokenbf_v1,
  ngrambf_v1, set with all arg shapes).
- ``build_introspected_tables`` — joins the three system rows into one
  ``IntrospectedTable`` per (database, name). Sorts deterministically.
- ``list_schema_objects`` / ``list_table_details`` — issue the SQL
  queries against a ``ClickHouseClient`` and decode the rows.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, TypeAlias

from chkit.clickhouse.create_table_parser import (
    parse_engine_from_create_table_query,
    parse_order_by_from_create_table_query,
    parse_partition_by_from_create_table_query,
    parse_primary_key_from_create_table_query,
    parse_projections_from_create_table_query,
    parse_settings_from_create_table_query,
    parse_ttl_from_create_table_query,
    parse_unique_key_from_create_table_query,
)
from chkit.core.codec import parse_codec
from chkit.core.model import (
    ColumnDefinition,
    ProjectionDefinition,
    SkipIndexBloomFilter,
    SkipIndexDefinition,
    SkipIndexMinmax,
    SkipIndexNgramBF,
    SkipIndexSet,
    SkipIndexTokenBF,
)
from chkit.core.sql_normalizer import normalize_sql_fragment

SchemaObjectKind: TypeAlias = Literal["table", "view", "materialized_view", "dictionary"]

__all__ = [
    "IntrospectedTable",
    "SchemaObjectKind",
    "SchemaObjectRef",
    "SystemColumnRow",
    "SystemSkippingIndexRow",
    "SystemTableRow",
    "build_introspected_tables",
    "infer_schema_kind_from_engine",
    "list_schema_objects",
    "list_table_details",
    "normalize_column_from_system_row",
    "normalize_index_from_system_row",
]


@dataclass(frozen=True, slots=True)
class SchemaObjectRef:
    kind: SchemaObjectKind
    database: str
    name: str


@dataclass(frozen=True, slots=True)
class SystemTableRow:
    database: str
    name: str
    engine: str
    create_table_query: str | None = None


@dataclass(frozen=True, slots=True)
class SystemColumnRow:
    database: str
    table: str
    name: str
    type: str
    position: int
    default_kind: str | None = None
    default_expression: str | None = None
    comment: str | None = None
    compression_codec: str | None = None


@dataclass(frozen=True, slots=True)
class SystemSkippingIndexRow:
    database: str
    table: str
    name: str
    expr: str
    type: str
    granularity: int


@dataclass(frozen=True, slots=True)
class IntrospectedTable:
    database: str
    name: str
    columns: list[ColumnDefinition]
    settings: dict[str, str]
    indexes: list[SkipIndexDefinition]
    projections: list[ProjectionDefinition]
    engine: str | None = None
    primary_key: str | None = None
    order_by: str | None = None
    unique_key: str | None = None
    partition_by: str | None = None
    ttl: str | None = None


_NULLABLE_RE = re.compile(r"^Nullable\((.+)\)$")
_INDEX_TYPE_RE = re.compile(r"^(\w+)\((.+)\)$")


def infer_schema_kind_from_engine(engine: str) -> SchemaObjectKind | None:
    if engine == "View":
        return "view"
    if engine == "MaterializedView":
        return "materialized_view"
    if engine == "Dictionary":
        return "dictionary"
    if not engine:
        return None
    return "table"


def normalize_column_from_system_row(row: SystemColumnRow) -> ColumnDefinition:
    """Decode one ``system.columns`` row into a ``ColumnDefinition``."""
    nullable_match = _NULLABLE_RE.match(row.type)
    inner = nullable_match.group(1) if nullable_match is not None else None
    type_ = inner if inner else row.type
    nullable = bool(inner)

    default_value: str | None = None
    if row.default_expression and row.default_kind == "DEFAULT":
        default_value = normalize_sql_fragment(row.default_expression)

    codec_steps = parse_codec(row.compression_codec)
    comment = row.comment.strip() if row.comment is not None else None

    return ColumnDefinition(
        name=row.name,
        type=type_,
        nullable=nullable or None,
        default=default_value,
        comment=comment or None,
        codec=codec_steps,
    )


def _split_int_args(args: str | None) -> list[int]:
    if args is None:
        return []
    out: list[int] = []
    for part in args.split(","):
        token = part.strip()
        if not token:
            continue
        try:
            out.append(int(float(token)))
        except ValueError:
            continue
    return out


def _split_float_args(args: str | None) -> list[float]:
    if args is None:
        return []
    out: list[float] = []
    for part in args.split(","):
        token = part.strip()
        if not token:
            continue
        try:
            out.append(float(token))
        except ValueError:
            continue
    return out


def _padded(ints: list[int], width: int) -> list[int]:
    """Right-pad ``ints`` with zeros to ``width`` so positional indexing is safe."""
    return (ints + [0] * width)[:width]


def normalize_index_from_system_row(row: SystemSkippingIndexRow) -> SkipIndexDefinition:
    """Decode one ``system.data_skipping_indices`` row into a SkipIndexDefinition.

    Returns a discriminated-union member (Pydantic-validated) based on the
    ``type`` column value. Unknown variants fall back to ``set`` to mirror TS.
    """
    base_payload: dict[str, Any] = {
        "name": row.name,
        "expression": normalize_sql_fragment(row.expr),
        "granularity": row.granularity,
    }

    match = _INDEX_TYPE_RE.match(row.type)
    base_name = match.group(1) if match is not None else row.type
    args_str = match.group(2) if match is not None else None

    if base_name == "minmax":
        return SkipIndexMinmax(**base_payload)

    if base_name == "bloom_filter":
        floats = _split_float_args(args_str)
        rate = floats[0] if floats else None
        return SkipIndexBloomFilter(**base_payload, false_positive_rate=rate)

    if base_name == "tokenbf_v1":
        size_bytes, hash_functions, random_seed = _padded(
            _split_int_args(args_str), 3
        )
        return SkipIndexTokenBF(
            **base_payload,
            size_bytes=size_bytes,
            hash_functions=hash_functions,
            random_seed=random_seed,
        )

    if base_name == "ngrambf_v1":
        ngram_size, size_bytes, hash_functions, random_seed = _padded(
            _split_int_args(args_str), 4
        )
        return SkipIndexNgramBF(
            **base_payload,
            ngram_size=ngram_size,
            size_bytes=size_bytes,
            hash_functions=hash_functions,
            random_seed=random_seed,
        )

    ints = _split_int_args(args_str)
    return SkipIndexSet(**base_payload, max_rows=ints[0] if ints else 0)


def build_introspected_tables(
    tables: list[SystemTableRow],
    columns: list[SystemColumnRow],
    indexes: list[SystemSkippingIndexRow],
) -> list[IntrospectedTable]:
    """Join table/column/index rows into ``IntrospectedTable`` objects.

    Skips entries that aren't tables (views / MVs / dictionaries).
    Output is sorted by (database, name) for determinism.
    """
    table_rows = [
        t for t in tables if infer_schema_kind_from_engine(t.engine) == "table"
    ]
    if not table_rows:
        return []

    columns_by_table: dict[str, list[SystemColumnRow]] = {}
    for col_row in columns:
        key = f"{col_row.database}.{col_row.table}"
        columns_by_table.setdefault(key, []).append(col_row)

    indexes_by_table: dict[str, list[SystemSkippingIndexRow]] = {}
    for idx_row in indexes:
        key = f"{idx_row.database}.{idx_row.table}"
        indexes_by_table.setdefault(key, []).append(idx_row)

    out: list[IntrospectedTable] = []
    for table_row in table_rows:
        key = f"{table_row.database}.{table_row.name}"
        col_rows = sorted(
            columns_by_table.get(key, []), key=lambda c: c.position
        )
        idx_rows = indexes_by_table.get(key, [])
        out.append(
            IntrospectedTable(
                database=table_row.database,
                name=table_row.name,
                engine=parse_engine_from_create_table_query(
                    table_row.create_table_query
                ),
                primary_key=parse_primary_key_from_create_table_query(
                    table_row.create_table_query
                ),
                order_by=parse_order_by_from_create_table_query(
                    table_row.create_table_query
                ),
                unique_key=parse_unique_key_from_create_table_query(
                    table_row.create_table_query
                ),
                partition_by=parse_partition_by_from_create_table_query(
                    table_row.create_table_query
                ),
                columns=[normalize_column_from_system_row(c) for c in col_rows],
                settings=parse_settings_from_create_table_query(
                    table_row.create_table_query
                ),
                indexes=[normalize_index_from_system_row(i) for i in idx_rows],
                projections=[
                    ProjectionDefinition(
                        name=p.name, query=p.query, index=p.index, type=p.type
                    )
                    for p in parse_projections_from_create_table_query(
                        table_row.create_table_query
                    )
                ],
                ttl=parse_ttl_from_create_table_query(table_row.create_table_query),
            )
        )

    return sorted(out, key=lambda x: (x.database, x.name))


# ---------- SQL helpers ----------


def _quote_str_list(items: list[str]) -> str:
    return ", ".join("'" + item.replace("'", "''") + "'" for item in items)


_LIST_SCHEMA_OBJECTS_SQL = """\
SELECT database, name, engine
FROM system.tables
WHERE is_temporary = 0
  AND database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
  AND name NOT LIKE '_chkit_%'\
"""


def list_schema_objects(client: Any) -> list[SchemaObjectRef]:
    """Enumerate non-system tables/views/MVs. Excludes ``_chkit_*`` rows."""
    result = client.query(_LIST_SCHEMA_OBJECTS_SQL)
    out: list[SchemaObjectRef] = []
    for raw in result.rows:
        kind = infer_schema_kind_from_engine(str(raw.get("engine", "")))
        if kind is None:
            continue
        out.append(
            SchemaObjectRef(
                kind=kind,
                database=str(raw["database"]),
                name=str(raw["name"]),
            )
        )
    return out


def list_table_details(client: Any, databases: list[str]) -> list[IntrospectedTable]:
    """Fetch full table shape for every table in the given databases."""
    if not databases:
        return []
    quoted = _quote_str_list(databases)

    table_rows_raw = client.query(
        f"SELECT database, name, engine, create_table_query "
        f"FROM system.tables "
        f"WHERE is_temporary = 0 AND database IN ({quoted})"
    ).rows
    column_rows_raw = client.query(
        f"SELECT database, table, name, type, default_kind, default_expression, "
        f"comment, position, compression_codec "
        f"FROM system.columns WHERE database IN ({quoted})"
    ).rows
    index_rows_raw = client.query(
        f"SELECT database, table, name, expr, type, granularity "
        f"FROM system.data_skipping_indices WHERE database IN ({quoted})"
    ).rows

    tables = [
        SystemTableRow(
            database=str(r["database"]),
            name=str(r["name"]),
            engine=str(r.get("engine", "")),
            create_table_query=(
                str(r["create_table_query"])
                if r.get("create_table_query") is not None
                else None
            ),
        )
        for r in table_rows_raw
    ]
    columns = [
        SystemColumnRow(
            database=str(r["database"]),
            table=str(r["table"]),
            name=str(r["name"]),
            type=str(r["type"]),
            position=int(r["position"]),
            default_kind=(
                str(r["default_kind"]) if r.get("default_kind") else None
            ),
            default_expression=(
                str(r["default_expression"])
                if r.get("default_expression")
                else None
            ),
            comment=str(r["comment"]) if r.get("comment") else None,
            compression_codec=(
                str(r["compression_codec"])
                if r.get("compression_codec")
                else None
            ),
        )
        for r in column_rows_raw
    ]
    indexes = [
        SystemSkippingIndexRow(
            database=str(r["database"]),
            table=str(r["table"]),
            name=str(r["name"]),
            expr=str(r["expr"]),
            type=str(r["type"]),
            granularity=int(r["granularity"]),
        )
        for r in index_rows_raw
    ]

    return build_introspected_tables(tables, columns, indexes)
