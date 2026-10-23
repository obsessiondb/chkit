"""Read what an ALTER TABLE column statement sets.

1:1 port of ``packages/clickhouse/src/alter-column-statement.ts`` (#290). The
DDL propagation wait compares these values with ``system.columns`` on every
replica.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from chkit.core.sql_lexer import (
    SQLToken,
    identifier_name,
    is_trivia,
    string_literal_value,
    tokenize_sql,
)

_DEFAULT_KINDS: Final[frozenset[str]] = frozenset(
    {"DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL"}
)
# Clauses that may follow a column's type or default expression.
_TRAILING_CLAUSES: Final[frozenset[str]] = frozenset(
    {"TTL", "SETTINGS", "FIRST", "AFTER", "STATISTICS", "PRIMARY"}
)


@dataclass(frozen=True)
class ColumnIntent:
    """What a ``MODIFY COLUMN`` statement sets, in ``system.columns`` terms.

    A field is set only when the statement sets it: ClickHouse keeps a
    column's default, comment and codec when MODIFY COLUMN leaves them out.
    """

    # ``""`` after ``REMOVE DEFAULT`` (or MATERIALIZED, ALIAS, EPHEMERAL).
    default_kind: str | None = None
    # The expression as written; the server formats it before it is compared.
    default_expression: str | None = None
    # ``EPHEMERAL`` without an expression stores ``defaultValueOfTypeName(<type>)``.
    type_default: bool = False
    comment: str | None = None
    # ``REMOVE CODEC``. A codec the statement sets is compared between replicas only.
    codec_removed: bool = False


def parse_modify_column_intent(statement: str, column: str) -> ColumnIntent:  # noqa: PLR0911, PLR0912
    """Read what ``ALTER TABLE ... MODIFY COLUMN <column> ...`` sets.

    Returns an empty intent when the statement is not a single MODIFY COLUMN of
    ``column`` (hand-written or plugin-rewritten SQL), so the wait falls back
    to checking that every replica agrees.
    """
    tokens = _significant_tokens(statement)
    i = _find_top_level(tokens, ("MODIFY", "COLUMN"))
    if i < 0:
        return ColumnIntent()
    if _word(tokens, i) == "IF" and _word(tokens, i + 1) == "EXISTS":
        i += 2
    if i >= len(tokens) or identifier_name(tokens[i]) != column:
        return ColumnIntent()
    i += 1

    if _word(tokens, i) == "REMOVE":
        removed = _word(tokens, i + 1)
        if removed in _DEFAULT_KINDS:
            return ColumnIntent(default_kind="")
        if removed == "CODEC":
            return ColumnIntent(codec_removed=True)
        if removed == "COMMENT":
            return ColumnIntent(comment="")
        return ColumnIntent()

    default_kind: str | None = None
    default_expression: str | None = None
    type_default = False
    i = _skip_to_clause(tokens, i)
    kind = _word(tokens, i)
    if kind in _DEFAULT_KINDS:
        start = i + 1
        i = _skip_to_clause(tokens, start)
        default_kind = kind
        if i > start:
            default_expression = statement[tokens[start].start : tokens[i - 1].end]
        elif kind == "EPHEMERAL":
            type_default = True
        else:
            return ColumnIntent()
    comment: str | None = None
    while True:
        clause = _word(tokens, i)
        if clause == "COMMENT":
            value = string_literal_value(tokens[i + 1]) if i + 1 < len(tokens) else None
            if value is None:
                break
            comment = value
            i += 2
        elif clause == "CODEC":
            i = _skip_to_clause(tokens, i + 1)
        else:
            break
    return ColumnIntent(
        default_kind=default_kind,
        default_expression=default_expression,
        type_default=type_default,
        comment=comment,
    )


def parse_rename_column(statement: str) -> tuple[str, str] | None:
    """Read ``ALTER TABLE ... RENAME COLUMN [IF EXISTS] <from> TO <to>``.

    Names may contain ':', so an operation key cannot tell where ``from`` ends.
    """
    tokens = _significant_tokens(statement)
    i = _find_top_level(tokens, ("RENAME", "COLUMN"))
    if i < 0:
        return None
    if _word(tokens, i) == "IF" and _word(tokens, i + 1) == "EXISTS":
        i += 2
    if i + 2 >= len(tokens) or _word(tokens, i + 1) != "TO":
        return None
    from_ = identifier_name(tokens[i])
    to = identifier_name(tokens[i + 2])
    if from_ is None or to is None:
        return None
    return from_, to


def _significant_tokens(statement: str) -> list[SQLToken]:
    return [token for token in tokenize_sql(statement) if not is_trivia(token)]


def _find_top_level(tokens: list[SQLToken], keywords: tuple[str, ...]) -> int:
    """Index just past the first top-level occurrence of the keyword sequence."""
    depth = 0
    for i, token in enumerate(tokens):
        depth += _nesting(token)
        if depth == 0 and all(
            _word(tokens, i + offset) == keyword for offset, keyword in enumerate(keywords)
        ):
            return i + len(keywords)
    return -1


def _skip_to_clause(tokens: list[SQLToken], start: int) -> int:
    """Index of the next top-level clause keyword at or after ``start``.

    A default kind, ``COMMENT '<text>'``, ``CODEC(...)``, a trailing clause,
    ``,`` or ``;``.
    """
    depth = 0
    for i in range(start, len(tokens)):
        if depth == 0 and _is_clause_start(tokens, i):
            return i
        depth += _nesting(tokens[i])
    return len(tokens)


def _is_clause_start(tokens: list[SQLToken], i: int) -> bool:
    token = tokens[i]
    if token.text in (",", ";"):
        return True
    keyword = _word(tokens, i)
    if keyword in _DEFAULT_KINDS or keyword in _TRAILING_CLAUSES:
        return True
    following = tokens[i + 1] if i + 1 < len(tokens) else None
    if keyword == "COMMENT":
        return following is not None and following.kind == "string"
    if keyword == "CODEC":
        return following is not None and following.text == "("
    return False


def _nesting(token: SQLToken) -> int:
    if token.kind != "punctuation":
        return 0
    if token.text in ("(", "["):
        return 1
    if token.text in (")", "]"):
        return -1
    return 0


def _word(tokens: list[SQLToken], i: int) -> str:
    if i >= len(tokens) or tokens[i].kind != "identifier":
        return ""
    return tokens[i].text.upper()
