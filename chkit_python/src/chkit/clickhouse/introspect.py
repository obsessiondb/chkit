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
  row → ``SkipIndexDefinition`` (minmax, set, bloom_filter, tokenbf_v1,
  ngrambf_v1, text, vector_similarity; anything else stays a raw index).
- ``build_introspected_tables`` — joins the three system rows into one
  ``IntrospectedTable`` per (database, name). Sorts deterministically.
- ``list_schema_objects`` / ``list_table_details`` — issue the SQL
  queries against a ``ClickHouseClient`` and decode the rows.
- ``list_view_details`` — the stored query (and ``TO`` target) of each view
  and materialized view (``packages/clickhouse/src/view-details.ts``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, TypeAlias

from chkit.clickhouse.create_table_parser import (
    parse_constraints_from_create_table_query,
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
    SkipIndexRaw,
    SkipIndexSet,
    SkipIndexText,
    SkipIndexTokenBF,
    SkipIndexVectorSimilarity,
    TableConstraintDefinition,
)
from chkit.core.sql_lexer import identifier_name, is_trivia, tokenize_sql
from chkit.core.sql_normalizer import is_synthetic_ephemeral_default, normalize_sql_fragment
from chkit.core.text_index import parse_text_index_params
from chkit.core.text_index_sql import normalize_text_index_sql
from chkit.core.vector_index import parse_vector_index_args

SchemaObjectKind: TypeAlias = Literal["table", "view", "materialized_view", "dictionary"]

__all__ = [
    "IntrospectedTable",
    "IntrospectedView",
    "SchemaObjectKind",
    "SchemaObjectRef",
    "SystemColumnRow",
    "SystemSkippingIndexRow",
    "SystemTableRow",
    "build_introspected_tables",
    "infer_schema_kind_from_engine",
    "list_schema_objects",
    "list_table_details",
    "list_view_details",
    "normalize_column_from_system_row",
    "normalize_index_from_system_row",
    "parse_materialized_view_target",
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
    constraints: list[TableConstraintDefinition] | None = None
    engine: str | None = None
    primary_key: str | None = None
    order_by: str | None = None
    unique_key: str | None = None
    partition_by: str | None = None
    ttl: str | None = None


@dataclass(frozen=True, slots=True)
class IntrospectedView:
    kind: Literal["view", "materialized_view"]
    database: str
    name: str
    # The SELECT as ClickHouse stores it (``system.tables.as_select``).
    query: str
    # The ``TO`` target of a materialized view, when it has one.
    to: tuple[str, str] | None = None


_NULLABLE_RE = re.compile(r"^Nullable\((.+)\)$")
_INDEX_TYPE_RE = re.compile(r"^(\w+)\((.*)\)$", re.DOTALL)


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
    kind = row.default_kind
    if kind and kind not in {"DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL"}:
        raise ValueError(f"Unsupported column default kind: {kind}")
    if row.default_expression and kind:
        # Preserve whitespace inside SQL string literals when pulling expressions.
        default_value = row.default_expression.strip()

    # ClickHouse synthesizes defaultValueOfTypeName('<type as written>') for a
    # bare EPHEMERAL column, keeping alias spellings such as BIGINT or TEXT.
    if (
        kind == "EPHEMERAL"
        and default_value is not None
        and is_synthetic_ephemeral_default(default_value)
    ):
        default_value = None
    codec_steps = parse_codec(row.compression_codec)
    comment = row.comment.strip() if row.comment is not None else None

    return ColumnDefinition.model_validate({
        "name": row.name,
        "type": type_,
        "nullable": nullable or None,
        "default": default_value,
        "defaultKind": kind if kind and kind != "DEFAULT" else None,
        "comment": comment or None,
        "codec": codec_steps,
    })


_NUMBER_ARG_RE = re.compile(r"^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$", re.IGNORECASE)


def _numeric_args(args: str | None) -> list[float] | None:
    """Every argument as a number, or None when any is not a plain number."""
    if args is None:
        return None
    parts = [part.strip() for part in args.split(",")]
    if not all(_NUMBER_ARG_RE.match(part) for part in parts):
        return None
    return [float(part) for part in parts]


def normalize_index_from_system_row(  # noqa: PLR0911, PLR0912
    row: SystemSkippingIndexRow,
) -> SkipIndexDefinition:
    """Decode one ``system.data_skipping_indices`` row into a SkipIndexDefinition.

    ``row.type`` is ``type_full``. A type chkit has no structured form for, or
    arguments that do not fit one (``set`` without a row limit, an unknown text
    parameter, a newer vector similarity option), becomes ``SkipIndexRaw``
    carrying ``type_full`` verbatim, so pull and drift never rewrite an index
    into a different one (TS parity).
    """
    base_payload: dict[str, Any] = {
        "name": row.name,
        "expression": normalize_sql_fragment(row.expr),
        "granularity": int(row.granularity),
    }
    raw = SkipIndexRaw(**base_payload, raw_type=normalize_sql_fragment(row.type))

    match = _INDEX_TYPE_RE.match(row.type)
    base_name = match.group(1) if match is not None else row.type.strip()
    args_str = match.group(2) if match is not None else None
    numbers = _numeric_args(args_str)

    def ints(count: int) -> list[int] | None:
        if numbers is None or len(numbers) != count:
            return None
        return [int(n) for n in numbers]

    if base_name == "text":
        try:
            params = parse_text_index_params(args_str or "")
        except ValueError:
            return raw
        return SkipIndexText.model_validate(
            {**base_payload, "expression": normalize_text_index_sql(row.expr), **params}
        )
    if base_name == "vector_similarity":
        vector = parse_vector_index_args(args_str) if args_str is not None else None
        if vector is None:
            return raw
        return SkipIndexVectorSimilarity.model_validate({**base_payload, **vector})
    if base_name == "minmax":
        return SkipIndexMinmax(**base_payload) if args_str is None else raw
    if base_name == "bloom_filter":
        if args_str is None:
            return SkipIndexBloomFilter(**base_payload)
        if numbers is None or len(numbers) != 1:
            return raw
        return SkipIndexBloomFilter(**base_payload, false_positive_rate=numbers[0])
    if base_name == "set":
        set_args = ints(1)
        return raw if set_args is None else SkipIndexSet(**base_payload, max_rows=set_args[0])
    if base_name == "tokenbf_v1":
        token_args = ints(3)
        if token_args is None:
            return raw
        size_bytes, hash_functions, random_seed = token_args
        return SkipIndexTokenBF(
            **base_payload,
            size_bytes=size_bytes,
            hash_functions=hash_functions,
            random_seed=random_seed,
        )
    if base_name == "ngrambf_v1":
        ngram_args = ints(4)
        if ngram_args is None:
            return raw
        ngram_size, size_bytes, hash_functions, random_seed = ngram_args
        return SkipIndexNgramBF(
            **base_payload,
            ngram_size=ngram_size,
            size_bytes=size_bytes,
            hash_functions=hash_functions,
            random_seed=random_seed,
        )
    return raw


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
                ) or table_row.engine,
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
                constraints=parse_constraints_from_create_table_query(
                    table_row.create_table_query
                ),
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
        f"SELECT database, table, name, expr, type_full AS type, granularity "
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


def list_view_details(client: Any, databases: list[str]) -> list[IntrospectedView]:
    """The views and materialized views in ``databases``, with their stored query.

    ClickHouse qualifies unqualified table names in that query with the
    database the view was created from, so ``FROM events`` comes back as
    ``FROM analytics.events``.
    """
    if not databases:
        return []
    rows = client.query(
        f"SELECT database, name, engine, as_select, create_table_query "
        f"FROM system.tables "
        f"WHERE is_temporary = 0 AND database IN ({_quote_str_list(databases)}) "
        f"AND engine IN ('View', 'MaterializedView')"
    ).rows
    out: list[IntrospectedView] = []
    for r in rows:
        database = str(r["database"])
        query = str(r.get("as_select") or "")
        if r.get("engine") == "View":
            out.append(
                IntrospectedView(kind="view", database=database, name=str(r["name"]), query=query)
            )
            continue
        out.append(
            IntrospectedView(
                kind="materialized_view",
                database=database,
                name=str(r["name"]),
                query=query,
                to=parse_materialized_view_target(r.get("create_table_query"), database),
            )
        )
    return out


_MV_NAME_END = 4


def parse_materialized_view_target(
    create_query: str | None, fallback_database: str
) -> tuple[str, str] | None:
    """The ``TO [db.]name`` of a ``CREATE MATERIALIZED VIEW`` statement.

    The first top-level ``TO`` after the view name and before ``AS``. A
    materialized view with an inner table has none.
    """
    if not create_query:
        return None
    tokens = [t for t in tokenize_sql(create_query) if not is_trivia(t)]

    def name_at(i: int) -> str | None:
        return identifier_name(tokens[i]) if i < len(tokens) else None

    # Skip ``CREATE MATERIALIZED VIEW <db>.<name>``.
    qualified = len(tokens) > _MV_NAME_END and tokens[_MV_NAME_END].text == "."
    i = _MV_NAME_END + 2 if qualified else _MV_NAME_END
    depth = 0
    while i < len(tokens):
        token = tokens[i]
        if token.text == "(":
            depth += 1
        elif token.text == ")":
            depth -= 1
        if depth == 0 and token.kind == "identifier":
            keyword = token.text.upper()
            if keyword == "AS":
                return None
            if keyword == "TO":
                first = name_at(i + 1)
                if first is None:
                    return None
                if i + 2 >= len(tokens) or tokens[i + 2].text != ".":
                    return (fallback_database, first)
                second = name_at(i + 3)
                return None if second is None else (first, second)
        i += 1
    return None

