"""Extract clauses from raw ``CREATE TABLE`` DDL strings.

1:1 port of ``packages/clickhouse/src/create-table-parser.ts``.

Used by ``listTableDetails`` (live ClickHouse introspection) and by
the future ``pull`` plugin to reconstruct a chkit schema from existing
tables. Pure parser — no I/O, no Pydantic models, no side effects.

The implementation matches the TS regex-based approach intentionally
rather than reaching for a full SQL parser: ClickHouse DDL has a
small, stable surface and an actual parser would carry far more
dependencies than the eight clauses we care about.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from chkit.core.key_clause import split_top_level_comma
from chkit.core.projection import normalize_projection_index
from chkit.core.sql_normalizer import normalize_sql_fragment

__all__ = [
    "ProjectionDefinitionShape",
    "parse_engine_from_create_table_query",
    "parse_order_by_from_create_table_query",
    "parse_partition_by_from_create_table_query",
    "parse_primary_key_from_create_table_query",
    "parse_projections_from_create_table_query",
    "parse_settings_from_create_table_query",
    "parse_ttl_from_create_table_query",
    "parse_unique_key_from_create_table_query",
]


@dataclass(frozen=True, slots=True)
class ProjectionDefinitionShape:
    """A SELECT projection (``query``) or an index-only projection (``index``/``type``)."""

    name: str
    query: str | None = None
    index: str | None = None
    type: str | None = None


_SETTINGS_RE = re.compile(r"\bSETTINGS\b(.*?)(?:;|$)", re.IGNORECASE | re.DOTALL)
_TTL_RE = re.compile(r"\bTTL\b(.*?)(?:\bSETTINGS\b|;|$)", re.IGNORECASE | re.DOTALL)
_BODY_ENGINE_RE = re.compile(r"\)\s*ENGINE\s*=", re.IGNORECASE)

_ENGINE_START = re.compile(r"\bENGINE\s*=\s*", re.IGNORECASE)
_ENGINE_STOP = re.compile(
    r"\bPRIMARY\s+KEY\b|\bORDER\s+BY\b|\bPARTITION\s+BY\b|\bUNIQUE\s+KEY\b"
    r"|\bSAMPLE\s+BY\b|\bTTL\b|\bSETTINGS\b|;|$",
    re.IGNORECASE,
)

_PRIMARY_KEY_START = re.compile(r"\bPRIMARY\s+KEY\b", re.IGNORECASE)
_PRIMARY_KEY_STOP = re.compile(
    r"\bORDER\s+BY\b|\bPARTITION\s+BY\b|\bUNIQUE\s+KEY\b|\bSAMPLE\s+BY\b"
    r"|\bTTL\b|\bSETTINGS\b|;|$",
    re.IGNORECASE,
)

_ORDER_BY_START = re.compile(r"\bORDER\s+BY\b", re.IGNORECASE)
_ORDER_BY_STOP = re.compile(
    r"\bPRIMARY\s+KEY\b|\bPARTITION\s+BY\b|\bUNIQUE\s+KEY\b|\bSAMPLE\s+BY\b"
    r"|\bTTL\b|\bSETTINGS\b|;|$",
    re.IGNORECASE,
)

_PARTITION_BY_START = re.compile(r"\bPARTITION\s+BY\b", re.IGNORECASE)
_PARTITION_BY_STOP = re.compile(
    r"\bPRIMARY\s+KEY\b|\bORDER\s+BY\b|\bUNIQUE\s+KEY\b|\bSAMPLE\s+BY\b"
    r"|\bTTL\b|\bSETTINGS\b|;|$",
    re.IGNORECASE,
)

_UNIQUE_KEY_START = re.compile(r"\bUNIQUE\s+KEY\b", re.IGNORECASE)
_UNIQUE_KEY_STOP = re.compile(
    r"\bPRIMARY\s+KEY\b|\bORDER\s+BY\b|\bPARTITION\s+BY\b|\bSAMPLE\s+BY\b"
    r"|\bTTL\b|\bSETTINGS\b|;|$",
    re.IGNORECASE,
)

_PROJECTION_RE = re.compile(
    r"^\s*PROJECTION\s+(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s*\((.*)\)\s*$",
    re.IGNORECASE | re.DOTALL,
)

# Index-only projections have no SELECT body, so they must be matched before
# the parenthesized SELECT form.
_INDEX_PROJECTION_RE = re.compile(
    r"^\s*PROJECTION\s+(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))"
    r"\s+INDEX\s+(.+?)\s+TYPE\s+([A-Za-z_][A-Za-z0-9_]*)\s*$",
    re.IGNORECASE | re.DOTALL,
)


def _parse_clause(
    query: str | None, start_pattern: re.Pattern[str], stop_pattern: re.Pattern[str]
) -> str | None:
    """Slice between ``start_pattern`` and the first ``stop_pattern`` hit."""
    if not query:
        return None
    # Table-level clauses (ENGINE, ORDER BY, PRIMARY KEY, ...) only appear
    # after the column list. Searching the whole query would match a keyword
    # inside the body — e.g. the `ORDER BY` of a projection's SELECT — and
    # swallow the real clause plus everything up to the next stop keyword
    # (issue #190).
    options = _extract_table_options(query)
    start = start_pattern.search(options)
    if start is None:
        return None
    after = options[start.end() :]
    stop = stop_pattern.search(after)
    raw = after[: stop.start()] if stop is not None else after
    raw = raw.strip()
    if not raw:
        return None
    return normalize_sql_fragment(raw)


def _find_column_list_bounds(query: str) -> tuple[int, int] | None:
    """Positions of the parens that open and close the column list.

    The close is the one right before the table-level ``ENGINE =``. Returns
    ``None`` when there is no balanced column list (e.g. a view, or a query we
    can't parse).
    """
    engine_match = _BODY_ENGINE_RE.search(query)
    if engine_match is None:
        return None
    # Up to and including the closing ')' before ENGINE.
    left = query[: engine_match.start() + 1]
    open_index = left.find("(")
    if open_index == -1:
        return None

    depth = 0
    in_string = False
    string_quote = "'"
    for i in range(open_index, len(left)):
        char = left[i]
        if not char:
            continue
        if in_string:
            if char == string_quote and (i == 0 or left[i - 1] != "\\"):
                in_string = False
            continue
        if char in {"'", '"'}:
            in_string = True
            string_quote = char
            continue
        if char == "(":
            depth += 1
            continue
        if char == ")":
            depth -= 1
            if depth == 0:
                return (open_index, i)
    return None


def _extract_create_table_body(query: str | None) -> str | None:
    """Return the body between the opening ``(`` and matching ``)`` before ENGINE."""
    if not query:
        return None
    bounds = _find_column_list_bounds(query)
    if bounds is None:
        return None
    body = query[bounds[0] + 1 : bounds[1]].strip()
    return body or None


def _extract_table_options(query: str) -> str:
    """Everything after the column list: ``ENGINE = ... ORDER BY ...``.

    This is where table-level clauses live. Falls back to the whole query when
    the column list can't be located, preserving behaviour for unparseable
    inputs.
    """
    bounds = _find_column_list_bounds(query)
    return query[bounds[1] + 1 :] if bounds is not None else query


def parse_settings_from_create_table_query(query: str | None) -> dict[str, str]:
    """Extract ``SETTINGS k=v, k=v`` as a dict (last write wins)."""
    if not query:
        return {}
    match = _SETTINGS_RE.search(_extract_table_options(query))
    if match is None:
        return {}
    raw = match.group(1).strip()
    if not raw:
        return {}
    out: dict[str, str] = {}
    for item in split_top_level_comma(raw):
        eq = item.find("=")
        if eq == -1:
            continue
        key = item[:eq].strip()
        value = item[eq + 1 :].strip()
        if not key:
            continue
        out[key] = value
    return out


def parse_ttl_from_create_table_query(query: str | None) -> str | None:
    if not query:
        return None
    match = _TTL_RE.search(_extract_table_options(query))
    if match is None:
        return None
    raw = match.group(1).strip()
    if not raw:
        return None
    return normalize_sql_fragment(raw)


def parse_engine_from_create_table_query(query: str | None) -> str | None:
    return _parse_clause(query, _ENGINE_START, _ENGINE_STOP)


def parse_primary_key_from_create_table_query(query: str | None) -> str | None:
    return _parse_clause(query, _PRIMARY_KEY_START, _PRIMARY_KEY_STOP)


def parse_order_by_from_create_table_query(query: str | None) -> str | None:
    return _parse_clause(query, _ORDER_BY_START, _ORDER_BY_STOP)


def parse_partition_by_from_create_table_query(query: str | None) -> str | None:
    return _parse_clause(query, _PARTITION_BY_START, _PARTITION_BY_STOP)


def parse_unique_key_from_create_table_query(query: str | None) -> str | None:
    return _parse_clause(query, _UNIQUE_KEY_START, _UNIQUE_KEY_STOP)


def parse_projections_from_create_table_query(
    query: str | None,
) -> list[ProjectionDefinitionShape]:
    body = _extract_create_table_body(query)
    if body is None:
        return []
    projections: list[ProjectionDefinitionShape] = []
    for part in split_top_level_comma(body):
        index_match = _INDEX_PROJECTION_RE.match(part)
        if index_match is not None:
            name = (index_match.group(1) or index_match.group(2) or "").strip()
            index = normalize_projection_index(index_match.group(3) or "")
            type_text = (index_match.group(4) or "").strip()
            if not name or not index or not type_text:
                continue
            projections.append(
                ProjectionDefinitionShape(name=name, index=index, type=type_text)
            )
            continue

        match = _PROJECTION_RE.match(part)
        if match is None:
            continue
        name = (match.group(1) or match.group(2) or "").strip()
        query_text = normalize_sql_fragment((match.group(3) or "").strip())
        if not name or not query_text:
            continue
        projections.append(ProjectionDefinitionShape(name=name, query=query_text))
    return projections
