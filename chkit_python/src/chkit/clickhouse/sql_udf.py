"""Conservative substitution of scalar SQL UDFs from system.functions."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from chkit.core.sql_lexer import identifier_name, is_trivia, tokenize_sql
from chkit.core.sql_scan import find_matching_paren, strip_wrapping_parens

_MAX_DEPTH = 64
_MAX_SUBSTITUTIONS = 1000
_MAX_BYTES = 1_000_000


@dataclass(frozen=True)
class SQLUDF:
    parameters: list[str]
    body: str


def parse_sql_udf(query: str) -> SQLUDF | None:
    tokens = [token for token in tokenize_sql(query) if not is_trivia(token)]
    header_size = 5
    if (
        len(tokens) < header_size
        or tokens[0].text.upper() != "CREATE"
        or tokens[1].text.upper() != "FUNCTION"
        or tokens[3].text.upper() != "AS"
    ):
        return None
    opening = tokens[4]
    end = find_matching_paren(query, opening.start) if opening.text == "(" else opening.end - 1
    parts_list = (
        None
        if end is None
        else _split_arguments(query[opening.end : end] if opening.text == "(" else opening.text)
    )
    if end is None or parts_list is None:
        return None
    parameters: list[str] = []
    for parameter in parts_list:
        parts = [token for token in tokenize_sql(parameter) if not is_trivia(token)]
        name = identifier_name(parts[0]) if len(parts) == 1 else None
        if name is None:
            return None
        parameters.append(name)
    tail = [token for token in tokenize_sql(query[end + 1 :]) if not is_trivia(token)]
    arrow_size = 2
    if len(tail) < arrow_size or tail[0].text != "-" or tail[1].text != ">":
        return None
    body = query[end + 1 + tail[1].end :].strip()
    body_tokens = [token for token in tokenize_sql(body) if not is_trivia(token)]
    # Nested scopes require an AST binder; leave those definitions intact.
    if any(
        (token.kind == "identifier" and token.text.upper() in {"SELECT", "WITH", "AS"})
        or (token.text == "-" and i + 1 < len(body_tokens) and body_tokens[i + 1].text == ">")
        for i, token in enumerate(body_tokens)
    ):
        return None
    return SQLUDF(parameters, body) if body and len(set(parameters)) == len(parameters) else None


def expand_sql_udfs(sql: str, definitions: Mapping[str, SQLUDF]) -> str | None:
    substitutions = 0

    def expand(value: str, active: frozenset[str], depth: int = 0) -> str | None:
        nonlocal substitutions
        if len(value) > _MAX_BYTES or depth > _MAX_DEPTH:
            return None
        tokens = [token for token in tokenize_sql(value) if not is_trivia(token)]
        output: list[str] = []
        cursor = 0
        i = 0
        while i < len(tokens):
            token = tokens[i]
            name = identifier_name(token)
            definition = definitions.get(name) if name is not None else None
            if (
                definition is None
                or name is None
                or (i > 0 and tokens[i - 1].text == ".")
                or i + 1 >= len(tokens)
                or tokens[i + 1].text != "("
            ):
                i += 1
                continue
            substitutions += 1
            if name in active or substitutions > _MAX_SUBSTITUTIONS:
                return None
            opening = tokens[i + 1]
            end = find_matching_paren(value, opening.start)
            arguments = None if end is None else _split_arguments(value[opening.end : end])
            if end is None or arguments is None or len(arguments) != len(definition.parameters):
                return None
            expanded_arguments = [expand(argument, active, depth + 1) for argument in arguments]
            if any(argument is None for argument in expanded_arguments):
                return None
            by_name = dict(zip(definition.parameters, expanded_arguments, strict=True))
            body: list[str] = []
            previous = ""
            for part in tokenize_sql(definition.body):
                parameter = identifier_name(part)
                argument = (
                    by_name.get(parameter) if parameter is not None and previous != "." else None
                )
                body.append(part.text if argument is None else _wrap_replacement(argument))
                if not is_trivia(part):
                    previous = part.text
            replacement = expand("".join(body), active | {name}, depth + 1)
            if replacement is None:
                return None
            following = next((part for part in tokens if part.start > end), None)
            # Older server formatters retain redundant grouping around whole expressions.
            delimited = (
                i > 0 and tokens[i - 1].text.upper() in ("SELECT", "(", ",", "[")
                and (following is None or following.text.upper() in ("AS", "FROM", ",", ")", "]"))
            )
            output.append(
                value[cursor : token.start]
                + (_unwrap_scalar(replacement) if delimited else _wrap_replacement(replacement))
            )
            cursor = end + 1
            while i + 1 < len(tokens) and tokens[i + 1].start <= end:
                i += 1
            i += 1
        return "".join(output) + value[cursor:]

    return expand(sql, frozenset())


def _wrap_replacement(body: str) -> str:
    tokens = [token for token in tokenize_sql(body) if not is_trivia(token)]
    minimum_call_tokens = 3
    call = (
        len(tokens) >= minimum_call_tokens
        and identifier_name(tokens[0]) is not None
        and tokens[1].text == "("
        and find_matching_paren(body, tokens[1].start) == len(body) - 1
    )
    parenthesized = (
        bool(tokens)
        and tokens[0].text == "("
        and find_matching_paren(body, tokens[0].start) == len(body) - 1
    )
    bracket = tokens[0].text if tokens else ""
    closing = {"[": "]", "{": "}"}.get(bracket)
    enclosed = False
    depth = 0
    if closing:
        for token in tokens:
            if token.text == bracket:
                depth += 1
            if token.text == closing:
                depth -= 1
                if depth == 0:
                    enclosed = token.end == len(body)
                    break
    return body if len(tokens) == 1 or call or parenthesized or enclosed else f"({body})"


def _split_arguments(sql: str) -> list[str] | None:
    if not sql.strip():
        return []
    arguments: list[str] = []
    stack: list[str] = []
    start = 0
    for token in tokenize_sql(sql):
        if token.kind != "punctuation":
            continue
        if token.text in {"(", "[", "{"}:
            stack.append(token.text)
        elif token.text in {")", "]", "}"}:
            opening = stack.pop() if stack else None
            if opening != {")": "(", "]": "[", "}": "{"}[token.text]:
                return None
        elif token.text == "," and not stack:
            arguments.append(sql[start : token.start].strip())
            start = token.end
    arguments.append(sql[start:].strip())
    return arguments if not stack and all(arguments) else None


def _unwrap_scalar(body: str) -> str:
    while True:
        inner = strip_wrapping_parens(body)
        arguments = _split_arguments(inner)
        if inner == body or arguments is None or len(arguments) != 1:
            return body
        body = inner
