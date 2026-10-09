"""Distribution probes (string prefix / key / temporal buckets).

Port of ``chunking/services/distribution-source.ts``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from chkit_plugin_backfill.chunking.sql import build_where_clause_from_ranges
from chkit_plugin_backfill.chunking.types import (
    ChunkRange,
    PlannerContext,
    SortKey,
    StringPrefixBucket,
    TemporalBucket,
)
from chkit_plugin_backfill.chunking.utils.binary_string import latin1_bytes
from chkit_plugin_backfill.chunking.utils.jsnum import parse_js_number


def _find_range(
    ranges: list[ChunkRange], dimension_index: int
) -> ChunkRange | None:
    return next(
        (
            candidate
            for candidate in ranges
            if candidate.dimension_index == dimension_index
        ),
        None,
    )


def _count(value: object) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return parse_js_number(str(value)) if value is not None else 0.0


def probe_string_prefix_distribution(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    partition_id: str,
    ranges: list[ChunkRange],
    sort_key: SortKey,
    dimension_index: int,
    depth: int,
    sort_keys: list[SortKey],
) -> list[StringPrefixBucket]:
    range_ = _find_range(ranges, dimension_index)
    if range_ is None or not range_.from_ or not range_.to:
        return []

    rows = context.query(
        f"""
SELECT
  substring({sort_key.name}, 1, {depth}) AS prefix,
  count() AS cnt
FROM {context.database}.{context.table}
WHERE {build_where_clause_from_ranges(partition_id, ranges, sort_keys)}
GROUP BY prefix
ORDER BY prefix""",
        context.query_settings,
    )

    return [
        StringPrefixBucket(
            value=str(row.get("prefix", "")),
            row_count=_count(row.get("cnt")),
            is_exact_value=len(latin1_bytes(str(row.get("prefix", "")))) < depth,
        )
        for row in rows
    ]


class StringKeyBucket(BaseModel):
    model_config = ConfigDict(frozen=True, populate_by_name=True)

    value: str
    row_count: float = Field(..., alias="rowCount")


def probe_string_key_distribution(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    partition_id: str,
    ranges: list[ChunkRange],
    sort_key: SortKey,
    dimension_index: int,
    sort_keys: list[SortKey],
    limit: int,
) -> list[StringKeyBucket] | None:
    range_ = _find_range(ranges, dimension_index)
    if range_ is None or not range_.from_ or not range_.to:
        return None

    rows = context.query(
        f"""
SELECT
  {sort_key.name} AS key,
  count() AS cnt
FROM {context.database}.{context.table}
WHERE {build_where_clause_from_ranges(partition_id, ranges, sort_keys)}
GROUP BY key
ORDER BY cnt DESC
LIMIT {limit + 1}""",
        context.query_settings,
    )

    if len(rows) > limit:
        return None

    return [
        StringKeyBucket(value=str(row.get("key", "")), row_count=_count(row.get("cnt")))
        for row in rows
    ]


def probe_temporal_distribution(  # noqa: PLR0917 — TS signature parity
    context: PlannerContext,
    partition_id: str,
    ranges: list[ChunkRange],
    sort_keys: list[SortKey],
    dimension_index: int,
    grain: Literal["day", "hour"],
) -> list[TemporalBucket]:
    sort_key = (
        sort_keys[dimension_index]
        if 0 <= dimension_index < len(sort_keys)
        else None
    )
    if sort_key is None or sort_key.category != "datetime":
        return []

    bucket_expression = (
        f"toStartOfDay({sort_key.name})"
        if grain == "day"
        else f"toStartOfHour({sort_key.name})"
    )

    rows = context.query(
        f"""
SELECT
  formatDateTime({bucket_expression}, '%Y-%m-%dT%H:%i:%sZ') AS bucket,
  count() AS cnt
FROM {context.database}.{context.table}
WHERE {build_where_clause_from_ranges(partition_id, ranges, sort_keys)}
GROUP BY bucket
ORDER BY bucket""",
        context.query_settings,
    )

    return [
        TemporalBucket(start=str(row.get("bucket", "")), row_count=_count(row.get("cnt")))
        for row in rows
    ]


__all__ = [
    "StringKeyBucket",
    "probe_string_key_distribution",
    "probe_string_prefix_distribution",
    "probe_temporal_distribution",
]
