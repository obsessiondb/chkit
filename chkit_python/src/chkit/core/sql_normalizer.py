"""Whitespace + engine normalization helpers used during canonicalization."""

from __future__ import annotations

import json
import re
from typing import Final

from chkit.core.kafka import is_kafka_engine, normalize_kafka_engine
from chkit.core.sql_lexer import (
    JS_WHITESPACE_RUN,
    SQLToken,
    is_js_space,
    js_trim,
    tokenize_sql,
)
from chkit.core.text_index_sql import text_expression_fingerprint, text_sql_fingerprint

_SYNTHETIC_EPHEMERAL_DEFAULT: Final[re.Pattern[str]] = re.compile(
    r"defaultValueOfTypeName\s*\(\s*'(?:[^'\\]|\\.|'')*'\s*\)", re.DOTALL
)


def sql_expression_fingerprint(value: str) -> str:
    """Compare expression tokens while preserving quoted values and identifier case.

    SQL the lexer cannot read (e.g. an unterminated quote) falls back to its
    ``normalize_sql_fragment`` form, encoded as a JSON string so it never
    equals a token list.
    """
    try:
        tokens = text_sql_fingerprint(text_expression_fingerprint(value))
    except ValueError:
        return json.dumps(normalize_sql_fragment(value))
    return json.dumps(tokens)


def is_synthetic_ephemeral_default(expression: str) -> bool:
    """Whether ``expression`` is the default ClickHouse stores for a bare EPHEMERAL column.

    ClickHouse synthesizes ``defaultValueOfTypeName('<type as written>')``; the
    literal keeps alias spellings (BIGINT, TEXT) that ``system.columns.type``
    canonicalizes, so any single string literal counts.
    """
    return _SYNTHETIC_EPHEMERAL_DEFAULT.fullmatch(expression.strip()) is not None


def normalize_sql_fragment(value: str) -> str:
    """Canonical one-line form of a SQL fragment.

    A view or materialized view ``as``, ``partition_by``, ``ttl``, a skip index
    expression, a projection, a dictionary ``source``/``layout``/``lifetime``,
    or the same clauses read back from ClickHouse.

    Comments are dropped and every run of whitespace becomes one space, inside
    string literals too. Comments must go before the newlines do: a ``--``,
    ``//``, ``# `` or ``#!`` comment ends at its newline, so on a single line
    it would swallow the rest of the fragment and the ``;`` the renderer
    appends after it (#232). Comment syntax is ClickHouse's, from the shared
    lexer: markers inside string literals, quoted identifiers and heredocs are
    text, and an unterminated block comment or string is kept as written for
    ClickHouse to report.

    A dropped comment leaves one space, so the tokens around it never fuse: a
    minus, an empty block comment and a minus become ``- -``, not a ``--``
    comment. Text without comments or a stray ``#`` normalizes exactly as a
    plain whitespace collapse would, and the result is stable: normalizing it
    again changes nothing.
    """
    out = ""
    separator = ""
    after_bare_hash = False
    for token in tokenize_sql(value):
        if _separates_tokens(token):
            # `#` not followed by a space or `!` is a syntax error in ClickHouse.
            # A space after it would turn it into a `# ` comment that hides the
            # rest of the fragment, so keep the error visible with a newline.
            separator = "\n" if after_bare_hash else " "
            continue
        if out != "":
            out += separator
        out += JS_WHITESPACE_RUN.sub(" ", token.text)
        separator = ""
        after_bare_hash = token.kind == "punctuation" and token.text == "#"
    # An unterminated string or block comment at the end can still end in a space.
    return js_trim(out)


def strip_sql_comments(value: str) -> str:
    """SQL text without its comments, trimmed.

    Unlike ``normalize_sql_fragment``, all other text stays as written,
    including whitespace inside string literals. chkit renders a column default
    expression on one line of a CREATE or ALTER statement, where a ``--``
    comment would swallow the ``,``, ``COMMENT``, ``CODEC`` or ``;`` after it
    (#234).

    A run of whitespace and comments that holds a comment becomes one space,
    so the tokens around it never fuse, or a newline after a stray ``#``, for
    the reason ``normalize_sql_fragment`` gives. A stray ``#`` at the end is
    followed by a newline too: the `` COMMENT`` or `` CODEC`` rendered after it
    would otherwise turn it into a ``# `` comment that hides them. An
    unterminated block comment or string is kept as written for ClickHouse to
    report.
    """
    out = ""
    gap = ""
    gap_has_comment = False
    after_bare_hash = False
    ends_with_bare_hash = False
    for token in tokenize_sql(value):
        comment = _is_closed_comment(token)
        if comment or token.kind == "whitespace":
            gap += token.text
            gap_has_comment = gap_has_comment or comment
            continue
        if gap_has_comment:
            out += "\n" if after_bare_hash else " "
        else:
            out += gap
        out += token.text
        gap = ""
        gap_has_comment = False
        after_bare_hash = token.kind == "punctuation" and token.text == "#"
        # trim() also drops Unicode whitespace, which the lexer reads as punctuation.
        if not is_js_space(token.text):
            ends_with_bare_hash = after_bare_hash
    return f"{js_trim(out)}\n" if ends_with_bare_hash else js_trim(out)


def normalize_engine(engine: str) -> str:
    if is_kafka_engine(engine):
        return normalize_kafka_engine(engine)
    normalized = engine.strip()
    if normalized.startswith("Shared"):
        normalized = normalized[len("Shared") :]
    if "(" not in normalized:
        normalized += "()"
    return normalized


def _separates_tokens(token: SQLToken) -> bool:
    # Whitespace and closed comments. The lexer reads Unicode whitespace such as
    # a no-break space as punctuation; ClickHouse skips it like a space, and
    # chkit has always collapsed it like one.
    if token.kind == "whitespace":
        return True
    if token.kind in ("line_comment", "block_comment"):
        return token.terminated
    return token.kind == "punctuation" and is_js_space(token.text)


def _is_closed_comment(token: SQLToken) -> bool:
    return token.kind in ("line_comment", "block_comment") and token.terminated
