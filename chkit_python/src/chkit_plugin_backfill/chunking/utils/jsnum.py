"""JS number semantics for boundary math.

The chunking planner does its numeric/datetime boundary arithmetic with JS
``Number`` (float64) + ``String(n)`` round-trips. Python floats are the same
IEEE-754 doubles, but ``str(float)`` formats differently (``43.0`` vs ``43``,
e-notation thresholds, shortest-digits vs exact-integer digits above 2^53).
These helpers pin the JS behaviour so boundary strings emitted by the Python
planner match the TS planner byte-for-byte.
"""

from __future__ import annotations

import math
import re

# JS Number() grammar (after trimming JS whitespace): decimal with optional
# exponent, hex/octal/binary literals, Infinity, empty string == 0. Compiled
# with re.ASCII so `\d` matches [0-9] only, like the JS grammar (JS Number()
# rejects Unicode digits).
_JS_WS = (
    "\t\n\v\f\r \u00a0\u1680\u2000-\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_TRIM_RE = re.compile(f"^[{_JS_WS}]+|[{_JS_WS}]+$")
_DECIMAL_RE = re.compile(
    r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$", re.ASCII
)
_HEX_RE = re.compile(r"^0[xX][0-9a-fA-F]+$", re.ASCII)
_OCT_RE = re.compile(r"^0[oO][0-7]+$", re.ASCII)
_BIN_RE = re.compile(r"^0[bB][01]+$", re.ASCII)

_JS_POSITIONAL_EXP_MIN = -7  # exclusive: exponent -7 → e-notation in JS
_JS_POSITIONAL_EXP_MAX = 21  # exclusive: exponent 21 → e-notation in JS


def parse_js_number(raw: str) -> float:  # noqa: PLR0911 — Number() grammar arms
    """Replicate JS ``Number(raw)`` for string input (NaN on failure)."""
    value = _TRIM_RE.sub("", raw)
    if value == "":
        return 0.0
    if value in {"Infinity", "+Infinity"}:
        return math.inf
    if value == "-Infinity":
        return -math.inf
    if _HEX_RE.match(value):
        return float(int(value, 16))
    if _OCT_RE.match(value):
        return float(int(value, 8))
    if _BIN_RE.match(value):
        return float(int(value, 2))
    if _DECIMAL_RE.match(value):
        return float(value)
    return math.nan


def js_number_to_string(value: float) -> str:  # noqa: PLR0911 — String() grammar arms
    """Replicate JS ``String(number)`` for finite doubles.

    JS prints the *shortest round-trip digits* (which Python's ``repr`` also
    produces) and switches to e-notation only outside ``[1e-6, 1e21)``. The
    digits are therefore taken from ``repr`` and re-positioned, never from
    exact-integer expansion (``str(int(v))`` diverges from JS above 2^53) or
    fixed-precision formatting (``format(v, 'f')`` rounds at 6 decimals).
    """
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"  # JS String(-0) is also "0"
    text = repr(value)
    if "e" not in text and "E" not in text:
        # Python positional repr range (1e-4 .. 1e16) is a subset of JS's
        # positional range, so the digits can be reused directly.
        return text[:-2] if text.endswith(".0") else text
    mantissa, _, exponent_text = text.partition("e")
    exponent = int(exponent_text)
    sign = "-" if mantissa.startswith("-") else ""
    digits = mantissa.lstrip("-").replace(".", "")
    if _JS_POSITIONAL_EXP_MIN < exponent < _JS_POSITIONAL_EXP_MAX:
        # Expand the shortest-repr digits into positional notation.
        if exponent >= 0:
            int_len = exponent + 1
            if int_len >= len(digits):
                return sign + digits + "0" * (int_len - len(digits))
            return sign + digits[:int_len] + "." + digits[int_len:]
        return sign + "0." + "0" * (-exponent - 1) + digits
    js_mantissa = digits[0] + (f".{digits[1:]}" if len(digits) > 1 else "")
    exponent_sign = "+" if exponent >= 0 else "-"
    return f"{sign}{js_mantissa}e{exponent_sign}{abs(exponent)}"


__all__ = ["js_number_to_string", "parse_js_number"]
