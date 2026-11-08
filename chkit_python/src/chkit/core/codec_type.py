"""The value types a column codec sees.

1:1 port of ``packages/core/src/codec-type.ts``. ClickHouse applies a codec to
each data stream of a column: the values inside Nullable, Array and
LowCardinality, and each element of a Tuple or Map. Array sizes and null maps
are not codec input.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, Literal, TypeAlias

from chkit.core.codec_integer import parse_integer_arg
from chkit.core.sql_lexer import JS_WHITESPACE, js_trim

CodecTypeFamily: TypeAlias = Literal[
    "int",
    "bool",
    "float",
    "bfloat16",
    "decimal",
    "date",
    "time",
    "enum",
    "ipv4",
    "ipv6",
    "uuid",
    "string",
    "fixedstring",
]


@dataclass(frozen=True)
class CodecValueType:
    """A value type of a column. ``width`` is its size in bytes when known."""

    type: str
    family: CodecTypeFamily
    width: int | None = None


_WRAPPER_RE: Final = re.compile(
    rf"^(Nullable|Array|LowCardinality)[{JS_WHITESPACE}]*\(([\s\S]*)\)$"
)
_TUPLE_RE: Final = re.compile(rf"^Tuple[{JS_WHITESPACE}]*\(([\s\S]*)\)$")
_MAP_RE: Final = re.compile(rf"^Map[{JS_WHITESPACE}]*\(([\s\S]*)\)$")
_AGGREGATE_RE: Final = re.compile(
    rf"^SimpleAggregateFunction[{JS_WHITESPACE}]*\(([\s\S]*)\)$"
)


def codec_value_types(column_type: str) -> list[CodecValueType] | None:
    """The value types of a column type, or None when one of them is a type
    chkit does not model (JSON, Dynamic, Variant, Nested, AggregateFunction, ...)."""
    type_ = js_trim(column_type)
    wrapper = _WRAPPER_RE.match(type_)
    if wrapper is not None:
        return codec_value_types(wrapper.group(2))
    aggregate = _AGGREGATE_RE.match(type_)
    if aggregate is not None:
        args = _split_type_arguments(aggregate.group(1))
        return codec_value_types(args[1]) if len(args) == 2 else None  # noqa: PLR2004 - function, type
    tuple_ = _TUPLE_RE.match(type_)
    if tuple_ is not None:
        return _collect([_strip_element_name(e) for e in _split_type_arguments(tuple_.group(1))])
    map_ = _MAP_RE.match(type_)
    if map_ is not None:
        return _collect(_split_type_arguments(map_.group(1)))
    leaf = _leaf_type(type_)
    return [leaf] if leaf is not None else None


def codec_has_reachable_float(column_type: str) -> bool | None:
    """Whether a float is reachable without entering Map or LowCardinality.

    Unknown types stay unknown.
    """
    type_ = js_trim(column_type)
    if re.match(rf"^(LowCardinality|Map)[{JS_WHITESPACE}]*\(", type_):
        return False
    wrapper = re.match(rf"^(Nullable|Array)[{JS_WHITESPACE}]*\(([\s\S]*)\)$", type_)
    if wrapper is not None:
        return codec_has_reachable_float(wrapper.group(2))
    aggregate = _AGGREGATE_RE.match(type_)
    if aggregate is not None:
        args = _split_type_arguments(aggregate.group(1))
        return codec_has_reachable_float(args[1]) if len(args) == 2 else None  # noqa: PLR2004 - function, type
    tuple_ = _TUPLE_RE.match(type_)
    if tuple_ is not None:
        floats = [
            codec_has_reachable_float(_strip_element_name(element))
            for element in _split_type_arguments(tuple_.group(1))
        ]
        if True in floats:
            return True
        return None if None in floats else False
    leaf = _leaf_type(type_)
    return leaf.family in {"float", "bfloat16"} if leaf is not None else None


def codec_value_width(column_type: str) -> int | None:
    """The byte width ClickHouse fills in for a bare ``Delta`` or ``Gorilla``.

    None (the codec stays bare) when the column's values differ in width, as in
    ``Tuple(UInt8, UInt64)``, or are unknown.
    """
    values = codec_value_types(column_type)
    widths = {value.width for value in values} if values is not None else set()
    if len(widths) != 1:
        return None
    return next(iter(widths))


def _collect(types: list[str]) -> list[CodecValueType] | None:
    out: list[CodecValueType] = []
    for type_ in types:
        values = codec_value_types(type_)
        if values is None:
            return None
        out.extend(values)
    return out


_INTEGER_TYPE: Final = re.compile(r"^U?Int(8|16|32|64|128|256)$")
_DECIMAL_SIZED_TYPE: Final = re.compile(rf"^Decimal(32|64|128|256)[{JS_WHITESPACE}]*\(")
_DECIMAL_TYPE: Final = re.compile(rf"^Decimal[{JS_WHITESPACE}]*\([{JS_WHITESPACE}]*([0-9]+)")
_FIXED_STRING_TYPE: Final = re.compile(
    rf"^FixedString[{JS_WHITESPACE}]*\([{JS_WHITESPACE}]*([0-9]+)[{JS_WHITESPACE}]*\)$"
)

_SIMPLE_TYPES: Final[dict[str, tuple[CodecTypeFamily, int | None]]] = {
    "Bool": ("bool", 1),
    "Boolean": ("bool", 1),
    "Float32": ("float", 4),
    "Float64": ("float", 8),
    "BFloat16": ("bfloat16", 2),
    "Date": ("date", 2),
    "Date32": ("date", 4),
    "Time": ("time", 4),
    "IPv4": ("ipv4", 4),
    "IPv6": ("ipv6", 16),
    "UUID": ("uuid", 16),
    "String": ("string", None),
}


def _leaf_type(type_: str) -> CodecValueType | None:  # noqa: PLR0911 - one branch per type family
    integer = _INTEGER_TYPE.match(type_)
    if integer is not None:
        return CodecValueType(type_, "int", int(integer.group(1)) // 8)
    sized_decimal = _DECIMAL_SIZED_TYPE.match(type_)
    if sized_decimal is not None:
        return CodecValueType(type_, "decimal", int(sized_decimal.group(1)) // 8)
    decimal = _DECIMAL_TYPE.match(type_)
    if decimal is not None:
        return CodecValueType(type_, "decimal", _decimal_width(int(decimal.group(1))))
    fixed_string = _FIXED_STRING_TYPE.match(type_)
    if fixed_string is not None:
        return CodecValueType(type_, "fixedstring", int(fixed_string.group(1)))
    if re.match(rf"^DateTime64[{JS_WHITESPACE}]*\(", type_):
        return CodecValueType(type_, "date", 8)
    if re.match(rf"^DateTime(?:[{JS_WHITESPACE}]*\(|$)", type_):
        return CodecValueType(type_, "date", 4)
    if re.match(rf"^Time64[{JS_WHITESPACE}]*\(", type_):
        return CodecValueType(type_, "time", 8)
    if re.match(rf"^Enum8[{JS_WHITESPACE}]*\(", type_):
        return CodecValueType(type_, "enum", 1)
    if re.match(rf"^Enum16[{JS_WHITESPACE}]*\(", type_):
        return CodecValueType(type_, "enum", 2)
    enumeration = re.match(rf"^Enum[{JS_WHITESPACE}]*\(([\s\S]*)\)$", type_)
    if enumeration is not None:
        return CodecValueType(type_, "enum", _enum_width(enumeration.group(1)))
    simple = _SIMPLE_TYPES.get(type_)
    return CodecValueType(type_, *simple) if simple is not None else None


def _decimal_width(precision: int) -> int:
    if precision <= 9:  # noqa: PLR2004
        return 4
    if precision <= 18:  # noqa: PLR2004
        return 8
    if precision <= 38:  # noqa: PLR2004
        return 16
    return 32


_ENUM_ENTRY_RE: Final = re.compile(
    r"^'(?:\\[\s\S]|''|[^'\\])*'"
    rf"(?:[{JS_WHITESPACE}]*=[{JS_WHITESPACE}]*([^{JS_WHITESPACE}]+))?[{JS_WHITESPACE}]*$"
)


def _enum_width(arguments_text: str) -> int | None:
    previous = 0
    fits_int8 = True
    for entry in _split_type_arguments(arguments_text):
        match = _ENUM_ENTRY_RE.match(entry)
        if match is None:
            return None
        value = previous + 1 if match.group(1) is None else parse_integer_arg(match.group(1))
        if value is None:
            return None
        fits_int8 = fits_int8 and -128 <= value <= 127  # noqa: PLR2004 - Int8 bounds
        previous = value
    return 1 if fits_int8 else 2


_ELEMENT_NAME_RE: Final = re.compile(
    r'^(?:`(?:\\[\s\S]|``|[^`\\])*`|"(?:\\[\s\S]|""|[^"\\])*"|[A-Za-z_][A-Za-z0-9_]*)'
    rf"[{JS_WHITESPACE}]+([^{JS_WHITESPACE}][\s\S]*)$"
)


def _strip_element_name(element: str) -> str:
    """``a UInt8`` or ```a b` UInt8`` in a named Tuple is the element type ``UInt8``."""
    named = _ELEMENT_NAME_RE.match(js_trim(element))
    return named.group(1) if named is not None else element


def _split_type_arguments(text: str) -> list[str]:
    """Split type arguments on top-level commas, outside parentheses and quotes."""
    out: list[str] = []
    depth = 0
    quote: str | None = None
    current: list[str] = []
    escaped = False
    for ch in text:
        if quote is not None:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = None
        elif ch in {"'", "`", '"'}:
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(js_trim("".join(current)))
            current = []
            continue
        current.append(ch)
    out.append(js_trim("".join(current)))
    return out
