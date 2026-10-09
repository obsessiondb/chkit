"""Backfill logging helpers.

Port of ``packages/plugin-backfill/src/logging.ts``. TS uses ``@logtape/logtape``
with category arrays; Python uses stdlib :mod:`logging` with dotted logger
names under ``chkit.backfill`` (the CLI's logging setup configures the
``chkit`` root). The SQL summarisation helpers are 1:1.
"""

from __future__ import annotations

import logging
import re

CHKIT_LOGGER_CATEGORY = ("chkit",)
CHKIT_BACKFILL_LOGGER_CATEGORY = (*CHKIT_LOGGER_CATEGORY, "backfill")
SLOW_CLICKHOUSE_QUERY_MS = 5000
SLOW_CLICKHOUSE_QUERY_REPEAT_INITIAL_MS = 5000
SLOW_CLICKHOUSE_QUERY_REPEAT_MAX_MS = 30000

_SUMMARY_MAX_LENGTH = 240


def get_backfill_logger(*segments: str) -> logging.Logger:
    return logging.getLogger(
        ".".join((*CHKIT_BACKFILL_LOGGER_CATEGORY, *segments))
    )


def format_bytes(bytes_: float) -> str:
    if bytes_ >= 1024**4:
        return f"{bytes_ / 1024**4:.1f} TiB"
    if bytes_ >= 1024**3:
        return f"{bytes_ / 1024**3:.1f} GiB"
    if bytes_ >= 1024**2:
        return f"{bytes_ / 1024**2:.1f} MiB"
    if bytes_ >= 1024:  # noqa: PLR2004 — KiB threshold
        return f"{bytes_ / 1024:.1f} KiB"
    return f"{_format_byte_count(bytes_)} B"


def _format_byte_count(bytes_: float) -> str:
    """TS interpolates the raw number — render integral floats without `.0`."""
    if bytes_ == int(bytes_):
        return str(int(bytes_))
    return str(bytes_)


def summarize_sql(sql: str, max_length: int = _SUMMARY_MAX_LENGTH) -> str:
    normalized = _normalize_sql(sql)
    if len(normalized) <= max_length:
        return normalized
    return f"{normalized[: max_length - 3]}..."


_PREFIX_DISTRIBUTION_RE = re.compile(
    r"^SELECT substring\((\w+), 1, \d+\) AS prefix, count\(\) AS cnt "
)
_TEMPORAL_DISTRIBUTION_RE = re.compile(
    r"^SELECT formatDateTime\(toStartOf(Day|Hour)\((\w+)\)"
)
_MIN_MAX_PROBE_RE = re.compile(
    r"^SELECT toString\(min\((\w+)\)\) AS minVal, toString\(max\(\1\)\) AS maxVal "
)
_PARTITION_CONTEXT_RE = re.compile(r"_partition_id = '([^']+)'")


def describe_sql_operation(sql: str) -> str:  # noqa: PLR0911 — pattern table
    normalized = _normalize_sql(sql)

    prefix_distribution = _PREFIX_DISTRIBUTION_RE.match(normalized)
    if prefix_distribution is not None:
        return f"prefix distribution on {prefix_distribution.group(1)}"

    temporal_distribution = _TEMPORAL_DISTRIBUTION_RE.match(normalized)
    if temporal_distribution is not None:
        grain = temporal_distribution.group(1).lower()
        return f"{grain} distribution on {temporal_distribution.group(2)}"

    min_max_probe = _MIN_MAX_PROBE_RE.match(normalized)
    if min_max_probe is not None:
        return f"range probe on {min_max_probe.group(1)}"

    if normalized.startswith("SELECT count() AS cnt FROM "):
        return "row count probe"
    if normalized.startswith("SELECT sorting_key FROM system.tables"):
        return "sort key introspection"
    if normalized.startswith("SELECT name, type FROM system.columns"):
        return "column introspection"
    if normalized.startswith("SELECT partition_id,"):
        return "partition introspection"
    if normalized.startswith("SELECT 1 FROM "):
        return "table existence probe"

    return summarize_sql(normalized, 100)


def describe_sql_context(sql: str) -> str | None:
    normalized = _normalize_sql(sql)
    match = _PARTITION_CONTEXT_RE.search(normalized)
    if match is not None:
        return f"partition {match.group(1)}"
    return None


_WS_RE = re.compile(r"\s+")


def _normalize_sql(sql: str) -> str:
    return _WS_RE.sub(" ", sql).strip()


__all__ = [
    "CHKIT_BACKFILL_LOGGER_CATEGORY",
    "CHKIT_LOGGER_CATEGORY",
    "SLOW_CLICKHOUSE_QUERY_MS",
    "SLOW_CLICKHOUSE_QUERY_REPEAT_INITIAL_MS",
    "SLOW_CLICKHOUSE_QUERY_REPEAT_MAX_MS",
    "describe_sql_context",
    "describe_sql_operation",
    "format_bytes",
    "get_backfill_logger",
    "summarize_sql",
]
