"""Port of ``packages/core/src/planner-deep-default-chain.test.ts`` (#789).

Ordering the MODIFY COLUMNs of a deep chain of defaults took time quadratic
in its length: 30 s and more here. Now it takes a few seconds.
"""

from __future__ import annotations

import time
from collections.abc import Callable

from chkit.core.model import TableDefinition, table
from chkit.core.planner import plan_diff

DEPTH = 5000
BOUND_SECONDS = 20


def _chain_table(expression: Callable[[int], str], extra: tuple[str, ...] = ()) -> TableDefinition:
    return table(
        database="app",
        name="chain",
        columns=[
            {"name": "id", "type": "UInt64"},
            *(
                {"name": f"c{index}", "type": "UInt64", "default": {"expression": expression(index)}}
                for index in range(DEPTH)
            ),
            *({"name": name, "type": "UInt64"} for name in extra),
        ],
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )


def _next(index: int) -> str:
    return f"c{index + 1}" if index + 1 < DEPTH else "id"


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
        lambda index: "id + 0" if index == 0 else "id + c0" if index == DEPTH - 1 else f"{_next(index)} + 0"
    )
    after = _chain_table(lambda index: "c1 + 1" if index == 0 else f"{_next(index)} + 1")
    sql = _timed_plan(before, after)
    assert len(sql) == DEPTH
    assert _modify_index(sql, last) < _modify_index(sql, "c0")


def test_a_chain_whose_every_column_stops_reading_another_column_is_ordered_in_linear_time() -> None:
    before = _chain_table(lambda index: f"{_next(index)} + x", ("x",))
    after = _chain_table(_next, ("x",))
    sql = _timed_plan(before, after)
    assert len(sql) == DEPTH
    assert sql[0] == "ALTER TABLE app.chain MODIFY COLUMN `c0` UInt64 DEFAULT c1;"
