"""Row estimation probes — port of ``chunking/services/row-probe.ts``."""

from __future__ import annotations

import math

from chkit_plugin_backfill.chunking.sql import (
    build_count_sql,
    build_estimate_sql,
    build_where_clause_from_ranges,
)
from chkit_plugin_backfill.chunking.types import (
    ChunkRange,
    EstimateFilter,
    PlannerContext,
    RowProbeStrategy,
    SortKey,
)
from chkit_plugin_backfill.chunking.utils.jsnum import parse_js_number
from chkit_plugin_backfill.time_utils import parse_planner_datetime


def get_row_probe_strategy(context: PlannerContext) -> RowProbeStrategy:
    return context.row_probe_strategy


def _coerce_row_value(value: object) -> float:
    """JS ``Number(value ?? 0)`` over a JSON cell (str | number | None).

    clickhouse-connect can hand back native driver objects (e.g. Decimal)
    where the TS JSON transport delivers strings — coerce their string form
    through the same JS-Number grammar rather than treating them as NaN.
    """
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return parse_js_number(str(value))


def estimate_rows(
    context: PlannerContext,
    filter_: EstimateFilter,
    sort_keys: list[SortKey],
) -> float:
    if get_row_probe_strategy(context) == "count":
        return count_rows_exact(context, filter_, sort_keys)

    rows = context.query(
        build_estimate_sql(filter_, sort_keys, context, get_row_probe_strategy(context)),
        context.query_settings,
    )

    if not rows:
        return 0
    first_row = rows[0]

    for key, value in first_row.items():
        if "row" not in key.lower():
            continue
        parsed = _coerce_row_value(value)
        if math.isfinite(parsed):
            return parsed

    for value in first_row.values():
        parsed = _coerce_row_value(value)
        if math.isfinite(parsed):
            return parsed

    return 0


def count_rows_exact(
    context: PlannerContext,
    filter_: EstimateFilter,
    sort_keys: list[SortKey],
) -> float:
    rows = context.query(
        build_count_sql(
            filter_, sort_keys, database=context.database, table=context.table
        ),
        context.query_settings,
    )
    if not rows:
        return 0.0
    return _coerce_row_value(rows[0].get("cnt", 0))


def get_sort_key_range(
    context: PlannerContext,
    partition_id: str,
    ranges: list[ChunkRange],
    sort_keys: list[SortKey],
    sort_key: SortKey,
) -> tuple[str, str] | None:
    rows = context.query(
        f"""
SELECT
  toString(min({sort_key.name})) AS minVal,
  toString(max({sort_key.name})) AS maxVal
FROM {context.database}.{context.table}
WHERE {build_where_clause_from_ranges(partition_id, ranges, sort_keys)}""",
        context.query_settings,
    )

    if not rows:
        return None
    min_val = rows[0].get("minVal")
    max_val = rows[0].get("maxVal")
    return (
        str(min_val) if min_val is not None else "",
        str(max_val) if max_val is not None else "",
    )


parse_planner_date_time = parse_planner_datetime


__all__ = [
    "count_rows_exact",
    "estimate_rows",
    "get_row_probe_strategy",
    "get_sort_key_range",
    "parse_planner_date_time",
]
