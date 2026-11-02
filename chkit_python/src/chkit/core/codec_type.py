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
    """A value type of a column. ``width`` is its size in bytes, unknown for ``Enum(...)``."""

    type: str
    family: CodecTypeFamily
    width: int | None = None


_WRAPPER_RE: Final = re.compile(r"^(Nullable|Array|LowCardinality)\(([\s\S]*)\)$")
_TUPLE_RE: Final = re.compile(r"^Tuple\(([\s\S]*)\)$")
_MAP_RE: Final = re.compile(r"^Map\(([\s\S]*)\)$")


def codec_value_types(column_type: str) -> list[CodecValueType] | None:
    """The value types of a column type, or None when one of them is a type
    chkit does not model (JSON, Dynamic, Variant, Nested, AggregateFunction, ...)."""
    type_ = column_type.strip()
    wrapper = _WRAPPER_RE.match(type_)
    if wrapper is not None:
        return codec_value_types(wrapper.group(2))
    tuple_ = _TUPLE_RE.match(type_)
    if tuple_ is not None:
        return _collect([_strip_element_name(e) for e in _split_type_arguments(tuple_.group(1))])
    map_ = _MAP_RE.match(type_)
    if map_ is not None:
        return _collect(_split_type_arguments(map_.group(1)))
    leaf = _leaf_type(type_)
    return [leaf] if leaf is not None else None


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
_DECIMAL_SIZED_TYPE: Final = re.compile(r"^Decimal(32|64|128|256)\(")
_DECIMAL_TYPE: Final = re.compile(r"^Decimal\(\s*(\d+)")
_FIXED_STRING_TYPE: Final = re.compile(r"^FixedString\(\s*(\d+)\s*\)$")

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
    if re.match(r"^DateTime64\(", type_):
        return CodecValueType(type_, "date", 8)
    if re.match(r"^DateTime(\(|$)", type_):
        return CodecValueType(type_, "date", 4)
    if re.match(r"^Time64\(", type_):
        return CodecValueType(type_, "time", 8)
    if re.match(r"^Enum8\(", type_):
        return CodecValueType(type_, "enum", 1)
    if re.match(r"^Enum16\(", type_):
        return CodecValueType(type_, "enum", 2)
    if re.match(r"^Enum\(", type_):
        return CodecValueType(type_, "enum")
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


_ELEMENT_NAME_RE: Final = re.compile(r'^(?:`[^`]*`|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)\s+(\S[\s\S]*)$')


def _strip_element_name(element: str) -> str:
    """``a UInt8`` or ```a b` UInt8`` in a named Tuple is the element type ``UInt8``."""
    named = _ELEMENT_NAME_RE.match(element.strip())
    return named.group(1) if named is not None else element


def _split_type_arguments(text: str) -> list[str]:
    """Split type arguments on top-level commas, outside parentheses and quotes."""
    out: list[str] = []
    depth = 0
    quote: str | None = None
    current: list[str] = []
    for ch in text:
        if quote is not None:
            if ch == quote:
                quote = None
        elif ch in {"'", "`", '"'}:
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append("".join(current).strip())
            current = []
            continue
        current.append(ch)
    out.append("".join(current).strip())
    return out
