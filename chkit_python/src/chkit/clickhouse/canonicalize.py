"""Canonicalize SQL fragments through ClickHouse's own formatter.

Port of ``packages/clickhouse/src/canonicalize.ts`` (#195).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from chkit.core.sql_lexer import js_trim

# Keep each batched query well under ClickHouse's default max_query_size
# (262144 bytes) so a large schema doesn't overflow a single query — which would
# throw and silently drop the whole run back to string comparison.
MAX_BATCH_LITERAL_BYTES = 128_000

_SELECT_PREFIX_RE = re.compile(r"^SELECT\s+(.+)$", re.IGNORECASE | re.DOTALL)


def canonicalize_sql_fragments(
    client: Any, fragments: Sequence[str], *, wrap: bool
) -> dict[str, str]:
    """Map each fragment to the exact form ClickHouse stores it in.

    The server rewrites expressions on the way in — spacing, operator
    precedence parens, ``INTERVAL n UNIT`` -> ``toIntervalUnit(n)`` — which no
    local string normalizer can reproduce.

    ``wrap`` distinguishes a scalar expression (wrapped as ``SELECT <expr>``,
    prefix stripped back off) from a full ``SELECT`` query (formatted as-is).
    Formatting is batched through ``formatQuerySingleLineOrNull``, which yields
    NULL for a fragment it can't parse rather than failing the whole batch;
    those fragments have no entry, so the caller falls back to string
    comparison.
    """
    result: dict[str, str] = {}
    unique = list(dict.fromkeys(t for t in (js_trim(f) for f in fragments) if t))
    if not unique:
        return result

    format_call = (
        "formatQuerySingleLineOrNull('SELECT ' || fragment)"
        if wrap
        else "formatQuerySingleLineOrNull(fragment)"
    )

    for batch in _batch_fragments(unique):
        array_literal = ", ".join(_quote_literal(fragment) for fragment in batch)
        rows = client.query(
            f"SELECT arrayMap(fragment -> {format_call}, [{array_literal}]) AS formatted"
        ).rows
        formatted: list[str | None] = list(rows[0]["formatted"]) if rows else []
        for raw, value in zip(batch, formatted, strict=False):
            if value is None:
                continue
            canonical = _strip_select_prefix(value) if wrap else js_trim(value)
            if canonical:
                result[raw] = canonical
    return result


def _batch_fragments(fragments: Sequence[str]) -> list[list[str]]:
    batches: list[list[str]] = []
    current: list[str] = []
    size = 0
    for fragment in fragments:
        cost = len(_quote_literal(fragment)) + 2  # literal + ", " separator
        if current and size + cost > MAX_BATCH_LITERAL_BYTES:
            batches.append(current)
            current = []
            size = 0
        current.append(fragment)
        size += cost
    if current:
        batches.append(current)
    return batches


def _quote_literal(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("'", "''")
    return f"'{escaped}'"


def _strip_select_prefix(formatted: str) -> str | None:
    match = _SELECT_PREFIX_RE.match(formatted)
    return js_trim(match.group(1)) if match else None
