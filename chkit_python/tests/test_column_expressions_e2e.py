"""Execute expression-column DDL, inserts, pull and ALTER against ClickHouse."""

from __future__ import annotations

import os
import time
from typing import Any
from uuid import uuid4

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
from chkit.core.model import TableDefinition
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.validate import validate_definitions
from chkit_plugin_backfill.planner import assert_backfill_target_safe
from chkit_plugin_codegen import generate_type_artifacts
from tests.e2e_testkit import poll_until, run_once_visible

# Consecutive ALTERs race replica lag on ObsessionDB (#240); the verify job runs
# this against open-source ClickHouse.
_ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"


@pytest.mark.skipif(
    _ON_OBSESSIONDB,
    reason="consecutive ALTERs race replica lag on ObsessionDB (#240)",
)
def test_expression_column_lifecycle(ch_client: Any) -> None:  # noqa: PLR0915 — mirrors the TS lifecycle test
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
        actual = _settled_shape(client, definition)
        assert compare_table_shape(definition, actual) is None
        with pytest.raises(Exception, match="cannot reconstruct EPHEMERAL"):
            assert_backfill_target_safe(database=database, table=name, mode="copy",
                query=lambda sql, settings: list(client.query(sql).named_results()))
        with pytest.raises(Exception, match="does not exist or is not visible yet"):
            assert_backfill_target_safe(database=database, table=f"{name}_missing", mode="copy",
                query=lambda sql, settings: list(client.query(sql).named_results()))
        pulled = _introspected_table_to_definition(actual)
        assert pulled is not None
        namespace: dict[str, Any] = {}
        exec(render_schema_file([pulled]), namespace)
        assert plan_diff([definition], namespace["definitions"]).operations == []
        run_once_visible(lambda: client.command(f"INSERT INTO {target} (id, raw) VALUES (1, 'abc')"))
        assert _settled_rows(client, f"SELECT size, label FROM {target}", 1) == [(3, "3")]
        models: dict[str, Any] = {"__name__": "generated_live"}
        exec(generate_type_artifacts(definitions=[definition]).content, models)
        read = next(value for key, value in models.items() if key.endswith("Row"))
        explicit = models[read.__name__ + "Explicit"]
        read.model_validate(next(client.query(f"SELECT * FROM {target}").named_results()))
        # UInt64 models use the same string encoding as ClickHouse JSON output.
        explicit.model_validate({"id": 1, "size": "3", "label": "3"})
        with pytest.raises(Exception, match="MATERIALIZED"):
            client.command(f"INSERT INTO {target} (id, size) VALUES (2, 10)")
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
        assert compare_table_shape(changed, _settled_shape(client, changed)) is None
        assert _settled_rows(client, f"SELECT size FROM {target}", 1) == [(3,)]
        client.command(f"INSERT INTO {target} (id, raw) VALUES (2, 'abcd')")
        assert _settled_rows(client, f"SELECT size FROM {target} ORDER BY id", 2) == [(3,), (7,)]
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
        assert compare_table_shape(plain, _settled_shape(client, plain)) is None
        # In one ALTER, ClickHouse casts the retained 'abc' to UInt64 before the REMOVE.
        coded = plain.model_copy(update={"name": f"{name}_code", "columns": [
            ColumnDefinition(name="id", type="UInt32"),
            ColumnDefinition(name="code", type="String", default="abc"),
        ]})
        retyped = coded.model_copy(
            update={"columns": [coded.columns[0], ColumnDefinition(name="code", type="UInt64")]}
        )
        client.command(to_create_sql(coded))
        assert compare_table_shape(coded, _settled_shape(client, coded)) is None
        run_once_visible(
            lambda: client.command(f"INSERT INTO {target}_code (id, code) VALUES (1, '42')")
        )
        for operation in plan_diff([coded], [retyped]).operations:
            client.command(operation.sql)
        assert compare_table_shape(retyped, _settled_shape(client, retyped)) is None
        assert _settled_rows(client, f"SELECT code FROM {target}_code", 1) == [(42,)]
        keyed = plain.model_copy(update={"order_by": ["id", "k"], "columns": [
            ColumnDefinition(name="id", type="UInt32"),
            ColumnDefinition(name="k", type="UInt32", default_kind="ALIAS", default="fn:id"),
        ]})
        assert [issue.code for issue in validate_definitions([keyed])] == ["column_kind_not_stored"]
        create = f"CREATE TABLE {target}_keyed (id UInt32, k UInt32 {{}} id) ENGINE = MergeTree ORDER BY (id, k)"
        with pytest.raises(Exception, match="UNKNOWN_IDENTIFIER"):
            client.command(create.format("ALIAS"))
        client.command(create.format("MATERIALIZED"))
    finally:
        for suffix in ("", "_code", "_keyed"):
            client.command(f"DROP TABLE IF EXISTS {target}{suffix} SYNC")


def test_hand_written_heredoc_and_alias_typed_ephemeral_columns_show_no_drift(
    ch_client: Any,
) -> None:
    client = ch_client._client
    definition = table(
        database=client.database,
        name=f"expr_drift_py_{uuid4().hex}",
        engine="MergeTree()",
        order_by=["id"],
        primary_key=["id"],
        columns=[
            {"name": "id", "type": "UInt32"},
            {"name": "msg", "type": "String", "default": "fn:$$it's$$"},
            {"name": "wrapped", "type": "String", "default": "fn:concat($$(x$$, 'y')"},
            {"name": "big", "type": "Int64", "default_kind": "EPHEMERAL"},
            {"name": "dec", "type": "Decimal(9, 2)", "default_kind": "EPHEMERAL"},
            {"name": "opt", "type": "Int64", "nullable": True, "default_kind": "EPHEMERAL"},
            {
                "name": "explicit",
                "type": "String",
                "default_kind": "EPHEMERAL",
                "default": "fn:defaultValueOfTypeName('String')",
            },
        ],
    )
    target = f"{definition.database}.{definition.name}"
    try:
        # ClickHouse stores heredocs as quoted literals and canonicalizes alias types,
        # but keeps the written spelling in the synthesized EPHEMERAL default.
        client.command(
            f"CREATE TABLE {target} (id UInt32, msg String DEFAULT $$it's$$, "
            "wrapped String DEFAULT concat($$(x$$, 'y'), big BIGINT EPHEMERAL, "
            "dec Decimal32(2) EPHEMERAL, opt Nullable(BIGINT) EPHEMERAL, "
            "explicit String EPHEMERAL defaultValueOfTypeName('String')) "
            "ENGINE = MergeTree ORDER BY id"
        )
        assert compare_table_shape(definition, _settled_shape(client, definition)) is None
    finally:
        client.command(f"DROP TABLE IF EXISTS {target} SYNC")


def _settled_rows(client: Any, sql: str, count: int) -> list[Any]:
    """Re-read until ``count`` rows are visible (TS ``settledRows``).

    Inserted rows can reach replicas at different times on managed ClickHouse
    (e.g. ObsessionDB).
    """
    return poll_until(lambda: list(client.query(sql).result_rows), lambda rows: len(rows) == count)


def _settled_shape(client: Any, definition: TableDefinition) -> IntrospectedTable:
    """Re-read ``system.columns`` until it matches ``definition``.

    DDL is eventually consistent on managed ClickHouse (e.g. ObsessionDB). Running
    out of time returns the last observation so the caller's assert shows it.
    """
    for _ in range(60):
        shape = _read_shape(client, definition)
        if compare_table_shape(definition, shape) is None:
            break
        time.sleep(0.5)
    return shape


def _read_shape(client: Any, definition: TableDefinition) -> IntrospectedTable:
    rows = client.query(
        "SELECT database, table, name, type, position, default_kind, default_expression "
        f"FROM system.columns WHERE database='{definition.database}' "
        f"AND table='{definition.name}' ORDER BY position"
    ).named_results()
    return IntrospectedTable(
        database=definition.database,
        name=definition.name,
        columns=[normalize_column_from_system_row(SystemColumnRow(**row)) for row in rows],
        settings={},
        indexes=[],
        projections=[],
        engine="MergeTree()",
        primary_key="id",
        order_by="id",
    )
