"""Extract clauses from raw ``CREATE DICTIONARY`` DDL strings.

1:1 port of ``packages/clickhouse/src/create-dictionary-parser.ts``.

Pure parser — no I/O, no Pydantic models, no side effects. The clauses are
located with the SQL lexer, as in TS.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from chkit.core.key_clause import split_top_level_comma
from chkit.core.sql_lexer import (
    JS_WHITESPACE,
    SQLToken,
    is_js_space,
    is_trivia,
    js_regex,
    js_trim,
    tokenize_sql,
)

__all__ = [
    "ParsedDictionaryAttribute",
    "parse_dictionary_attributes_from_create_dictionary_query",
    "parse_dictionary_primary_key_from_create_dictionary_query",
    "parse_dictionary_range_from_create_dictionary_query",
    "parse_dictionary_settings_from_create_dictionary_query",
    "parse_layout_from_create_dictionary_query",
    "parse_lifetime_from_create_dictionary_query",
    "parse_source_from_create_dictionary_query",
]


@dataclass
class ParsedDictionaryAttribute:
    name: str
    type: str
    default: str | int | float | None = None
    expression: str | None = None
    hierarchical: bool | None = None
    bidirectional: bool | None = None
    injective: bool | None = None
    is_object_id: bool | None = None


_MODIFIER_KEYWORDS = (
    "DEFAULT",
    "EXPRESSION",
    "HIERARCHICAL",
    "BIDIRECTIONAL",
    "INJECTIVE",
    "IS_OBJECT_ID",
)

_ATTRIBUTE_NAME_RE = re.compile(js_regex(r"^(?:`([^`]+)`|([A-Za-z_]\w*))\s+([\s\S]+)$"))

_RANGE_RE = re.compile(js_regex(r"^MIN\s+(\S+)\s+MAX\s+(\S+)$"), re.IGNORECASE)


# The dictionary-level clauses written as ``<keyword>(...)`` after the attribute list.
_PAREN_CLAUSES = frozenset({"SOURCE", "LAYOUT", "LIFETIME", "RANGE", "SETTINGS"})


@dataclass
class _DictionaryStatement:
    """Where the parts of a ``CREATE DICTIONARY`` statement are, as offsets into it."""

    # The parens of the attribute list.
    attributes: tuple[int, int]
    # The text after ``PRIMARY KEY``, up to the next clause.
    primary_key: tuple[int, int] | None
    # The parens of each ``<keyword>(...)`` clause, by keyword in upper case;
    # repeated if written twice.
    clauses: dict[str, list[tuple[int, int]]]


def _locate_dictionary_statement(query: str) -> _DictionaryStatement | None:
    """Locate the attribute list and the dictionary-level clauses with the SQL lexer.

    A clause keyword in a quoted name, a string, a comment or inside another
    clause's parentheses is never taken for the clause: only a bare keyword at
    the top level, after the attribute list, followed by ``(``. ``None`` when
    the statement can't be read whole: no ``DICTIONARY`` keyword or attribute
    list, a string, name or comment without its end, or unbalanced
    parentheses.
    """
    all_tokens = tokenize_sql(query)
    if any(not token.terminated for token in all_tokens):
        return None
    tokens = [token for token in all_tokens if not is_trivia(token)]
    clauses: dict[str, list[tuple[int, int]]] = {}
    saw_dictionary = False
    attributes_open: int | None = None
    attributes: tuple[int, int] | None = None
    attributes_end = -1
    primary_key: tuple[int, int] | None = None
    clause: tuple[str, int] | None = None
    depth = 0
    for i, token in enumerate(tokens):
        if depth == 0 and attributes is not None:
            primary_key = _track_primary_key(tokens, i, attributes_end, primary_key, len(query))
        if token.kind == "punctuation" and token.text == "(":
            keyword = _upper_word(tokens[i - 1]) if i > 0 else None
            if depth == 0 and saw_dictionary and attributes_open is None:
                attributes_open = token.start
            elif (
                depth == 0
                and attributes is not None
                and keyword is not None
                and keyword in _PAREN_CLAUSES
            ):
                clause = (keyword, token.start)
            depth += 1
        elif token.kind == "punctuation" and token.text == ")":
            depth -= 1
            if depth < 0:
                return None
            if depth == 0 and attributes is None and attributes_open is not None:
                attributes = (attributes_open, token.start)
                attributes_end = i
            elif depth == 0 and clause is not None:
                clauses.setdefault(clause[0], []).append((clause[1], token.start))
                clause = None
        elif depth == 0 and _upper_word(token) == "DICTIONARY":
            saw_dictionary = True
    if depth != 0 or attributes is None:
        return None
    return _DictionaryStatement(
        attributes=attributes,
        primary_key=primary_key,
        clauses=clauses,
    )


def _track_primary_key(
    tokens: list[SQLToken],
    i: int,
    attributes_end: int,
    primary_key: tuple[int, int] | None,
    end_of_query: int,
) -> tuple[int, int] | None:
    """The ``PRIMARY KEY`` span after reading ``tokens[i]``, a top-level token past the list.

    The span opens right after ``PRIMARY KEY``, the two tokens after the
    attribute list, and ends at the first clause after it.
    """
    token = tokens[i]
    if (
        i == attributes_end + 2
        and _upper_word(token) == "KEY"
        and _upper_word(tokens[i - 1]) == "PRIMARY"
    ):
        return (token.end, end_of_query)
    if (
        primary_key is not None
        and primary_key[1] == end_of_query
        and _starts_clause_after_primary_key(tokens, i)
    ):
        return (primary_key[0], token.start)
    return primary_key


def _upper_word(token: SQLToken | None) -> str | None:
    """The bare word a token is, in upper case; ``None`` for anything else."""
    return token.text.upper() if token is not None and token.kind == "identifier" else None


def _starts_clause_after_primary_key(tokens: list[SQLToken], i: int) -> bool:
    """Whether ``tokens[i]``, at the top level, ends the ``PRIMARY KEY`` list.

    That is a ``<clause>(``, ``COMMENT`` or ``;``.
    """
    word = _upper_word(tokens[i])
    if word == "COMMENT" or tokens[i].text == ";":
        return True
    return (
        word is not None
        and word in _PAREN_CLAUSES
        and i + 1 < len(tokens)
        and tokens[i + 1].text == "("
    )


def parse_attribute_list_text_from_create_dictionary_query(query: str | None) -> str | None:
    """The attribute list as written, without its parentheses."""
    if not query:
        return None
    statement = _locate_dictionary_statement(query)
    if statement is None:
        return None
    body = js_trim(query[statement.attributes[0] + 1 : statement.attributes[1]])
    return body or None


def _extract_keyword_paren_body(query: str, keyword: str) -> str | None:
    group = _find_keyword_paren_group(query, keyword)
    return js_trim(query[group[0] + 1 : group[1]]) if group is not None else None


def _find_keyword_paren_group(query: str, keyword: str) -> tuple[int, int] | None:
    """Positions of the parens of the dictionary-level ``<keyword>(...)`` clause.

    ``None`` unless the statement has exactly one, so a statement that can't be
    read whole never has its ``SOURCE`` masked in the wrong place.
    """
    statement = _locate_dictionary_statement(query)
    groups = statement.clauses.get(keyword, []) if statement is not None else []
    return groups[0] if len(groups) == 1 else None


def _split_attribute_type_and_modifiers(rest: str) -> tuple[str, str]:
    """Split an attribute's trailing text into ``(type, modifier_tail)``.

    Scans for the first top-level (paren-depth 0) modifier keyword, so a type
    argument like ``Decimal(9, 2)`` isn't mistaken for the start of a
    modifier.
    """
    depth = 0
    in_string = False
    string_quote = "'"
    for i, char in enumerate(rest):
        if not char:
            continue
        if in_string:
            if char == string_quote and (i == 0 or rest[i - 1] != "\\"):
                in_string = False
            continue
        if char in ("'", '"'):
            in_string = True
            string_quote = char
            continue
        if char == "(":
            depth += 1
            continue
        if char == ")":
            depth -= 1
            continue
        prev_char = rest[i - 1] if i > 0 else " "
        if depth == 0 and re.match(r"[A-Za-z_]", char) and (i == 0 or is_js_space(prev_char)):
            remainder = rest[i:]
            for keyword in _MODIFIER_KEYWORDS:
                if re.match(rf"^{keyword}\b", remainder, re.IGNORECASE):
                    return (js_trim(rest[:i]), js_trim(remainder))
    return (js_trim(rest), "")


# Numeric tokens are coerced with JS `Number()` semantics, not Python's
# looser `int()`/`float()`: Python accepts `1_000`, `nan`, `inf`
# (JS Number → NaN → keep the string), and re-renders `300.0`/`1e5` with a
# trailing `.0` where JS prints `300`/`100000`. Any divergence here leaks into
# pulled schema files and re-rendered SETTINGS, becoming a permanent spurious
# diff against TS-written snapshots.
_JS_DECIMAL_RE = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")
_JS_HEX_RE = re.compile(r"^0[xX][0-9a-fA-F]+$")


def _coerce_number_like_js(token: str) -> str | int | float:
    if _JS_HEX_RE.match(token):
        return int(token, 16)
    if _JS_DECIMAL_RE.match(token) is None:
        return token
    value = float(token)
    # JS renders integer-valued numbers without a fraction (`300.0` → 300).
    if value.is_integer():
        return int(value)
    return value


def _consume_quoted_or_bare_value(text: str) -> tuple[str | int | float, str]:
    trimmed = text.lstrip(JS_WHITESPACE)
    if trimmed.startswith("'"):
        out: list[str] = []
        i = 1
        while i < len(trimmed):
            char = trimmed[i]
            if char == "'":
                if i + 1 < len(trimmed) and trimmed[i + 1] == "'":
                    out.append("'")
                    i += 2
                    continue
                i += 1
                break
            if char == "\\" and i + 1 < len(trimmed) and trimmed[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            out.append(char)
            i += 1
        return ("".join(out), trimmed[i:])
    match = re.match(js_regex(r"^\S+"), trimmed)
    token = match.group(0) if match is not None else ""
    rest = trimmed[len(token) :]
    if token:
        return (_coerce_number_like_js(token), rest)
    return (token, rest)


def _apply_attribute_modifiers(attribute: ParsedDictionaryAttribute, tail: str) -> None:
    remaining = js_trim(tail)
    while remaining:
        if re.match(r"^DEFAULT\b", remaining, re.IGNORECASE):
            remaining = re.sub(js_regex(r"^DEFAULT\s+"), "", remaining, flags=re.IGNORECASE)
            value, rest = _consume_quoted_or_bare_value(remaining)
            attribute.default = value
            remaining = js_trim(rest)
            continue
        if re.match(r"^EXPRESSION\b", remaining, re.IGNORECASE):
            remaining = re.sub(js_regex(r"^EXPRESSION\s+"), "", remaining, flags=re.IGNORECASE)
            expression, expr_rest = _split_attribute_type_and_modifiers(remaining)
            attribute.expression = expression
            remaining = js_trim(expr_rest)
            continue
        if re.match(r"^HIERARCHICAL\b", remaining, re.IGNORECASE):
            attribute.hierarchical = True
            remaining = js_trim(
                re.sub(r"^HIERARCHICAL\b", "", remaining, flags=re.IGNORECASE)
            )
            continue
        if re.match(r"^BIDIRECTIONAL\b", remaining, re.IGNORECASE):
            attribute.bidirectional = True
            remaining = js_trim(
                re.sub(r"^BIDIRECTIONAL\b", "", remaining, flags=re.IGNORECASE)
            )
            continue
        if re.match(r"^INJECTIVE\b", remaining, re.IGNORECASE):
            attribute.injective = True
            remaining = js_trim(
                re.sub(r"^INJECTIVE\b", "", remaining, flags=re.IGNORECASE)
            )
            continue
        if re.match(r"^IS_OBJECT_ID\b", remaining, re.IGNORECASE):
            attribute.is_object_id = True
            remaining = js_trim(
                re.sub(r"^IS_OBJECT_ID\b", "", remaining, flags=re.IGNORECASE)
            )
            continue
        break


def parse_dictionary_attributes_from_create_dictionary_query(
    query: str | None,
) -> list[ParsedDictionaryAttribute]:
    body = parse_attribute_list_text_from_create_dictionary_query(query)
    if body is None:
        return []
    attributes: list[ParsedDictionaryAttribute] = []
    for part in split_top_level_comma(body):
        trimmed = js_trim(part)
        if not trimmed:
            continue
        name_match = _ATTRIBUTE_NAME_RE.match(trimmed)
        if name_match is None:
            continue
        name = js_trim(name_match.group(1) or name_match.group(2) or "")
        rest = js_trim(name_match.group(3) or "")
        if not name or not rest:
            continue
        type_text, tail = _split_attribute_type_and_modifiers(rest)
        if not type_text:
            continue
        attribute = ParsedDictionaryAttribute(name=name, type=type_text)
        _apply_attribute_modifiers(attribute, tail)
        attributes.append(attribute)
    return attributes


def parse_dictionary_primary_key_from_create_dictionary_query(
    query: str | None,
) -> list[str]:
    if not query:
        return []
    statement = _locate_dictionary_statement(query)
    primary_key = statement.primary_key if statement is not None else None
    raw = js_trim(query[primary_key[0] : primary_key[1]]) if primary_key is not None else ""
    if not raw:
        return []
    out: list[str] = []
    for part in split_top_level_comma(raw):
        # At most one backtick per side (TS `.replace(/^`|`$/g, '')`), so a
        # doubly-quoted pathological token stays distinguishable.
        token = js_trim(part)
        token = token.removeprefix("`").removesuffix("`")
        if token:
            out.append(token)
    return out


def parse_source_from_create_dictionary_query(query: str | None) -> str | None:
    if not query:
        return None
    return _extract_keyword_paren_body(query, "SOURCE")


def replace_source_in_create_dictionary_query(query: str, body: str) -> str | None:
    """The query with the body of its ``SOURCE(...)`` clause replaced by ``body``.

    ``None`` unless the query has exactly one top-level ``SOURCE`` clause and
    reads whole.
    """
    group = _find_keyword_paren_group(query, "SOURCE")
    if group is None:
        return None
    return f"{query[: group[0] + 1]}{body}{query[group[1] :]}"


def parse_layout_from_create_dictionary_query(query: str | None) -> str | None:
    if not query:
        return None
    return _extract_keyword_paren_body(query, "LAYOUT")


def parse_lifetime_from_create_dictionary_query(query: str | None) -> str | None:
    if not query:
        return None
    return _extract_keyword_paren_body(query, "LIFETIME")


def _strip_backticks(value: str) -> str:
    trimmed = js_trim(value)
    if trimmed.startswith("`") and trimmed.endswith("`"):
        return trimmed[1:-1]
    return trimmed


def parse_dictionary_range_from_create_dictionary_query(
    query: str | None,
) -> tuple[str, str] | None:
    """Return ``(min, max)`` of the RANGE clause, or ``None``."""
    if not query:
        return None
    body = _extract_keyword_paren_body(query, "RANGE")
    if body is None:
        return None
    match = _RANGE_RE.match(js_trim(body))
    if match is None or not match.group(1) or not match.group(2):
        return None
    return (_strip_backticks(match.group(1)), _strip_backticks(match.group(2)))


def parse_dictionary_settings_from_create_dictionary_query(
    query: str | None,
) -> dict[str, str | int | float] | None:
    if not query:
        return None
    body = _extract_keyword_paren_body(query, "SETTINGS")
    if body is None:
        return None
    out: dict[str, str | int | float] = {}
    for part in split_top_level_comma(body):
        eq = part.find("=")
        if eq == -1:
            continue
        key = js_trim(part[:eq])
        if not key:
            continue
        value, _rest = _consume_quoted_or_bare_value(js_trim(part[eq + 1 :]))
        out[key] = value
    return out if out else None
