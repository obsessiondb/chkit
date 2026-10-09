"""Port of ``packages/core/src/column-default.test.ts`` (#234)."""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from pydantic import ValidationError

from chkit.core.canonical import canonicalize_definitions
from chkit.core.column_default import (
    ExpressionDefault,
    LiteralDefault,
    canonicalize_column_default,
    column_type_accepts_string_literal,
    parse_column_default,
    render_default,
    starts_with_function_call,
    stores_unparsable_literal_as_null,
)
from chkit.core.model import (
    ChxValidationError,
    ColumnDefinition,
    SQLExpression,
    TableDefinition,
    table,
)
from chkit.core.planner import plan_diff
from chkit.core.snapshot import create_snapshot
from chkit.core.sql import render_alter_add_column, render_alter_modify_column, to_create_sql
from chkit.core.sql_lexer import tokenize_sql
from chkit.core.sql_splitter import extract_executable_statements
from chkit.core.validate import validate_definitions

Column = dict[str, Any]


def events(columns: list[Column]) -> TableDefinition:
    return table(
        database="app",
        name="events",
        columns=[{"name": "id", "type": "UInt64"}, *columns],
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )


def issue_codes(columns: list[Column]) -> list[str]:
    return [issue.code for issue in validate_definitions([events(columns)])]


def issue_messages(columns: list[Column]) -> list[str]:
    return [issue.message for issue in validate_definitions([events(columns)])]


def operation_types(old: list[Column], new: list[Column]) -> list[str]:
    return [op.type for op in plan_diff([events(old)], [events(new)]).operations]


def ops(old: list[Column], new: list[Column]) -> list[dict[str, Any]]:
    return [
        op.model_dump(by_alias=True, exclude_none=True)
        for op in plan_diff([events(old)], [events(new)]).operations
    ]


def historical_values_warning(column: str) -> str:
    """The planner's note on a MODIFY COLUMN that changes a DEFAULT or MATERIALIZED expression."""
    return (
        f"Changing the expression for app.events.{column} does not rewrite stored historical "
        "values. Review a separate MATERIALIZE COLUMN migration if a rewrite is required; never "
        "reconstruct values from discarded EPHEMERAL inputs."
    )


def expr(sql: str) -> dict[str, str]:
    return {"expression": sql}


# ---------- parse_column_default ----------


def test_parse_reads_strings_numbers_and_booleans_as_literals() -> None:
    assert parse_column_default("pending") == LiteralDefault("pending")
    assert parse_column_default(" now() ") == LiteralDefault(" now() ")
    assert parse_column_default(0) == LiteralDefault(0)
    assert parse_column_default(False) == LiteralDefault(False)  # noqa: FBT003


def test_parse_reads_expression_and_legacy_prefix_as_trimmed_sql() -> None:
    assert parse_column_default(SQLExpression(expression="  now64(3)\n")) == ExpressionDefault("now64(3)")
    assert parse_column_default("fn:now64(3)") == ExpressionDefault("now64(3)")
    assert parse_column_default("fn: now() ") == ExpressionDefault("now()")


def test_parse_keeps_comments_inside_the_expression() -> None:
    assert parse_column_default(SQLExpression(expression="now() -- set on insert")) == (
        ExpressionDefault("now() -- set on insert")
    )


@pytest.mark.parametrize("expression", ["now() # ", "now() #  \n# \t", "now() # \n\u00a0"])
def test_parse_trims_an_empty_hash_comment_at_the_end_like_whitespace(expression: str) -> None:
    # ClickHouse reads # as a comment only before a space or `!`: trimming the
    # space of an empty `# ` comment would leave a bare #, a syntax error.
    assert parse_column_default(SQLExpression(expression=expression)) == ExpressionDefault("now()")


def test_parse_trims_empty_hash_comment_in_legacy_and_alone() -> None:
    assert parse_column_default("fn:now() # ") == ExpressionDefault("now()")
    assert parse_column_default(SQLExpression(expression="# ")) == ExpressionDefault("")


def test_parse_keeps_hash_comment_with_text_bang_comment_and_stray_hash() -> None:
    def parse(sql: str) -> object:
        return parse_column_default(SQLExpression(expression=sql))

    assert parse("now() # note ") == ExpressionDefault("now() # note")
    assert parse("now() #! ") == ExpressionDefault("now() #!")
    assert parse("concat('a', '# ') ") == ExpressionDefault("concat('a', '# ')")
    # A tab or a no-break space after # starts no comment; validation reports the #.
    assert parse("now() #\t") == ExpressionDefault("now() #")
    assert parse("now() #\u00a0") == ExpressionDefault("now() #")


# ---------- canonicalize_column_default ----------


def test_canonicalize_stores_an_expression_as_the_trimmed_fn_string() -> None:
    assert canonicalize_column_default(SQLExpression(expression="now64(3)")) == "fn:now64(3)"
    assert canonicalize_column_default(SQLExpression(expression=" now64(3) ")) == "fn:now64(3)"
    assert canonicalize_column_default("fn:now64(3)") == "fn:now64(3)"
    assert canonicalize_column_default("fn: now64(3)\n") == "fn:now64(3)"
    assert canonicalize_column_default(SQLExpression(expression="now() -- set on insert")) == (
        "fn:now() -- set on insert"
    )
    assert canonicalize_column_default(SQLExpression(expression="now64(3) # ")) == "fn:now64(3)"


def test_canonicalize_returns_literals_unchanged() -> None:
    assert canonicalize_column_default("pending") == "pending"
    assert canonicalize_column_default("  padded ") == "  padded "
    assert canonicalize_column_default(0) == 0
    assert canonicalize_column_default(True) is True  # noqa: FBT003


# ---------- render_default ----------


def test_render_quotes_string_literals_escaping_quotes_and_backslashes() -> None:
    assert render_default("it's") == "'it''s'"
    assert render_default("C:\\temp") == "'C:\\\\temp'"
    assert render_default(0) == "0"
    assert render_default(False) == "false"  # noqa: FBT003


def test_render_expression_in_either_spelling_without_comments() -> None:
    assert render_default(SQLExpression(expression=" now64(3) -- set on insert ")) == "now64(3)"
    assert render_default("fn: now64(3) /* server clock */") == "now64(3)"


def test_render_ends_with_newline_after_a_stray_hash() -> None:
    assert render_default(SQLExpression(expression="1 #")) == "1 #\n"
    assert render_default(SQLExpression(expression="now() #\t-- note")) == "now() #\n"


# ---------- type helpers ----------


@pytest.mark.parametrize(
    "type_",
    [
        "String", " String ", "FixedString(16)", "LowCardinality(String)", "Nullable(String)",
        "Nullable( String )", "LowCardinality(Nullable(String))", "Nullable(FixedString(8))",
        "Enum8('a' = 1)", "Enum16('a' = 1)", "Enum('a' = 1)", "TEXT", "text", "VARCHAR(255)",
        "NATIONAL CHAR VARYING", "BINARY(16)", "Dynamic", "Dynamic(max_types=4)",
        "Variant(String, UInt64)", "Variant(LowCardinality(String), UInt64)",
        "SimpleAggregateFunction(anyLast, Nullable(String))",
    ],
)
def test_type_holds_a_string_literal(type_: str) -> None:
    assert column_type_accepts_string_literal(type_) is True


@pytest.mark.parametrize(
    "type_",
    [
        "DateTime", "DateTime64(3, 'UTC')", "Date", "UInt64", "Float64", "Decimal(10, 2)", "Bool",
        "UUID", "IPv4", "Array(String)", "Array(Nullable(String))", "Map(String, String)",
        "Tuple(String)", "JSON", "Nested(a String)", "Nullable(DateTime)",
        "LowCardinality(Nullable(DateTime))", "Variant(DateTime, UInt64)",
        "Variant(Array(String), UInt64)", "SimpleAggregateFunction(max, DateTime)",
    ],
)
def test_type_does_not_hold_a_string_literal(type_: str) -> None:
    assert column_type_accepts_string_literal(type_) is False


@pytest.mark.parametrize(
    "type_",
    [
        "Nullable(DateTime)", "Nullable( DateTime )", "Nullable(DateTime64(3, 'UTC'))",
        "Nullable(UInt64)", "Nullable(Decimal(10, 2))", "Nullable(UUID)", "Nullable(IPv6)",
        "Nullable(TIMESTAMP)", "Nullable(BIGINT UNSIGNED)",
        "Nullable(SimpleAggregateFunction(max, UInt64))",
        "SimpleAggregateFunction(max, Nullable(DateTime))",
    ],
)
def test_type_stores_unparsable_literal_as_null(type_: str) -> None:
    assert stores_unparsable_literal_as_null(type_) is True


@pytest.mark.parametrize(
    "type_",
    [
        "DateTime", "Nullable(Bool)", "LowCardinality(Nullable(DateTime))",
        "Nullable(LowCardinality(DateTime))", "Nullable(Nullable(DateTime))",
        "Nullable(Array(DateTime))", "Nullable(Map(String, DateTime))",
        "SimpleAggregateFunction(max, DateTime)", "Nullable(SimpleAggregateFunction(anyLast, Bool))",
    ],
)
def test_type_does_not_store_unparsable_literal_as_null(type_: str) -> None:
    assert stores_unparsable_literal_as_null(type_) is False


@pytest.mark.parametrize(
    "value", ["now()", "now64(3)", " toDate(now()) ", "now() - INTERVAL 1 DAY", "CAST(0 AS UInt8)", "map()"]
)
def test_starts_with_function_call(value: str) -> None:
    assert starts_with_function_call(value) is True


@pytest.mark.parametrize(
    "value", ["pending", "42", "2024-01-01 00:00:00", "[]", "(1, 2)", "''", "now", "db.f()"]
)
def test_does_not_start_with_function_call(value: str) -> None:
    assert starts_with_function_call(value) is False


# ---------- rendering ----------


def test_renders_sql_expression_as_sql() -> None:
    sql = to_create_sql(events([
        {"name": "updated_at", "type": "DateTime64(3, 'UTC')", "default": expr("now64(3)")}
    ]))
    assert "`updated_at` DateTime64(3, 'UTC') DEFAULT now64(3)" in sql


def test_renders_trimmed_expression_keeping_comment_and_codec() -> None:
    sql = to_create_sql(events([{
        "name": "ts", "type": "DateTime", "codec": {"kind": "ZSTD", "level": 3},
        "comment": "insert time", "default": expr(" now() "),
    }]))
    assert "`ts` DateTime DEFAULT now() COMMENT 'insert time' CODEC(ZSTD(3))" in sql


def test_quotes_string_literals_and_renders_numbers_and_booleans() -> None:
    sql = to_create_sql(events([
        {"name": "note", "type": "String", "default": "it's"},
        {"name": "n", "type": "UInt32", "default": 0},
        {"name": "flag", "type": "Bool", "default": False},
    ]))
    assert "`note` String DEFAULT 'it''s'" in sql
    assert "`n` UInt32 DEFAULT 0" in sql
    assert "`flag` Bool DEFAULT false" in sql


def test_renders_legacy_prefix_like_sql_expression_trimmed() -> None:
    sql = to_create_sql(events([
        {"name": "a", "type": "DateTime", "default": "fn:now()"},
        {"name": "b", "type": "DateTime", "default": "fn: now()"},
    ]))
    assert "`a` DateTime DEFAULT now()," in sql
    assert "`b` DateTime DEFAULT now()\n" in sql


def test_renders_alter_add_column_with_expression_default() -> None:
    assert render_alter_add_column(
        events([]), {"name": "ts", "type": "DateTime", "default": expr("now()")}
    ) == "ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `ts` DateTime DEFAULT now();"


COMMENTED: Column = {"name": "ts", "type": "DateTime", "default": expr("now() -- set on insert")}


def test_comment_does_not_swallow_the_comma_before_the_next_column() -> None:
    sql = to_create_sql(events([COMMENTED, {"name": "n", "type": "UInt8"}]))
    assert "`ts` DateTime DEFAULT now(),\n  `n` UInt8" in sql
    assert "set on insert" not in sql


def test_comment_does_not_swallow_comment_or_codec() -> None:
    sql = to_create_sql(events([
        {**COMMENTED, "comment": "insert time", "codec": {"kind": "ZSTD", "level": 3}}
    ]))
    assert "`ts` DateTime DEFAULT now() COMMENT 'insert time' CODEC(ZSTD(3))" in sql


def test_comment_does_not_swallow_the_semicolon_of_add_or_modify_column() -> None:
    assert render_alter_add_column(events([]), COMMENTED) == (
        "ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `ts` DateTime DEFAULT now();"
    )
    assert render_alter_modify_column(events([COMMENTED]), COMMENTED) == (
        "ALTER TABLE app.events MODIFY COLUMN `ts` DateTime DEFAULT now();"
    )


def test_comments_are_dropped_from_the_legacy_spelling_too() -> None:
    sql = to_create_sql(events([{"name": "ts", "type": "DateTime", "default": "fn:now() /* server time */"}]))
    assert "`ts` DateTime DEFAULT now()\n" in sql


def test_comments_are_removed_outside_literals_only_keeping_other_whitespace() -> None:
    expression = (
        "multiIf(\n  toString(id) = 'a -- b', 'x  y', -- first branch\n  /* fallback */ '#  z')"
    )
    sql = to_create_sql(events([{"name": "label", "type": "String", "default": expr(expression)}]))
    assert "`label` String DEFAULT multiIf(\n  toString(id) = 'a -- b', 'x  y', '#  z')\n" in sql


def test_stray_hash_at_end_cannot_comment_out_comment_codec_or_semicolon() -> None:
    column: Column = {
        "name": "d", "type": "UInt64", "default": expr("2 #"), "comment": "added",
        "codec": {"kind": "ZSTD", "level": 3},
    }
    add = render_alter_add_column(events([]), column)
    modify = render_alter_modify_column(events([column]), column)
    assert add == (
        "ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `d` UInt64 DEFAULT 2 #\n "
        "COMMENT 'added' CODEC(ZSTD(3));"
    )
    assert modify == (
        "ALTER TABLE app.events MODIFY COLUMN `d` UInt64 DEFAULT 2 #\n COMMENT 'added' CODEC(ZSTD(3));"
    )
    for sql in (add, modify):
        assert [t for t in tokenize_sql(sql) if t.kind == "line_comment"] == []


def test_each_added_column_stays_its_own_statement_in_a_planned_migration() -> None:
    plan = plan_diff([events([])], [events([
        COMMENTED, {"name": "n", "type": "UInt8", "default": expr("toUInt8(1) # one")}
    ])])
    assert [op.type for op in plan.operations] == ["alter_table_add_column", "alter_table_add_column"]
    migration = "\n".join(op.sql for op in plan.operations)
    assert len(extract_executable_statements(migration)) == 2
    assert "set on insert" not in migration
    assert "# one" not in migration


# ---------- canonicalization and planning ----------

OBJECT_FORM: list[Column] = [
    {"name": "updated_at", "type": "DateTime64(3, 'UTC')", "default": expr("now64(3)")}
]
LEGACY_FORM: list[Column] = [
    {"name": "updated_at", "type": "DateTime64(3, 'UTC')", "default": "fn:now64(3)"}
]


def test_switching_between_sql_expression_and_fn_plans_nothing() -> None:
    assert operation_types(LEGACY_FORM, OBJECT_FORM) == []
    assert operation_types(OBJECT_FORM, LEGACY_FORM) == []


def test_whitespace_around_the_expression_in_either_spelling_plans_nothing() -> None:
    spellings: list[Any] = ["fn:now64(3)", "fn: now64(3)", expr(" now64(3)\n")]
    for before in spellings:
        for after in spellings:
            assert operation_types(
                [{"name": "updated_at", "type": "DateTime64(3, 'UTC')", "default": before}],
                [{"name": "updated_at", "type": "DateTime64(3, 'UTC')", "default": after}],
            ) == []


def test_the_snapshot_stores_sql_expression_as_the_fn_string() -> None:
    snapshot = create_snapshot([events(OBJECT_FORM)])
    assert snapshot.definitions == create_snapshot([events(LEGACY_FORM)]).definitions
    [definition] = snapshot.definitions
    assert isinstance(definition, TableDefinition)
    assert definition.columns[1].default == "fn:now64(3)"
    dumped = json.loads(snapshot.model_dump_json(by_alias=True))
    assert dumped["definitions"][0]["columns"][1]["default"] == "fn:now64(3)"


def test_creates_a_table_with_the_expression_default() -> None:
    plan = plan_diff([], [events(OBJECT_FORM)])
    assert [op.type for op in plan.operations] == ["create_database", "create_table"]
    assert "`updated_at` DateTime64(3, 'UTC') DEFAULT now64(3)" in plan.operations[1].sql


def test_changing_the_expression_modifies_the_column() -> None:
    assert ops(
        [{"name": "ts", "type": "DateTime", "default": "fn:now()"}],
        [{"name": "ts", "type": "DateTime", "default": expr("now() + 60")}],
    ) == [{
        "type": "alter_table_modify_column",
        "key": "table:app.events:column:ts",
        "risk": "caution",
        "sql": "ALTER TABLE app.events MODIFY COLUMN `ts` DateTime DEFAULT now() + 60;",
        "warning": historical_values_warning("ts"),
    }]


def test_editing_only_a_comment_modifies_the_column_with_the_same_default() -> None:
    # The snapshot keeps the expression as written, comments included.
    assert [op["sql"] for op in ops(
        [{"name": "ts", "type": "DateTime", "default": expr("now() -- set on insert")}],
        [{"name": "ts", "type": "DateTime", "default": expr("now() -- server time")}],
    )] == ["ALTER TABLE app.events MODIFY COLUMN `ts` DateTime DEFAULT now();"]


def test_suggests_a_rename_across_default_spellings() -> None:
    plan = plan_diff(
        [events([{"name": "seen", "type": "DateTime", "default": "fn:now()"}])],
        [events([{"name": "seen_at", "type": "DateTime", "default": expr("now()")}])],
    )
    assert len(plan.rename_suggestions) == 1
    assert (plan.rename_suggestions[0].from_, plan.rename_suggestions[0].to) == ("seen", "seen_at")


def test_adds_no_default_to_a_column_without_one() -> None:
    [definition] = canonicalize_definitions([events([{"name": "v", "type": "String"}])])
    assert isinstance(definition, TableDefinition)
    assert definition.columns[1].name == "v"
    assert definition.columns[1].default is None


def test_upgrades_a_snapshot_holding_a_quoted_function_call_with_one_modify() -> None:
    # Users who already hit #234 have the quoted literal in snapshot.json. Only
    # new definitions are validated, so the fix plans one MODIFY COLUMN.
    assert ops(
        [{"name": "seen_at", "type": "DateTime", "nullable": True, "default": "now()"}],
        [{"name": "seen_at", "type": "DateTime", "nullable": True, "default": expr("now()")}],
    ) == [{
        "type": "alter_table_modify_column",
        "key": "table:app.events:column:seen_at",
        "risk": "caution",
        "sql": "ALTER TABLE app.events MODIFY COLUMN `seen_at` Nullable(DateTime) DEFAULT now();",
        "warning": historical_values_warning("seen_at"),
    }]
    assert [op["sql"] for op in ops(
        [{"name": "updated_at", "type": "DateTime64(3, 'UTC')", "default": "now64(3)"}], OBJECT_FORM
    )] == ["ALTER TABLE app.events MODIFY COLUMN `updated_at` DateTime64(3, 'UTC') DEFAULT now64(3);"]


# ---------- validation ----------


def test_rejects_a_function_call_written_as_a_plain_string() -> None:
    issues = validate_definitions([events([
        {"name": "updated_at", "type": "DateTime64(3, 'UTC')", "default": "now64(3)"}
    ])])
    assert [issue.model_dump() for issue in issues] == [{
        "code": "column_default_looks_like_expression",
        "kind": "table",
        "database": "app",
        "name": "events",
        "message": (
            'Table app.events column "updated_at" has default "now64(3)", a plain string that '
            "looks like a SQL function call. Plain strings render as quoted literals (DEFAULT "
            "'now64(3)'), which ClickHouse rejects for type DateTime64(3, 'UTC'). Use default: "
            '{ expression: "now64(3)" } to render DEFAULT now64(3). If chkit misjudged the type '
            "and the column should store this text, use default: { expression: \"'now64(3)'\" }."
        ),
    }]


def test_says_a_nullable_column_stores_null() -> None:
    assert issue_messages([
        {"name": "seen_at", "type": "DateTime", "nullable": True, "default": "now()"}
    ]) == [
        'Table app.events column "seen_at" has default "now()", a plain string that looks like a '
        "SQL function call. Plain strings render as quoted literals (DEFAULT 'now()'), which "
        "ClickHouse accepts for type Nullable(DateTime) but stores as NULL. Use default: "
        '{ expression: "now()" } to render DEFAULT now(). If chkit misjudged the type and the '
        "column should store this text, use default: { expression: \"'now()'\" }."
    ]


@pytest.mark.parametrize(("type_", "value"), [("Nullable(DateTime)", "now()"), ("Nullable(UInt64)", "abs(1)")])
def test_says_type_stores_null(type_: str, value: str) -> None:
    [message] = issue_messages([{"name": "c", "type": type_, "default": value}])
    assert f"which ClickHouse accepts for type {type_} but stores as NULL" in message


@pytest.mark.parametrize(
    ("column", "rendered"),
    [
        ({"name": "c", "type": "LowCardinality(Nullable(DateTime))", "default": "now()"},
         "LowCardinality(Nullable(DateTime))"),
        ({"name": "c", "type": "Bool", "nullable": True, "default": "toBool(1)"}, "Nullable(Bool)"),
        ({"name": "c", "type": "Array(DateTime)", "nullable": True, "default": "array()"},
         "Nullable(Array(DateTime))"),
    ],
)
def test_says_clickhouse_rejects_type(column: Column, rendered: str) -> None:
    [message] = issue_messages([column])
    assert f"which ClickHouse rejects for type {rendered}." in message


@pytest.mark.parametrize(
    ("type_", "value"),
    [("UInt64", "abs(1)"), ("Array(String)", "array()"), ("Map(String, String)", "map()"),
     ("Date", "today() - 1"), ("DateTime", " now() ")],
)
def test_rejects_function_like_value_on_type(type_: str, value: str) -> None:
    assert issue_codes([{"name": "c", "type": type_, "default": value}]) == [
        "column_default_looks_like_expression"
    ]


def test_keeps_the_suggested_fixes_valid_when_the_value_holds_quotes() -> None:
    [message] = issue_messages([{"name": "ts", "type": "DateTime", "default": "toDateTime('2024-01-01')"}])
    assert (
        "Use default: { expression: \"toDateTime('2024-01-01')\" } to render "
        "DEFAULT toDateTime('2024-01-01')" in message
    )
    assert (
        "the column should store this text, use default: "
        "{ expression: \"'toDateTime(''2024-01-01'')'\" }." in message
    )


def test_shows_the_sql_the_suggested_expression_renders_without_its_comment() -> None:
    [message] = issue_messages([{"name": "ts", "type": "DateTime", "default": "now() -- set on insert"}])
    assert 'Use default: { expression: "now() -- set on insert" } to render DEFAULT now(). If' in message


def test_suggests_an_expression_without_an_empty_hash_comment() -> None:
    [message] = issue_messages([{"name": "ts", "type": "DateTime", "default": "now() # "}])
    assert 'Use default: { expression: "now()" } to render DEFAULT now(). If' in message


@pytest.mark.parametrize("value", ["now() #", "now() /* set on insert", "toDateTime('2024-01-01)"])
def test_suggests_no_expression_that_validation_would_reject(value: str) -> None:
    [message] = issue_messages([{"name": "ts", "type": "DateTime", "default": value}])
    assert 'Use default: { expression: "<sql>" } for a SQL expression. If' in message
    assert "to render DEFAULT" not in message
    assert "\n" not in message


def test_shows_the_sql_a_multi_line_expression_renders_on_one_line() -> None:
    [message] = issue_messages([{"name": "ts", "type": "DateTime", "default": "toDateTime(\n  now()\n)"}])
    assert (
        'Use default: { expression: "toDateTime(\\n  now()\\n)" } to render '
        "DEFAULT toDateTime( now() ). If" in message
    )


@pytest.mark.parametrize(
    "column",
    [
        {"name": "c", "type": "String", "default": "now()"},
        {"name": "c", "type": "LowCardinality(String)", "default": "lower(x)"},
        {"name": "c", "type": "Enum8('now()' = 1, 'b' = 2)", "default": "now()"},
        {"name": "c", "type": "FixedString(8)", "default": "now()"},
        {"name": "c", "type": "Nullable(String)", "default": "now()"},
        {"name": "c", "type": "String", "nullable": True, "default": "now()"},
        {"name": "c", "type": "UInt64", "default": "42"},
        {"name": "c", "type": "Date", "default": "2024-01-01"},
        {"name": "c", "type": "DateTime", "default": "now"},
    ],
)
def test_accepts_plain_strings_on_string_columns_or_without_a_call(column: Column) -> None:
    assert issue_codes([column]) == []


@pytest.mark.parametrize(
    "column",
    [
        {"name": "c", "type": "DateTime64(3, 'UTC')", "default": expr("now64(3)")},
        {"name": "c", "type": "DateTime64(3, 'UTC')", "default": "fn:now64(3)"},
        {"name": "c", "type": "DateTime", "default": expr("now() -- set on insert")},
        {"name": "c", "type": "DateTime", "default": expr("now() /* set on insert */")},
        {"name": "c", "type": "DateTime", "default": expr("'now()'")},
        {"name": "c", "type": "DateTime", "default": expr("now() # set on insert")},
        {"name": "c", "type": "DateTime", "default": expr("now() #!set on insert")},
        {"name": "c", "type": "DateTime", "default": expr("now() # ")},
        {"name": "c", "type": "DateTime", "default": "fn:now() # "},
        {"name": "c", "type": "String", "default": expr("concat('#x', `#y`)")},
        # `::` casts a column named fn; it is not the legacy prefix.
        {"name": "c", "type": "String", "default": expr("fn::String")},
        {"name": "c", "type": "String", "default": "fn:fn::String"},
    ],
)
def test_accepts_expressions(column: Column) -> None:
    assert issue_codes([column]) == []


@pytest.mark.parametrize(
    "value",
    [expr(""), expr("   "), expr("-- set later"), expr("/* todo */"), expr("# "), "fn:", "fn:   "],
)
def test_rejects_an_empty_expression_with_one_issue(value: Any) -> None:
    assert issue_codes([{"name": "c", "type": "DateTime", "default": value}]) == [
        "column_expression_required"
    ]


@pytest.mark.parametrize("raw", ['{"expr":"now()"}', "{}", "[]", '{"expression":42}'])
def test_rejects_a_default_object_that_is_not_an_sql_expression(raw: str) -> None:
    # TS reports column_default_invalid; the strict Pydantic model refuses the
    # value when the definition is built.
    with pytest.raises(ValidationError):
        events([{"name": "c", "type": "DateTime", "default": json.loads(raw)}])


def test_rejects_the_legacy_prefix_inside_sql_expression() -> None:
    assert issue_messages([{"name": "ts", "type": "DateTime", "default": expr("fn:now()")}]) == [
        'Table app.events column "ts" has default expression "fn:now()", which keeps the legacy '
        "fn: prefix and would render DEFAULT fn:now(), a syntax error. Remove the prefix: "
        'default: { expression: "now()" }.'
    ]
    assert issue_codes([{"name": "ts", "type": "DateTime", "default": "fn:fn:now()"}]) == [
        "column_default_invalid"
    ]


@pytest.mark.parametrize(
    "value",
    [expr("now() /* set on insert"), expr("/* todo"), expr("concat('a, b)"), expr("toString(`id)"),
     "fn:now() /* set on insert"],
)
def test_rejects_an_expression_with_an_unterminated_token(value: Any) -> None:
    assert issue_codes([{"name": "c", "type": "String", "default": value}]) == ["column_default_invalid"]


@pytest.mark.parametrize(
    "value",
    [expr("now() #"), expr("now() #\n"), expr("now() #\t-- note"), expr("now() #\u00a0"),
     expr("toUInt8(1) #one"), "fn:now() #"],
)
def test_rejects_a_hash_that_starts_no_comment(value: Any) -> None:
    assert issue_codes([{"name": "c", "type": "DateTime", "default": value}]) == ["column_default_invalid"]


def test_blocks_trailing_stray_hash_before_comment_and_codec() -> None:
    column: Column = {
        "name": "c", "type": "UInt64", "default": expr("1 #"), "comment": "kept?",
        "codec": {"kind": "ZSTD", "level": 3},
    }
    assert issue_messages([column]) == [
        'Table app.events column "c" has default expression "1 #" with a # that starts no comment, '
        'which ClickHouse rejects. Remove it, or put a space after it to start a comment: "# note".'
    ]
    with pytest.raises(ChxValidationError):
        to_create_sql(events([column]))
    with pytest.raises(ChxValidationError):
        plan_diff([events([])], [events([column])])
    with pytest.raises(ChxValidationError):
        plan_diff([events([{"name": "c", "type": "UInt64"}])], [events([column])])


@pytest.mark.parametrize("expression", ["1 # ", "1 # note"])
def test_accepts_the_hash_once_a_space_follows_it(expression: str) -> None:
    column: Column = {
        "name": "c", "type": "UInt64", "default": expr(expression), "comment": "kept",
        "codec": {"kind": "ZSTD", "level": 3},
    }
    assert issue_codes([column]) == []
    assert "`c` UInt64 DEFAULT 1 COMMENT 'kept' CODEC(ZSTD(3))\n" in to_create_sql(events([column]))
    assert render_alter_add_column(events([]), column) == (
        "ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `c` UInt64 DEFAULT 1 COMMENT 'kept' "
        "CODEC(ZSTD(3));"
    )


def test_names_the_unterminated_token() -> None:
    nxt = events([
        {"name": "a", "type": "DateTime", "default": expr("now() /* set on insert")},
        {"name": "b", "type": "String", "default": expr("concat('a, b)")},
    ])
    assert [issue.message for issue in validate_definitions([nxt])] == [
        'Table app.events column "a" has default expression "now() /* set on insert" with an '
        "unterminated block comment, which would swallow the rest of the generated SQL. Close it "
        "or remove it.",
        'Table app.events column "b" has default expression "concat(\'a, b)" with an unterminated '
        "string literal, which would swallow the rest of the generated SQL. Close it or remove it.",
    ]
    with pytest.raises(ChxValidationError):
        plan_diff([events([])], [nxt])


def test_reports_the_same_issues_for_canonical_definitions() -> None:
    definitions = canonicalize_definitions([events([
        {"name": "a", "type": "DateTime", "default": expr("")},
        {"name": "b", "type": "DateTime", "default": expr("fn:now()")},
        {"name": "c", "type": "DateTime", "default": "now()"},
        {"name": "d", "type": "DateTime", "default": expr("now()")},
        {"name": "e", "type": "DateTime", "default": expr("now() /* set on insert")},
        {"name": "f", "type": "String", "default": expr("fn::String")},
    ])])
    by_column = [
        (re.search(r'column "(\w+)"', issue.message).group(1), issue.code)  # type: ignore[union-attr]
        for issue in validate_definitions(definitions)
    ]
    assert by_column == [
        ("a", "column_expression_required"),
        ("b", "column_default_invalid"),
        ("c", "column_default_looks_like_expression"),
        ("e", "column_default_invalid"),
    ]


@pytest.mark.parametrize(
    "column",
    [
        {"name": "ts", "type": "DateTime", "default": "now()"},
        {"name": "ts", "type": "DateTime", "default": expr("")},
        {"name": "ts", "type": "DateTime", "default_kind": "MATERIALIZED"},
        {"name": "ts", "type": "DateTime", "default_kind": "EPHEMERAL", "default": "now()"},
        # An ALIAS or bare EPHEMERAL column cannot have a codec either; removing the kind fixes both.
        {"name": "ts", "type": "DateTime", "default_kind": "ALIAS", "default": "fn:now()",
         "codec": {"kind": "ZSTD", "level": 1}},
        {"name": "ts", "type": "DateTime", "default_kind": "EPHEMERAL",
         "codec": {"kind": "ZSTD", "level": 1}},
    ],
)
def test_reports_only_kafka_column_default_on_a_kafka_table(column: Column) -> None:
    assert [issue.code for issue in validate_definitions([_queue(column)])] == ["kafka_column_default"]


def test_kafka_codec_chain_error_is_a_mistake_of_its_own() -> None:
    column: Column = {"name": "ts", "type": "DateTime", "default_kind": "ALIAS",
                      "default": "fn:now()", "codec": []}
    assert [issue.code for issue in validate_definitions([_queue(column)])] == [
        "kafka_column_default", "codec_chain_empty",
    ]


def _queue(column: Column) -> TableDefinition:
    return table(
        database="app",
        name="queue",
        engine="Kafka('broker:9092', 'topic', 'group', 'JSONEachRow')",
        columns=[column],
    )


def test_blocks_to_create_sql_and_plan_diff() -> None:
    broken = events([{"name": "updated_at", "type": "DateTime64(3, 'UTC')", "default": "now64(3)"}])
    with pytest.raises(ChxValidationError):
        to_create_sql(broken)
    with pytest.raises(ChxValidationError):
        plan_diff([], [broken])


# ---------- column default kinds ----------


def day(**column: Any) -> Column:
    return {"name": "day", "type": "Date", **column}


@pytest.mark.parametrize("kind", ["DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL"])
def test_renders_sql_expression_for_every_kind(kind: str) -> None:
    sql = to_create_sql(events([day(default_kind=kind, default=expr("toDate(now()) -- today"))]))
    assert f"`day` Date {kind} toDate(now())\n" in sql


def test_stores_the_fn_string_with_the_kind_so_switching_spellings_plans_nothing() -> None:
    object_form = [day(default_kind="MATERIALIZED", default=expr("toDate(now())"))]
    legacy_form = [day(default_kind="MATERIALIZED", default="fn:toDate(now())")]
    [definition] = create_snapshot([events(object_form)]).definitions
    assert isinstance(definition, TableDefinition)
    assert (definition.columns[1].default_kind, definition.columns[1].default) == (
        "MATERIALIZED", "fn:toDate(now())"
    )
    assert operation_types(legacy_form, object_form) == []
    assert operation_types(object_form, legacy_form) == []


def test_changing_the_kind_of_an_expression_column_modifies_it() -> None:
    assert [op["sql"] for op in ops(
        [day(default=expr("toDate(now())"))],
        [day(default_kind="MATERIALIZED", default=expr("toDate(now())"))],
    )] == ["ALTER TABLE app.events MODIFY COLUMN `day` Date MATERIALIZED toDate(now());"]


@pytest.mark.parametrize("kind", ["MATERIALIZED", "ALIAS"])
def test_requires_a_non_empty_expression_on_materialized_and_alias(kind: str) -> None:
    assert issue_messages([day(default_kind=kind)]) == [
        f'Table app.events column "day" is {kind} and requires a non-empty expression. '
        'Set default: { expression: "<sql>" }.'
    ]
    for value in [expr(""), expr(" -- todo"), "fn:  "]:
        assert issue_messages([day(default_kind=kind, default=value)]) == [
            'Table app.events column "day" has an empty default expression. Put the SQL in '
            'default: { expression: "<sql>" }.'
        ]
    assert issue_codes([day(default_kind=kind, default=expr("toDate(now())"))]) == []


def test_empty_expression_on_default_and_bare_ephemeral() -> None:
    assert issue_codes([day(default_kind="EPHEMERAL")]) == []
    assert issue_messages([day(default=expr(""))]) == [
        'Table app.events column "day" has an empty default expression. Put the SQL in '
        'default: { expression: "<sql>" }, or remove default.'
    ]


def test_reports_the_same_expression_issues_for_canonical_kinds() -> None:
    definitions = canonicalize_definitions([events([
        day(name="a", default_kind="MATERIALIZED"),
        day(name="b", default_kind="ALIAS", default=expr("/* todo */")),
        day(name="c", default_kind="MATERIALIZED", default=expr("toDate(now())")),
    ])])
    assert [issue.code for issue in validate_definitions(definitions)] == [
        "column_expression_required", "column_expression_required",
    ]


def test_function_call_check_per_kind() -> None:
    for kind in ("DEFAULT", "EPHEMERAL"):
        assert issue_codes([day(type="DateTime", default_kind=kind, default="now()")]) == [
            "column_default_looks_like_expression"
        ]
        assert issue_codes([day(type="String", default_kind=kind, default="now()")]) == []
    for kind in ("MATERIALIZED", "ALIAS"):
        assert issue_codes([day(type="DateTime", default_kind=kind, default="now()")]) == [
            "column_expression_requires_fn"
        ]


def test_names_the_ephemeral_clause_and_null_reads() -> None:
    assert issue_messages([day(type="DateTime", default_kind="EPHEMERAL", default="now()")]) == [
        'Table app.events column "day" has default "now()", a plain string that looks like a SQL '
        "function call. Plain strings render as quoted literals (EPHEMERAL 'now()'), which "
        'ClickHouse rejects for type DateTime. Use default: { expression: "now()" } to render '
        "EPHEMERAL now(). If chkit misjudged the type and the column should hold this text, use "
        "default: { expression: \"'now()'\" }."
    ]
    [message] = issue_messages([
        day(type="DateTime", nullable=True, default_kind="EPHEMERAL", default="now()")
    ])
    assert "which ClickHouse accepts for type Nullable(DateTime) but reads as NULL." in message


@pytest.mark.parametrize(
    ("type_", "kind", "outcome"),
    [
        ("LowCardinality(Nullable(DateTime))", "EPHEMERAL",
         "accepts for type LowCardinality(Nullable(DateTime)) but reads as NULL"),
        ("LowCardinality(Nullable(UInt64))", "EPHEMERAL",
         "accepts for type LowCardinality(Nullable(UInt64)) but reads as NULL"),
        ("LowCardinality(Nullable(DateTime64(3)))", "EPHEMERAL",
         "rejects for type LowCardinality(Nullable(DateTime64(3)))"),
        ("LowCardinality(Nullable(Decimal(10, 2)))", "EPHEMERAL",
         "rejects for type LowCardinality(Nullable(Decimal(10, 2)))"),
        ("LowCardinality(DateTime)", "EPHEMERAL", "rejects for type LowCardinality(DateTime)"),
        ("Nullable(Bool)", "EPHEMERAL", "rejects for type Nullable(Bool)"),
        ("LowCardinality(Nullable(DateTime))", "DEFAULT",
         "rejects for type LowCardinality(Nullable(DateTime))"),
    ],
)
def test_ephemeral_null_outcomes(type_: str, kind: str, outcome: str) -> None:
    [message] = issue_messages([{"name": "c", "type": type_, "default_kind": kind, "default": "now()"}])
    assert f"which ClickHouse {outcome}." in message


def test_checks_expressions_of_every_kind() -> None:
    for kind in ("MATERIALIZED", "ALIAS", "EPHEMERAL"):
        assert issue_codes([day(default_kind=kind, default=expr("fn:toDate(now())"))]) == [
            "column_default_invalid"
        ]
        assert issue_codes([day(default_kind=kind, default=expr("toDate(now()) #"))]) == [
            "column_default_invalid"
        ]
    assert issue_messages([day(default_kind="ALIAS", default=expr("fn:toDate(now())"))]) == [
        'Table app.events column "day" has default expression "fn:toDate(now())", which keeps the '
        "legacy fn: prefix and would render ALIAS fn:toDate(now()), a syntax error. Remove the "
        'prefix: default: { expression: "toDate(now())" }.'
    ]


def test_column_definition_accepts_sql_expression_instances_and_dicts() -> None:
    a = ColumnDefinition(name="c", type="DateTime", default=SQLExpression(expression="now()"))
    b = ColumnDefinition.model_validate({"name": "c", "type": "DateTime", "default": expr("now()")})
    assert a == b
