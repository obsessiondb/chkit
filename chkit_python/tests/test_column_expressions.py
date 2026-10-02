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
from chkit.core.model import ChxValidationError, Snapshot, TableDefinition
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
    # REMOVE runs first on its own: ClickHouse checks the old default against the new type.
    assert [(operation.key, operation.sql) for operation in operations] == [
        ("table:default.events:column:day", f"ALTER TABLE default.events MODIFY COLUMN `day` REMOVE {kind};"),
        ("table:default.events:column:day", "ALTER TABLE default.events MODIFY COLUMN `day` Date32;"),
    ]
    assert [operation.warning is None for operation in operations] == [True, False]


@pytest.mark.parametrize("kind", ["ALIAS", "EPHEMERAL"])
def test_storage_kind_changes_are_rejected(kind: str) -> None:
    virtual = definition(default_kind=kind, default="fn:toDate(ts)")
    with pytest.raises(ChxValidationError):
        plan_diff([definition()], [virtual])
    with pytest.raises(ChxValidationError):
        plan_diff([virtual], [definition()])


def test_every_blocked_storage_kind_change_of_a_table_is_reported_at_once() -> None:
    def events(day: str, label: str) -> TableDefinition:
        return table(
            database="default",
            name="events",
            engine="MergeTree()",
            primary_key=["ts"],
            order_by=["ts"],
            columns=[
                {"name": "ts", "type": "DateTime"},
                {"name": "day", "type": "Date", "default_kind": day, "default": "fn:toDate(ts)"},
                {"name": "label", "type": "String", "default_kind": label, "default": "fn:toString(ts)"},
            ],
        )

    with pytest.raises(ChxValidationError) as excinfo:
        plan_diff([events("DEFAULT", "ALIAS")], [events("EPHEMERAL", "DEFAULT")])
    assert [issue.model_dump() for issue in excinfo.value.issues] == [
        {
            "code": "column_kind_change_unsupported",
            "kind": "table",
            "database": "default",
            "name": "events",
            "message": f"Cannot automatically change column default.events.{name} from {old} to "
            f"{new}; storage-kind conversions involving ALIAS or EPHEMERAL are not supported. "
            f"Keep the column declared as {old} in the schema.",
        }
        for name, old, new in [("day", "DEFAULT", "EPHEMERAL"), ("label", "ALIAS", "DEFAULT")]
    ]


@pytest.mark.parametrize(("before", "after"), [(0, False), (True, 1)])
def test_historical_value_warning_treats_booleans_and_numbers_as_distinct(
    before: int | bool, after: int | bool
) -> None:
    plan = plan_diff([definition(type="UInt8", default=before)], [definition(type="UInt8", default=after)])
    assert "does not rewrite stored historical values" in (plan.operations[0].warning or "")


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
        ([{"name": "raw", "default_kind": "EPHEMERAL"}, {"name": "day", "default_kind": "MATERIALIZED"}],
         r"recomputes MATERIALIZED column\(s\) day, which may read EPHEMERAL column\(s\) raw"),
        ([], "does not exist or is not visible yet"),
        ([{"name": "raw"}], "Cannot verify live target column kinds"),
        ([{"name": "raw", "default_kind": "FUTURE"}], "Cannot verify live target column kinds"),
    ],
)
def test_backfill_live_safety_gate(rows: list[dict[str, object]], message: str) -> None:

    with pytest.raises(Exception, match=message):
        assert_backfill_target_safe(
            database="default", table="events", mode="copy", query=lambda sql, settings: rows
        )


def test_synthetic_ephemeral_default_escaped_type() -> None:
    col = normalize_column_from_system_row(SystemColumnRow(
        database="default", table="events", name="raw", type="Enum8('a\\b' = 1)",
        position=1, default_kind="EPHEMERAL",
        default_expression="defaultValueOfTypeName('Enum8(\\'a\\\\b\\' = 1)')",
    ))
    assert col.default is None


def kind_table(**overrides: Any) -> TableDefinition:
    columns: list[dict[str, Any]] = [
        {"name": "id", "type": "UInt64"},
        {"name": "day", "type": "Date", "default_kind": "ALIAS", "default": "fn:toDate(id)"},
        {"name": "raw", "type": "String", "default_kind": "EPHEMERAL"},
        {"name": "size", "type": "UInt64", "default_kind": "MATERIALIZED", "default": "fn:length(raw)"},
    ]
    return table(**{"database": "default", "name": "events", "engine": "MergeTree()",
                    "primary_key": ["id"], "order_by": ["id"], "columns": columns, **overrides})


def issue_messages(definition: TableDefinition, code: str) -> list[str]:
    return [issue.message for issue in validate_definitions([definition]) if issue.code == code]


@pytest.mark.parametrize(
    ("kind", "default", "flagged"),
    [
        ("MATERIALIZED", "toDate(ts)", True),
        ("ALIAS", "label", True),
        ("ALIAS", "fn:'label'", False),
        ("MATERIALIZED", 7, False),
        ("ALIAS", True, False),
        ("DEFAULT", "label", False),
        ("EPHEMERAL", "label", False),
    ],
)
def test_expression_kinds_reject_plain_string_defaults(kind: str, default: Any, flagged: bool) -> None:
    messages = issue_messages(definition(default_kind=kind, default=default), "column_expression_requires_fn")
    expected = (
        f'Column "day" is {kind} with a plain string default, which ClickHouse would store as the '
        f"text '{default}'. Prefix SQL expressions with fn: (for example fn:toDate(ts)); "
        "write fn:'<text>' for a constant string."
    )
    assert messages == ([expected] if flagged else [])


@pytest.mark.parametrize(
    ("overrides", "field", "kind", "column"),
    [
        ({"order_by": ["day"]}, "orderBy", "ALIAS", "day"),
        ({"order_by": ["id", "`raw`"]}, "orderBy", "EPHEMERAL", "raw"),
        ({"order_by": ["id", '"raw"']}, "orderBy", "EPHEMERAL", "raw"),
        ({"primary_key": ["id, day"]}, "primaryKey", "ALIAS", "day"),
        ({"partition_by": "(day, id)"}, "partitionBy", "ALIAS", "day"),
        ({"engine": "SummingMergeTree((id, day))"}, "engine", "ALIAS", "day"),
        ({"engine": "ReplacingMergeTree(raw)"}, "engine", "EPHEMERAL", "raw"),
        ({"indexes": [{"name": "i", "expression": "raw", "type": "minmax", "granularity": 1}]},
         'index "i"', "EPHEMERAL", "raw"),
    ],
)
def test_unstored_columns_named_where_clickhouse_needs_stored_data(
    overrides: dict[str, Any], field: str, kind: str, column: str
) -> None:
    assert issue_messages(kind_table(**overrides), "column_kind_not_stored") == [
        f'Table default.events {field} references {kind} column "{column}", which ClickHouse '
        "does not store; use a MATERIALIZED column instead."
    ]


@pytest.mark.parametrize(
    "overrides",
    [
        {"order_by": ["size"], "partition_by": "size", "engine": "SummingMergeTree(size)"},
        {"order_by": ["toStartOfMonth(day)"], "partition_by": "toYYYYMM(day)"},
        {"engine": "ReplicatedMergeTree('day', 'raw')", "ttl": "day + INTERVAL 1 DAY"},
        {"indexes": [{"name": "i", "expression": "day", "type": "minmax", "granularity": 1}]},
    ],
)
def test_stored_columns_and_nested_references_are_not_flagged(overrides: dict[str, Any]) -> None:
    assert issue_messages(kind_table(**overrides), "column_kind_not_stored") == []


@pytest.mark.parametrize(
    ("projection", "flagged"),
    [
        ({"name": "p", "query": "SELECT id, length(raw), raw ORDER BY id"}, True),
        ({"name": "p", "query": "SELECT `raw`, id ORDER BY id"}, True),
        ({"name": "p", "index": "raw", "type": "basic"}, True),
        ({"name": "p", "query": "SELECT id, lower(toString(id)), 'raw', day ORDER BY id"}, False),
        ({"name": "p", "query": "SELECT (raw"}, False),
        ({"name": "p", "query": "SELECT id AS raw ORDER BY id"}, False),
    ],
)
def test_projections_reading_ephemeral_columns(projection: dict[str, Any], flagged: bool) -> None:
    columns = [*kind_table().columns, {"name": "lower", "type": "String", "default_kind": "EPHEMERAL"}]
    definition = kind_table(columns=columns, projections=[projection])
    assert issue_messages(definition, "column_ephemeral_in_projection") == (
        [
            'Table default.events projection "p" reads EPHEMERAL column "raw", which ClickHouse '
            "does not store, so the table is rejected or every INSERT fails. "
            "Use a MATERIALIZED column instead."
        ]
        if flagged
        else []
    )


@pytest.mark.parametrize(
    ("column", "flagged"),
    [
        ({"default_kind": "ALIAS", "default": "fn:toDate(ts)"}, True),
        ({"default_kind": "EPHEMERAL"}, True),
        ({"default_kind": "EPHEMERAL", "default": "fn:today()"}, False),
        ({"default_kind": "EPHEMERAL", "comment": "input"}, False),
        ({"default_kind": "MATERIALIZED", "default": "fn:toDate(ts)"}, False),
    ],
)
def test_codecs_on_columns_without_storage(column: dict[str, Any], flagged: bool) -> None:
    messages = issue_messages(definition(codec={"kind": "LZ4"}, **column), "column_kind_codec_unsupported")
    assert messages == (
        [f'Column "day" is {column["default_kind"]} and cannot have a codec; ClickHouse stores no data for it.']
        if flagged
        else []
    )
