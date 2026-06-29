"""Tests for `chkit.cli.commands.drift_diff` + `drift_compare`."""

from __future__ import annotations

from chkit.cli.commands.drift_compare import (
    KindMismatch,
    SchemaObjectShape,
    compare_schema_objects,
    compare_table_shape,
    summarize_drift_reasons,
)
from chkit.cli.commands.drift_diff import (
    diff_by_name,
    diff_named_shape_maps,
    diff_settings,
)
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.model import (
    ColumnDefinition,
    ProjectionDefinition,
    SkipIndexBloomFilter,
    SkipIndexMinmax,
    TableDefinition,
    table,
)

# ---------- diff_by_name ----------


def test_diff_by_name_missing_extra_changed() -> None:
    expected = [{"name": "a", "v": 1}, {"name": "b", "v": 2}, {"name": "c", "v": 3}]
    actual = [{"name": "a", "v": 1}, {"name": "b", "v": 99}, {"name": "d", "v": 4}]
    result = diff_by_name(expected, actual, lambda x: str(x["name"]), lambda x: str(x["v"]))
    assert result.missing == ["c"]
    assert result.extra == ["d"]
    assert result.changed == ["b"]


def test_diff_by_name_empty_lists() -> None:
    result = diff_by_name([], [], lambda _: "", lambda _: "")
    assert result.missing == result.extra == result.changed == []


# ---------- diff_settings ----------


def test_diff_settings_detects_value_mismatch_and_missing() -> None:
    diffs = diff_settings(
        {"index_granularity": 8192, "allow_nullable_key": True},
        {"index_granularity": "8192"},
    )
    assert "allow_nullable_key" in diffs
    assert "index_granularity" not in diffs


def test_diff_settings_orders_keys() -> None:
    diffs = diff_settings({"z": 1, "a": 1, "m": 1}, {})
    assert diffs == ["a", "m", "z"]


# ---------- diff_named_shape_maps ----------


def test_diff_named_shape_maps_diffs_changed_and_missing() -> None:
    diffs = diff_named_shape_maps({"a": "x", "b": "y"}, {"a": "x", "b": "z", "c": "w"})
    assert "b" in diffs
    assert "c" in diffs
    assert "a" not in diffs


# ---------- compare_schema_objects ----------


def _so(kind: str, database: str, name: str) -> SchemaObjectShape:
    return SchemaObjectShape(kind=kind, database=database, name=name)  # type: ignore[arg-type]


def test_compare_objects_detects_missing() -> None:
    expected = [_so("table", "db", "events")]
    actual: list[SchemaObjectShape] = []
    result = compare_schema_objects(expected, actual)
    assert result.missing == ["table:db.events"]
    assert any(d.code == "missing_object" for d in result.object_drift)


def test_compare_objects_detects_extra() -> None:
    expected: list[SchemaObjectShape] = []
    actual = [_so("table", "db", "events")]
    result = compare_schema_objects(expected, actual)
    assert result.extra == ["table:db.events"]
    assert any(d.code == "extra_object" for d in result.object_drift)


def test_compare_objects_detects_kind_mismatch_view_to_table() -> None:
    expected = [_so("view", "db", "events")]
    actual = [_so("table", "db", "events")]
    result = compare_schema_objects(expected, actual)
    assert result.missing == []
    assert result.extra == []
    assert result.kind_mismatches == [
        KindMismatch(object="db.events", expected="view", actual="table")
    ]


def test_compare_objects_identical_returns_empty_buckets() -> None:
    expected = [_so("table", "db", "events")]
    actual = [_so("table", "db", "events")]
    result = compare_schema_objects(expected, actual)
    assert result.missing == result.extra == []
    assert result.kind_mismatches == []
    assert result.object_drift == []


# ---------- summarize_drift_reasons ----------


def test_summarize_drift_aggregates_object_and_table_codes() -> None:
    expected = [_so("table", "db", "a")]
    object_result = compare_schema_objects(expected, [])
    table_drift = []
    summary = summarize_drift_reasons(object_result.object_drift, table_drift)
    assert summary.object == 1
    assert summary.table == 0
    assert summary.counts.get("missing_object") == 1


# ---------- compare_table_shape ----------


def _t(
    *,
    name: str = "t",
    columns: list[ColumnDefinition] | None = None,
    engine: str = "MergeTree",
    primary_key: list[str] | None = None,
    order_by: list[str] | None = None,
    settings: dict[str, object] | None = None,
    indexes: list[object] | None = None,
    projections: list[ProjectionDefinition] | None = None,
    partition_by: str | None = None,
    ttl: str | None = None,
) -> TableDefinition:
    return table(
        database="db",
        name=name,
        engine=engine,
        columns=columns or [ColumnDefinition(name="id", type="UInt64")],
        primary_key=primary_key or ["id"],
        order_by=order_by or ["id"],
        settings=settings,
        indexes=indexes,
        projections=projections,
        partition_by=partition_by,
        ttl=ttl,
    )


def _it(
    *,
    name: str = "t",
    columns: list[ColumnDefinition] | None = None,
    engine: str | None = "MergeTree",
    primary_key: str | None = "(id)",
    order_by: str | None = "(id)",
    settings: dict[str, str] | None = None,
    indexes: list[object] | None = None,
    projections: list[ProjectionDefinition] | None = None,
    partition_by: str | None = None,
    ttl: str | None = None,
) -> IntrospectedTable:
    return IntrospectedTable(
        database="db",
        name=name,
        columns=columns or [ColumnDefinition(name="id", type="UInt64")],
        settings=settings or {},
        indexes=indexes or [],  # type: ignore[arg-type]
        projections=projections or [],
        engine=engine,
        primary_key=primary_key,
        order_by=order_by,
        partition_by=partition_by,
        ttl=ttl,
    )


def test_table_shape_no_drift_returns_none() -> None:
    assert compare_table_shape(_t(), _it()) is None


def test_table_shape_detects_extra_column() -> None:
    actual = _it(
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="extra", type="String"),
        ]
    )
    detail = compare_table_shape(_t(), actual)
    assert detail is not None
    assert "extra_column" in detail.reason_codes
    assert "extra" in detail.extra_columns


def test_table_shape_detects_missing_column() -> None:
    expected = _t(columns=[
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="ts", type="DateTime"),
    ])
    actual = _it()
    detail = compare_table_shape(expected, actual)
    assert detail is not None
    assert "missing_column" in detail.reason_codes


def test_table_shape_detects_engine_mismatch() -> None:
    detail = compare_table_shape(_t(engine="MergeTree"), _it(engine="ReplacingMergeTree"))
    assert detail is not None
    assert "engine_mismatch" in detail.reason_codes


def test_table_shape_detects_order_by_mismatch() -> None:
    detail = compare_table_shape(_t(order_by=["id", "ts"]), _it(order_by="(id)"))
    assert detail is not None
    assert "order_by_mismatch" in detail.reason_codes


def test_table_shape_detects_partition_by_mismatch() -> None:
    detail = compare_table_shape(
        _t(partition_by="toYYYYMM(ts)"), _it(partition_by="toYear(ts)")
    )
    assert detail is not None
    assert "partition_by_mismatch" in detail.reason_codes


def test_table_shape_detects_ttl_mismatch() -> None:
    detail = compare_table_shape(_t(ttl="ts + INTERVAL 7 DAY"), _it(ttl=None))
    assert detail is not None
    assert "ttl_mismatch" in detail.reason_codes


def test_table_shape_detects_index_mismatch() -> None:
    expected_idx = SkipIndexMinmax(name="idx_x", expression="x", granularity=8192)
    actual_idx = SkipIndexBloomFilter(
        name="idx_x", expression="x", granularity=8192, false_positive_rate=0.01
    )
    detail = compare_table_shape(
        _t(indexes=[expected_idx]), _it(indexes=[actual_idx])
    )
    assert detail is not None
    assert "index_mismatch" in detail.reason_codes


def test_table_shape_detects_setting_mismatch() -> None:
    detail = compare_table_shape(
        _t(settings={"index_granularity": 8192}),
        _it(settings={"index_granularity": "4096"}),
    )
    assert detail is not None
    assert "setting_mismatch" in detail.reason_codes


def test_table_shape_detects_projection_mismatch() -> None:
    detail = compare_table_shape(
        _t(projections=[ProjectionDefinition(name="p", query="SELECT * ORDER BY id")]),
        _it(projections=[ProjectionDefinition(name="p", query="SELECT * ORDER BY ts")]),
    )
    assert detail is not None
    assert "projection_mismatch" in detail.reason_codes
