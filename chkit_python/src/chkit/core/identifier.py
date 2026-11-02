"""Identifier helpers, ported from ``packages/core/src/identifier.ts``."""

from __future__ import annotations

import re

from chkit.core.key_clause import is_plain_column_reference
from chkit.core.sql_scan import find_quote_end


def quote_identifier(name: str) -> str:
    """Wrap a name in backticks, escaping backslashes and backticks.

    The name can never terminate the quoted identifier early. Matches
    ClickHouse's own formatting of quoted identifiers.
    """
    escaped = name.replace("\\", "\\\\").replace("`", "\\`")
    return f"`{escaped}`"


def render_identifier(name: str) -> str:
    """Render a database or object name.

    Plain identifiers stay bare so generated SQL is unchanged for existing
    schemas; anything else is quoted and escaped.
    """
    return name if is_plain_column_reference(name) else quote_identifier(name)


def render_qualified_name(database: str, name: str) -> str:
    return f"{render_identifier(database)}.{render_identifier(name)}"


def unquote_identifiers(sql: str) -> str:
    """Replace every backtick-quoted identifier with its raw, unescaped name.

    String literals are left untouched.
    """
    out: list[str] = []
    i = 0
    while i < len(sql):
        char = sql[i]
        if char == "'":
            end = find_quote_end(sql, i, "'")
            out.append(sql[i : end + 1])
            i = end + 1
            continue
        if char == "`":
            end = find_quote_end(sql, i, "`")
            out.append(unescape_quoted(sql[i + 1 : end]))
            i = end + 1
            continue
        out.append(char)
        i += 1
    return "".join(out)


def unescape_quoted(body: str, quote: str = "`") -> str:
    """Resolve backslash escapes and doubled quotes inside a quoted body."""
    escaped_quote = re.escape(quote)
    return re.sub(
        rf"\\(.)|{escaped_quote}{escaped_quote}",
        lambda match: match.group(1) if match.group(1) is not None else quote,
        body,
    )
