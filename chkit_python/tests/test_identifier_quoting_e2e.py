"""Port of ``packages/core/src/identifier-quoting.e2e.test.ts``.

Executes chkit-py-generated DDL whose database, table and column names need
quoting, then reads the names back from system tables to prove ClickHouse
stored exactly what was declared.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest

from chkit.core.model import TableDefinition, table
from chkit.core.planner import plan_diff
from chkit.core.sql import render_alter_add_column, render_alter_drop_column, to_create_sql
from tests.e2e_testkit import (
    create_prefix,
    live_env_to_client_kwargs,
    poll_until,
    resolve_live_env,
    run_once_visible,
)

EVIL_COLUMN = "evil` UInt8, `x"


@pytest.fixture(scope="module")
def client() -> Iterator[Any]:
    live = clickhouse_connect.get_client(**live_env_to_client_kwargs(resolve_live_env()))
    yield live
    live.close()


@pytest.fixture
def table_definition(client: Any) -> Iterator[TableDefinition]:
    name = f"{create_prefix('ident')}we`ird\\name"
    database = resolve_live_env().clickhouse_database
    definition = table(
        database=database,
        name=name,
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": EVIL_COLUMN, "type": "String"},
            {"name": "a.b", "type": "String"},
        ],
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )
    _exec(client, to_create_sql(definition))
    yield definition
    drop = plan_diff([definition], []).operations[0].sql
    client.command(drop.removesuffix(";"), settings={"wait_end_of_query": 1})


def _exec(client: Any, sql: str) -> None:
    client.command(sql.removesuffix(";"), settings={"wait_end_of_query": 1})


def _column_names(client: Any, definition: TableDefinition) -> list[str]:
    rows = client.query(
        "SELECT name FROM system.columns WHERE database = {db:String} "
        "AND table = {table:String} ORDER BY position",
        parameters={"db": definition.database, "table": definition.name},
    ).result_rows
    return [str(row[0]) for row in rows]


def test_create_table_preserves_names_verbatim(
    client: Any, table_definition: TableDefinition
) -> None:
    definition = table_definition
    expected = ["id", EVIL_COLUMN, "a.b"]
    assert poll_until(lambda: _column_names(client, definition), lambda n: n == expected) == expected


def test_add_and_drop_column_target_the_exact_names(
    client: Any, table_definition: TableDefinition
) -> None:
    definition = table_definition
    added = "new`col\\with slash"
    run_once_visible(
        lambda: _exec(client, render_alter_add_column(definition, {"name": added, "type": "String"}))
    )
    expected = ["id", EVIL_COLUMN, "a.b", added]
    assert poll_until(lambda: _column_names(client, definition), lambda n: n == expected) == expected

    _exec(client, render_alter_drop_column(definition, EVIL_COLUMN))
    expected = ["id", "a.b", added]
    assert poll_until(lambda: _column_names(client, definition), lambda n: n == expected) == expected
