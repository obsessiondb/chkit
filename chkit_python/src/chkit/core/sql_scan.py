"""Quote-aware SQL scanning primitives.

Port of ``packages/core/src/sql-scan.ts``. Characters inside a single-quoted
string, a double-quoted identifier, or a backtick-quoted identifier are literal
text, not structure: parens and commas there must be ignored.

Every scanner skips quoted regions through ``find_quote_end``, so the escaping
rule lives in exactly one place and the copies cannot drift apart again (#197).
"""

from __future__ import annotations

import re

_QUOTE_CHARS = frozenset({"'", '"', "`"})


def is_quote_char(char: str | None) -> bool:
    return char in _QUOTE_CHARS


def find_quote_end(sql: str, start: int, quote: str) -> int:
    """Index of the quote closing the one at ``start``.

    Honours backslash escapes and doubled quotes. Unterminated input runs to
    the end of the string.
    """
    i = start + 1
    while i < len(sql):
        if sql[i] == "\\":
            i += 1
        elif sql[i] == quote:
            if i + 1 < len(sql) and sql[i + 1] == quote:
                i += 1
            else:
                return i
        i += 1
    return len(sql)


def strip_wrapping_parens(text: str) -> str:
    """Peel one layer of wrapping parentheses.

    Only when the leading ``(`` closes at the very end — so ``(a, b)`` becomes
    ``a, b`` while ``(a), (b)`` is left intact.
    """
    if not (text.startswith("(") and text.endswith(")")):
        return text
    close = find_matching_paren(text, 0)
    return text[1:-1].strip() if close == len(text) - 1 else text


def find_matching_paren(text: str, open_index: int) -> int | None:
    """Index of the ``)`` matching the ``(`` at ``open_index``, or None when unbalanced."""
    depth = 0
    i = open_index
    while i < len(text):
        char = text[i]
        if char in _QUOTE_CHARS:
            i = find_quote_end(text, i, char)
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def find_top_level_sql_pattern(sql: str, pattern: re.Pattern[str]) -> re.Match[str] | None:
    """Find a clause/delimiter outside quoted strings, identifiers and parentheses."""
    depth = 0
    i = 0
    while i < len(sql):
        char = sql[i]
        if char in _QUOTE_CHARS:
            i = find_quote_end(sql, i, char) + 1
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif depth == 0:
            match = pattern.match(sql, i)
            if match is not None:
                return match
        i += 1
    return None
