"""Port of ``packages/core/src/planner-key-collision.test.ts`` and
``packages/cli/src/test/commands/generate/plan-pipeline-key-collision.test.ts`` (#801).

Table ``t:column:x`` with column ``a`` and table ``t`` with column
``x:column:a`` both give the operation key ``table:app.t:column:x:column:a``.
"""

from __future__ import annotations

from chkit import table
from chkit.cli.commands.generate_plan_pipeline import (
    apply_selected_rename_suggestions,
    build_explicit_column_rename_suggestions,
)
from chkit.cli.commands.generate_rename_mappings import ColumnRenameMapping
from chkit.core.model import SchemaDefinition, TableDefinition
from chkit.core.planner import plan_diff

ID: dict[str, object] = {"name": "id", "type": "UInt64"}


def app_table(name: str, columns: list[dict[str, object]]) -> TableDefinition:
    return table(
        database="app",
        name=name,
        columns=list(columns),
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )


def sql_of(old: list[SchemaDefinition], new: list[SchemaDefinition]) -> list[str]:
    return [op.sql for op in plan_diff(old, new).operations]


def test_issue_repro_the_other_table_does_not_hide_what_a_changed_expression_reads() -> None:
    other = app_table("t:column:x", [ID, {"name": "a", "type": "UInt64", "default": "fn:id + 0"}])
    before = app_table("t", [ID, {"name": "x:column:a", "type": "UInt64", "default": "fn:id + 0"}])
    after = app_table(
        "t",
        [
            ID,
            {"name": "x:column:a", "type": "UInt64", "default": "fn:`x:column:b` + 1"},
            {"name": "x:column:b", "type": "UInt64", "default": "fn:id + 2"},
        ],
    )

    expected = [
        "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `x:column:b` UInt64 DEFAULT id + 2;",
        "ALTER TABLE app.t MODIFY COLUMN `x:column:a` UInt64 DEFAULT `x:column:b` + 1;",
    ]
    assert sql_of([before], [after]) == expected
    assert sql_of([before, other], [after, other]) == expected


def test_a_statement_of_the_other_table_does_not_hide_that_the_cycle_closing_modify_is_last() -> (
    None
):
    # `x:column:a` reads `x:column:b`, whose old expression reads it back:
    # the MODIFY of `x:column:b` must remove that read first (#769).
    before: list[SchemaDefinition] = [
        app_table(
            "t",
            [
                ID,
                {"name": "x:column:a", "type": "UInt64", "default": "fn:id + 0"},
                {"name": "x:column:b", "type": "UInt64", "default": "fn:`x:column:a` + 1"},
            ],
        ),
        app_table("t:column:x", [ID, {"name": "a", "type": "UInt64", "comment": "old"}]),
    ]
    after: list[SchemaDefinition] = [
        app_table(
            "t",
            [
                ID,
                {"name": "x:column:a", "type": "UInt64", "default": "fn:`x:column:b` + 1"},
                {"name": "x:column:b", "type": "UInt64", "default": "fn:id + 2"},
            ],
        ),
        app_table("t:column:x", [ID, {"name": "a", "type": "UInt64", "comment": "new"}]),
    ]

    assert sql_of(before, after) == [
        "ALTER TABLE app.`t:column:x` COMMENT COLUMN `a` 'new';",
        "ALTER TABLE app.t MODIFY COLUMN `x:column:b` UInt64 DEFAULT id + 2;",
        "ALTER TABLE app.t MODIFY COLUMN `x:column:a` UInt64 DEFAULT `x:column:b` + 1;",
    ]


def test_each_table_orders_its_own_type_change() -> None:
    # `a` of `t:column:x` and `x:column:a` of `t` both change from String to
    # UInt64. In `t:column:x`, `b` stops reading `a`, so its MODIFY runs first;
    # in `t`, `x:column:b` starts reading `x:column:a`, so its MODIFY runs
    # after. The colliding keys don't mix the two tables' orders (#814).
    before: list[SchemaDefinition] = [
        app_table(
            "t:column:x",
            [
                ID,
                {"name": "a", "type": "String"},
                {"name": "b", "type": "UInt64", "default": "fn:length(a)"},
            ],
        ),
        app_table(
            "t",
            [
                ID,
                {"name": "x:column:a", "type": "String"},
                {"name": "x:column:b", "type": "UInt64", "default": "fn:0"},
            ],
        ),
    ]
    after: list[SchemaDefinition] = [
        app_table(
            "t:column:x",
            [
                ID,
                {"name": "a", "type": "UInt64"},
                {"name": "b", "type": "UInt64", "default": "fn:0"},
            ],
        ),
        app_table(
            "t",
            [
                ID,
                {"name": "x:column:a", "type": "UInt64"},
                {"name": "x:column:b", "type": "UInt64", "default": "fn:`x:column:a` + 1"},
            ],
        ),
    ]
    other = [
        "ALTER TABLE app.`t:column:x` MODIFY COLUMN `b` UInt64 DEFAULT 0;",
        "ALTER TABLE app.`t:column:x` MODIFY COLUMN `a` UInt64;",
    ]
    own = [
        "ALTER TABLE app.t MODIFY COLUMN `x:column:a` UInt64;",
        "ALTER TABLE app.t MODIFY COLUMN `x:column:b` UInt64 DEFAULT `x:column:a` + 1;",
    ]
    assert sql_of([before[0]], [after[0]]) == other
    assert sql_of([before[1]], [after[1]]) == own
    assert sql_of(before, after) == [*own, *other]


def test_a_default_that_reads_a_renamed_column_runs_after_the_rename_to_it() -> None:
    # Renames `a:b` -> `c` and `a` -> `b:c` both give the operation key
    # `table:app.t:column_rename:a:b:c`.
    previous: list[SchemaDefinition] = [
        app_table(
            "t",
            [
                ID,
                {"name": "a:b", "type": "UInt64"},
                {"name": "a", "type": "UInt64"},
                {"name": "x", "type": "UInt64", "default": 0},
            ],
        )
    ]
    next_: list[SchemaDefinition] = [
        app_table(
            "t",
            [
                ID,
                {"name": "c", "type": "UInt64"},
                {"name": "b:c", "type": "UInt64"},
                {"name": "x", "type": "UInt64", "default": {"expression": "c + 1"}},
            ],
        )
    ]
    planned = plan_diff(previous, next_)
    plan = apply_selected_rename_suggestions(
        planned,
        build_explicit_column_rename_suggestions(
            planned,
            [
                ColumnRenameMapping("app", "t", "a:b", "c", "cli"),
                ColumnRenameMapping("app", "t", "a", "b:c", "cli"),
            ],
        ),
        previous_definitions=previous,
        next_definitions=next_,
    )

    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a:b` TO `c`;",
        "ALTER TABLE app.t MODIFY COLUMN `x` UInt64 DEFAULT c + 1;",
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b:c`;",
    ]
