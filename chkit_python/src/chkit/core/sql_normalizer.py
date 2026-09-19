"""Whitespace + engine normalization helpers used during canonicalization."""

from __future__ import annotations

import re
from typing import Final

_WHITESPACE: Final[re.Pattern[str]] = re.compile(r"\s+")


def normalize_sql_fragment(value: str) -> str:
    return _WHITESPACE.sub(" ", value).strip()


def normalize_engine(engine: str) -> str:
    normalized = engine.strip()
    if normalized.startswith("Shared"):
        normalized = normalized[len("Shared") :]
    if "(" not in normalized:
        normalized += "()"
    return normalized
