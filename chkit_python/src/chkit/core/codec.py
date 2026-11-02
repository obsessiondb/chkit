"""Codec spec — parse/render/canonicalize ClickHouse column codecs."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any, Final, Literal, NamedTuple, TypeAlias

from pydantic import BaseModel, TypeAdapter, ValidationError

from chkit.core.codec_type import codec_value_width
from chkit.core.model import (
    ColumnCodec,
    ColumnCodecSpec,
    GeneralColumnCodec,
    InvalidColumnCodec,
    PreprocessingColumnCodec,
    RawColumnCodec,
    _CodecDeltaLike,
    _CodecFPC,
    _CodecLZ4HC,
    _CodecT64,
    _CodecZSTD,
)
from chkit.core.sql_lexer import JS_WHITESPACE_RUN

CodecSpecInput: TypeAlias = ColumnCodecSpec | Mapping[str, Any] | list[ColumnCodec | Mapping[str, Any]]
"""Loose input accepted by public entry points: dicts or models, single or list."""

_GENERAL_KINDS: Final[frozenset[str]] = frozenset(
    {"NONE", "LZ4", "LZ4HC", "ZSTD", "Default"}
)
_PREPROCESSOR_KINDS: Final[frozenset[str]] = frozenset(
    {"Delta", "DoubleDelta", "Gorilla", "GCD", "T64", "FPC", "ALP"}
)

_CODEC_FIELDS: Final[dict[str, tuple[str, ...]]] = {
    "NONE": (),
    "LZ4": (),
    "LZ4HC": ("level",),
    "ZSTD": ("level", "windowLog"),
    "Default": (),
    "Delta": ("size",),
    "DoubleDelta": ("size",),
    "Gorilla": ("size",),
    "GCD": (),
    "T64": ("mode",),
    "FPC": ("level", "floatSize"),
    "ALP": (),
    "raw": ("expression",),
}
"""The fields each codec kind takes, in the order they are reported."""

CODEC_KINDS: Final[tuple[str, ...]] = tuple(_CODEC_FIELDS)
"""The codec kinds, as listed in validation messages."""

# chkit-py's models also take the snake_case spelling of these fields.
_FIELD_ALIASES: Final[dict[str, str]] = {"float_size": "floatSize", "window_log": "windowLog"}


_GENERAL_ADAPTER: Final[TypeAdapter[GeneralColumnCodec]] = TypeAdapter(GeneralColumnCodec)
_PREPROCESSOR_ADAPTER: Final[TypeAdapter[PreprocessingColumnCodec]] = TypeAdapter(
    PreprocessingColumnCodec
)
_CODEC_ADAPTER: Final[TypeAdapter[ColumnCodec]] = TypeAdapter(ColumnCodec)


def _normalize_atom(atom: ColumnCodec | Mapping[str, Any]) -> ColumnCodec:
    if isinstance(atom, Mapping):
        try:
            return _CODEC_ADAPTER.validate_python(dict(atom))
        except ValidationError:
            return InvalidColumnCodec(value=dict(atom))
    return atom


def _to_list(spec: CodecSpecInput) -> list[ColumnCodec]:
    if isinstance(spec, list):
        return [_normalize_atom(a) for a in spec]
    return [_normalize_atom(spec)]


def is_general_codec(codec: ColumnCodec) -> bool:
    return codec.kind in _GENERAL_KINDS


def is_preprocessor_codec(codec: ColumnCodec) -> bool:
    return codec.kind in _PREPROCESSOR_KINDS


def is_raw_codec(codec: ColumnCodec) -> bool:
    return codec.kind == "raw"


def _render_step(step: ColumnCodec) -> str:
    kind = step.kind
    if kind in {"NONE", "LZ4", "Default", "GCD", "ALP"}:
        return kind
    if isinstance(step, _CodecT64):
        return f"T64('{step.mode}')" if step.mode is not None else "T64"
    if isinstance(step, _CodecLZ4HC):
        return f"LZ4HC({step.level})" if step.level is not None else "LZ4HC"
    if isinstance(step, _CodecZSTD):
        if step.window_log is not None:
            return f"ZSTD({1 if step.level is None else step.level}, {step.window_log})"
        return f"ZSTD({step.level})" if step.level is not None else "ZSTD"
    if isinstance(step, _CodecDeltaLike):
        # Without a size ClickHouse fills in the column's value width; it
        # ignores the DoubleDelta size and never stores it.
        if kind == "DoubleDelta" or step.size is None:
            return kind
        return f"{kind}({step.size})"
    if isinstance(step, _CodecFPC):
        if step.float_size is not None:
            return f"FPC({12 if step.level is None else step.level}, {step.float_size})"
        return f"FPC({step.level})" if step.level is not None else "FPC"
    if isinstance(step, RawColumnCodec):
        return step.expression
    msg = f"Unknown codec kind: {kind!r}"
    raise ValueError(msg)


def render_codec(spec: CodecSpecInput) -> str:
    steps = _to_list(spec)
    inner = ", ".join(_render_step(step) for step in steps)
    return f"CODEC({inner})"


_ATOM_PATTERN: Final[re.Pattern[str]] = re.compile(r"^(\w+)(?:\(([^)]*)\))?$")
_CODEC_WRAPPER_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^CODEC\s*\(([\s\S]*)\)\s*$", re.IGNORECASE
)


def _parse_atom(raw: str) -> ColumnCodec | None:
    trimmed = raw.strip()
    if not trimmed:
        return None
    match = _ATOM_PATTERN.match(trimmed)
    if match is None:
        return None
    name, args_raw = match.group(1), match.group(2)
    if not name:
        return None

    if args_raw is None:
        args: list[str] | None = None
    else:
        parts = [value.strip() for value in args_raw.split(",")]
        args = None if len(parts) == 1 and parts[0] == "" else parts

    def _as_finite(value: str) -> float | None:
        try:
            parsed = float(value)
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) else None

    if name in {"NONE", "LZ4", "Default", "GCD", "ALP"}:
        if args is not None:
            return None
        return _CODEC_ADAPTER.validate_python({"kind": name})
    if name == "T64":
        if args is None:
            return _CODEC_ADAPTER.validate_python({"kind": "T64"})
        mode = re.fullmatch(r"'(byte|bit)'", args[0]) if len(args) == 1 else None
        if mode is None:
            return None
        return _CODEC_ADAPTER.validate_python({"kind": "T64", "mode": mode.group(1)})
    if name == "LZ4HC":
        if args is None:
            return _GENERAL_ADAPTER.validate_python({"kind": "LZ4HC"})
        if len(args) != 1:
            return None
        level = _parse_level(args[0])
        if level is None:
            return None
        return _normalize_atom({"kind": "LZ4HC", "level": _number(level)})
    if name == "ZSTD":
        if args is None:
            return _GENERAL_ADAPTER.validate_python({"kind": "ZSTD"})
        if len(args) > 2:
            return None
        level = _parse_level(args[0])
        if level is None:
            return None
        if len(args) == 1:
            return _normalize_atom({"kind": "ZSTD", "level": _number(level)})
        window_log = _as_finite(args[1])
        if window_log is None:
            return None
        return _normalize_atom(
            {"kind": "ZSTD", "level": _number(level), "windowLog": _number(window_log)}
        )
    if name in {"Delta", "DoubleDelta", "Gorilla"}:
        if args is None:
            return _PREPROCESSOR_ADAPTER.validate_python({"kind": name})
        if len(args) != 1:
            return None
        size_float = _as_finite(args[0])
        if size_float is None:
            return None
        if size_float not in {1, 2, 4, 8}:
            return None
        return _PREPROCESSOR_ADAPTER.validate_python({"kind": name, "size": int(size_float)})
    if name == "FPC":
        # ClickHouse stores FPC(level) and drops the float size.
        if args is None:
            return _PREPROCESSOR_ADAPTER.validate_python({"kind": "FPC"})
        if len(args) > 2:
            return None
        level = _as_finite(args[0])
        if level is None:
            return None
        if len(args) == 1:
            return _normalize_atom({"kind": "FPC", "level": _number(level)})
        float_size_value = _as_finite(args[1])
        if float_size_value not in {4, 8}:
            return None
        return _normalize_atom(
            {"kind": "FPC", "level": _number(level), "floatSize": int(float_size_value)}
        )
    return None


def _number(value: float) -> float | int:
    """A parsed argument as chkit (TS) reads it: an integer when it is one."""
    return int(value) if float(value).is_integer() else value


_UINT64_SIGN: Final[int] = 2**63
_UINT64_RANGE: Final[int] = 2**64


def _parse_level(raw: str) -> float | None:
    """ClickHouse prints a negative level unsigned: `ZSTD(-1)` reads back as `ZSTD(18446744073709551615)`."""
    if re.fullmatch(r"[0-9]+", raw) and int(raw) >= _UINT64_SIGN:
        return int(raw) - _UINT64_RANGE
    try:
        parsed = float(raw)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def _split_top_level_commas(text: str) -> list[str]:
    out: list[str] = []
    depth = 0
    current: list[str] = []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            out.append("".join(current))
            current = []
            continue
        current.append(ch)
    if current:
        out.append("".join(current))
    return out


def parse_codec(raw: str | None) -> list[ColumnCodec] | None:
    """Parse a ClickHouse codec expression (e.g. `CODEC(Delta(4), ZSTD(1))`).

    Unknown atoms fall back to a single `raw` codec, mirroring the TS
    implementation so unfamiliar chains still round-trip.
    """
    if raw is None:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None

    inner_match = _CODEC_WRAPPER_PATTERN.match(trimmed)
    stripped = inner_match.group(1).strip() if inner_match is not None else trimmed
    if not stripped:
        return None

    atoms = [a.strip() for a in _split_top_level_commas(stripped) if a.strip()]
    parsed: list[ColumnCodec] = []
    for atom in atoms:
        step = _parse_atom(atom)
        if step is None:
            return [RawColumnCodec(expression=stripped)]
        parsed.append(step)
    return parsed


class RawCodecAtom(NamedTuple):
    """One atom of a raw codec: the typed codec it parses as, or None."""

    codec: ColumnCodec | None
    text: str


def parse_raw_codec_atoms(expression: str) -> list[RawCodecAtom]:
    """Split a raw codec expression into its atoms (``Delta, Default`` is two).

    Each atom's text has no whitespace.
    """
    texts = [JS_WHITESPACE_RUN.sub("", atom) for atom in _split_top_level_commas(expression)]
    return [RawCodecAtom(_parse_atom(text), text) for text in texts if text]


def _canonicalize_step(step: ColumnCodec) -> ColumnCodec:
    # A malformed atom stays as written, so validation reports it.
    if codec_atom_problem(step) is not None:
        return step
    if isinstance(step, _CodecZSTD):
        return step.model_copy(update={"level": 1 if step.level is None else step.level})
    if isinstance(step, _CodecLZ4HC):
        return step.model_copy(update={"level": 9 if step.level is None else step.level})
    if isinstance(step, _CodecDeltaLike) and step.kind == "DoubleDelta":
        return step.model_copy(update={"size": None})
    if isinstance(step, RawColumnCodec):
        return RawColumnCodec(expression=step.expression.strip())
    return step


def canonicalize_codec(spec: CodecSpecInput) -> list[ColumnCodec]:
    """Normalize spec to array form with ClickHouse's default levels filled in.

    A ``Delta``/``Gorilla`` without a size stays bare: its width depends on
    the column type. Does not reorder chain steps.
    """
    return [_canonicalize_step(s) for s in _to_list(spec)]


def codec_fingerprint(spec: CodecSpecInput | None, column_type: str | None = None) -> str:
    """The codec in the form `system.columns.compression_codec` reports it (#383).

    A schema codec and the live one compare equal however either is spelled;
    the planner, drift and pull all compare codecs this way (#465). ClickHouse
    stores a bare `ZSTD` as `ZSTD(1)` and a bare `LZ4HC` as `LZ4HC(0)`, which
    like any level below 1 means the default 9. It fills in the column's value
    width for a bare `Delta` or `Gorilla` (`Delta(8)` on UInt64, still bare on a
    mixed-width Tuple), keeps no `DoubleDelta` width, no `FPC` float size and
    no `T64('byte')` mode. Atoms of a raw codec that parse get the same
    treatment; the others compare without whitespace. No codec is the empty
    string.
    """
    if spec is None:
        return ""
    width = None if column_type is None else codec_value_width(column_type)
    parts: list[str] = []
    for step in _to_list(spec):
        if isinstance(step, RawColumnCodec):
            parts.extend(
                _step_fingerprint(atom.codec, width) if atom.codec is not None else atom.text
                for atom in parse_raw_codec_atoms(step.expression)
            )
        else:
            parts.append(_step_fingerprint(step, width))
    return ",".join(parts)


def _step_fingerprint(step: ColumnCodec, width: int | None) -> str:
    if isinstance(step, _CodecZSTD):
        level = 1 if step.level is None else step.level
        window = "" if step.window_log is None else f",{step.window_log}"
        return f"ZSTD({level}{window})"
    if isinstance(step, _CodecLZ4HC):
        return f"LZ4HC({step.level if step.level is not None and step.level >= 1 else 9})"
    if isinstance(step, _CodecDeltaLike):
        if step.kind == "DoubleDelta":
            return "DoubleDelta"
        size = step.size if step.size is not None else width
        return f"{step.kind}({size})" if size is not None else step.kind
    if isinstance(step, _CodecT64):
        return "T64('bit')" if step.mode == "bit" else "T64"
    if isinstance(step, _CodecFPC):
        return f"FPC({12 if step.level is None else step.level})"
    if isinstance(step, RawColumnCodec):
        return step.expression
    return str(step.kind)


def codecs_equal(
    a: CodecSpecInput | None, b: CodecSpecInput | None, column_type: str | None = None
) -> bool:
    """Whether two codecs are stored the same way.

    Pass the column type so a bare ``Delta`` or ``Gorilla`` equals the width
    ClickHouse fills in.
    """
    return codec_fingerprint(a, column_type) == codec_fingerprint(b, column_type)


class CodecAtomProblem(NamedTuple):
    """What is wrong with one codec atom of a schema, before chain and type rules."""

    code: Literal["codec_unknown", "codec_parameter_invalid"]
    message: str
    """Completes ``Table db.t column "c" ``."""


def codec_atom_problem(step: object) -> CodecAtomProblem | None:
    """Check the shape of one codec atom as a schema wrote it.

    A known kind, only that kind's fields, and parameters ClickHouse accepts:
    the checks and messages of chkit (TS), also for the atoms chkit-py's models
    reject (#465).
    """
    data = _atom_data(step)
    kind = data.get("kind") if isinstance(data, dict) else None
    if not isinstance(data, dict) or not isinstance(kind, str):
        return CodecAtomProblem(
            "codec_unknown", f"has a codec without a kind; use one of {', '.join(CODEC_KINDS)}"
        )
    fields = _CODEC_FIELDS.get(kind)
    if fields is None:
        return CodecAtomProblem(
            "codec_unknown",
            f'has an unknown codec kind "{kind}"; codec kinds are case-sensitive: '
            f"{', '.join(CODEC_KINDS)}",
        )
    for field, value in data.items():
        if field != "kind" and value is not None and field not in fields:
            return CodecAtomProblem(
                "codec_parameter_invalid", f'codec {kind} has an unknown field "{field}"'
            )
    problem = _codec_parameter_problem(kind, data)
    if problem is not None:
        return CodecAtomProblem("codec_parameter_invalid", f"codec {kind} {problem}")
    if isinstance(step, InvalidColumnCodec):
        # A value chkit accepts but chkit-py's models do not (e.g. a float level).
        return CodecAtomProblem("codec_parameter_invalid", f"codec {kind} is invalid")
    return None


def _atom_data(step: object) -> object:
    if isinstance(step, InvalidColumnCodec):
        value = step.value
        if isinstance(value, Mapping):
            return {_FIELD_ALIASES.get(str(k), str(k)): v for k, v in value.items()}
        return value
    if isinstance(step, BaseModel):
        return step.model_dump(by_alias=True, exclude_none=True)
    if isinstance(step, Mapping):
        return {_FIELD_ALIASES.get(str(k), str(k)): v for k, v in step.items()}
    return step


def _codec_parameter_problem(kind: str, data: dict[str, Any]) -> str | None:
    level = data.get("level")
    if kind == "LZ4HC":
        return "level must be an integer" if level is not None and not _is_int(level) else None
    if kind == "ZSTD":
        if level is not None and not _is_int(level):
            return "level must be an integer"
        if isinstance(level, int) and _is_int(level) and level > 22:
            return "level must be at most 22"
        window_log = data.get("windowLog")
        if window_log is not None and not (
            isinstance(window_log, int) and _is_int(window_log) and 10 <= window_log <= 31
        ):
            return "windowLog must be an integer between 10 and 31"
        return None
    if kind in {"Delta", "DoubleDelta", "Gorilla"}:
        size = data.get("size")
        if size is not None and not _is_one_of(size, (1, 2, 4, 8)):
            return "size must be 1, 2, 4 or 8"
        return None
    if kind == "T64":
        mode = data.get("mode")
        if mode is not None and mode not in ("byte", "bit"):
            return "mode must be 'byte' or 'bit'"
        return None
    if kind == "FPC":
        if level is not None and not (isinstance(level, int) and _is_int(level) and 1 <= level <= 28):
            return "level must be an integer between 1 and 28"
        float_size = data.get("floatSize")
        if float_size is not None and not _is_one_of(float_size, (4, 8)):
            return "floatSize must be 4 or 8"
        return None
    if kind == "raw":
        expression = data.get("expression")
        if isinstance(expression, str) and expression.strip():
            return None
        return "expression must be a non-empty string"
    return None


def _is_int(value: object) -> bool:
    # chkit-py's models take ints only, never bools or floats.
    return isinstance(value, int) and not isinstance(value, bool)


def _is_one_of(value: object, allowed: tuple[int, ...]) -> bool:
    return _is_int(value) and value in allowed


def codec_raw(expression: str) -> RawColumnCodec:
    return RawColumnCodec(expression=expression.strip())
