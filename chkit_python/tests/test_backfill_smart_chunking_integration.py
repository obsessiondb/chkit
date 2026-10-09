"""1:1 port of ``packages/plugin-backfill/src/chunking/smart-chunking.integration.test.ts``.

The fixture "query" emulates the ClickHouse surface the planner probes
(``system.parts`` / ``system.tables`` / ``system.columns``, ``EXPLAIN
ESTIMATE``, GROUP BY distributions, min/max, count) over an in-memory row
set, so the full analyze-and-chunk pipeline runs without a live server.
"""

from __future__ import annotations

import math
import re
from functools import reduce

from chkit_plugin_backfill.chunking.analyze import analyze_and_chunk
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import (
    Chunk,
    ChunkPlan,
    GenerateChunkPlanInput,
    PlannerQuery,
    QuerySettings,
)
from chkit_plugin_backfill.chunking.utils.binary_string import (
    compare_binary_strings,
    latin1_bytes,
    latin1_str,
)
from chkit_plugin_backfill.time_utils import iso_from_epoch_ms, parse_planner_datetime

MIB = 1024**2

RowValue = str | int | float
# Every FixtureRow carries "_partition_id" + "event_time" plus arbitrary columns.
FixtureRow = dict[str, RowValue]

_DAY_MS = 86_400_000
_HOUR_MS = 3_600_000


def _iso_at(day: int, hour: int, minute: int = 0) -> str:
    """TS ``new Date(Date.UTC(2026, 0, day, hour, minute, 0)).toISOString()``."""
    return f"2026-01-{day:02d}T{hour:02d}:{minute:02d}:00.000Z"


def _create_fixture_query(
    *,
    database: str,
    table: str,
    rows: list[FixtureRow],
    sort_keys: list[dict[str, str]],
    bytes_per_row: int = 1024,
    uncompressed_bytes_per_row: int | None = None,
) -> PlannerQuery:
    resolved_uncompressed = (
        uncompressed_bytes_per_row
        if uncompressed_bytes_per_row is not None
        else bytes_per_row * 2
    )

    def query(  # noqa: PLR0911, PLR0912 — mirrors the TS fixture dispatch
        sql: str, settings: QuerySettings | None
    ) -> list[dict[str, object]]:
        _ = settings

        if f"SELECT 1 FROM {database}.{table} LIMIT 1" in sql:
            return [{"ok": 1}]

        if "FROM system.parts" in sql:
            return _summarize_partitions(rows, bytes_per_row, resolved_uncompressed)

        if "FROM system.tables" in sql:
            return [{"sorting_key": ", ".join(key["column"] for key in sort_keys)}]

        if "FROM system.columns" in sql:
            return [{"name": key["column"], "type": key["type"]} for key in sort_keys]

        filtered_rows = _filter_rows(sql, rows)

        if sql.startswith("EXPLAIN ESTIMATE"):
            return [{"rows": str(len(filtered_rows))}]

        if " AS key" in sql and "GROUP BY key" in sql:
            match = re.search(r"^\s*SELECT\s+(\w+)\s+AS key", sql, re.MULTILINE)
            column = match.group(1) if match is not None else None
            if column is None:
                return []

            limit_match = re.search(r"LIMIT\s+(\d+)", sql)
            limit = int(limit_match.group(1)) if limit_match is not None else None

            grouped: dict[str, int] = {}
            for row in filtered_rows:
                value = _string_or_empty(row.get(column))
                grouped[value] = grouped.get(value, 0) + 1

            entries = sorted(grouped.items(), key=lambda item: item[1], reverse=True)
            if limit is not None:
                entries = entries[:limit]
            return [{"key": key, "cnt": str(cnt)} for key, cnt in entries]

        if "substring(" in sql:
            match = re.search(r"substring\((\w+), 1, (\d+)\) AS prefix", sql)
            column = match.group(1) if match is not None else None
            depth = int(match.group(2)) if match is not None else 0
            if column is None or depth <= 0:
                return []

            grouped = {}
            for row in filtered_rows:
                value = _string_or_empty(row.get(column))
                prefix = latin1_str(latin1_bytes(value)[:depth])
                grouped[prefix] = grouped.get(prefix, 0) + 1

            entries = sorted(grouped.items(), key=lambda item: latin1_bytes(item[0]))
            return [{"prefix": prefix, "cnt": str(cnt)} for prefix, cnt in entries]

        if (
            "formatDateTime(toStartOfDay(" in sql
            or "formatDateTime(toStartOfHour(" in sql
        ):
            grain = "day" if "toStartOfDay(" in sql else "hour"
            column_match = re.search(r"toStartOf(?:Day|Hour)\((\w+)\)", sql)
            column = column_match.group(1) if column_match is not None else None
            if column is None:
                return []

            grouped = {}
            for row in filtered_rows:
                raw = str(row.get(column))
                bucket = (
                    _to_start_of_day(raw) if grain == "day" else _to_start_of_hour(raw)
                )
                grouped[bucket] = grouped.get(bucket, 0) + 1

            entries = sorted(grouped.items(), key=lambda item: item[0])
            return [{"bucket": bucket, "cnt": str(cnt)} for bucket, cnt in entries]

        if "toString(min(" in sql and "toString(max(" in sql:
            match = re.search(
                r"toString\(min\((\w+)\)\) AS minVal,\s+toString\(max\(\1\)\) AS maxVal",
                sql,
            )
            column = match.group(1) if match is not None else None
            if column is None or len(filtered_rows) == 0:
                return []

            values = [row[column] for row in filtered_rows if column in row]
            if len(values) == 0:
                return []

            min_val = reduce(
                lambda current, candidate: (
                    candidate if _compare_values(candidate, current) < 0 else current
                ),
                values,
            )
            max_val = reduce(
                lambda current, candidate: (
                    candidate if _compare_values(candidate, current) > 0 else current
                ),
                values,
            )
            return [{"minVal": str(min_val), "maxVal": str(max_val)}]

        if "SELECT count() AS cnt" in sql:
            return [{"cnt": str(len(filtered_rows))}]

        return []

    return query


def _summarize_partitions(
    rows: list[FixtureRow],
    bytes_per_row: int,
    uncompressed_bytes_per_row: int,
) -> list[dict[str, object]]:
    by_partition: dict[str, list[FixtureRow]] = {}
    for row in rows:
        by_partition.setdefault(str(row["_partition_id"]), []).append(row)

    return [
        {
            "partition_id": partition_id,
            "total_rows": str(len(partition_rows)),
            "total_bytes": str(len(partition_rows) * bytes_per_row),
            "total_uncompressed_bytes": str(
                len(partition_rows) * uncompressed_bytes_per_row
            ),
            "min_time": min(str(row["event_time"]) for row in partition_rows),
            "max_time": max(str(row["event_time"]) for row in partition_rows),
        }
        for partition_id, partition_rows in sorted(by_partition.items())
    ]


def _filter_rows(sql: str, rows: list[FixtureRow]) -> list[FixtureRow]:
    where_match = re.search(
        r"WHERE\s+([\s\S]*?)(?:GROUP BY|ORDER BY|SETTINGS|$)", sql, re.IGNORECASE
    )
    if where_match is None or not where_match.group(1):
        return rows

    clauses = [
        re.sub(r"\s+", " ", clause).strip()
        for clause in re.split(r"\s+AND\s+", where_match.group(1))
    ]
    clauses = [clause for clause in clauses if clause]

    return [
        row
        for row in rows
        if all(_evaluate_clause(clause, row) for clause in clauses)
    ]


def _evaluate_clause(clause: str, row: FixtureRow) -> bool:  # noqa: PLR0911
    match = re.fullmatch(r"_partition_id = '([^']+)'", clause)
    if match is not None:
        return row["_partition_id"] == match.group(1)

    match = re.fullmatch(r"(\w+) >= parseDateTimeBestEffort\('([^']+)'\)", clause)
    if match is not None:
        left = parse_planner_datetime(str(row[match.group(1)]))
        return left >= parse_planner_datetime(match.group(2))

    match = re.fullmatch(r"(\w+) < parseDateTimeBestEffort\('([^']+)'\)", clause)
    if match is not None:
        left = parse_planner_datetime(str(row[match.group(1)]))
        return left < parse_planner_datetime(match.group(2))

    match = re.fullmatch(r"(\w+) >= unhex\('([0-9a-f]*)'\)", clause, re.IGNORECASE)
    if match is not None:
        bound = latin1_str(bytes.fromhex(match.group(2)))
        return _compare_latin1(_string_or_empty(row.get(match.group(1))), bound) >= 0

    match = re.fullmatch(r"(\w+) < unhex\('([0-9a-f]*)'\)", clause, re.IGNORECASE)
    if match is not None:
        bound = latin1_str(bytes.fromhex(match.group(2)))
        return _compare_latin1(_string_or_empty(row.get(match.group(1))), bound) < 0

    match = re.fullmatch(r"(\w+) >= '([^']+)'", clause)
    if match is not None:
        return _compare_primitive(row.get(match.group(1)), match.group(2)) >= 0

    match = re.fullmatch(r"(\w+) < '([^']+)'", clause)
    if match is not None:
        return _compare_primitive(row.get(match.group(1)), match.group(2)) < 0

    match = re.fullmatch(r"(\w+) >= (-?\d+(?:\.\d+)?)", clause)
    if match is not None:
        return _as_number(row.get(match.group(1))) >= float(match.group(2))

    match = re.fullmatch(r"(\w+) < (-?\d+(?:\.\d+)?)", clause)
    if match is not None:
        return _as_number(row.get(match.group(1))) < float(match.group(2))

    msg = f"Unsupported test clause: {clause}"
    raise ValueError(msg)


def _string_or_empty(value: RowValue | None) -> str:
    return str(value) if value is not None else ""


def _as_number(value: RowValue | None) -> float:
    if value is None:
        return math.nan
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except ValueError:
        return math.nan


def _compare_primitive(left: RowValue | None, right: str) -> float:
    if isinstance(left, (int, float)) and not isinstance(left, bool):
        return left - float(right)
    left_str = _string_or_empty(left)
    if left_str < right:
        return -1
    if left_str > right:
        return 1
    return 0


def _compare_values(left: RowValue, right: RowValue) -> float:
    if (
        isinstance(left, (int, float))
        and isinstance(right, (int, float))
        and not isinstance(left, bool)
        and not isinstance(right, bool)
    ):
        return left - right
    return _compare_latin1(str(left), str(right))


def _compare_latin1(left: str, right: str) -> int:
    return compare_binary_strings(left, right)


def _to_start_of_day(value: str) -> str:
    ms = parse_planner_datetime(value)
    return iso_from_epoch_ms(ms - (ms % _DAY_MS))


def _to_start_of_hour(value: str) -> str:
    ms = parse_planner_datetime(value)
    return iso_from_epoch_ms(ms - (ms % _HOUR_MS))


def _plan_fixture(
    *,
    rows: list[FixtureRow],
    sort_keys: list[dict[str, str]],
    max_chunk_bytes: int,
) -> ChunkPlan:
    query = _create_fixture_query(
        database="app", table="events", rows=rows, sort_keys=sort_keys
    )
    return analyze_and_chunk(
        GenerateChunkPlanInput(
            database="app",
            table="events",
            target_chunk_bytes=max_chunk_bytes,
            query=query,
        )
    )


def _strategy_ids(chunk: Chunk) -> list[str]:
    return [step.strategy_id for step in chunk.analysis.lineage]


def _build_sql_for_chunk(plan: ChunkPlan, chunk: Chunk) -> str:
    return build_chunk_execution_sql(
        plan_id="fixture-plan",
        chunk=chunk,
        target="app.events",
        source_target="app.events",
        table=plan.table,
    )


def _require_chunk(value: Chunk | None, label: str) -> Chunk:
    if value is None:
        msg = f"Missing expected chunk: {label}"
        raise AssertionError(msg)
    return value


def test_keeps_small_partitions_as_a_single_metadata_chunk() -> None:
    rows: list[FixtureRow] = [
        {"_partition_id": "p_small", "event_time": _iso_at(1, index), "id": index}
        for index in range(12)
    ]

    plan = _plan_fixture(
        rows=rows,
        sort_keys=[{"column": "id", "type": "UInt64"}],
        max_chunk_bytes=64 * MIB,
    )

    assert len(plan.chunks) == 1
    assert plan.chunks[0].estimate.reason == "partition-metadata"
    assert len(_strategy_ids(_require_chunk(plan.chunks[0], "metadata chunk"))) == 0


def test_uses_quantile_range_splitting_for_wide_numeric_distributions() -> None:
    rows: list[FixtureRow] = [
        {
            "_partition_id": "p_quantile",
            "event_time": _iso_at(2, index % 24),
            "id": index,
        }
        for index in range(120)
    ]

    plan = _plan_fixture(
        rows=rows,
        sort_keys=[{"column": "id", "type": "UInt64"}],
        max_chunk_bytes=60 * 1024,
    )

    assert len(plan.chunks) >= 3
    assert all(
        "quantile-range-split" in _strategy_ids(chunk) for chunk in plan.chunks
    )

    estimated_rows = [chunk.estimate.rows for chunk in plan.chunks]
    assert max(estimated_rows) - min(estimated_rows) <= 4


def test_falls_back_to_equal_width_splitting_when_quantile_boundaries_collapse() -> None:
    rows: list[FixtureRow] = [
        {
            "_partition_id": "p_equal",
            "event_time": _iso_at(3, index % 24),
            "id": 100 + (index % 2),
        }
        for index in range(80)
    ]

    plan = _plan_fixture(
        rows=rows,
        sort_keys=[{"column": "id", "type": "UInt64"}],
        max_chunk_bytes=40 * 1024,
    )

    assert len(plan.chunks) > 1
    assert any("equal-width-split" in _strategy_ids(chunk) for chunk in plan.chunks)
    assert all(chunk.estimate.rows > 0 for chunk in plan.chunks)
    assert all(
        all(range_.from_ != range_.to for range_ in chunk.ranges)
        for chunk in plan.chunks
    )


def test_uses_string_key_splitting_for_string_distributed_partitions() -> None:
    rows: list[FixtureRow] = []
    for prefix in ["apple", "apricot", "banana", "berry", "citrus"]:
        for index in range(24):
            rows.append(
                {
                    "_partition_id": "p_string",
                    "event_time": _iso_at(4, index % 24),
                    "slug": f"{prefix}-{index:02d}",
                }
            )

    plan = _plan_fixture(
        rows=rows,
        sort_keys=[{"column": "slug", "type": "String"}],
        max_chunk_bytes=48 * 1024,
    )

    assert len(plan.chunks) > 2
    uses_string_strategy = any(
        "group-by-key-split" in _strategy_ids(chunk)
        or "string-prefix-split" in _strategy_ids(chunk)
        for chunk in plan.chunks
    )
    assert uses_string_strategy

    sql = _build_sql_for_chunk(
        plan, _require_chunk(plan.chunks[0], "string-key first chunk")
    )
    assert "unhex('" in sql


def test_combines_string_prefix_and_temporal_splitting_for_focused_time_windows() -> None:
    rows: list[FixtureRow] = []

    for day in range(1, 4):
        for hour in range(24):
            rows.append(
                {
                    "_partition_id": "p_combo_temporal",
                    "event_time": _iso_at(10 + day, hour),
                    "user_id": "hot",
                    "score": 1000 + day * 24 + hour,
                }
            )

    for index in range(18):
        rows.append(
            {
                "_partition_id": "p_combo_temporal",
                "event_time": _iso_at(10, index),
                "user_id": f"cold-{index}",
                "score": index,
            }
        )

    plan = _plan_fixture(
        rows=rows,
        sort_keys=[
            {"column": "user_id", "type": "String"},
            {"column": "event_time", "type": "DateTime"},
        ],
        max_chunk_bytes=36 * 1024,
    )

    hot_chunks = [
        chunk
        for chunk in plan.chunks
        if "temporal-bucket-split" in _strategy_ids(chunk)
        and any(range_.dimension_index == 0 for range_ in chunk.ranges)
        and any(range_.dimension_index == 1 for range_ in chunk.ranges)
    ]

    assert len(hot_chunks) > 0
    assert all(
        chunk.analysis.focused_value is not None
        and chunk.analysis.focused_value.value == "hot"
        for chunk in hot_chunks
    )

    sql = _build_sql_for_chunk(
        plan, _require_chunk(hot_chunks[0], "temporal combo chunk")
    )
    assert "user_id >=" in sql
    assert "event_time >=" in sql
    assert "parseDateTimeBestEffort" in sql

    temporal_ranges = sorted(
        (
            range_
            for chunk in hot_chunks
            for range_ in [
                next(
                    (
                        candidate
                        for candidate in chunk.ranges
                        if candidate.dimension_index == 1
                    ),
                    None,
                )
            ]
            if range_ is not None
        ),
        key=lambda range_: str(range_.from_),
    )

    for index in range(1, len(temporal_ranges)):
        assert temporal_ranges[index - 1].to == temporal_ranges[index].from_


def test_combines_string_prefix_and_quantile_splitting_on_secondary_numeric_dimensions() -> None:
    rows: list[FixtureRow] = []

    for index in range(96):
        rows.append(
            {
                "_partition_id": "p_combo_numeric",
                "event_time": _iso_at(20, index % 24),
                "account": "vip",
                "seq": index,
            }
        )

    for index in range(24):
        rows.append(
            {
                "_partition_id": "p_combo_numeric",
                "event_time": _iso_at(20, index % 24),
                "account": f"free-{index}",
                "seq": index,
            }
        )

    plan = _plan_fixture(
        rows=rows,
        sort_keys=[
            {"column": "account", "type": "String"},
            {"column": "seq", "type": "UInt64"},
        ],
        max_chunk_bytes=48 * 1024,
    )

    combo_chunks = [
        chunk
        for chunk in plan.chunks
        if "quantile-range-split" in _strategy_ids(chunk)
        and any(range_.dimension_index == 0 for range_ in chunk.ranges)
        and any(range_.dimension_index == 1 for range_ in chunk.ranges)
    ]

    assert len(combo_chunks) > 0

    sql = _build_sql_for_chunk(
        plan, _require_chunk(combo_chunks[0], "numeric combo chunk")
    )
    assert "account >=" in sql
    assert "seq >= '" in sql
