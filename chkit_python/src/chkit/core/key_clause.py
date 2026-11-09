"""Helpers to split ClickHouse key expressions on top-level commas."""

from __future__ import annotations

import re
from collections.abc import Set
from typing import Final

from chkit.core.sql_lexer import identifier_name, is_js_space, is_trivia, iter_sql_tokens, js_trim
from chkit.core.sql_scan import find_quote_end, is_quote_char

_PLAIN_COLUMN_REFERENCE: Final[re.Pattern[str]] = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_BACKSLASH_OR_BACKTICK: Final[re.Pattern[str]] = re.compile(r"[\\`]")


def is_plain_column_reference(token: str) -> bool:
    """A key entry references a table column only when it is a bare identifier.

    Anything else — function calls like ``toDate(ts)``, arithmetic, or tuples —
    is an expression that ClickHouse validates itself, so it must not be
    checked against the table's declared column list.
    """
    return _PLAIN_COLUMN_REFERENCE.fullmatch(token) is not None


def split_top_level_comma(text: str) -> list[str]:
    """Split on commas that are not inside parens, quotes, or backticks."""
    out: list[str] = []
    current: list[str] = []
    depth = 0
    i = 0
    while i < len(text):
        ch = text[i]

        if is_quote_char(ch):
            end = find_quote_end(text, i, ch)
            current.append(text[i : end + 1])
            i = end + 1
            continue

        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            token = js_trim("".join(current))
            if token:
                out.append(token)
            current = []
            i += 1
            continue

        current.append(ch)
        i += 1

    tail = js_trim("".join(current))
    if tail:
        out.append(tail)
    return out


def normalize_key_columns(
    values: list[str], declared_columns: Set[str] = frozenset()
) -> list[str]:
    """Flatten key entries into one token per key part.

    An entry may hold several comma-separated parts (``'id, toDate(ts)'``), but
    one that exactly names a declared column is kept whole, since the name
    itself may contain a comma.
    """
    out: list[str] = []
    for value in values:
        trimmed = js_trim(value)
        if trimmed in declared_columns:
            out.append(trimmed)
        else:
            out.extend(split_top_level_comma(trimmed))
    return out


def key_clause_fingerprint(sql: str) -> str:
    """A key clause reduced to what it means, for comparing two clauses only.

    Never rendered. It keeps one entry per token: whitespace and comments go,
    every identifier compares by its name whether written bare, in backticks or
    in double quotes (ClickHouse re-quotes names when it stores a key), and a
    quoted name keeps its commas and spaces. So ``` `a, b` ``` differs from
    ``` `a`, `b` ``` and ``` `a b` ``` from ``ab`` (#558), while
    ``toStartOfHour( ts )`` matches ``toStartOfHour(ts)`` and ``` `user-id` ```
    matches ``"user-id"``. Pass the clause as rendered
    (``render_key_clause_columns``): a declared column such as ``user-id`` must
    already be quoted, or it reads as ``user - id``.
    """
    parts: list[str] = []
    for token in iter_sql_tokens(sql):
        # The lexer reads Unicode whitespace (a no-break space) as punctuation.
        if is_trivia(token) or (token.kind == "punctuation" and is_js_space(token.text)):
            continue
        name = identifier_name(token)
        if name is None:
            parts.append(token.text)
        else:
            escaped = _BACKSLASH_OR_BACKTICK.sub(r"\\\g<0>", name)
            parts.append(f"`{escaped}`")
    return " ".join(parts)
