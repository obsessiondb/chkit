"""Column defaults: literals vs SQL expressions (#234).

1:1 port of ``packages/core/src/column-default.ts``. A default is a SQL
expression when it is an :class:`SQLExpression` or a legacy ``'fn:'`` string;
every other value is a literal.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, Literal, TypeAlias

from chkit.core.key_clause import split_top_level_comma
from chkit.core.model import ColumnDefaultValue, SQLExpression
from chkit.core.sql_lexer import (
    JS_WHITESPACE,
    JS_WHITESPACE_RUN,
    SQLToken,
    is_js_space,
    js_trim,
    tokenize_sql,
)
from chkit.core.sql_normalizer import strip_sql_comments

# Legacy spelling of an expression default: `'fn:now()'` == `SQLExpression(expression='now()')`.
LEGACY_EXPRESSION_PREFIX: Final[str] = "fn:"

# Type families (upper-cased) whose columns a quoted string literal can
# populate: String and FixedString with their SQL aliases (case-insensitive in
# ClickHouse), Enum labels, and Dynamic. Verified on ClickHouse 26.3 by creating
# `c <type> DEFAULT 'now()'` for every family in system.data_type_families
# (#234). Nullable and LowCardinality wrappers, Variant and
# SimpleAggregateFunction are resolved structurally.
_STRING_LITERAL_TYPE_FAMILIES: Final[frozenset[str]] = frozenset({
    "STRING", "FIXEDSTRING", "ENUM", "ENUM8", "ENUM16", "DYNAMIC",
    # FixedString alias
    "BINARY",
    # String aliases
    "BINARY LARGE OBJECT", "BINARY VARYING", "BLOB", "BYTEA", "CHAR", "CHAR LARGE OBJECT",
    "CHAR VARYING", "CHARACTER", "CHARACTER LARGE OBJECT", "CHARACTER VARYING", "CLOB",
    "LONGBLOB", "LONGTEXT", "MEDIUMBLOB", "MEDIUMTEXT", "NATIONAL CHAR", "NATIONAL CHAR VARYING",
    "NATIONAL CHARACTER", "NATIONAL CHARACTER LARGE OBJECT", "NATIONAL CHARACTER VARYING",
    "NCHAR", "NCHAR LARGE OBJECT", "NCHAR VARYING", "NVARCHAR", "TEXT", "TINYBLOB", "TINYTEXT",
    "VARBINARY", "VARCHAR", "VARCHAR2",
})

# Type families (upper-cased, with their SQL aliases) for which a Nullable
# column accepts any quoted string default and stores NULL when the text does
# not parse: numbers, decimals, dates and times, UUID and IP addresses. Bool
# rejects the text even inside Nullable. Verified on ClickHouse 26.3 by
# inserting a row into `c Nullable(<type>) DEFAULT 'now()'` for each (#234).
_NULL_ON_UNPARSABLE_LITERAL_FAMILIES: Final[frozenset[str]] = frozenset({
    "INT8", "INT16", "INT32", "INT64", "INT128", "INT256",
    "UINT8", "UINT16", "UINT32", "UINT64", "UINT128", "UINT256",
    "BFLOAT16", "FLOAT32", "FLOAT64",
    "DECIMAL", "DECIMAL32", "DECIMAL64", "DECIMAL128", "DECIMAL256",
    "DATE", "DATE32", "DATETIME", "DATETIME32", "DATETIME64", "TIME", "TIME64",
    "UUID", "IPV4", "IPV6",
    # Integer aliases
    "BIGINT", "BIGINT SIGNED", "BIGINT UNSIGNED", "BIT", "BYTE", "INT", "INT SIGNED",
    "INT UNSIGNED", "INT1", "INT1 SIGNED", "INT1 UNSIGNED", "INTEGER", "INTEGER SIGNED",
    "INTEGER UNSIGNED", "MEDIUMINT", "MEDIUMINT SIGNED", "MEDIUMINT UNSIGNED", "SET", "SIGNED",
    "SMALLINT", "SMALLINT SIGNED", "SMALLINT UNSIGNED", "TINYINT", "TINYINT SIGNED",
    "TINYINT UNSIGNED", "UNSIGNED", "YEAR",
    # Float, Decimal, DateTime and IP aliases
    "DOUBLE", "DOUBLE PRECISION", "FLOAT", "REAL", "SINGLE", "DEC", "FIXED", "NUMERIC",
    "TIMESTAMP", "INET4", "INET6",
})

# Families of _NULL_ON_UNPARSABLE_LITERAL_FAMILIES that ClickHouse refuses
# inside LowCardinality: decimals, DateTime64 and Time64. Verified on
# ClickHouse 26.3 by creating `c LowCardinality(Nullable(<type>)) EPHEMERAL 'now()'`
# for each (#234).
_LOW_CARDINALITY_REJECTED_FAMILIES: Final[frozenset[str]] = frozenset({
    "DECIMAL", "DECIMAL32", "DECIMAL64", "DECIMAL128", "DECIMAL256", "DEC", "FIXED", "NUMERIC",
    "DATETIME64", "TIME64",
})

_FUNCTION_CALL_START: Final[re.Pattern[str]] = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\s*\(")
_BLANK_HASH_COMMENT: Final[re.Pattern[str]] = re.compile(f"#[{JS_WHITESPACE}]*")


@dataclass(frozen=True, slots=True)
class ExpressionDefault:
    sql: str
    kind: Literal["expression"] = "expression"


@dataclass(frozen=True, slots=True)
class LiteralDefault:
    value: str | int | float | bool
    kind: Literal["literal"] = "literal"


ParsedColumnDefault: TypeAlias = ExpressionDefault | LiteralDefault


def parse_column_default(value: ColumnDefaultValue) -> ParsedColumnDefault:
    """Classify a column default.

    ``SQLExpression`` and a legacy ``'fn:'`` string are SQL expressions,
    trimmed with their comments kept (an empty ``# `` comment at the end is
    trimmed like whitespace); every other value is a literal. Canonical
    definitions, which snapshots and plugin hooks see, always use the ``fn:``
    spelling, so read defaults through this function rather than inspecting
    the raw value.
    """
    if isinstance(value, SQLExpression):
        return ExpressionDefault(sql=trim_expression(value.expression))
    if isinstance(value, str) and value.startswith(LEGACY_EXPRESSION_PREFIX):
        return ExpressionDefault(sql=trim_expression(value[len(LEGACY_EXPRESSION_PREFIX) :]))
    return LiteralDefault(value=value)


def canonicalize_column_default(value: ColumnDefaultValue) -> str | int | float | bool:
    """Snapshot form of a default.

    An expression in either spelling becomes the trimmed ``fn:`` string
    (``SQLExpression(expression=' now() ')`` and ``'fn: now()'`` both give
    ``'fn:now()'``), so switching spellings plans nothing. Literals are unchanged.
    """
    parsed = parse_column_default(value)
    if parsed.kind == "expression":
        return f"{LEGACY_EXPRESSION_PREFIX}{parsed.sql}"
    return parsed.value


def render_default(value: ColumnDefaultValue) -> str:
    """SQL for a column default, whatever its ``default_kind``.

    An expression is its SQL without comments: chkit renders it on the
    column's line, where a ``--`` comment would swallow the ``,``, COMMENT,
    CODEC or ``;`` that follows (#234). A string is a quoted literal with
    quotes and backslashes escaped; numbers and booleans render as written.
    """
    parsed = parse_column_default(value)
    if parsed.kind == "expression":
        return strip_sql_comments(parsed.sql)
    literal = parsed.value
    if isinstance(literal, str):
        escaped = literal.replace("\\", "\\\\").replace("'", "''")
        return f"'{escaped}'"
    if isinstance(literal, bool):
        return "true" if literal else "false"
    return str(literal)


def column_type_accepts_string_literal(type_: str) -> bool:
    """Whether a quoted string literal is a valid value of ``type_``, whatever its wrappers."""
    family, args = _parse_type_family(_unwrap_column_type(type_))
    if family == "SIMPLEAGGREGATEFUNCTION":
        return len(args) >= 2 and column_type_accepts_string_literal(args[-1])  # noqa: PLR2004
    if family == "VARIANT":
        return any(column_type_accepts_string_literal(member) for member in args)
    return family in _STRING_LITERAL_TYPE_FAMILIES


def stores_unparsable_literal_as_null(type_: str) -> bool:
    """Whether ClickHouse stores NULL for a quoted default of ``type_`` that does not parse.

    True for a Nullable number, decimal, date, time, UUID or IP address.
    SimpleAggregateFunction defers to its value type, as ClickHouse does.
    """
    return _literal_falls_back_to_null(type_, inside_nullable=False)


def reads_unparsable_ephemeral_literal_as_null(type_: str) -> bool:
    """``stores_unparsable_literal_as_null`` for an EPHEMERAL default.

    ClickHouse reads an EPHEMERAL default but never stores it, so it skips the
    checks for stored column types. LowCardinality around a Nullable number,
    date, time, UUID or IP address then reads NULL too, where a DEFAULT column
    of that type is refused; a type that LowCardinality rejects (decimals,
    DateTime64, Time64) still fails. Verified on ClickHouse 26.3 (#234).
    """
    family, args = _parse_type_family(type_)
    if family != "LOWCARDINALITY" or len(args) != 1:
        return stores_unparsable_literal_as_null(type_)
    inner = args[0]
    nullable_family, nullable_args = _parse_type_family(inner)
    if nullable_family != "NULLABLE" or len(nullable_args) == 0:
        return False
    base_family, _ = _parse_type_family(nullable_args[0])
    return (
        base_family not in _LOW_CARDINALITY_REJECTED_FAMILIES
        and stores_unparsable_literal_as_null(inner)
    )


def starts_with_function_call(value: str) -> bool:
    """Text that starts with a function call, e.g. ``now()`` or ``toDate(ts) + 1``."""
    return _FUNCTION_CALL_START.match(js_trim(value)) is not None


def trim_expression(sql: str) -> str:
    """Trim an expression.

    ClickHouse reads ``#`` as a comment only before a space or ``!``, so
    trimming the space of an empty ``# `` comment at the end would leave a bare
    ``#``, a syntax error. That comment is trimmed with the whitespace instead.
    """
    end = len(sql)
    for token in reversed(tokenize_sql(sql)):
        if not _is_blank_at_end(token):
            break
        end = token.start
    return js_trim(sql[:end])


def _is_blank_at_end(token: SQLToken) -> bool:
    # Whitespace, including the Unicode whitespace that trim() drops and the
    # lexer reads as punctuation, and a `#` comment without text.
    if token.kind == "whitespace":
        return True
    if token.kind == "punctuation":
        return is_js_space(token.text)
    return token.kind == "line_comment" and _BLANK_HASH_COMMENT.fullmatch(token.text) is not None


def _literal_falls_back_to_null(type_: str, *, inside_nullable: bool) -> bool:
    family, args = _parse_type_family(type_)
    if family == "SIMPLEAGGREGATEFUNCTION":
        return len(args) >= 2 and _literal_falls_back_to_null(  # noqa: PLR2004
            args[-1], inside_nullable=inside_nullable
        )
    # Nullable(Nullable(...)) and Nullable(LowCardinality(...)) are rejected.
    if family == "NULLABLE":
        return (
            not inside_nullable
            and len(args) == 1
            and _literal_falls_back_to_null(args[0], inside_nullable=True)
        )
    return inside_nullable and family in _NULL_ON_UNPARSABLE_LITERAL_FAMILIES


def _unwrap_column_type(type_: str) -> str:
    """Strip outer ``Nullable(…)`` and ``LowCardinality(…)`` layers."""
    base = js_trim(type_)
    while True:
        family, args = _parse_type_family(base)
        if len(args) != 1 or family not in ("NULLABLE", "LOWCARDINALITY"):
            return base
        base = args[0]


def _parse_type_family(type_: str) -> tuple[str, list[str]]:
    """``DateTime64(3, 'UTC')`` -> ``('DATETIME64', ['3', "'UTC'"])``.

    The family is upper-cased with whitespace collapsed.
    """
    trimmed = js_trim(type_)
    open_at = trimmed.find("(")
    if open_at == -1 or not trimmed.endswith(")"):
        return _normalize_type_family(trimmed), []
    return (
        _normalize_type_family(trimmed[:open_at]),
        split_top_level_comma(trimmed[open_at + 1 : -1]),
    )


def _normalize_type_family(name: str) -> str:
    return JS_WHITESPACE_RUN.sub(" ", js_trim(name)).upper()
