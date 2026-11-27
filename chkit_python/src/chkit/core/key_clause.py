"""Helpers to split ClickHouse key expressions on top-level commas."""

from __future__ import annotations

import re
from collections.abc import Set
from typing import Final

from chkit.core.sql_lexer import SQLToken, is_js_space, is_trivia, iter_sql_tokens, js_trim
from chkit.core.text_index_sql import string_literal

_PLAIN_COLUMN_REFERENCE: Final[re.Pattern[str]] = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def is_plain_column_reference(token: str) -> bool:
    """A key entry references a table column only when it is a bare identifier.

    Anything else — function calls like ``toDate(ts)``, arithmetic, or tuples —
    is an expression that ClickHouse validates itself, so it must not be
    checked against the table's declared column list.
    """
    return _PLAIN_COLUMN_REFERENCE.fullmatch(token) is not None


def split_top_level_comma(text: str) -> list[str]:
    """Split on commas outside parentheses.

    The input is read with the SQL lexer, so a comma or paren in a string,
    quoted name, heredoc (``$$a, b$$``) or comment is text (#596). Comments are
    dropped, each leaving one space so the tokens around it never fuse: a part
    is trimmed and its callers rejoin parts on one line, where a kept ``--``
    comment would swallow the rest. An unterminated block comment is kept as
    written for ClickHouse to report.
    """
    out: list[str] = []
    current: list[str] = []
    depth = 0
    for token in iter_sql_tokens(text):
        if token.kind == "line_comment" or (token.kind == "block_comment" and token.terminated):
            current.append(" ")
            continue
        if token.kind == "punctuation":
            if token.text == "(":
                depth += 1
            elif token.text == ")":
                depth = max(0, depth - 1)
            elif token.text == "," and depth == 0:
                part = js_trim("".join(current))
                if part:
                    out.append(part)
                current = []
                continue
        current.append(token.text)

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
        name = _name_fingerprint(token, qualified=bool(parts) and parts[-1] == ".")
        parts.append(token.text if name is None else name)
    return " ".join(parts)


def _name_fingerprint(token: SQLToken, *, qualified: bool) -> str | None:
    r"""A name as the bytes ClickHouse reads from it, in one canonical spelling.

    So ``` `a\x41` ``` matches ``aA`` while ``` `a\q` ``` keeps its backslash
    (ClickHouse decodes escapes in a quoted name as in a string literal). A bare
    NULL is the literal and stays as written, unless a dot qualifies it
    (``c.null``, the null map of a Nullable column): ClickHouse always quotes a
    column named ``null``. It does not quote one named ``true``, ``false``,
    ``inf`` or ``nan``, so those compare as names however they are written.
    """
    if token.kind == "identifier":
        if token.text.lower() == "null" and not qualified:
            return None
        return "`" + string_literal(token.text)
    if token.kind != "quoted_identifier" or not token.terminated:
        return None
    quote = token.text[0]
    body = token.text[1:-1]
    # As a string literal body: the doubled quote becomes an escaped one, and a
    # bare `'` is escaped so it is never read as half of a doubled `''`.
    literal: list[str] = []
    i = 0
    while i < len(body):
        char = body[i]
        if char == "\\":
            literal.append(body[i : i + 2])
            i += 2
        elif char == quote and body[i + 1 : i + 2] == quote:
            literal.append("\\" + quote)
            i += 2
        else:
            literal.append("\\'" if char == "'" else char)
            i += 1
    try:
        return "`" + string_literal("".join(literal))
    except ValueError:
        # An invalid escape (`\xZZ`) is compared as written.
        return None
