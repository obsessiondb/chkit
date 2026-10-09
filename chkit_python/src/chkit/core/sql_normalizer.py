"""Whitespace + engine normalization helpers used during canonicalization."""

from __future__ import annotations

import json
import re
from typing import Final

from chkit.core.kafka import is_kafka_engine, normalize_kafka_engine
from chkit.core.text_index_sql import text_expression_fingerprint, text_sql_fingerprint

_WHITESPACE: Final[re.Pattern[str]] = re.compile(r"\s+")
_SYNTHETIC_EPHEMERAL_DEFAULT: Final[re.Pattern[str]] = re.compile(
    r"defaultValueOfTypeName\s*\(\s*'(?:[^'\\]|\\.|'')*'\s*\)", re.DOTALL
)


def sql_expression_fingerprint(value: str) -> str:
    """Compare expression tokens while preserving quoted values and identifier case.

    SQL the lexer cannot read (e.g. an unterminated quote) falls back to
    whitespace normalization, encoded as a JSON string so it never equals a
    token list.
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
    return _WHITESPACE.sub(" ", value).strip()


def normalize_engine(engine: str) -> str:
    if is_kafka_engine(engine):
        return normalize_kafka_engine(engine)
    normalized = engine.strip()
    if normalized.startswith("Shared"):
        normalized = normalized[len("Shared") :]
    if "(" not in normalized:
        normalized += "()"
    return normalized
