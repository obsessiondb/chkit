"""Canonicalize SQL fragments through ClickHouse's own formatter.

Port of ``packages/clickhouse/src/canonicalize.ts`` (#195).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, TypedDict

from chkit.core.sql_lexer import is_trivia, js_regex, js_trim, tokenize_sql

from .sql_udf import SQLUDF, expand_sql_udfs, parse_sql_udf

# Keep each batched query well under ClickHouse's default max_query_size
# (262144 bytes) so a large schema doesn't overflow a single query — which would
# throw and silently drop the whole run back to string comparison.
MAX_BATCH_LITERAL_BYTES = 128_000

_SELECT_LIST_PREFIX_RE = re.compile(js_regex(r"^SELECT\s+0,\s*(.+)$"), re.IGNORECASE | re.DOTALL)
_SELECT_PREFIX_RE = re.compile(js_regex(r"^SELECT\s+(.+)$"), re.IGNORECASE | re.DOTALL)


class FunctionRegistry(TypedDict):
    """Case-resolution rules for function names, from ``system.functions``.

    ``exact`` maps every registered name to its canonical form (``alias_to``
    when set, else the name itself); ``insensitive`` does the same keyed by
    lowercased name, but only for names ClickHouse resolves case-insensitively.
    """

    sql_udfs: dict[str, SQLUDF]
    exact: dict[str, str]
    insensitive: dict[str, str]


def build_function_registry(rows: Sequence[Mapping[str, Any]]) -> FunctionRegistry:
    sql_udfs: dict[str, SQLUDF] = {}
    exact: dict[str, str] = {}
    insensitive: dict[str, str] = {}
    for row in rows:
        name = str(row["name"])
        definition = parse_sql_udf(str(row.get("create_query") or ""))
        if definition is not None:
            sql_udfs[name] = definition
        canonical = str(row["alias_to"]) or name
        exact[name] = canonical
        if row["case_insensitive"]:
            insensitive[name.lower()] = canonical
    return {"exact": exact, "insensitive": insensitive, "sql_udfs": sql_udfs}


def _load_function_registry(client: Any, on_unavailable: Any = None) -> FunctionRegistry:
    """Load the server's function-name resolution rules once for a run.

    A view written with ``FLOOR`` or ``LCASE`` is stored as ``floor`` /
    ``lower``, while user-defined (case-sensitive) functions stay as written —
    only ``system.functions`` tells the two apart (#729 review). If the
    registry cannot be read, names are left as written: no normalization is
    safer than lowercasing case-sensitive names.
    """
    try:
        rows = client.query(
            "SELECT name, case_insensitive, alias_to, "
            "if(isValidUTF8(create_query), create_query, '') AS create_query FROM system.functions"
        ).rows
    except Exception as error:
        if on_unavailable is not None:
            on_unavailable(error)
        rows = []
    return build_function_registry(rows)


def normalize_function_names(sql: str, registry: FunctionRegistry) -> str:
    """Resolve function-call names the way ClickHouse does on write (#729).

    A registered name rewrites to its canonical form (``CEILING`` -> ``ceil``,
    ``LCASE`` -> ``lower``); an unregistered or case-sensitive name keeps its
    written form — so ``rv_f`` and ``RV_f`` still compare different, and drift
    output keeps readable case (``toUnixTimestamp``). Only an identifier
    followed by ``(`` is a call, and only when it is not qualified by a dot:
    ``analytics.FLOOR`` names a parameterized view, and ClickHouse normalizes
    the whole compound name, not its last part — leaving it as written keeps
    two differently-cased views distinct. Strings, quoted identifiers,
    comments and plain names keep their case.
    """
    tokens = tokenize_sql(sql)
    out: list[str] = []
    for i, token in enumerate(tokens):
        if token.kind == "identifier":
            prv = i - 1
            while prv >= 0 and is_trivia(tokens[prv]):
                prv -= 1
            nxt = i + 1
            while nxt < len(tokens) and is_trivia(tokens[nxt]):
                nxt += 1
            qualified = prv >= 0 and tokens[prv].text == "."
            if not qualified and nxt < len(tokens) and tokens[nxt].text == "(":
                text = token.text
                out.append(
                    registry["exact"].get(text) or registry["insensitive"].get(text.lower()) or text
                )
                continue
        out.append(token.text)
    return "".join(out)


def canonicalize_sql_fragments(
    client: Any,
    fragments: Sequence[str],
    *,
    wrap: bool,
    stored_query_pairs: Sequence[tuple[str, str]] = (),
    on_registry_unavailable: Any = None,
) -> dict[str, str]:
    """Map each fragment to the exact form ClickHouse stores it in.

    The server rewrites expressions on the way in — spacing, operator
    precedence parens, ``INTERVAL n UNIT`` -> ``toIntervalUnit(n)`` — which no
    local string normalizer can reproduce. Function-call names are then
    resolved through the server's ``system.functions`` registry, since the
    server canonicalizes their case and aliases on write but the formatter
    does not (#729).

    ``stored_query_pairs`` additionally analyzes differing view queries through
    the server storage rewrite path; unavailable analysis retains both forms.

    ``wrap`` distinguishes a scalar expression (wrapped as ``SELECT 0, <expr>``,
    prefix stripped back off; after ``0,`` a leading ``all`` or ``distinct``
    column is not read as the SELECT modifier) from a full ``SELECT`` query
    (formatted as-is). A scalar that does not parse there (a bare ``from``
    column) is retried as ``SELECT <expr>``.
    Formatting is batched through ``formatQuerySingleLineOrNull``, which yields
    NULL for a fragment it can't parse rather than failing the whole batch;
    those fragments have no entry, so the caller falls back to string
    comparison. So does a result that is not valid UTF-8 (a literal such as
    ``'\\xff'``): its bytes would decode to U+FFFD, and two different literals
    would match.
    """
    unique = list(dict.fromkeys(t for t in (js_trim(f) for f in fragments) if t))
    if not unique:
        return {}

    registry = _load_function_registry(client, on_registry_unavailable)
    if not wrap:
        result = _format_fragments(
            client, unique, "formatQuerySingleLineOrNull(fragment)", None, registry
        )
        _normalize_stored_query_pairs(client, stored_query_pairs, result, registry)
        return result

    result = _format_fragments(
        client,
        unique,
        "formatQuerySingleLineOrNull('SELECT 0, ' || fragment)",
        _SELECT_LIST_PREFIX_RE,
        registry,
    )
    rest = [
        fragment
        for fragment in unique
        if fragment not in result and not _starts_with_select_modifier(fragment)
    ]
    result.update(
        _format_fragments(
            client,
            rest,
            "formatQuerySingleLineOrNull('SELECT ' || fragment)",
            _SELECT_PREFIX_RE,
            registry,
        )
    )
    return result


def _starts_with_select_modifier(fragment: str) -> bool:
    # Right after a bare SELECT, a leading ``all`` or ``distinct`` reads as the
    # modifier (``SELECT all from`` formats as ``SELECT from``), so such a
    # fragment is not retried there and falls back to text comparison.
    first = next((token for token in tokenize_sql(fragment) if not is_trivia(token)), None)
    return (
        first is not None
        and first.kind == "identifier"
        and first.text.lower() in ("all", "distinct")
    )


def _format_fragments(
    client: Any,
    unique: Sequence[str],
    format_call: str,
    prefix: re.Pattern[str] | None,
    registry: FunctionRegistry,
) -> dict[str, str]:
    result: dict[str, str] = {}
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
            canonical = js_trim(value) if prefix is None else _strip_prefix(value, prefix)
            if canonical:
                result[raw] = normalize_function_names(canonical, registry)
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


def _strip_prefix(formatted: str, prefix: re.Pattern[str]) -> str | None:
    match = prefix.match(formatted)
    return js_trim(match.group(1)) if match else None


def _normalize_stored_query_pairs(
    client: Any,
    pairs: Sequence[tuple[str, str]],
    result: dict[str, str],
    registry: FunctionRegistry,
) -> None:
    # Normalize by initial formatted value, so shared view queries cannot
    # receive different rewrites depending on their pair's position.
    original = dict(result)
    candidates: dict[str, str] = {}
    for pair in pairs:
        for query in pair:
            canonical = original.get(js_trim(query))
            if not canonical or canonical in candidates:
                continue
            expanded = expand_sql_udfs(canonical, registry["sql_udfs"])
            if expanded is not None and (expanded != canonical or _has_with_clause(canonical)):
                candidates[canonical] = expanded
    if not candidates:
        return
    try:
        formatted = _format_fragments(
            client, list(dict.fromkeys(candidates.values())),
            "formatQuerySingleLineOrNull(fragment)", None, registry
        )
        normalized: dict[str, str] = {}
        for canonical, expanded in candidates.items():
            value = formatted.get(expanded)
            if value:
                normalized[canonical] = value
        explained = _explain_with_queries(client, normalized.values())
        syntax = _format_fragments(
            client, list(dict.fromkeys(explained.values())),
            "formatQuerySingleLineOrNull(fragment)", None, registry
        )
        for canonical, value in normalized.items():
            explanation = explained.get(value)
            if explanation:
                normalized[canonical] = syntax.get(explanation, value)
        for raw, canonical in original.items():
            if canonical in normalized:
                result[raw] = normalized[canonical]
    except Exception:
        pass  # Keep the initial formatter results if the server cannot reformat.


def _explain_with_queries(client: Any, queries: Iterable[str]) -> dict[str, str]:
    explained: dict[str, str] = {}
    for query in queries:
        if not _has_with_clause(query) or query in explained:
            continue
        try:
            rows = client.query("EXPLAIN SYNTAX oneline=1 " + query).rows
            text = js_trim("\n".join(str(row["explain"]) for row in rows))
            if text and "\ufffd" not in text:
                explained[query] = text
        except Exception:
            pass  # Retain valid scalar expansion when analysis is unavailable.
    return explained


def _has_with_clause(sql: str) -> bool:
    return any(
        token.kind == "identifier" and token.text.upper() == "WITH"
        for token in tokenize_sql(sql)
    )
