"""Codec spec — parse/render/canonicalize ClickHouse column codecs."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any, Final, TypeAlias

from pydantic import TypeAdapter

from chkit.core.model import (
    ColumnCodec,
    ColumnCodecSpec,
    GeneralColumnCodec,
    PreprocessingColumnCodec,
    RawColumnCodec,
)

CodecSpecInput: TypeAlias = ColumnCodecSpec | Mapping[str, Any] | list[ColumnCodec | Mapping[str, Any]]
"""Loose input accepted by public entry points: dicts or models, single or list."""

_GENERAL_KINDS: Final[frozenset[str]] = frozenset(
    {"NONE", "LZ4", "LZ4HC", "ZSTD", "T64", "GCD", "ALP"}
)
_PREPROCESSOR_KINDS: Final[frozenset[str]] = frozenset(
    {"Delta", "DoubleDelta", "Gorilla", "FPC"}
)


_GENERAL_ADAPTER: Final[TypeAdapter[GeneralColumnCodec]] = TypeAdapter(GeneralColumnCodec)
_PREPROCESSOR_ADAPTER: Final[TypeAdapter[PreprocessingColumnCodec]] = TypeAdapter(
    PreprocessingColumnCodec
)
_CODEC_ADAPTER: Final[TypeAdapter[ColumnCodec]] = TypeAdapter(ColumnCodec)


def _normalize_atom(atom: ColumnCodec | Mapping[str, Any]) -> ColumnCodec:
    if isinstance(atom, Mapping):
        return _CODEC_ADAPTER.validate_python(dict(atom))
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
    data = step.model_dump()
    kind = str(data["kind"])
    if kind in {"NONE", "LZ4", "T64", "GCD", "ALP"}:
        return kind
    if kind == "LZ4HC":
        level = data.get("level")
        return f"LZ4HC({level})" if level is not None else "LZ4HC"
    if kind == "ZSTD":
        level = data.get("level")
        return f"ZSTD({level})" if level is not None else "ZSTD"
    if kind in {"Delta", "DoubleDelta", "Gorilla"}:
        size = data.get("size")
        return f"{kind}({size})" if size is not None else kind
    if kind == "FPC":
        return f"FPC({data['level']}, {data['float_size']})"
    if kind == "raw":
        return str(data["expression"])
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

    if name in {"NONE", "LZ4", "T64", "GCD", "ALP"}:
        if args is not None:
            return None
        return _GENERAL_ADAPTER.validate_python({"kind": name})
    if name == "LZ4HC":
        if args is None:
            return _GENERAL_ADAPTER.validate_python({"kind": "LZ4HC"})
        if len(args) != 1:
            return None
        level = _as_finite(args[0])
        if level is None:
            return None
        return _GENERAL_ADAPTER.validate_python({"kind": "LZ4HC", "level": int(level)})
    if name == "ZSTD":
        if args is None:
            return _GENERAL_ADAPTER.validate_python({"kind": "ZSTD"})
        if len(args) != 1:
            return None
        level = _as_finite(args[0])
        if level is None:
            return None
        return _GENERAL_ADAPTER.validate_python({"kind": "ZSTD", "level": int(level)})
    if name in {"Delta", "DoubleDelta", "Gorilla"}:
        if args is None:
            return _PREPROCESSOR_ADAPTER.validate_python({"kind": name})
        if len(args) != 1:
            return None
        size_float = _as_finite(args[0])
        if size_float is None:
            return None
        size = int(size_float)
        if size not in {1, 2, 4, 8}:
            return None
        return _PREPROCESSOR_ADAPTER.validate_python({"kind": name, "size": size})
    if name == "FPC":
        if args is None or len(args) != 2:
            return None
        level = _as_finite(args[0])
        float_size_value = _as_finite(args[1])
        if level is None or float_size_value is None:
            return None
        float_size_int = int(float_size_value)
        if float_size_int not in {4, 8}:
            return None
        return _PREPROCESSOR_ADAPTER.validate_python(
            {"kind": "FPC", "level": int(level), "floatSize": float_size_int}
        )
    return None


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


def _canonicalize_step(step: ColumnCodec) -> ColumnCodec:
    data = step.model_dump()
    kind = str(data["kind"])
    if kind == "ZSTD":
        level = data.get("level")
        return _GENERAL_ADAPTER.validate_python(
            {"kind": "ZSTD", "level": level if level is not None else 1}
        )
    if kind == "LZ4HC":
        level = data.get("level")
        return _GENERAL_ADAPTER.validate_python(
            {"kind": "LZ4HC", "level": level if level is not None else 9}
        )
    if kind in {"Delta", "DoubleDelta", "Gorilla"}:
        size = data.get("size")
        return _PREPROCESSOR_ADAPTER.validate_python(
            {"kind": kind, "size": size if size is not None else 1}
        )
    if kind == "FPC":
        return _PREPROCESSOR_ADAPTER.validate_python(
            {
                "kind": "FPC",
                "level": data["level"],
                "floatSize": data["float_size"],
            }
        )
    if kind == "raw":
        return RawColumnCodec(expression=str(data["expression"]).strip())
    return _GENERAL_ADAPTER.validate_python({"kind": kind})


def canonicalize_codec(spec: CodecSpecInput) -> list[ColumnCodec]:
    """Normalize spec to array form with ClickHouse defaults filled in."""
    return [_canonicalize_step(s) for s in _to_list(spec)]


def codecs_equal(a: CodecSpecInput | None, b: CodecSpecInput | None) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    canon_a = [step.model_dump() for step in canonicalize_codec(a)]
    canon_b = [step.model_dump() for step in canonicalize_codec(b)]
    return canon_a == canon_b


def codec_raw(expression: str) -> RawColumnCodec:
    return RawColumnCodec(expression=expression.strip())
