"""Canonicalize SQL fragments through ClickHouse's own formatter.

Port of ``packages/clickhouse/src/canonicalize.ts`` (#195).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from chkit.core.sql_lexer import is_trivia, js_regex, js_trim, tokenize_sql

# Keep each batched query well under ClickHouse's default max_query_size
# (262144 bytes) so a large schema doesn't overflow a single query — which would
# throw and silently drop the whole run back to string comparison.
MAX_BATCH_LITERAL_BYTES = 128_000

_SELECT_PREFIX_RE = re.compile(js_regex(r"^SELECT\s+(.+)$"), re.IGNORECASE | re.DOTALL)


def normalize_function_name_case(sql: str) -> str:
    """Lowercase the name of every function call in a SQL fragment.

    ClickHouse resolves case-insensitive function names to their registered
    case when it stores a query (``FLOOR(...)`` comes back as ``floor(...)``),
    but its formatter keeps the written case — so a view whose schema says
    ``FLOOR`` drifts on the stored ``floor`` (#729). Only an identifier
    followed by ``(`` is a call; strings, quoted identifiers, comments and
    plain names keep their case.
    """
    tokens = tokenize_sql(sql)
    out: list[str] = []
    for i, token in enumerate(tokens):
        if token.kind == "identifier":
            nxt = i + 1
            while nxt < len(tokens) and is_trivia(tokens[nxt]):
                nxt += 1
            if nxt < len(tokens) and tokens[nxt].text == "(":
                out.append(token.text.lower())
                continue
        out.append(token.text)
    return "".join(out)


def canonicalize_sql_fragments(
    client: Any, fragments: Sequence[str], *, wrap: bool
) -> dict[str, str]:
    """Map each fragment to the exact form ClickHouse stores it in.

    The server rewrites expressions on the way in — spacing, operator
    precedence parens, ``INTERVAL n UNIT`` -> ``toIntervalUnit(n)`` — which no
    local string normalizer can reproduce. Function-call names are lowercased
    afterwards, since the server canonicalizes their case on write but the
    formatter does not (#729).

    ``wrap`` distinguishes a scalar expression (wrapped as ``SELECT <expr>``,
    prefix stripped back off) from a full ``SELECT`` query (formatted as-is).
    Formatting is batched through ``formatQuerySingleLineOrNull``, which yields
    NULL for a fragment it can't parse rather than failing the whole batch;
    those fragments have no entry, so the caller falls back to string
    comparison. So does a result that is not valid UTF-8 (a literal such as
    ``'\\xff'``): its bytes would decode to U+FFFD, and two different literals
    would match.
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
            "SELECT arrayMap(f -> if(isValidUTF8(f), f, NULL), "
            f"arrayMap(fragment -> {format_call}, [{array_literal}])) AS formatted"
        ).rows
        formatted: list[str | None] = list(rows[0]["formatted"]) if rows else []
        for raw, value in zip(batch, formatted, strict=False):
            if value is None:
                continue
            canonical = _strip_select_prefix(value) if wrap else js_trim(value)
            if canonical:
                result[raw] = normalize_function_name_case(canonical)
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
