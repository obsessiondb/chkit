"""Planner / diff tests."""

from __future__ import annotations

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ColumnDefinition, table
from chkit.core.planner import plan_diff


def _events_v1() -> list:
    return canonicalize_definitions(
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
                order_by=["ts"],
            )
        ]
    )


def _events_v2() -> list:
    return canonicalize_definitions(
        [
            table(
                database="default",
                name="events",
                engine="MergeTree",
                columns=[
                    ColumnDefinition(name="ts", type="DateTime"),
                    ColumnDefinition(name="user_id", type="UInt64"),
                    ColumnDefinition(name="event", type="String"),
                ],
                primary_key=["ts"],
                order_by=["ts"],
            )
        ]
    )


def test_no_changes_produces_empty_plan() -> None:
    plan = plan_diff(_events_v1(), _events_v1())
    assert plan.operations == []


def test_added_column_emits_alter_add() -> None:
    plan = plan_diff(_events_v1(), _events_v2())
    types = [op.type for op in plan.operations]
    assert "alter_table_add_column" in types


def test_initial_create_emits_create_database_and_create_table() -> None:
    plan = plan_diff([], _events_v1())
    types = [op.type for op in plan.operations]
    assert "create_database" in types
    assert "create_table" in types
