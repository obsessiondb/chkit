"""Execute expression-column DDL, inserts, pull and ALTER against ClickHouse."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from chkit import table
from chkit.cli.commands.drift_compare import compare_table_shape
from chkit.cli.commands.pull import _introspected_table_to_definition
from chkit.cli.commands.pull_render import render_schema_file
from chkit.clickhouse.introspect import (
    IntrospectedTable,
    SystemColumnRow,
    normalize_column_from_system_row,
)
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit_plugin_backfill.planner import assert_backfill_target_safe
from chkit_plugin_codegen import generate_type_artifacts


def test_expression_column_lifecycle(ch_client: Any) -> None:
    client = ch_client._client
    name = f"column_expr_py_{uuid4().hex}"
    database = client.database
    definition = table(
        database=database,
        name=name,
        engine="MergeTree()",
        order_by=["id"],
        primary_key=["id"],
        columns=[
            {"name": "id", "type": "UInt32"},
            {"name": "raw", "type": "String", "default_kind": "EPHEMERAL"},
            {
                "name": "size",
                "type": "UInt64",
                "default_kind": "MATERIALIZED",
                "default": "fn:length(raw)",
            },
            {
                "name": "label",
                "type": "String",
                "default_kind": "ALIAS",
                "default": "fn:toString(size)",
            },
        ],
    )
    target = f"{database}.{name}"
    try:
        client.command(to_create_sql(definition))
        rows = client.query(
            f"SELECT database, table, name, type, position, default_kind, default_expression FROM system.columns WHERE database='{database}' AND table='{name}' ORDER BY position"
        ).named_results()
        columns = [normalize_column_from_system_row(SystemColumnRow(**row)) for row in rows]
        actual = IntrospectedTable(
            database=database,
            name=name,
            columns=columns,
            settings={},
            indexes=[],
            projections=[],
            engine="MergeTree()",
            primary_key="id",
            order_by="id",
        )
        assert compare_table_shape(definition, actual) is None
        with pytest.raises(Exception, match="cannot reconstruct EPHEMERAL"):
            assert_backfill_target_safe(database=database, table=name,
                query=lambda sql, settings: list(client.query(sql).named_results()))
        pulled = _introspected_table_to_definition(actual)
        assert pulled is not None
        namespace: dict[str, Any] = {}
        exec(render_schema_file([pulled]), namespace)
        assert plan_diff([definition], namespace["definitions"]).operations == []
        client.command(f"INSERT INTO {target} (id, raw) VALUES (1, 'abc')")
        assert client.query(f"SELECT size, label FROM {target}").result_rows == [(3, "3")]
        models: dict[str, Any] = {"__name__": "generated_live"}
        exec(generate_type_artifacts(definitions=[definition]).content, models)
        read = next(value for key, value in models.items() if key.endswith("Row"))
        explicit = models[read.__name__ + "Explicit"]
        read.model_validate(next(client.query(f"SELECT * FROM {target}").named_results()))
        # UInt64 models use the same string encoding as ClickHouse JSON output.
        explicit.model_validate({"id": 1, "size": "3", "label": "3"})
        with pytest.raises(Exception, match="MATERIALIZED"):
            client.command(f"INSERT INTO {target} (id, size) VALUES (2, 10)")
        with pytest.raises(Exception, match="raw"):
            client.query(f"SELECT raw FROM {target}")
        # Changing the expression leaves the already stored value intact.
        changed = definition.model_copy(
            update={
                "columns": [
                    column.model_copy(update={"default": "fn:toUInt64(7)"})
                    if column.name == "size"
                    else column
                    for column in definition.columns
                ]
            }
        )
        for operation in plan_diff([definition], [changed]).operations:
            assert "MATERIALIZE COLUMN" not in operation.sql
            client.command(operation.sql)
        assert client.query(f"SELECT size FROM {target}").result_rows == [(3,)]
        client.command(f"INSERT INTO {target} (id, raw) VALUES (2, 'abcd')")
        assert client.query(f"SELECT size FROM {target} ORDER BY id").result_rows == [(3,), (7,)]
        plain = changed.model_copy(
            update={
                "columns": [
                    column.model_copy(update={"default": None, "default_kind": None})
                    if column.name == "size"
                    else column
                    for column in changed.columns
                ]
            }
        )
        for operation in plan_diff([changed], [plain]).operations:
            client.command(operation.sql)
        assert client.query(
            f"SELECT default_kind FROM system.columns WHERE database='{database}' AND table='{name}' AND name='size'"
        ).result_rows == [("",)]
    finally:
        client.command(f"DROP TABLE IF EXISTS {target} SYNC")
