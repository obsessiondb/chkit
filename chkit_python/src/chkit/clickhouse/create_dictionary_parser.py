"""Extract clauses from raw ``CREATE DICTIONARY`` DDL strings.

1:1 port of ``packages/clickhouse/src/create-dictionary-parser.ts``.

Pure parser — no I/O, no Pydantic models, no side effects. Matches the TS
regex-based approach intentionally: ClickHouse dictionary DDL has a small,
stable surface.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from chkit.core.key_clause import split_top_level_comma

__all__ = [
    "ParsedDictionaryAttribute",
    "parse_comment_from_create_dictionary_query",
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

_DICTIONARY_NAME_RE = re.compile(
    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?DICTIONARY\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\w.]+\s*",
    re.IGNORECASE,
)

_ATTRIBUTE_NAME_RE = re.compile(r"^(?:`([^`]+)`|([A-Za-z_]\w*))\s+([\s\S]+)$")

_PRIMARY_KEY_RE = re.compile(
    r"^\s*PRIMARY\s+KEY\s+([\s\S]*?)"
    r"(?:\bSOURCE\s*\(|\bLAYOUT\s*\(|\bLIFETIME\s*\(|\bCOMMENT\b|;|$)",
    re.IGNORECASE,
)

_COMMENT_RE = re.compile(r"\bCOMMENT\s+'((?:[^'\\]|\\.|'')*)'", re.IGNORECASE)

_RANGE_RE = re.compile(r"^MIN\s+(\S+)\s+MAX\s+(\S+)$", re.IGNORECASE)


def _extract_balanced_paren_group(
    text: str, from_index: int
) -> tuple[str, int] | None:
    """Return ``(content, end_index)`` of the first balanced paren group."""
    open_index = text.find("(", from_index)
    if open_index == -1:
        return None
    depth = 0
    in_string = False
    string_quote = "'"
    for i in range(open_index, len(text)):
        char = text[i]
        if not char:
            continue
        if in_string:
            if char == string_quote and (i == 0 or text[i - 1] != "\\"):
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
            if depth == 0:
                return (text[open_index + 1 : i], i + 1)
    return None


def _find_attribute_list_bounds(query: str) -> tuple[int, int] | None:
    """Positions of the parens that open and close the attribute list.

    The close is the one right before the dictionary's ``PRIMARY KEY ...``
    clause. Returns ``None`` when there is no balanced attribute list.
    """
    name_match = _DICTIONARY_NAME_RE.search(query)
    if name_match is None:
        return None
    start = name_match.end()
    open_index = query.find("(", start)
    if open_index == -1:
        return None
    group = _extract_balanced_paren_group(query, start)
    if group is None:
        return None
    return (open_index, group[1] - 1)


def _extract_create_dictionary_body(query: str | None) -> str | None:
    if not query:
        return None
    bounds = _find_attribute_list_bounds(query)
    if bounds is None:
        return None
    body = query[bounds[0] + 1 : bounds[1]].strip()
    return body or None


def _extract_dictionary_options(query: str) -> str:
    """Everything after the attribute list: ``PRIMARY KEY ... SOURCE(...) ...``.

    This is where dictionary-level clauses live. Table-level keywords like
    SOURCE/RANGE can also appear inside an attribute's EXPRESSION (``range()``
    is a real ClickHouse array function) — searching the whole query would
    risk matching one of those instead of the real clause. Falls back to the
    whole query when the attribute list can't be located, preserving
    behaviour for unparseable inputs.
    """
    bounds = _find_attribute_list_bounds(query)
    return query[bounds[1] + 1 :] if bounds is not None else query


def _extract_keyword_paren_body(query: str, keyword: str) -> str | None:
    options = _extract_dictionary_options(query)
    match = re.search(rf"\b{keyword}\s*\(", options, re.IGNORECASE)
    if match is None:
        return None
    open_index = match.end() - 1
    group = _extract_balanced_paren_group(options, open_index)
    return group[0].strip() if group is not None else None


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
        if depth == 0 and re.match(r"[A-Za-z_]", char) and (i == 0 or prev_char.isspace()):
            remainder = rest[i:]
            for keyword in _MODIFIER_KEYWORDS:
                if re.match(rf"^{keyword}\b", remainder, re.IGNORECASE):
                    return (rest[:i].strip(), remainder.strip())
    return (rest.strip(), "")


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
    trimmed = text.lstrip()
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
    match = re.match(r"^\S+", trimmed)
    token = match.group(0) if match is not None else ""
    rest = trimmed[len(token) :]
    if token:
        return (_coerce_number_like_js(token), rest)
    return (token, rest)


def _apply_attribute_modifiers(attribute: ParsedDictionaryAttribute, tail: str) -> None:
    remaining = tail.strip()
    while remaining:
        if re.match(r"^DEFAULT\b", remaining, re.IGNORECASE):
            remaining = re.sub(r"^DEFAULT\s+", "", remaining, flags=re.IGNORECASE)
            value, rest = _consume_quoted_or_bare_value(remaining)
            attribute.default = value
            remaining = rest.strip()
            continue
        if re.match(r"^EXPRESSION\b", remaining, re.IGNORECASE):
            remaining = re.sub(r"^EXPRESSION\s+", "", remaining, flags=re.IGNORECASE)
            expression, expr_rest = _split_attribute_type_and_modifiers(remaining)
            attribute.expression = expression
            remaining = expr_rest.strip()
            continue
        if re.match(r"^HIERARCHICAL\b", remaining, re.IGNORECASE):
            attribute.hierarchical = True
            remaining = re.sub(
                r"^HIERARCHICAL\b", "", remaining, flags=re.IGNORECASE
            ).strip()
            continue
        if re.match(r"^BIDIRECTIONAL\b", remaining, re.IGNORECASE):
            attribute.bidirectional = True
            remaining = re.sub(
                r"^BIDIRECTIONAL\b", "", remaining, flags=re.IGNORECASE
            ).strip()
            continue
        if re.match(r"^INJECTIVE\b", remaining, re.IGNORECASE):
            attribute.injective = True
            remaining = re.sub(
                r"^INJECTIVE\b", "", remaining, flags=re.IGNORECASE
            ).strip()
            continue
        if re.match(r"^IS_OBJECT_ID\b", remaining, re.IGNORECASE):
            attribute.is_object_id = True
            remaining = re.sub(
                r"^IS_OBJECT_ID\b", "", remaining, flags=re.IGNORECASE
            ).strip()
            continue
        break


def parse_dictionary_attributes_from_create_dictionary_query(
    query: str | None,
) -> list[ParsedDictionaryAttribute]:
    body = _extract_create_dictionary_body(query)
    if body is None:
        return []
    attributes: list[ParsedDictionaryAttribute] = []
    for part in split_top_level_comma(body):
        trimmed = part.strip()
        if not trimmed:
            continue
        name_match = _ATTRIBUTE_NAME_RE.match(trimmed)
        if name_match is None:
            continue
        name = (name_match.group(1) or name_match.group(2) or "").strip()
        rest = (name_match.group(3) or "").strip()
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
    options = _extract_dictionary_options(query)
    match = _PRIMARY_KEY_RE.search(options)
    raw = match.group(1).strip() if match is not None else ""
    if not raw:
        return []
    out: list[str] = []
    for part in split_top_level_comma(raw):
        # At most one backtick per side (TS `.replace(/^`|`$/g, '')`), so a
        # doubly-quoted pathological token stays distinguishable.
        token = part.strip()
        token = token.removeprefix("`").removesuffix("`")
        if token:
            out.append(token)
    return out


def parse_source_from_create_dictionary_query(query: str | None) -> str | None:
    if not query:
        return None
    return _extract_keyword_paren_body(query, "SOURCE")


def parse_layout_from_create_dictionary_query(query: str | None) -> str | None:
    if not query:
        return None
    return _extract_keyword_paren_body(query, "LAYOUT")


def parse_lifetime_from_create_dictionary_query(query: str | None) -> str | None:
    if not query:
        return None
    return _extract_keyword_paren_body(query, "LIFETIME")


def parse_comment_from_create_dictionary_query(query: str | None) -> str | None:
    if not query:
        return None
    match = _COMMENT_RE.search(query)
    if match is None or not match.group(1):
        return None
    return match.group(1).replace("\\'", "'").replace("''", "'")


def _strip_backticks(value: str) -> str:
    trimmed = value.strip()
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
    match = _RANGE_RE.match(body.strip())
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
        key = part[:eq].strip()
        if not key:
            continue
        value, _rest = _consume_quoted_or_bare_value(part[eq + 1 :].strip())
        out[key] = value
    return out if out else None
