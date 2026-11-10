"""Shared integer literals for codec arguments and Enum values."""

from __future__ import annotations

import re
from typing import Final

_UINT64_SIGN: Final[int] = 2**63
_UINT64_RANGE: Final[int] = 2**64
_MAX_SAFE: Final[int] = 2**53 - 1
_UINT64_DECIMAL_DIGITS: Final[int] = 20


# The integer literals ClickHouse takes as a codec argument; a float such as `1.0` is not one.
# Beyond ±(2^53 - 1) a JS number is not exact, so such an argument stays unparsed, as in TS.
_INTEGER_ARG: Final[re.Pattern[str]] = re.compile(
    r"[+-]?(?:0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|0b[01]+(?:_[01]+)*|[0-9]+(?:_[0-9]+)*)"
)


def parse_integer_arg(raw: str) -> int | None:
    """An integer codec argument as ClickHouse reads it.

    Decimal (``1_0`` is 10), ``0x`` hex or ``0b`` binary, optionally signed.
    ClickHouse prints a negative level unsigned: ``ZSTD(-1)`` reads back as
    ``ZSTD(18446744073709551615)``.
    """
    signed = parse_integer_literal(raw)
    if signed is None:
        return None
    value = signed - _UINT64_RANGE if signed >= _UINT64_SIGN else signed
    return value if -_MAX_SAFE <= value <= _MAX_SAFE else None


def parse_integer_literal(raw: str) -> int | None:
    """An exact integer literal, before codec argument wrapping and JS number bounds."""
    if _INTEGER_ARG.fullmatch(raw) is None:
        return None
    digits = raw.lstrip("+-").replace("_", "")
    if digits[:2] in ("0x", "0X"):
        magnitude = int(digits[2:], 16)
    elif digits[:2] == "0b":
        magnitude = int(digits[2:], 2)
    else:
        # More than 20 digits is beyond UInt64; int() refuses very long strings.
        decimal = digits.lstrip("0") or "0"
        if len(decimal) > _UINT64_DECIMAL_DIGITS:
            return None
        magnitude = int(decimal, 10)
    if magnitude >= _UINT64_RANGE:
        return None
    return -magnitude if raw.startswith("-") else magnitude
