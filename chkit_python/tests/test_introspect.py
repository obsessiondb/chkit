"""Tests for `chkit.clickhouse.introspect`.

Pure-function tests (no live ClickHouse). The list_* SQL functions are
exercised via a fake client to keep these in the unit-test suite.
"""

from __future__ import annotations

from typing import Any

import pytest

from chkit.clickhouse.introspect import (
    IntrospectedTable,
    SchemaObjectRef,
    SystemColumnRow,
    SystemSkippingIndexRow,
    SystemTableRow,
    build_introspected_tables,
    infer_schema_kind_from_engine,
    list_schema_objects,
    list_table_details,
    normalize_column_from_system_row,
    normalize_index_from_system_row,
)
from chkit.core.model import (
    GeneralColumnCodec,
    SkipIndexBloomFilter,
    SkipIndexMinmax,
    SkipIndexNgramBF,
    SkipIndexSet,
    SkipIndexTokenBF,
)

# ---------- infer_schema_kind_from_engine ----------


def test_infer_kind_for_view() -> None:
    assert infer_schema_kind_from_engine("View") == "view"


def test_infer_kind_for_materialized_view() -> None:
    assert infer_schema_kind_from_engine("MaterializedView") == "materialized_view"


def test_infer_kind_for_table_engines() -> None:
    for engine in ["MergeTree", "ReplicatedMergeTree", "SharedMergeTree", "Memory"]:
        assert infer_schema_kind_from_engine(engine) == "table"


def test_infer_kind_returns_dictionary_for_dictionary_engine() -> None:
    # First-class since the Dictionary primitive (TS 65c90d6).
    assert infer_schema_kind_from_engine("Dictionary") == "dictionary"


def test_infer_kind_returns_none_for_empty_string() -> None:
    assert infer_schema_kind_from_engine("") is None


# ---------- normalize_column_from_system_row ----------


def test_normalize_column_basic() -> None:
    row = SystemColumnRow(
        database="db", table="t", name="id", type="UInt64", position=1
    )
    column = normalize_column_from_system_row(row)
    assert column.name == "id"
    assert column.type == "UInt64"
    assert column.nullable is None


def test_normalize_column_strips_nullable_wrapper() -> None:
    row = SystemColumnRow(
        database="db", table="t", name="name", type="Nullable(String)", position=1
    )
    column = normalize_column_from_system_row(row)
    assert column.type == "String"
    assert column.nullable is True


def test_normalize_column_picks_up_default_when_kind_is_default() -> None:
    row = SystemColumnRow(
        database="db",
        table="t",
        name="created_at",
        type="DateTime",
        position=1,
        default_kind="DEFAULT",
        default_expression="now()",
    )
    column = normalize_column_from_system_row(row)
    assert column.default == "now()"


def test_normalize_column_ignores_default_when_kind_is_materialized() -> None:
    row = SystemColumnRow(
        database="db",
        table="t",
        name="x",
        type="DateTime",
        position=1,
        default_kind="MATERIALIZED",
        default_expression="now()",
    )
    column = normalize_column_from_system_row(row)
    assert column.default is None


def test_normalize_column_preserves_comment_and_codec() -> None:
    row = SystemColumnRow(
        database="db",
        table="t",
        name="x",
        type="UInt64",
        position=1,
        comment="  Spaces around me  ",
        compression_codec="CODEC(ZSTD(3))",
    )
    column = normalize_column_from_system_row(row)
    assert column.comment == "Spaces around me"
    assert column.codec is not None
    if isinstance(column.codec, list):
        assert any(isinstance(c, GeneralColumnCodec) for c in column.codec)
    else:
        assert isinstance(column.codec, GeneralColumnCodec)


# ---------- normalize_index_from_system_row ----------


def test_normalize_index_minmax() -> None:
    row = SystemSkippingIndexRow(
        database="db", table="t", name="idx_ts", expr="ts", type="minmax", granularity=8192
    )
    idx = normalize_index_from_system_row(row)
    assert isinstance(idx, SkipIndexMinmax)
    assert idx.name == "idx_ts"


def test_normalize_index_bloom_filter_default_rate() -> None:
    row = SystemSkippingIndexRow(
        database="db", table="t", name="idx", expr="x", type="bloom_filter", granularity=1
    )
    idx = normalize_index_from_system_row(row)
    assert isinstance(idx, SkipIndexBloomFilter)
    assert idx.false_positive_rate is None


def test_normalize_index_bloom_filter_with_rate() -> None:
    row = SystemSkippingIndexRow(
        database="db",
        table="t",
        name="idx",
        expr="x",
        type="bloom_filter(0.01)",
        granularity=1,
    )
    idx = normalize_index_from_system_row(row)
    assert isinstance(idx, SkipIndexBloomFilter)
    assert idx.false_positive_rate == pytest.approx(0.01)


def test_normalize_index_tokenbf_v1() -> None:
    row = SystemSkippingIndexRow(
        database="db",
        table="t",
        name="idx",
        expr="x",
        type="tokenbf_v1(256, 3, 0)",
        granularity=1,
    )
    idx = normalize_index_from_system_row(row)
    assert isinstance(idx, SkipIndexTokenBF)
    assert idx.size_bytes == 256
    assert idx.hash_functions == 3
    assert idx.random_seed == 0


def test_normalize_index_ngrambf_v1() -> None:
    row = SystemSkippingIndexRow(
        database="db",
        table="t",
        name="idx",
        expr="x",
        type="ngrambf_v1(3, 256, 4, 0)",
        granularity=1,
    )
    idx = normalize_index_from_system_row(row)
    assert isinstance(idx, SkipIndexNgramBF)
    assert idx.ngram_size == 3
    assert idx.size_bytes == 256
    assert idx.hash_functions == 4


def test_normalize_index_set_with_max_rows() -> None:
    row = SystemSkippingIndexRow(
        database="db",
        table="t",
        name="idx",
        expr="x",
        type="set(100)",
        granularity=1,
    )
    idx = normalize_index_from_system_row(row)
    assert isinstance(idx, SkipIndexSet)
    assert idx.max_rows == 100


def test_normalize_index_set_without_args() -> None:
    row = SystemSkippingIndexRow(
        database="db", table="t", name="idx", expr="x", type="set", granularity=1
    )
    idx = normalize_index_from_system_row(row)
    assert isinstance(idx, SkipIndexSet)
    assert idx.max_rows == 0


def test_normalize_index_tokenbf_with_partial_args_zero_pads() -> None:
    row = SystemSkippingIndexRow(
        database="db", table="t", name="idx", expr="x", type="tokenbf_v1(256)", granularity=1
    )
    idx = normalize_index_from_system_row(row)
    assert isinstance(idx, SkipIndexTokenBF)
    assert idx.size_bytes == 256
    assert idx.hash_functions == 0
    assert idx.random_seed == 0


# ---------- build_introspected_tables ----------


def _t(name: str, *, engine: str = "MergeTree", create: str | None = None) -> SystemTableRow:
    return SystemTableRow(
        database="db", name=name, engine=engine, create_table_query=create
    )


def _c(table: str, name: str, *, position: int = 1, type_: str = "UInt64") -> SystemColumnRow:
    return SystemColumnRow(
        database="db", table=table, name=name, type=type_, position=position
    )


def test_build_introspected_skips_views_and_dictionaries() -> None:
    out = build_introspected_tables(
        tables=[
            _t("t1"),
            _t("v1", engine="View"),
            _t("d1", engine="Dictionary"),
        ],
        columns=[_c("t1", "id")],
        indexes=[],
    )
    assert [it.name for it in out] == ["t1"]


def test_build_introspected_sorts_by_database_then_name() -> None:
    out = build_introspected_tables(
        tables=[
            SystemTableRow(database="z", name="x", engine="MergeTree"),
            SystemTableRow(database="a", name="y", engine="MergeTree"),
            SystemTableRow(database="a", name="x", engine="MergeTree"),
        ],
        columns=[],
        indexes=[],
    )
    assert [(it.database, it.name) for it in out] == [("a", "x"), ("a", "y"), ("z", "x")]


def test_build_introspected_sorts_columns_by_position() -> None:
    out = build_introspected_tables(
        tables=[_t("t")],
        columns=[
            _c("t", "z", position=3),
            _c("t", "y", position=2),
            _c("t", "x", position=1),
        ],
        indexes=[],
    )
    [table] = out
    assert [c.name for c in table.columns] == ["x", "y", "z"]


def test_build_introspected_uses_create_table_query_for_clauses() -> None:
    ddl = (
        "CREATE TABLE db.t (`id` UInt64)\n"
        "ENGINE = MergeTree\n"
        "PRIMARY KEY (id)\n"
        "ORDER BY (id)\n"
        "SETTINGS index_granularity = 8192"
    )
    out = build_introspected_tables(
        tables=[_t("t", create=ddl)],
        columns=[_c("t", "id")],
        indexes=[],
    )
    [table] = out
    assert table.engine == "MergeTree"
    assert table.primary_key == "(id)"
    assert table.order_by == "(id)"
    assert table.settings == {"index_granularity": "8192"}


def test_build_introspected_returns_empty_when_no_tables() -> None:
    out = build_introspected_tables(tables=[], columns=[], indexes=[])
    assert out == []


# ---------- list_schema_objects / list_table_details (fake client) ----------


class _FakeResult:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows


class _FakeClient:
    def __init__(self, responses: list[list[dict[str, Any]]]) -> None:
        self._responses = list(responses)
        self.queries: list[str] = []

    def query(self, sql: str) -> _FakeResult:
        self.queries.append(sql)
        return _FakeResult(self._responses.pop(0))


def test_list_schema_objects_filters_by_kind() -> None:
    client = _FakeClient(
        [
            [
                {"database": "default", "name": "events", "engine": "MergeTree"},
                {"database": "default", "name": "agg", "engine": "View"},
                {"database": "default", "name": "mv", "engine": "MaterializedView"},
                {"database": "default", "name": "dict", "engine": "Dictionary"},
            ]
        ]
    )
    out = list_schema_objects(client)
    kinds = {(ref.name, ref.kind) for ref in out}
    assert ("events", "table") in kinds
    assert ("agg", "view") in kinds
    assert ("mv", "materialized_view") in kinds
    # Dictionaries are first-class since the Dictionary primitive (TS 65c90d6).
    assert ("dict", "dictionary") in kinds


def test_list_schema_objects_excludes_chkit_tables_via_sql_text() -> None:
    client = _FakeClient([[]])
    list_schema_objects(client)
    # The SQL should embed the exclusion clauses.
    assert "name NOT LIKE '_chkit_%'" in client.queries[0]
    assert "system" in client.queries[0]


def test_list_table_details_returns_empty_for_empty_databases() -> None:
    client = _FakeClient([])
    out = list_table_details(client, [])
    assert out == []
    assert client.queries == []


def test_list_table_details_quotes_database_names() -> None:
    client = _FakeClient([[], [], []])
    list_table_details(client, ["analytics", "warehouse"])
    table_sql = client.queries[0]
    assert "'analytics'" in table_sql
    assert "'warehouse'" in table_sql


def test_list_table_details_escapes_single_quotes_in_db_name() -> None:
    client = _FakeClient([[], [], []])
    list_table_details(client, ["weird'name"])
    assert "'weird''name'" in client.queries[0]


def test_list_table_details_returns_introspected_table() -> None:
    table_rows = [
        {
            "database": "db",
            "name": "events",
            "engine": "MergeTree",
            "create_table_query": (
                "CREATE TABLE db.events (`id` UInt64) "
                "ENGINE = MergeTree ORDER BY id SETTINGS index_granularity = 8192"
            ),
        }
    ]
    column_rows = [
        {
            "database": "db",
            "table": "events",
            "name": "id",
            "type": "UInt64",
            "position": 1,
            "default_kind": None,
            "default_expression": None,
            "comment": None,
            "compression_codec": None,
        }
    ]
    index_rows: list[dict[str, Any]] = []

    client = _FakeClient([table_rows, column_rows, index_rows])
    out = list_table_details(client, ["db"])
    assert len(out) == 1
    [table] = out
    assert isinstance(table, IntrospectedTable)
    assert table.database == "db"
    assert table.name == "events"
    assert table.engine == "MergeTree"
    assert [c.name for c in table.columns] == ["id"]


def test_schema_object_ref_is_frozen() -> None:
    ref = SchemaObjectRef(kind="table", database="db", name="t")
    try:
        ref.kind = "view"  # type: ignore[misc]
    except (AttributeError, TypeError):
        return
    raise AssertionError("SchemaObjectRef should be frozen")
