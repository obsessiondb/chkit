"""Function expressions in primaryKey/orderBy — port of TS 5a8d805 (#178).

Direct ports of the #176/#178 tests in ``packages/core/src/index.test.ts``.
"""

from __future__ import annotations

from chkit.core.model import table
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.validate import validate_definitions


def test_renders_function_expressions_in_key_clauses_without_quoting() -> None:
    events = table(
        database="chatty",
        name="session",
        columns=[
            {"name": "sso_id", "type": "String"},
            {"name": "session_id", "type": "String"},
            {"name": "session_end", "type": "DateTime"},
        ],
        engine="MergeTree()",
        primary_key=["sso_id", "toStartOfHour(session_end)", "session_id"],
        order_by=["sso_id", "toStartOfHour(session_end)", "session_id", "session_end"],
    )

    sql = to_create_sql(events)
    assert "PRIMARY KEY (`sso_id`, toStartOfHour(session_end), `session_id`)" in sql
    assert (
        "ORDER BY (`sso_id`, toStartOfHour(session_end), `session_id`, `session_end`)"
        in sql
    )


def test_quotes_declared_columns_even_when_the_name_needs_quoting() -> None:
    events = table(
        database="app",
        name="events",
        columns=[
            {"name": "user-id", "type": "String"},
            {"name": "ts", "type": "DateTime"},
        ],
        engine="MergeTree()",
        primary_key=["user-id", "toStartOfHour(ts)"],
        order_by=["user-id", "toStartOfHour(ts)"],
    )

    sql = to_create_sql(events)
    assert "PRIMARY KEY (`user-id`, toStartOfHour(ts))" in sql
    assert "ORDER BY (`user-id`, toStartOfHour(ts))" in sql


def test_no_recreate_when_key_expression_differs_only_by_whitespace() -> None:
    columns = [
        {"name": "sso_id", "type": "String"},
        {"name": "session_end", "type": "DateTime"},
    ]
    introspected = [
        table(
            database="app",
            name="sessions",
            columns=columns,
            engine="MergeTree()",
            primary_key=["sso_id", "toStartOfHour(session_end)"],
            order_by=["sso_id", "toStartOfHour(session_end)"],
        )
    ]
    config = [
        table(
            database="app",
            name="sessions",
            columns=columns,
            engine="MergeTree()",
            primary_key=["sso_id", "toStartOfHour(  session_end )"],
            order_by=["sso_id", "toStartOfHour(  session_end )"],
        )
    ]

    plan = plan_diff(introspected, config)
    assert plan.operations == []


def test_no_recreate_when_key_column_differs_only_by_identifier_quoting() -> None:
    columns = [
        {"name": "user-id", "type": "String"},
        {"name": "ts", "type": "DateTime"},
    ]
    introspected = [
        table(
            database="app",
            name="events",
            columns=columns,
            engine="MergeTree()",
            primary_key=["`user-id`"],
            order_by=["`user-id`", "toStartOfHour(ts)"],
        )
    ]
    config = [
        table(
            database="app",
            name="events",
            columns=columns,
            engine="MergeTree()",
            primary_key=["user-id"],
            order_by=["user-id", "toStartOfHour(ts)"],
        )
    ]

    plan = plan_diff(introspected, config)
    assert plan.operations == []


def test_allows_function_expressions_in_primary_key_and_order_by() -> None:
    defs = [
        table(
            database="bi",
            name="price_history_label",
            columns=[
                {"name": "csin", "type": "String"},
                {"name": "product_changed_at", "type": "DateTime"},
            ],
            engine="MergeTree()",
            primary_key=["toDate(product_changed_at)", "csin", "product_changed_at"],
            order_by=["toDate(product_changed_at)", "csin", "product_changed_at"],
        )
    ]

    issues = validate_definitions(defs)
    assert issues == []
