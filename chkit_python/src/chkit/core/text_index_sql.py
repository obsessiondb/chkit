"""Small text-index SQL lexer; mirrors core/src/text-index-sql.ts."""

from __future__ import annotations

import re

_ESCAPES = {"0": 0, "a": 7, "b": 8, "t": 9, "n": 10, "v": 11, "f": 12, "r": 13, "e": 27}
_WORD = re.compile(r"(?:\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[\w$]+|->|<=|>=|!=|<>|\|\||::|==)")
_CLOSE = {")": "(", "]": "[", "}": "{"}


def _string_literal(body: str) -> str:
    data = bytearray()
    i = 0
    while i < len(body):
        char = body[i]
        if body[i : i + 2] == "''":
            data.append(39)
            i += 2
        elif char == "\\":
            next_char = body[i + 1]
            hex_value = body[i + 2 : i + 4]
            if next_char == "x" and re.fullmatch(r"[\da-fA-F]{2}", hex_value):
                data.append(int(hex_value, 16))
                i += 4
            else:
                if next_char == "x":
                    raise ValueError("Invalid hexadecimal SQL escape")
                if next_char == "N":
                    i += 2
                    continue
                if next_char not in _ESCAPES and next_char not in ("'", '"', "`", "\\", "/", "="):
                    data.append(92)
                if next_char in _ESCAPES:
                    data.append(_ESCAPES[next_char])
                else:
                    data.extend(next_char.encode())
                i += 2
        else:
            data.extend(char.encode())
            i += 1
    parts = []
    for byte in data:
        if byte == 39:
            parts.append("\\'")
        elif byte == 92:
            parts.append("\\\\")
        elif 32 <= byte < 127:
            parts.append(chr(byte))
        else:
            parts.append(f"\\x{byte:02x}")
    return "'" + "".join(parts) + "'"


def text_sql_tokens(sql: str) -> list[str]:
    tokens: list[str] = []
    brackets: list[str] = []
    i = 0
    while i < len(sql):
        char = sql[i]
        if char.isspace():
            i += 1
            continue
        if sql.startswith("--", i):
            end = sql.find("\n", i + 2)
            i = len(sql) if end < 0 else end + 1
            continue
        if sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            if end < 0:
                raise ValueError("Unterminated SQL comment")
            i = end + 2
            continue
        if char in ("'", '"', "`"):
            start = i
            i += 1
            closed = False
            while i < len(sql):
                if sql[i] == "\\":
                    i += 2
                    continue
                current = sql[i]
                i += 1
                if current == char:
                    if i < len(sql) and sql[i] == char:
                        i += 1
                        continue
                    closed = True
                    break
            if not closed:
                raise ValueError("Unterminated SQL quote")
            raw = sql[start:i]
            tokens.append(_string_literal(raw[1:-1]) if char == "'" else raw)
            continue
        if char == ";":
            raise ValueError("Expected a SQL expression, not a statement")
        if char in "([{":
            brackets.append(char)
        if char in _CLOSE and (not brackets or brackets.pop() != _CLOSE[char]):
            raise ValueError("Unbalanced SQL brackets")
        match = _WORD.match(sql, i)
        token = match.group() if match else char
        tokens.append(token)
        i += len(token)
    if brackets:
        raise ValueError("Unbalanced SQL brackets")
    return tokens


def format_text_sql(tokens: list[str]) -> str:
    parts = []
    for i, token in enumerate(tokens):
        previous = tokens[i - 1] if i else ""
        tight = (
            i == 0
            or token in (")", "]", "}", ",", ".")
            or previous in ("(", "[", "{", ".")
            or (token == "(" and re.fullmatch(r"[^\W\d]\w*", previous))
        )
        parts.append(("" if tight else " ") + token)
    return "".join(parts)


def normalize_text_index_sql(sql: str) -> str:
    return format_text_sql(text_sql_tokens(sql))


def text_expression_fingerprint(sql: str) -> str:
    tokens = text_sql_tokens(sql)
    while tokens and tokens[0] == "(" and tokens[-1] == ")":
        depth = 0
        wraps = True
        for i, token in enumerate(tokens):
            if token == "(":
                depth += 1
            if token == ")":
                depth -= 1
            if depth == 0 and i < len(tokens) - 1:
                wraps = False
                break
        if not wraps:
            break
        tokens = tokens[1:-1]
    return format_text_sql(tokens)


def text_sql_fingerprint(sql: str) -> list[str]:
    """Ignore redundant simple identifier quotes only for comparisons."""
    return [
        re.sub(r'([`"])([A-Za-z_][A-Za-z0-9_]*)\1$', r"\2", token)
        if re.fullmatch(r'([`"])([A-Za-z_][A-Za-z0-9_]*)\1', token)
        else token
        for token in text_sql_tokens(sql)
    ]
