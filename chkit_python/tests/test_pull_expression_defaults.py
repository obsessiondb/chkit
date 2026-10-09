"""Pull renders expression defaults as ``SQLExpression`` (port of #234 pull tests)."""

from __future__ import annotations

from typing import Any

from chkit.cli.commands.pull import _introspected_table_to_definition
from chkit.cli.commands.pull_render import render_schema_file
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ColumnDefinition, TableDefinition, table
from chkit.core.sql import to_create_sql


def _events(received_at: Any) -> TableDefinition:
    return table(
        database="app",
        name="events",
        engine="MergeTree()",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "received_at", "type": "DateTime64(3)", "default": received_at},
            {"name": "status", "type": "String", "default": "pending"},
            {"name": "n", "type": "UInt8", "default": 0},
        ],
        primary_key=["id"],
        order_by=["id"],
    )


def _load(content: str) -> list[Any]:
    namespace: dict[str, Any] = {}
    exec(content, namespace)
    return list(namespace["definitions"])


def test_renders_expression_defaults_as_sql_expression_in_either_spelling() -> None:
    from_legacy = render_schema_file([_events("fn:now64(3)")])
    assert "from chkit import " in from_legacy
    assert "SQLExpression" in from_legacy.split("\n", 4)[2]
    assert (
        'ColumnDefinition(name="received_at", type="DateTime64(3)", '
        'default=SQLExpression(expression="now64(3)"))' in from_legacy
    )
    assert 'ColumnDefinition(name="status", type="String", default="pending")' in from_legacy
    assert 'ColumnDefinition(name="n", type="UInt8", default=0)' in from_legacy
    assert render_schema_file([_events({"expression": "now64(3)"})]) == from_legacy


def test_renders_default_kind_next_to_an_expression_default() -> None:
    content = render_schema_file([table(
        database="app",
        name="events",
        engine="MergeTree()",
        columns=[
            {"name": "ts", "type": "DateTime"},
            {"name": "day", "type": "Date", "default_kind": "MATERIALIZED", "default": "fn:toDate(ts)"},
            {"name": "label", "type": "String", "default_kind": "ALIAS",
             "default": {"expression": "toString(day)"}},
            {"name": "tag", "type": "String", "default_kind": "EPHEMERAL", "default": "none"},
        ],
        primary_key=["ts"],
        order_by=["ts"],
    )])
    assert (
        'ColumnDefinition(name="day", type="Date", default_kind="MATERIALIZED", '
        'default=SQLExpression(expression="toDate(ts)"))' in content
    )
    assert (
        'ColumnDefinition(name="label", type="String", default_kind="ALIAS", '
        'default=SQLExpression(expression="toString(day)"))' in content
    )
    assert (
        'ColumnDefinition(name="tag", type="String", default_kind="EPHEMERAL", default="none")'
        in content
    )


def test_file_without_expression_defaults_does_not_import_sql_expression() -> None:
    content = render_schema_file([_events(0)])
    assert "SQLExpression" not in content


def test_introspected_defaults_become_sql_expressions_and_load_back_as_fn_strings() -> None:
    introspected = IntrospectedTable(
        database="app",
        name="users",
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="email", type="String", default="''"),
            ColumnDefinition(name="domain", type="String", default_kind="MATERIALIZED",
                             default="domain(email)"),
            ColumnDefinition(name="raw", type="String", default_kind="EPHEMERAL"),
            ColumnDefinition(name="updated_at", type="DateTime", default="now()"),
        ],
        settings={},
        indexes=[],
        projections=[],
        engine="MergeTree",
        order_by="id",
    )
    pulled = _introspected_table_to_definition(introspected)
    assert pulled is not None
    content = render_schema_file([pulled])
    assert 'default=SQLExpression(expression="\'\'")' in content
    assert (
        'ColumnDefinition(name="domain", type="String", default_kind="MATERIALIZED", '
        'default=SQLExpression(expression="domain(email)"))' in content
    )
    assert 'ColumnDefinition(name="raw", type="String", default_kind="EPHEMERAL")' in content

    # The pulled SQLExpression defaults load back, canonicalize to the fn:
    # strings earlier pulls produced, and render as SQL.
    [loaded] = _load(content)
    assert isinstance(loaded, TableDefinition)
    assert "`updated_at` DateTime DEFAULT now()" in to_create_sql(loaded)
    [canonical] = canonicalize_definitions([loaded])
    assert isinstance(canonical, TableDefinition)
    defaults = {column.name: column.default for column in canonical.columns}
    assert defaults["updated_at"] == "fn:now()"
    assert defaults["email"] == "fn:''"
