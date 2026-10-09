"""Locate SQL clauses outside string literals, identifiers and parentheses."""

from __future__ import annotations

import re


def find_top_level_sql_pattern(sql: str, pattern: re.Pattern[str]) -> re.Match[str] | None:
    quote: str | None = None
    depth = 0
    i = 0
    while i < len(sql):
        char = sql[i]
        if quote is not None:
            if char == "\\":
                i += 2
                continue
            if char == quote:
                if i + 1 < len(sql) and sql[i + 1] == quote:
                    i += 2
                    continue
                quote = None
        elif char in {"'", '"', "`"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif depth == 0:
            match = pattern.match(sql, i)
            if match is not None:
                return match
        i += 1
    return None
