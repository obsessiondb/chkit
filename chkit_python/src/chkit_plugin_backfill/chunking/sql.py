"""Chunk-execution SQL builder + shared SQL scanner.

1:1 port of ``chunking/sql.ts`` (post-refactor ``9ad23f9``): the
quote/paren-skipping scan lives in one primitive (:func:`_scan_sql_tokens`)
shared by top-level keyword detection and top-level delimiter splitting.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from chkit_plugin_backfill.chunking.types import (
    Chunk,
    ChunkRange,
    EstimateFilter,
    PlannerContext,
    RowProbeStrategy,
    SortKey,
    SortKeyCategory,
    TableProfile,
)
from chkit_plugin_backfill.chunking.utils.binary_string import latin1_bytes

# Top-level clause keywords, in the order they may legally follow a
# projection. `inject_where_condition` uses this both to detect an existing
# `WHERE` and to find the first trailing clause a new condition must be
# inserted before.
_TRAILING_CLAUSE_KEYWORDS = (
    "WHERE",
    "GROUP BY",
    "HAVING",
    "ORDER BY",
    "QUALIFY",
    "LIMIT",
    "SETTINGS",
)

_JS_WS_CLASS = (
    "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a"
    "\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
)
_JS_WS_RE = re.compile(f"[{_JS_WS_CLASS}]")


def _is_js_space(char: str) -> bool:
    return _JS_WS_RE.match(char) is not None


def _js_trim_end(value: str) -> str:
    end = len(value)
    while end > 0 and _is_js_space(value[end - 1]):
        end -= 1
    return value[:end]


def _js_trim(value: str) -> str:
    start = 0
    while start < len(value) and _is_js_space(value[start]):
        start += 1
    return _js_trim_end(value[start:])


# ── Chunk execution SQL ──────────────────────────────────────────────────────


def build_chunk_execution_sql(
    *,
    plan_id: str,
    chunk: Chunk,
    target: str,
    table: TableProfile,
    source_target: str | None = None,
    mv_replay_queries: list[str] | None = None,
    target_columns: list[str] | None = None,
    idempotency_token: str | None = None,
) -> str:
    resolved_source = source_target if source_target is not None else target
    token = idempotency_token if idempotency_token is not None else ""
    header = f"/* chkit backfill plan={plan_id} chunk={chunk.id} token={token} */"
    settings = _build_settings_clause(token)
    chunk_conditions = _build_chunk_conditions(chunk, table.sort_keys)

    if mv_replay_queries:
        # Each MV feeding the target becomes a filtered SELECT; UNION ALL replays
        # them in one INSERT so a single query_id and dedup token cover the chunk.
        selects: list[str] = []
        for query in mv_replay_queries:
            filtered = _inject_partition_filter(query, chunk.partition_id)
            for condition in chunk_conditions:
                filtered = _inject_where_condition(filtered, condition)
            if target_columns:
                filtered = rewrite_select_columns(filtered, target_columns)
            selects.append(filtered)
        return "\n".join(
            [header, f"INSERT INTO {target}", "\nUNION ALL\n".join(selects), settings]
        )

    lines = [
        header,
        f"INSERT INTO {target}",
        "SELECT *",
        f"FROM {resolved_source}",
        f"WHERE _partition_id = {_quote_sql_string(chunk.partition_id)}",
    ]

    lines.extend(f"  AND {condition}" for condition in chunk_conditions)

    lines.append(settings)
    return "\n".join(lines)


# ── WHERE-clause builders ────────────────────────────────────────────────────


def build_where_clause_from_ranges(
    partition_id: str,
    ranges: list[ChunkRange],
    sort_keys: list[SortKey],
) -> str:
    conditions = [f"_partition_id = {_quote_sql_string(partition_id)}"]

    for range_ in ranges:
        sort_key = _sort_key_at(sort_keys, range_.dimension_index)
        if sort_key is None:
            continue
        conditions.extend(_build_range_bound_conditions(range_, sort_key))

    return "\n  AND ".join(conditions)


def build_where_clause_from_chunk(chunk: Chunk, table: TableProfile) -> str:
    return build_where_clause_from_ranges(
        chunk.partition_id, chunk.ranges, table.sort_keys
    )


def build_estimate_sql(
    filter_: EstimateFilter,
    sort_keys: list[SortKey],
    context: PlannerContext,
    row_probe_strategy: RowProbeStrategy,
) -> str:
    where_clause = _build_where_clause_from_filter(filter_, sort_keys)
    if row_probe_strategy == "count":
        return (
            f"SELECT count() AS cnt FROM {context.database}.{context.table} "
            f"WHERE {where_clause}"
        )
    return (
        f"EXPLAIN ESTIMATE SELECT count() FROM {context.database}.{context.table} "
        f"WHERE {where_clause}"
    )


def build_count_sql(
    filter_: EstimateFilter,
    sort_keys: list[SortKey],
    *,
    database: str,
    table: str,
) -> str:
    where_clause = _build_where_clause_from_filter(filter_, sort_keys)
    return f"SELECT count() AS cnt FROM {database}.{table} WHERE {where_clause}"


# ── Materialized-view query rewriting ────────────────────────────────────────


def rewrite_select_columns(query: str, target_columns: list[str]) -> str:
    """Reorder a materialized-view ``SELECT ... FROM ...`` projection to match
    the target table's column order. Projection items are matched to target
    columns by their alias (``expr AS alias``); unmatched target columns fall
    through as bare column references. Returns the query untouched when no
    top-level ``SELECT``/``FROM`` pair is found (e.g. a non-SELECT statement).
    """
    trimmed = _js_trim_end(query)

    bounds = _find_select_projection_bounds(trimmed)
    if bounds is None:
        return query
    select_pos, from_pos = bounds

    projection_start = select_pos + len("SELECT")
    raw_projection = _js_trim(trimmed[projection_start:from_pos])
    prefix, projection = _split_projection_prefix(raw_projection)

    items = [_js_trim(item) for item in split_top_level(projection, ",")]
    alias_map = _build_alias_map(items)

    rewritten = [alias_map.get(column, column) for column in target_columns]
    return (
        f"{trimmed[:projection_start]} {prefix}{', '.join(rewritten)}"
        f"\n{trimmed[from_pos:]}"
    )


def extract_source_table_ref(query: str) -> dict[str, str] | None:
    """Extract the primary source table an mv_replay backfill must chunk
    against — the table read by the first top-level ``FROM`` in a materialized
    view's ``SELECT``. Chunk conditions (``_partition_id``, sort-key ranges)
    are injected into that SELECT and run against this source, so its physical
    metadata is what sizing must introspect, not the (legitimately empty)
    target.

    Handles ``db.table``, bare ``table``, and backtick-quoted identifiers,
    ignoring a trailing alias or clause. Returns ``None`` when the ``FROM``
    target is a subquery, a table function, or otherwise not a plain table
    reference — the caller decides how to treat an unresolvable source.
    """
    from_hit = next(
        (hit for hit in find_top_level_keywords(query, ["FROM"]) if hit[0] == "FROM"),
        None,
    )
    if from_hit is None:
        return None

    token = _read_first_table_token(query[from_hit[1] + len("FROM") :])
    if token is None:
        return None

    return _parse_table_identifier(token)


def _read_first_table_token(text: str) -> str | None:
    """Read the identifier immediately following ``FROM``. Stops at the first
    whitespace, comma, or closing paren (an alias or trailing clause). Returns
    ``None`` for a subquery (``FROM (…)``) or table function (``name(…)``),
    which are not plain table references.
    """
    index = 0
    while index < len(text) and _is_js_space(text[index]):
        index += 1
    if index >= len(text) or text[index] == "(":
        return None

    token = ""
    in_backtick = False
    while index < len(text):
        char = text[index]
        if char == "`":
            in_backtick = not in_backtick
            token += char
            index += 1
            continue
        if in_backtick:
            token += char
            index += 1
            continue
        if char == "(":
            return None  # table function, e.g. numbers(10)
        if _is_js_space(char) or char in {",", ")"}:
            break
        token += char
        index += 1

    return token if len(token) > 0 else None


def _parse_table_identifier(ref: str) -> dict[str, str] | None:
    """Split a possibly-qualified, possibly-backticked identifier into db/table."""
    segments: list[str] = []
    current = ""
    in_backtick = False
    for char in ref:
        if char == "`":
            in_backtick = not in_backtick
            continue
        if char == "." and not in_backtick:
            segments.append(current)
            current = ""
            continue
        current += char
    segments.append(current)

    if len(segments) == 1:
        table = segments[0]
        return {"table": table} if table else None
    if len(segments) == 2:  # noqa: PLR2004 — db.table
        database, table = segments
        return {"database": database, "table": table} if database and table else None
    return None  # db.schema.table or malformed — unsupported


def inject_sort_key_filter(
    query: str,
    sort_key_column: str,
    category: SortKeyCategory,
    from_: str,
    to: str,
) -> str:
    if category == "datetime":
        condition = (
            f"{sort_key_column} >= parseDateTimeBestEffort({_quote_sql_string(from_)})\n"
            f"  AND {sort_key_column} < parseDateTimeBestEffort({_quote_sql_string(to)})"
        )
    elif category == "string":
        condition = (
            f"{sort_key_column} >= unhex('{latin1_bytes(from_).hex()}')\n"
            f"  AND {sort_key_column} < unhex('{latin1_bytes(to).hex()}')"
        )
    else:
        condition = (
            f"{sort_key_column} >= {_quote_sql_string(from_)}\n"
            f"  AND {sort_key_column} < {_quote_sql_string(to)}"
        )

    return _inject_where_condition(query, condition)


def _find_select_projection_bounds(sql: str) -> tuple[int, int] | None:
    """Locate the top-level ``SELECT`` and the first top-level ``FROM`` after it."""
    hits = find_top_level_keywords(sql, ["SELECT", "FROM"])

    select_pos = next((hit[1] for hit in hits if hit[0] == "SELECT"), -1)
    if select_pos == -1:
        return None

    from_pos = next(
        (hit[1] for hit in hits if hit[0] == "FROM" and hit[1] > select_pos), -1
    )
    if from_pos == -1:
        return None

    return select_pos, from_pos


# JS `/^DISTINCT\b\s*/i`: `\b` is an ASCII word boundary and `\s` is the JS
# whitespace class — Python's `\b`/`\s` differ (Unicode word chars; U+0085 in,
# U+FEFF out), so both are spelled out explicitly.
_DISTINCT_RE = re.compile(
    f"^DISTINCT(?![0-9A-Za-z_])[{_JS_WS_CLASS}]*", re.IGNORECASE
)


def _split_projection_prefix(raw_projection: str) -> tuple[str, str]:
    """Peel a leading ``DISTINCT`` off a projection so it survives the rewrite."""
    distinct_match = _DISTINCT_RE.match(raw_projection)
    if distinct_match is None:
        return "", raw_projection

    prefix = distinct_match.group(0)
    return prefix, _js_trim(raw_projection[len(prefix) :])


def _build_alias_map(items: list[str]) -> dict[str, str]:
    """Map each aliased projection item (``expr AS alias``) to its full source text."""
    alias_map: dict[str, str] = {}

    for item in items:
        if item == "*":
            continue
        alias = _find_column_alias(item)
        if alias is not None:
            alias_map[alias] = item

    return alias_map


def _find_column_alias(item: str) -> str | None:
    """Return the alias of a projection item, i.e. the text after its last
    top-level ``AS``."""
    hits = find_top_level_keywords(item, ["AS"])
    if not hits:
        return None
    as_hit = hits[-1]
    return _js_trim(item[as_hit[1] + len("AS") :])


def _inject_partition_filter(query: str, partition_id: str) -> str:
    return _inject_where_condition(
        query, f"_partition_id = {_quote_sql_string(partition_id)}"
    )


def _inject_where_condition(query: str, condition: str) -> str:
    """Insert ``condition`` into ``query``'s WHERE clause, appending with
    ``AND`` when a top-level ``WHERE`` already exists and inserting a fresh
    ``WHERE`` otherwise. The condition is placed before the first trailing
    clause (GROUP BY, ORDER BY, …) so it always lands inside the WHERE.
    """
    trimmed = _js_trim_end(query)
    hits = find_top_level_keywords(trimmed, _TRAILING_CLAUSE_KEYWORDS)

    where_hit = next((hit for hit in hits if hit[0] == "WHERE"), None)
    trailing = [
        hit
        for hit in hits
        if hit[0] != "WHERE" and (where_hit is None or hit[1] > where_hit[1])
    ]
    first_trailing = trailing[0] if trailing else None

    insert_at = first_trailing[1] if first_trailing is not None else len(trimmed)
    before = _js_trim_end(trimmed[:insert_at])
    after = trimmed[insert_at:]

    if where_hit is not None:
        return f"{before}\n  AND {condition}" + (f"\n{after}" if after else "")

    return f"{before}\nWHERE {condition}" + (f"\n{after}" if after else "")


# ── SQL string scanner (shared low-level) ────────────────────────────────────
#
# `find_top_level_keywords` and `split_top_level` are exported for direct unit
# testing of the quote/paren-skipping scan they share. They are intentionally
# NOT re-exported through the package entry point (`sdk.py`) — the package's
# public API is unchanged.

KeywordHit = tuple[str, int]


def _scan_sql_tokens(
    sql: str,
    visit: Callable[[str, int, int], None],
) -> None:
    """Walk ``sql`` character by character, tracking parenthesis depth and
    skipping single-quoted string literals (with backslash escapes). ``visit``
    is invoked for every character that lies outside a string literal and is
    not a parenthesis, receiving the current paren depth.

    This is the one primitive behind every SQL-structure scan in this module:
    top-level keyword detection and top-level delimiter splitting both build on
    it so the quote/paren bookkeeping lives in exactly one place.
    """
    depth = 0
    index = 0

    while index < len(sql):
        char = sql[index]
        if char == "(":
            depth += 1
            index += 1
            continue
        if char == ")":
            depth -= 1
            index += 1
            continue
        if char == "'":
            index += 1
            while index < len(sql) and sql[index] != "'":
                if sql[index] == "\\":
                    index += 1
                index += 1
            index += 1
            continue
        visit(char, index, depth)
        index += 1


def find_top_level_keywords(
    sql: str, keywords: tuple[str, ...] | list[str]
) -> list[KeywordHit]:
    """Find each occurrence of ``keywords`` that starts at the top level (paren
    depth 0), on a word boundary (preceded by whitespace or start-of-string and
    followed by whitespace or end-of-string). Matching is case-insensitive;
    hits are returned in ascending position order.
    """
    upper = sql.upper()
    hits: list[KeywordHit] = []

    def visit(_char: str, index: int, depth: int) -> None:
        if depth != 0:
            return
        if index > 0 and not _is_js_space(sql[index - 1]):
            return

        keyword = next(
            (
                candidate
                for candidate in keywords
                if _keyword_starts_at(sql, upper, index, candidate)
            ),
            None,
        )
        if keyword is not None:
            hits.append((keyword, index))

    _scan_sql_tokens(sql, visit)

    return hits


def _keyword_starts_at(sql: str, upper: str, index: int, keyword: str) -> bool:
    """Whether ``keyword`` starts at ``index`` on a trailing word boundary
    (case-insensitive)."""
    if not upper.startswith(keyword, index):
        return False
    after = index + len(keyword)
    return after >= len(sql) or _is_js_space(sql[after])


def split_top_level(sql: str, delimiter: str) -> list[str]:
    """Split ``sql`` on every top-level (paren depth 0) occurrence of
    ``delimiter``."""
    segments: list[str] = []
    state = {"start": 0}

    def visit(char: str, index: int, depth: int) -> None:
        if depth == 0 and char == delimiter:
            segments.append(sql[state["start"] : index])
            state["start"] = index + 1

    _scan_sql_tokens(sql, visit)
    segments.append(sql[state["start"] :])

    return segments


# ── Value formatting & condition helpers ─────────────────────────────────────


def _quote_sql_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def _format_bound(value: str, sort_key: SortKey) -> str:
    if sort_key.category == "datetime":
        return f"parseDateTimeBestEffort({_quote_sql_string(value)})"

    if sort_key.category == "string":
        return f"unhex('{latin1_bytes(value).hex()}')"

    return _quote_sql_string(value)


def _build_range_bound_conditions(range_: ChunkRange, sort_key: SortKey) -> list[str]:
    """Build the ``>= from`` / ``< to`` conditions for a single range on
    ``sort_key``."""
    conditions: list[str] = []

    if range_.from_ is not None:
        conditions.append(f"{sort_key.name} >= {_format_bound(range_.from_, sort_key)}")
    if range_.to is not None:
        conditions.append(f"{sort_key.name} < {_format_bound(range_.to, sort_key)}")

    return conditions


def _build_settings_clause(token: str) -> str:
    if token:
        return f"SETTINGS async_insert=0, insert_deduplication_token='{token}'"
    return "SETTINGS async_insert=0"


def _sort_key_at(sort_keys: list[SortKey], index: int) -> SortKey | None:
    if 0 <= index < len(sort_keys):
        return sort_keys[index]
    return None


def _build_chunk_conditions(chunk: Chunk, sort_keys: list[SortKey]) -> list[str]:
    conditions: list[str] = []
    for range_ in chunk.ranges:
        sort_key = _sort_key_at(sort_keys, range_.dimension_index)
        if sort_key is None:
            continue
        conditions.extend(_build_range_bound_conditions(range_, sort_key))
    return conditions


def _build_where_clause_from_filter(
    filter_: EstimateFilter, sort_keys: list[SortKey]
) -> str:
    conditions = [f"_partition_id = {_quote_sql_string(filter_.partition_id)}"]

    for range_ in filter_.ranges:
        sort_key = _sort_key_at(sort_keys, range_.dimension_index)
        if sort_key is None:
            continue

        if (
            filter_.exact_dimension_index == range_.dimension_index
            and filter_.exact_value is not None
        ):
            conditions.append(
                f"{sort_key.name} = {_format_bound(filter_.exact_value, sort_key)}"
            )
            continue

        conditions.extend(_build_range_bound_conditions(range_, sort_key))

    return " AND ".join(conditions)


__all__ = [
    "build_chunk_execution_sql",
    "build_count_sql",
    "build_estimate_sql",
    "build_where_clause_from_chunk",
    "build_where_clause_from_ranges",
    "extract_source_table_ref",
    "find_top_level_keywords",
    "inject_sort_key_filter",
    "rewrite_select_columns",
    "split_top_level",
]
