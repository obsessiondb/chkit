"""The names a ``CREATE TABLE`` statement defines in its column list.

Read as ClickHouse renders the statement in ``system.tables.create_table_query``:
each column, plus the name after INDEX, PROJECTION, CONSTRAINT or STATISTICS.
A name may be quoted with backticks or double quotes, or bare, depending on
``show_create_query_identifier_quoting_style`` and ``_rule``; text in string
literals and comments is never a name. Same as the TS ``createTableElementNames``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_NAMED_ELEMENT_KEYWORDS = frozenset({"INDEX", "PROJECTION", "CONSTRAINT", "STATISTICS"})
_BARE_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")


@dataclass(frozen=True, slots=True)
class _Identifier:
    name: str
    quoted: bool
    end: int


def create_table_element_names(create_query: str) -> list[str] | None:
    """The element names, or None when the statement cannot be read this way,
    so a caller never takes it for a missing column."""
    elements = _column_list_elements(create_query)
    if elements is None:
        return None
    names: list[str] = []
    for element in elements:
        first = _read_identifier(element, _skip_blank(element, 0))
        if first is None:
            return None
        names.append(first.name)
        if not first.quoted and first.name.upper() in _NAMED_ELEMENT_KEYWORDS:
            second = _read_identifier(element, _skip_blank(element, first.end))
            if second is None:
                return None
            names.append(second.name)
    return names


def _column_list_elements(sql: str) -> list[str] | None:
    """The text of each top-level element between the first ``(`` and its ``)``."""
    index = 0
    depth = 0
    start = -1
    elements: list[str] = []
    while index < len(sql):
        char = sql[index]
        if char in {"'", "`", '"'}:
            end = _skip_quoted(sql, index)
            if end is None:
                return None
            index = end
            continue
        if sql.startswith("--", index):
            newline = sql.find("\n", index)
            index = len(sql) if newline == -1 else newline + 1
            continue
        if sql.startswith("/*", index):
            close = sql.find("*/", index + 2)
            if close == -1:
                return None
            index = close + 2
            continue
        if char in {"(", "["}:
            depth += 1
            if depth == 1 and char == "(":
                start = index + 1
        elif char in {")", "]"}:
            depth -= 1
            if depth < 0:
                return None
            if depth == 0 and start != -1:
                elements.append(sql[start:index])
                return elements
        elif char == "," and depth == 1 and start != -1:
            elements.append(sql[start:index])
            start = index + 1
        index += 1
    return None


def _skip_quoted(sql: str, start: int) -> int | None:
    """The index after the quoted text that starts at ``start``; None when it never closes."""
    quote = sql[start]
    index = start + 1
    while index < len(sql):
        char = sql[index]
        if char == "\\":
            index += 2
            continue
        if char == quote:
            if sql[index + 1 : index + 2] == quote:
                index += 2
                continue
            return index + 1
        index += 1
    return None


def _skip_blank(text: str, start: int) -> int:
    index = start
    while index < len(text):
        if text[index].isspace():
            index += 1
        elif text.startswith("--", index):
            newline = text.find("\n", index)
            index = len(text) if newline == -1 else newline + 1
        elif text.startswith("/*", index):
            close = text.find("*/", index + 2)
            index = len(text) if close == -1 else close + 2
        else:
            break
    return index


def _read_identifier(text: str, start: int) -> _Identifier | None:
    quote = text[start : start + 1]
    if quote in {"`", '"'}:
        name: list[str] = []
        index = start + 1
        while index < len(text):
            char = text[index]
            if char == "\\":
                name.append(text[index + 1 : index + 2])
                index += 2
                continue
            if char == quote:
                if text[index + 1 : index + 2] == quote:
                    name.append(quote)
                    index += 2
                    continue
                return _Identifier("".join(name), quoted=True, end=index + 1)
            name.append(char)
            index += 1
        return None
    bare = _BARE_IDENTIFIER.match(text, start)
    if bare is None:
        return None
    return _Identifier(bare.group(0), quoted=False, end=bare.end())
