"""Partition + sort-key introspection — port of ``chunking/services/metadata-source.ts``."""

from __future__ import annotations

import re
from typing import Literal

from chkit_plugin_backfill.chunking.types import (
    Partition,
    PlannerContext,
    SortKey,
    SortKeyCategory,
)
from chkit_plugin_backfill.chunking.utils.jsnum import parse_js_number
from chkit_plugin_backfill.time_utils import parse_planner_datetime_to_iso

_NUMERIC_TYPES = re.compile(r"^(U?Int|Float|Decimal)")
_DATETIME_TYPES = re.compile(r"^(Date|DateTime)")
# re.ASCII: JS `\b` is ASCII-word-based; Python's default is Unicode-aware.
_IDENTIFIER_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b", re.ASCII)


def _parse_clickhouse_utc_timestamp(value: str) -> str:
    """ClickHouse returns timestamps without timezone — they are always UTC."""
    trimmed = value.strip()
    normalized = trimmed if "T" in trimmed else trimmed.replace(" ", "T", 1) + "Z"
    if not normalized.endswith("Z"):
        normalized = f"{normalized}Z"
    return parse_planner_datetime_to_iso(normalized)


def _classify_sort_key_type(type_: str) -> SortKeyCategory:
    if _NUMERIC_TYPES.match(type_) is not None:
        return "numeric"
    if _DATETIME_TYPES.match(type_) is not None:
        return "datetime"
    return "string"


def _boundary_encoding_for_category(
    category: SortKeyCategory,
) -> Literal["literal", "hex-latin1"]:
    return "hex-latin1" if category == "string" else "literal"


def _split_top_level_csv(input_: str) -> list[str]:
    parts: list[str] = []
    current = ""
    depth = 0
    quote: str | None = None

    for index, char in enumerate(input_):
        if quote is not None:
            current += char
            if char == quote and (index == 0 or input_[index - 1] != "\\"):
                quote = None
            continue

        if char in {"'", '"'}:
            quote = char
            current += char
            continue

        if char == "(":
            depth += 1
            current += char
            continue

        if char == ")":
            depth = max(0, depth - 1)
            current += char
            continue

        if char == "," and depth == 0:
            parts.append(current.strip())
            current = ""
            continue

        current += char

    if current.strip():
        parts.append(current.strip())

    return parts


def _resolve_sort_key_column(
    expression: str, known_columns: set[str]
) -> str | None:
    trimmed = expression.strip()
    if trimmed in known_columns:
        return trimmed

    identifiers = [match.group(0) for match in _IDENTIFIER_RE.finditer(trimmed)]

    matches: list[str] = []
    seen: set[str] = set()
    for identifier in identifiers:
        if identifier in known_columns and identifier not in seen:
            seen.add(identifier)
            matches.append(identifier)
    if len(matches) == 1:
        return matches[0]
    if len(known_columns) == 0 and identifiers:
        return identifiers[-1]
    return None


def introspect_partitions(context: PlannerContext) -> list[Partition]:
    context.query(
        f"SELECT 1 FROM {context.database}.{context.table} LIMIT 1 "
        "SETTINGS select_sequential_consistency = 1",
        None,
    )

    rows = context.query(
        f"""SELECT
  partition_id,
  toString(sum(rows)) AS total_rows,
  toString(sum(bytes_on_disk)) AS total_bytes,
  toString(sum(data_uncompressed_bytes)) AS total_uncompressed_bytes,
  toString(min(min_time)) AS min_time,
  toString(max(max_time)) AS max_time
FROM system.parts
WHERE database = '{context.database}'
  AND table = '{context.table}'
  AND active = 1
GROUP BY partition_id
ORDER BY partition_id
SETTINGS select_sequential_consistency = 1""",
        None,
    )

    partitions: list[Partition] = []
    for row in rows:
        total_bytes = str(row.get("total_bytes", ""))
        uncompressed_raw = row.get("total_uncompressed_bytes")
        uncompressed = (
            str(uncompressed_raw) if uncompressed_raw is not None else total_bytes
        )
        partitions.append(
            Partition(
                partition_id=str(row.get("partition_id", "")),
                rows=parse_js_number(str(row.get("total_rows", ""))),
                bytes_compressed=parse_js_number(total_bytes),
                bytes_uncompressed=parse_js_number(uncompressed),
                min_time=_parse_clickhouse_utc_timestamp(str(row.get("min_time", ""))),
                max_time=_parse_clickhouse_utc_timestamp(str(row.get("max_time", ""))),
            )
        )

    def in_window(partition: Partition) -> bool:
        if context.from_ and partition.max_time < context.from_:
            return False
        return not (context.to and partition.min_time >= context.to)

    return [partition for partition in partitions if in_window(partition)]


def introspect_sort_keys(context: PlannerContext) -> list[SortKey]:
    table_rows = context.query(
        "SELECT sorting_key FROM system.tables "
        f"WHERE database = '{context.database}' AND name = '{context.table}'",
        None,
    )

    sorting_key = str(table_rows[0].get("sorting_key") or "") if table_rows else ""
    if not sorting_key:
        return []

    expressions = _split_top_level_csv(sorting_key)
    if not expressions:
        return []

    column_rows = context.query(
        "SELECT name, type FROM system.columns "
        f"WHERE database = '{context.database}' AND table = '{context.table}'",
        None,
    )

    type_by_name: dict[str, str] = {}
    for row in column_rows:
        name = row.get("name")
        if name:
            type_by_name[str(name)] = str(row.get("type", ""))

    known_columns = set(type_by_name.keys())

    sort_keys: list[SortKey] = []
    for index, expression in enumerate(expressions):
        column = _resolve_sort_key_column(expression, known_columns)
        type_: str | None = None
        if column is not None:
            type_ = type_by_name.get(column)
            if type_ is None and index < len(column_rows):
                fallback = column_rows[index].get("type")
                type_ = str(fallback) if fallback is not None else None
            if type_ is None and column_rows:
                first_fallback = column_rows[0].get("type")
                type_ = str(first_fallback) if first_fallback is not None else None
        # TS `if (!column || !type) return []` — empty string is falsy too.
        if not column or not type_:
            continue

        category = _classify_sort_key_type(type_)
        sort_keys.append(
            SortKey(
                name=column,
                type=type_,
                category=category,
                boundary_encoding=_boundary_encoding_for_category(category),
            )
        )

    return sort_keys


__all__ = ["introspect_partitions", "introspect_sort_keys"]
