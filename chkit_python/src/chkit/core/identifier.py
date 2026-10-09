"""Identifier helpers.

Partial port of ``packages/core/src/identifier.ts``: only the unquoting half,
which drift uses to compare clauses ClickHouse re-renders with its own quoting.
"""

from __future__ import annotations

import re

from chkit.core.sql_scan import find_quote_end


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
