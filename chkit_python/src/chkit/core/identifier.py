"""Identifier helpers, ported from ``packages/core/src/identifier.ts``."""

from __future__ import annotations

import re

from chkit.core.key_clause import is_plain_column_reference
from chkit.core.sql_lexer import unescape_quoted
from chkit.core.sql_scan import find_quote_end

# ASCII control characters (incl. NUL). ClickHouse cannot round-trip them in a
# name reliably, and they are never intentional in a schema object name.
_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")


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


def describe_invalid_identifier(name: str) -> str | None:
    """Return why a name cannot be used as a ClickHouse identifier, if it can't."""
    if len(name) == 0:
        return "is empty"
    if _CONTROL_CHARACTER.search(name):
        return "contains a control character"
    return None


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
