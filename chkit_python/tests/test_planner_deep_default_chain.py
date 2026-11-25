"""Port of ``packages/core/src/planner-deep-default-chain.test.ts`` (#789).

Ordering the MODIFY COLUMNs of a deep chain of defaults took time quadratic
in its length: 45 s and more here. Now it takes a few seconds.
"""

from __future__ import annotations

import time
from collections.abc import Callable

from chkit.core.model import ColumnInput, TableDefinition, table
from chkit.core.planner import plan_diff

DEPTH = 7000
BOUND_SECONDS = 25


def _chain_table(
    expression: Callable[[int], str], extra: tuple[str, ...] = (), length: int = DEPTH
) -> TableDefinition:
    columns: list[ColumnInput] = [{"name": "id", "type": "UInt64"}]
    for index in range(length):
        columns.append(
            {"name": f"c{index}", "type": "UInt64", "default": {"expression": expression(index)}}
        )
    columns.extend({"name": name, "type": "UInt64"} for name in extra)
    return table(
        database="app",
        name="chain",
        columns=columns,
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )


def _next(index: int, length: int = DEPTH) -> str:
    return f"c{index + 1}" if index + 1 < length else "id"


def _modify_index(sql: list[str], column: str) -> int:
    prefix = f"ALTER TABLE app.chain MODIFY COLUMN `{column}` "
    return next(i for i, statement in enumerate(sql) if statement.startswith(prefix))


def _timed_plan(before: TableDefinition, after: TableDefinition) -> list[str]:
    started = time.perf_counter()
    sql = [op.sql for op in plan_diff([before], [after]).operations]
    assert time.perf_counter() - started < BOUND_SECONDS
    return sql


def test_a_chain_whose_last_column_stops_reading_the_first_is_ordered_in_linear_time() -> None:
    # c0 starts to read c1, and c1 leads to the last column, which stops
    # reading c0: that MODIFY must run first, or c0's closes a cycle.
    last = f"c{DEPTH - 1}"
    before = _chain_table(
        lambda index: (
            "id + 0" if index == 0 else "id + c0" if index == DEPTH - 1 else f"{_next(index)} + 0"
        )
    )
    after = _chain_table(lambda index: "c1 + 1" if index == 0 else f"{_next(index)} + 1")
    sql = _timed_plan(before, after)
    assert len(sql) == DEPTH
    assert _modify_index(sql, last) < _modify_index(sql, "c0")


def test_a_chain_whose_every_column_stops_reading_a_column_further_down_is_ordered() -> None:
    # Each column stops reading the one after next; only the last column's
    # MODIFY, which stops reading c0, must run before c0's.
    length = 1000

    def old(index: int) -> str:
        if index == 0:
            return "id"
        if index == length - 1:
            return "c0"
        if index == length - 2:
            return f"c{index + 1} + 0"
        return f"c{index + 1} + c{index + 2}"

    before = _chain_table(old, length=length)
    after = _chain_table(lambda index: _next(index, length), length=length)
    sql = [op.sql for op in plan_diff([before], [after]).operations]
    assert len(sql) == length
    assert _modify_index(sql, f"c{length - 1}") < _modify_index(sql, "c0")


def test_a_chain_whose_every_column_stops_reading_another_column_is_ordered_in_linear_time() -> (
    None
):
    before = _chain_table(lambda index: f"{_next(index)} + x", ("x",))
    after = _chain_table(_next, ("x",))
    sql = _timed_plan(before, after)
    assert len(sql) == DEPTH
    assert sql[0] == "ALTER TABLE app.chain MODIFY COLUMN `c0` UInt64 DEFAULT c1;"
