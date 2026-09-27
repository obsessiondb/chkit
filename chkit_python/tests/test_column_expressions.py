"""Column expression lifecycle and legacy snapshot compatibility (#206)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from chkit import ColumnDefinition, table
from chkit.cli.commands.drift_compare import compare_table_shape
from chkit.cli.commands.pull import _introspected_table_to_definition
from chkit.cli.commands.pull_render import render_schema_file
from chkit.clickhouse.introspect import (
    IntrospectedTable,
    SystemColumnRow,
    normalize_column_from_system_row,
)
from chkit.core.model import Snapshot, TableDefinition
from chkit.core.planner import plan_diff
from chkit.core.snapshot import create_snapshot
from chkit.core.sql import to_create_sql
from chkit.core.validate import validate_definitions
from chkit_plugin_backfill.planner import _detect_backfill_strategy, assert_backfill_target_safe
from chkit_plugin_codegen import generate_type_artifacts


def definition(**column: Any) -> TableDefinition:
    return table(
        database="default",
        name="events",
        engine="MergeTree()",
        primary_key=["ts"],
        order_by=["ts"],
        columns=[
            {"name": "ts", "type": "DateTime"},
            {"name": "day", "type": "Date", **column},
        ],
    )


def actual_table(columns: list[ColumnDefinition]) -> IntrospectedTable:
    return IntrospectedTable(
        database="default",
        name="events",
        columns=columns,
        settings={},
        indexes=[],
        projections=[],
        engine="MergeTree()",
        primary_key="ts",
        order_by="ts",
    )


@pytest.mark.parametrize("kind", ["DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL"])
def test_roundtrip_kind_and_expression(kind: str) -> None:
    expected = definition(default_kind=kind, default="fn:toDate(ts)")
    actual = normalize_column_from_system_row(
        SystemColumnRow(
            database="default",
            table="events",
            name="day",
            type="Date",
            position=2,
            default_kind=kind,
            default_expression="toDate(ts)",
        )
    )
    live = actual_table([expected.columns[0], actual])
    assert compare_table_shape(expected, live) is None
    pulled = _introspected_table_to_definition(live)
    assert pulled is not None
    source = render_schema_file([pulled])
    namespace: dict[str, Any] = {}
    exec(source, namespace)
    reloaded = namespace["definitions"][0]
    assert plan_diff([expected], [reloaded]).operations == []
    assert f"`day` Date {kind} toDate(ts)" in to_create_sql(reloaded)
    assert plan_diff([reloaded], [reloaded]).operations == []


def test_bare_ephemeral_synthetic_expression_is_normalized() -> None:
    expected = definition(default_kind="EPHEMERAL")
    actual = normalize_column_from_system_row(
        SystemColumnRow(
            database="default",
            table="events",
            name="day",
            type="Date",
            position=2,
            default_kind="EPHEMERAL",
            default_expression="defaultValueOfTypeName('Date')",
        )
    )
    assert actual.default is None
    assert actual.default_kind == "EPHEMERAL"
    assert compare_table_shape(expected, actual_table([expected.columns[0], actual])) is None
    assert "`day` Date EPHEMERAL" in to_create_sql(expected)


def test_legacy_snapshot_stability() -> None:
    for value in (None, 0, False, "", "fn:toDate(ts)"):
        old = definition(default=value)
        explicit = definition(default_kind="DEFAULT", default=value)
        payload = create_snapshot([old]).model_dump(mode="json", by_alias=True, exclude_none=True)
        assert "defaultKind" not in str(payload)
        legacy = Snapshot.model_validate(payload)
        assert plan_diff(list(legacy.definitions), [explicit]).operations == []
        assert "defaultKind" not in str(
            create_snapshot([explicit]).model_dump(exclude_none=True, by_alias=True)
        )


def test_drift_detects_kind_only_changes() -> None:
    materialized = definition(default_kind="MATERIALIZED", default="fn:toDate(ts)")
    normal = definition(default="fn:toDate(ts)")
    result = compare_table_shape(normal, actual_table(materialized.columns))
    assert result is not None
    assert result.changed_columns == ["day"]
    assert len(plan_diff([normal], [materialized]).operations) == 1


@pytest.mark.parametrize("kind", ["DEFAULT", "MATERIALIZED"])
def test_remove_expression_with_type_change(kind: str) -> None:
    operations = plan_diff(
        [definition(default_kind=kind, default="fn:toDate(ts)")], [definition(type="Date32")]
    ).operations
    assert len(operations) == 1
    assert (
        operations[0].sql
        == f"ALTER TABLE default.events MODIFY COLUMN `day` Date32, MODIFY COLUMN `day` REMOVE {kind};"
    )


@pytest.mark.parametrize("kind", ["ALIAS", "EPHEMERAL"])
def test_storage_kind_changes_are_rejected(kind: str) -> None:
    virtual = definition(default_kind=kind, default="fn:toDate(ts)")
    with pytest.raises(ValueError, match="storage-kind conversions involving ALIAS or EPHEMERAL are not supported"):
        plan_diff([definition()], [virtual])
    with pytest.raises(ValueError, match="storage-kind conversions involving ALIAS or EPHEMERAL are not supported"):
        plan_diff([virtual], [definition()])


def test_validation_and_alias() -> None:
    col = ColumnDefinition.model_validate(
        {"name": "day", "type": "Date", "defaultKind": "MATERIALIZED", "default": "fn:toDate(ts)"}
    )
    assert col.default_kind == "MATERIALIZED"
    for kind in ("MATERIALIZED", "ALIAS"):
        assert any(
            issue.code == "column_expression_required"
            for issue in validate_definitions([definition(default_kind=kind)])
        )
    assert any(
        issue.code == "column_expression_required"
        for issue in validate_definitions([definition(default="fn:")])
    )


def test_codegen_read_and_insert_models() -> None:
    expected = definition(default_kind="MATERIALIZED", default="fn:toDate(ts)")
    expected = expected.model_copy(
        update={
            "columns": [
                *expected.columns,
                ColumnDefinition(name="raw", type="String", defaultKind="EPHEMERAL"),
                ColumnDefinition(
                    name="label", type="String", default_kind="ALIAS", default="fn:toString(day)"
                ),
            ]
        }
    )
    output = generate_type_artifacts(definitions=[expected])
    namespace: dict[str, Any] = {"__name__": "generated_columns"}
    exec(output.content, namespace)
    models = [value for key, value in namespace.items() if key.endswith(("Row", "RowInsert"))]
    read = next(model for model in models if model.__name__.endswith("Row"))
    insert = next(model for model in models if model.__name__.endswith("RowInsert"))
    assert set(read.model_fields) == {"ts"}
    explicit = namespace[read.__name__ + "Explicit"]
    assert set(explicit.model_fields) == {"ts", "day", "label"}
    read.model_validate({"ts": "2026-01-01 00:00:00"})
    assert set(insert.model_fields) == {"ts", "raw"}


def test_backfill_uses_implicit_insert_columns(tmp_path: Path) -> None:

    (tmp_path / "schema.py").write_text("""from chkit import table, materialized_view
result = table(database="default", name="events", engine="MergeTree()", order_by=["id"], primary_key=["id"], columns=[
    {"name": "id", "type": "UInt32"},
    {"name": "size", "type": "UInt64", "default_kind": "MATERIALIZED", "default": "fn:length(raw)"},
    {"name": "label", "type": "String", "default_kind": "ALIAS", "default": "fn:toString(size)"},
])
mv = materialized_view(database="default", name="mv", to={"database": "default", "name": "events"}, as_="SELECT id FROM default.source")
""")
    strategy = _detect_backfill_strategy(
        schema=["schema.py"], config_dir=tmp_path, database="default", table="events"
    )
    assert strategy.target_columns == ["id"]
    path = tmp_path / "ephemeral.py"
    path.write_text(
        (tmp_path / "schema.py")
        .read_text()
        .replace(
            '{"name": "id", "type": "UInt32"}',
            '{"name": "id", "type": "UInt32"}, {"name": "raw", "type": "String", "default_kind": "EPHEMERAL"}',
        )
    )
    with pytest.raises(Exception, match="cannot reconstruct EPHEMERAL inputs"):
        _detect_backfill_strategy(
            schema=["ephemeral.py"], config_dir=tmp_path, database="default", table="events"
        )


def test_introspection_preserves_sql_literal_whitespace() -> None:
    column = normalize_column_from_system_row(
        SystemColumnRow(
            database="default",
            table="events",
            name="label",
            type="String",
            position=1,
            default_kind="ALIAS",
            default_expression="  concat('a  b', toString(id))  ",
        )
    )
    assert column.default == "concat('a  b', toString(id))"


@pytest.mark.parametrize(
    ("expected", "actual", "equal"),
    [
        ("fn:concat('a  b', toString(ts))", "concat('a b', toString(ts))", False),
        ("fn:toString(ts+1)", "toString(ts + 1)", True),
        ("toString(ts)", "toString(ts)", False),
        ("toString(ts)", "'toString(ts)'", True),
        (" a  b ", "' a  b '", True),
        ("O'Reilly", "'O\\'Reilly'", True),
        ("\\n", "'\\\\n'", True),
        ("\\n", "'\\n'", False),
        ("", None, False),
        (False, "false", True),
        (0, "0", True),
        ("fn:concat('a', `ts`)", "concat('a', ts)", True),
        ("fn:toString(ts /* comment */ +1)", "toString(ts + 1)", True),
        ("fn:concat('/* a */', ts)", "concat('/* b */', ts)", False),
    ],
)
def test_expression_comparison_preserves_literals(expected: Any, actual: Any, equal: bool) -> None:
    result = compare_table_shape(
        definition(default=expected), actual_table(definition(default=actual).columns)
    )
    assert (result is None) == equal


def test_stored_expression_warning() -> None:
    plan = plan_diff([definition(default="fn:toDate(ts)")], [definition(default="fn:today()")])
    assert "does not rewrite stored historical values" in (plan.operations[0].warning or "")
    plan = plan_diff(
        [definition(default="fn:toDate(ts)", default_kind="ALIAS")],
        [definition(default="fn:today()", default_kind="ALIAS")],
    )
    assert plan.operations[0].warning is None


@pytest.mark.parametrize(
    ("rows", "message"),
    [
        ([{"name": "raw", "default_kind": "EPHEMERAL"}], "cannot reconstruct EPHEMERAL"),
        ([], "Cannot verify live target column kinds"),
        ([{"name": "raw"}], "Cannot verify live target column kinds"),
        ([{"name": "raw", "default_kind": "FUTURE"}], "Cannot verify live target column kinds"),
    ],
)
def test_backfill_live_safety_gate(rows: list[dict[str, object]], message: str) -> None:

    with pytest.raises(Exception, match=message):
        assert_backfill_target_safe(
            database="default", table="events", query=lambda sql, settings: rows
        )


def test_synthetic_ephemeral_default_escaped_type() -> None:
    col = normalize_column_from_system_row(SystemColumnRow(
        database="default", table="events", name="raw", type="Enum8('a\\b' = 1)",
        position=1, default_kind="EPHEMERAL",
        default_expression="defaultValueOfTypeName('Enum8(\\'a\\\\b\\' = 1)')",
    ))
    assert col.default is None
