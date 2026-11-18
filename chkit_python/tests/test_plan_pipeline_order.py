"""Port of ``packages/cli/src/test/commands/generate/plan-pipeline-order.test.ts`` (#231).

The rename pipeline keeps the planner's (dependency-aware) order of drops and
creates.
"""

from __future__ import annotations

from typing import Any

from chkit import SQLExpression, table
from chkit.cli.commands.generate_plan_pipeline import (
    apply_explicit_dictionary_renames,
    apply_explicit_table_renames,
    apply_selected_rename_suggestions,
    build_explicit_column_rename_suggestions,
)
from chkit.cli.commands.generate_rename_mappings import (
    ColumnRenameMapping,
    DictionaryRenameMapping,
    TableRenameMapping,
)
from chkit.core.model import (
    MigrationOperation,
    MigrationPlan,
    SchemaDefinition,
    TableDefinition,
    _RiskSummary,
)
from chkit.core.planner import plan_diff


def _op(type_: str, key: str) -> MigrationOperation:
    return MigrationOperation.model_validate(
        {"type": type_, "key": key, "risk": "safe", "sql": f"-- {type_} {key}"}
    )


# What plan_diff emits for a plan with dependencies: drops dependents-first and
# creates dependencies-first (neither in key order); alters in key order.
PLAN = MigrationPlan(
    operations=[
        _op("drop_view", "view:app.z_top"),
        _op("drop_view", "view:app.a_base"),
        _op("drop_dictionary", "dictionary:app.d_old"),
        _op("drop_table", "table:app.users"),
        _op("alter_table_drop_column", "table:app.t:column:a"),
        _op("alter_table_add_column", "table:app.t:column:b"),
        _op("create_database", "database:app"),
        _op("create_table", "table:app.customers"),
        _op("create_dictionary", "dictionary:app.d"),
        _op("create_view", "view:app.z_base"),
        _op("create_view", "view:app.a_top"),
    ],
    risk_summary=_RiskSummary(safe=11, caution=0, danger=0),
    rename_suggestions=[],
)


def summary(plan: MigrationPlan) -> list[str]:
    return [f"{op.type} {op.key}" for op in plan.operations]


def test_table_rename() -> None:
    plan = apply_explicit_table_renames(
        PLAN, [TableRenameMapping("app", "users", "app", "customers", "cli")]
    )
    assert summary(plan) == [
        "drop_view view:app.z_top",
        "drop_view view:app.a_base",
        "drop_dictionary dictionary:app.d_old",
        "create_database database:app",
        "alter_table_rename_table table:app.customers:rename_table",
        "alter_table_drop_column table:app.t:column:a",
        "alter_table_add_column table:app.t:column:b",
        "create_dictionary dictionary:app.d",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]


def test_table_rename_into_another_database_adds_create_database_in_key_order() -> None:
    plan = apply_explicit_table_renames(
        PLAN, [TableRenameMapping("app", "users", "archive", "customers", "cli")]
    )
    assert summary(plan) == [
        "drop_view view:app.z_top",
        "drop_view view:app.a_base",
        "drop_dictionary dictionary:app.d_old",
        "create_database database:app",
        "create_database database:archive",
        "alter_table_rename_table table:archive.customers:rename_table",
        "alter_table_drop_column table:app.t:column:a",
        "alter_table_add_column table:app.t:column:b",
        "create_table table:app.customers",
        "create_dictionary dictionary:app.d",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]


def test_dictionary_rename() -> None:
    plan = apply_explicit_dictionary_renames(
        PLAN, [DictionaryRenameMapping("app", "d_old", "app", "d", "cli")]
    )
    assert summary(plan) == [
        "drop_view view:app.z_top",
        "drop_view view:app.a_base",
        "drop_table table:app.users",
        "create_database database:app",
        "rename_dictionary dictionary:app.d:rename_dictionary",
        "alter_table_drop_column table:app.t:column:a",
        "alter_table_add_column table:app.t:column:b",
        "create_table table:app.customers",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]


def test_column_rename() -> None:
    plan = apply_selected_rename_suggestions(
        PLAN,
        build_explicit_column_rename_suggestions(
            PLAN, [ColumnRenameMapping("app", "t", "a", "b", "cli")]
        ),
        previous_definitions=[],
        next_definitions=[],
    )
    assert summary(plan) == [
        "drop_view view:app.z_top",
        "drop_view view:app.a_base",
        "drop_dictionary dictionary:app.d_old",
        "drop_table table:app.users",
        "create_database database:app",
        "alter_table_rename_column table:app.t:column_rename:a:b",
        "create_table table:app.customers",
        "create_dictionary dictionary:app.d",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]


def test_column_rename_keeps_remove_default_right_before_its_modify_column() -> None:
    # plan_diff removes a column's expression in its own operation, with the
    # MODIFY COLUMN's key, and it must still run first once a rename merges the
    # alters: ClickHouse would cast the retained 'abc' to Int64 and fail.
    def t(columns: list[dict[str, Any]]) -> TableDefinition:
        return table(
            database="app",
            name="t",
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
            columns=[{"name": "id", "type": "UInt64"}, *columns],
        )

    previous = [
        t([{"name": "a", "type": "String"}, {"name": "code", "type": "String", "default": "abc"}])
    ]
    next_ = [t([{"name": "b", "type": "String"}, {"name": "code", "type": "Int64"}])]
    planned = plan_diff(previous, next_)
    plan = apply_selected_rename_suggestions(
        planned,
        build_explicit_column_rename_suggestions(
            planned, [ColumnRenameMapping("app", "t", "a", "b", "cli")]
        ),
        previous_definitions=previous,
        next_definitions=next_,
    )
    # Keys sort by code point in both ports (#489), so the rename comes last.
    # The pinned invariant: REMOVE DEFAULT runs right before its MODIFY COLUMN.
    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.t MODIFY COLUMN `code` REMOVE DEFAULT;",
        "ALTER TABLE app.t MODIFY COLUMN `code` Int64;",
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;",
    ]


def test_column_rename_keeps_an_add_column_after_the_add_column_its_default_reads() -> None:
    # #681: the rename pipeline re-sorts the alters by key; `Total` sorts
    # before `price`, but its DEFAULT reads `price`.
    def t(columns: list[dict[str, Any]]) -> TableDefinition:
        return table(
            database="app",
            name="t",
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
            columns=[{"name": "id", "type": "UInt64"}, *columns],
        )

    previous = [t([{"name": "a", "type": "String"}])]
    next_ = [t([
        {"name": "b", "type": "String"},
        {"name": "price", "type": "UInt64"},
        {"name": "Total", "type": "UInt64", "default": SQLExpression(expression="price + 1")},
    ])]
    planned = plan_diff(previous, next_)
    plan = apply_selected_rename_suggestions(
        planned,
        build_explicit_column_rename_suggestions(
            planned, [ColumnRenameMapping("app", "t", "a", "b", "cli")]
        ),
        previous_definitions=previous,
        next_definitions=next_,
    )
    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `price` UInt64;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `Total` UInt64 DEFAULT price + 1;",
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;",
    ]


# ---------- column statements ordered with the column renames (#746, #758) ----------


def _t(columns: list[dict[str, Any]]) -> TableDefinition:
    return table(
        database="app",
        name="t",
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
        columns=[{"name": "id", "type": "UInt64"}, *columns],
    )


def _renamed(
    previous: list[SchemaDefinition], next_: list[SchemaDefinition], from_: str, to: str
) -> list[str]:
    planned = plan_diff(previous, next_)
    plan = apply_selected_rename_suggestions(
        planned,
        build_explicit_column_rename_suggestions(
            planned, [ColumnRenameMapping("app", "t", from_, to, "cli")]
        ),
        previous_definitions=previous,
        next_definitions=next_,
    )
    return [op.sql for op in plan.operations]


def _expr(sql: str) -> SQLExpression:
    return SQLExpression(expression=sql)


def test_renames_a_column_before_the_add_columns_that_read_its_new_name() -> None:
    assert _renamed(
        [_t([{"name": "a", "type": "String"}])],
        [_t([
            {"name": "b", "type": "String"},
            {"name": "Copy", "type": "String", "default_kind": "MATERIALIZED",
             "default": _expr("concat(`b`, '!')")},
            {"name": "a_len", "type": "UInt64", "default_kind": "ALIAS", "default": _expr("length(b)")},
            {"name": "c_plain", "type": "String"},
        ])],
        "a",
        "b",
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c_plain` String;",
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `Copy` String MATERIALIZED concat(`b`, '!');",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a_len` UInt64 ALIAS length(b);",
    ]


def test_renames_a_column_before_the_modify_column_that_reads_its_new_name() -> None:
    assert _renamed(
        [_t([{"name": "a", "type": "String"}, {"name": "code", "type": "String", "default": _expr("a")}])],
        [_t([{"name": "b", "type": "String"}, {"name": "code", "type": "String", "default": _expr("b")}])],
        "a",
        "b",
    ) == [
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;",
        "ALTER TABLE app.t MODIFY COLUMN `code` String DEFAULT b;",
    ]


def test_keeps_a_modify_column_after_the_add_column_it_reads_when_a_rename_moves() -> None:
    # Reordering only the ADDs and the RENAME left the MODIFY of `d` in its
    # slot, before the ADD of `c` it reads.
    assert _renamed(
        [_t([{"name": "a", "type": "UInt64"}, {"name": "d", "type": "UInt64"}])],
        [_t([
            {"name": "c", "type": "UInt64", "default": _expr("length('abc')")},
            {"name": "d", "type": "UInt64", "default": _expr("c + 1")},
            {"name": "length", "type": "UInt64"},
        ])],
        "a",
        "length",
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c` UInt64 DEFAULT length('abc');",
        "ALTER TABLE app.t MODIFY COLUMN `d` UInt64 DEFAULT c + 1;",
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `length`;",
    ]


def test_keeps_a_chain_of_reads_in_order_around_a_rename() -> None:
    assert _renamed(
        [_t([{"name": "a", "type": "UInt64"}, {"name": "d", "type": "UInt64"}])],
        [_t([
            {"name": "b", "type": "UInt64"},
            {"name": "c", "type": "UInt64", "default": _expr("b + 1")},
            {"name": "d", "type": "UInt64", "default": _expr("c + 1")},
        ])],
        "a",
        "b",
    ) == [
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c` UInt64 DEFAULT b + 1;",
        "ALTER TABLE app.t MODIFY COLUMN `d` UInt64 DEFAULT c + 1;",
    ]


def test_a_function_call_named_like_a_column_does_not_hold_back_the_rename() -> None:
    # A function call named like the new column used to read it, which made a
    # cycle that kept the ADD before the RENAME it reads.
    assert _renamed(
        [_t([{"name": "a", "type": "UInt64", "default": _expr("length('abc')")}])],
        [_t([
            {"name": "b", "type": "UInt64", "default": _expr("length('abc')")},
            {"name": "length", "type": "UInt64", "default": _expr("b + 1")},
        ])],
        "a",
        "b",
    ) == [
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `length` UInt64 DEFAULT b + 1;",
    ]


def test_keeps_a_drop_column_after_the_modify_that_stops_reading_it() -> None:
    assert _renamed(
        [_t([
            {"name": "a", "type": "UInt64"},
            {"name": "b", "type": "UInt64", "default": _expr("c")},
            {"name": "c", "type": "UInt64"},
        ])],
        [_t([
            {"name": "b", "type": "UInt64", "default": _expr("z")},
            {"name": "y", "type": "UInt64"},
            {"name": "z", "type": "UInt64"},
        ])],
        "a",
        "y",
    ) == [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT z;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `c`;",
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `y`;",
    ]


def test_a_table_rename_keeps_the_planner_order_of_the_column_statements() -> None:
    planned = plan_diff(
        [_t([{"name": "Total", "type": "UInt64"}])],
        [_t([
            {"name": "Total", "type": "UInt64", "default": _expr("price + 1")},
            {"name": "price", "type": "UInt64"},
        ])],
    )
    plan = apply_explicit_table_renames(
        planned, [TableRenameMapping("app", "old_t", "app", "t", "cli")]
    )
    assert [op.sql for op in plan.operations] == [
        "RENAME TABLE IF EXISTS app.old_t TO app.t;",
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `price` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `Total` UInt64 DEFAULT price + 1;",
    ]


def test_column_rename_keeps_index_constraint_and_projection_drops_before_the_drop_column() -> None:
    # ClickHouse rejects a DROP COLUMN while a skip index, constraint or
    # projection still reads the column; plan_diff drops those first (#747).
    previous = [
        table(
            database="app",
            name="t",
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "a", "type": "String"},
                {"name": "x", "type": "String"},
            ],
            indexes=[{"name": "idx_x", "expression": "x", "type": "bloom_filter", "granularity": 1}],
            constraints=[{"name": "c_x", "check": "x != ''"}],
            projections=[{"name": "p_x", "query": "SELECT x ORDER BY x"}],
        )
    ]
    next_ = [
        table(
            database="app",
            name="t",
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
            columns=[{"name": "id", "type": "UInt64"}, {"name": "b", "type": "String"}],
        )
    ]
    planned = plan_diff(previous, next_)
    plan = apply_selected_rename_suggestions(
        planned,
        build_explicit_column_rename_suggestions(
            planned, [ColumnRenameMapping("app", "t", "a", "b", "cli")]
        ),
        previous_definitions=previous,
        next_definitions=next_,
    )
    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.t DROP CONSTRAINT IF EXISTS `c_x`;",
        "ALTER TABLE app.t DROP INDEX IF EXISTS `idx_x`;",
        "ALTER TABLE app.t DROP PROJECTION IF EXISTS `p_x`;",
        "ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;",
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;",
    ]
