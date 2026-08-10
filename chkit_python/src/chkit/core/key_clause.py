"""Helpers to split ClickHouse key expressions on top-level commas."""

from __future__ import annotations

import re
from typing import Final

_PLAIN_COLUMN_REFERENCE: Final[re.Pattern[str]] = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


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
    quote: str | None = None
    for i, ch in enumerate(text):
        prev = text[i - 1] if i > 0 else ""

        if quote is not None:
            current.append(ch)
            if ch == quote and prev != "\\":
                quote = None
            continue

        if ch in ("'", '"', "`"):
            quote = ch
            current.append(ch)
            continue

        if ch == "(":
            depth += 1
            current.append(ch)
            continue

        if ch == ")":
            depth = max(0, depth - 1)
            current.append(ch)
            continue

        if ch == "," and depth == 0:
            token = "".join(current).strip()
            if token:
                out.append(token)
            current = []
            continue

        current.append(ch)

    tail = "".join(current).strip()
    if tail:
        out.append(tail)
    return out


def normalize_key_columns(values: list[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        out.extend(split_top_level_comma(value.strip()))
    return out
