"""SQL rendering tests."""

from __future__ import annotations

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ColumnDefinition, table, view
from chkit.core.sql import to_create_sql


def test_render_table_minimal() -> None:
    definition = canonicalize_definitions(
        [
            table(
                database="default",
                name="events",
                engine="MergeTree",
                columns=[
                    ColumnDefinition(name="ts", type="DateTime"),
                    ColumnDefinition(name="user_id", type="UInt64"),
                ],
                primary_key=["ts"],
                order_by=["ts", "user_id"],
            )
        ]
    )[0]
    sql = to_create_sql(definition)
    assert "CREATE TABLE IF NOT EXISTS default.events" in sql
    assert "PRIMARY KEY (`ts`)" in sql
    assert "ORDER BY (`ts`, `user_id`)" in sql
    assert "ENGINE = MergeTree()" in sql


def test_render_view() -> None:
    definition = canonicalize_definitions(
        [view(database="default", name="agg", as_="SELECT 1")]
    )[0]
    sql = to_create_sql(definition)
    assert sql.startswith("CREATE VIEW IF NOT EXISTS default.agg")
    assert "SELECT 1" in sql
