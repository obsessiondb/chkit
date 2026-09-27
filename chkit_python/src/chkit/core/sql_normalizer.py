"""Whitespace + engine normalization helpers used during canonicalization."""

from __future__ import annotations

import re
from typing import Final

from chkit.core.kafka import is_kafka_engine, normalize_kafka_engine

_WHITESPACE: Final[re.Pattern[str]] = re.compile(r"\s+")


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
