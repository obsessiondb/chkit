"""Quote-aware SQL scanning primitives.

Port of ``packages/core/src/sql-scan.ts``. Characters inside a single-quoted
string, a double-quoted identifier, or a backtick-quoted identifier are literal
text, not structure: parens and commas there must be ignored.

A scanner that skips only quoted regions does so through ``find_quote_end``, so
the escaping rule lives in exactly one place (#197). ``find_matching_paren``,
``find_top_level_sql_pattern`` and ``split_top_level_comma`` read with the SQL
lexer instead, which also knows heredocs and comments (#587, #596).
"""

from __future__ import annotations

import re

from chkit.core.sql_lexer import iter_sql_tokens, js_trim

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
    return js_trim(text[1:-1]) if close == len(text) - 1 else text


def find_matching_paren(text: str, open_index: int) -> int | None:
    """Index of the ``)`` matching the ``(`` at ``open_index``, or None when unbalanced.

    The input is read with the SQL lexer, so a paren in a string, quoted name,
    heredoc (``$$)$$``) or comment is text (#587).
    """
    depth = 0
    for token in iter_sql_tokens(text[open_index:]):
        if token.kind != "punctuation":
            continue
        if token.text == "(":
            depth += 1
        elif token.text == ")":
            depth -= 1
            if depth == 0:
                return open_index + token.start
    return None


def find_top_level_sql_pattern(sql: str, pattern: re.Pattern[str]) -> re.Match[str] | None:
    """Find a clause/delimiter outside parentheses, strings, quoted identifiers,
    heredocs and comments.

    The input is read with the SQL lexer (#596); the pattern is tried at every
    position of the other tokens, and may run on past the token it starts in.
    """
    depth = 0
    for token in iter_sql_tokens(sql):
        if token.kind == "punctuation" and token.text == "(":
            depth += 1
        elif token.kind == "punctuation" and token.text == ")":
            depth -= 1
        elif depth == 0 and token.kind not in _TEXT_TOKEN_KINDS:
            for i in range(token.start, token.end):
                match = pattern.match(sql, i)
                if match is not None:
                    return match
    return None


# A string, heredoc, quoted name or comment: its characters are never structure.
_TEXT_TOKEN_KINDS = frozenset({"string", "quoted_identifier", "line_comment", "block_comment"})
