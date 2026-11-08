"""The rules ClickHouse applies to a column codec, checked at generate (#465).

1:1 port of ``packages/core/src/codec-rules.ts``: ClickHouse 26.3 with
``allow_suspicious_codecs = 0``, so a bad codec fails ``generate`` instead of a
migration partway.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal, TypeAlias

from chkit.core.codec import codec_atom_problem, parse_raw_codec_atoms
from chkit.core.codec_type import CodecValueType, codec_has_reachable_float, codec_value_types
from chkit.core.model import (
    ColumnCodec,
    ColumnCodecSpec,
    RawColumnCodec,
    ValidationIssueCode,
    _CodecDeltaLike,
)
from chkit.core.sql_lexer import js_trim


@dataclass(frozen=True)
class CodecProblem:
    code: ValidationIssueCode
    message: str
    """Completes ``Table db.t column "c" ``."""


CodecClass: TypeAlias = Literal[
    "none", "general", "transform", "compression", "encryption", "unknown"
]


@dataclass(frozen=True)
class _ChainStep:
    kind: str
    codec_class: CodecClass
    codec: ColumnCodec | None = None
    """The typed codec, also for an atom of a raw codec that parses as one."""


_CODEC_CLASSES: Final[dict[str, CodecClass]] = {
    "NONE": "none",
    "LZ4": "general",
    "LZ4HC": "general",
    "ZSTD": "general",
    "Default": "general",
    "Delta": "transform",
    "GCD": "transform",
    "DoubleDelta": "compression",
    "Gorilla": "compression",
    "T64": "compression",
    "FPC": "compression",
    "ALP": "compression",
    "AES_128_GCM_SIV": "encryption",
    "AES_256_GCM_SIV": "encryption",
}

_GENERAL_LIST: Final = "LZ4, LZ4HC, ZSTD, Default"
_FLOAT_SERIES_KINDS: Final = frozenset({"Gorilla", "FPC", "ALP"})


def column_codec_problem(spec: ColumnCodecSpec, column_type: str) -> CodecProblem | None:
    """The first problem of a column codec, or None when ClickHouse accepts it."""
    atoms = spec if isinstance(spec, list) else [spec]
    if not atoms:
        return CodecProblem(
            "codec_chain_empty",
            "codec chain is empty; provide at least one codec or omit the field",
        )
    steps: list[_ChainStep] = []
    for atom in atoms:
        problem = codec_atom_problem(atom)
        if problem is not None:
            return CodecProblem(problem.code, problem.message)
        expanded = _expand_step(atom)
        if isinstance(expanded, CodecProblem):
            return expanded
        steps.extend(expanded)
    return _chain_problem(steps) or _type_problem(steps, column_type)


def _expand_step(atom: ColumnCodec) -> list[_ChainStep] | CodecProblem:
    if not isinstance(atom, RawColumnCodec):
        return [_ChainStep(atom.kind, _CODEC_CLASSES.get(atom.kind, "unknown"), atom)]
    steps: list[_ChainStep] = []
    for parsed in parse_raw_codec_atoms(atom.expression):
        if parsed.codec is not None:
            problem = codec_atom_problem(parsed.codec)
            if problem is not None:
                return CodecProblem(problem.code, problem.message)
            kind = parsed.codec.kind
            steps.append(_ChainStep(kind, _CODEC_CLASSES.get(kind, "unknown"), parsed.codec))
            continue
        name_match = re.match(r"^\w+", parsed.text)
        name = name_match.group(0) if name_match is not None else parsed.text
        codec_class = _CODEC_CLASSES.get(name)
        # A typed kind whose arguments do not parse: `Delta(3)`, `T64('BIT')`.
        if codec_class is not None and codec_class != "encryption":
            return CodecProblem(
                "codec_parameter_invalid",
                f'codec raw "{parsed.text}" has invalid arguments for {name}',
            )
        # Codec names are case-sensitive: ClickHouse knows no `zstd`.
        known = (
            None
            if codec_class is not None
            else next((k for k in _CODEC_CLASSES if k.lower() == name.lower()), None)
        )
        if known is not None:
            return CodecProblem(
                "codec_unknown",
                f'codec raw "{parsed.text}" names an unknown codec; '
                f"codec names are case-sensitive: {known}",
            )
        steps.append(_ChainStep(name, codec_class or "unknown"))
    return steps


def _chain_problem(steps: list[_ChainStep]) -> CodecProblem | None:  # noqa: PLR0911 - one return per rule
    if len(steps) > 1 and any(step.codec_class == "none" for step in steps):
        return CodecProblem(
            "codec_none_combined", "combines NONE with other codecs; NONE must be the only codec"
        )
    for i, step in enumerate(steps):
        if step.codec_class not in {"general", "encryption"}:
            continue
        following = (
            later for later in steps[i + 1:] if later.codec_class not in {"encryption", "unknown"}
        )
        nxt = next(following, None)
        if nxt is None:
            continue
        if step.codec_class == "encryption":
            return CodecProblem(
                "codec_chain_encryption_not_last",
                f"codec chain puts {nxt.kind} after the encryption codec {step.kind}; "
                "encryption codecs must come last",
            )
        if nxt.codec_class == "general":
            return CodecProblem(
                "codec_chain_multiple_general",
                f"codec chain has more than one general codec ({step.kind}, {nxt.kind}); "
                f"a chain takes at most one of {_GENERAL_LIST}",
            )
        return CodecProblem(
            "codec_chain_must_end_with_general",
            f"codec chain puts {nxt.kind} after the general codec {step.kind}; "
            f"only encryption codecs may follow a general codec ({_GENERAL_LIST})",
        )
    transforms = [step for step in steps if step.codec_class == "transform"]
    if transforms and all(step.codec_class in {"transform", "encryption"} for step in steps):
        return CodecProblem(
            "codec_chain_no_compression",
            f"codec chain only transforms the data ({', '.join(step.kind for step in transforms)}) "
            "and compresses nothing; add a codec such as LZ4, ZSTD or T64",
        )
    for j, step in enumerate(steps):
        if step.kind not in _FLOAT_SERIES_KINDS:
            continue
        earlier = steps[:j]
        delta = next((b for b in earlier if b.kind in {"Delta", "DoubleDelta"}), None)
        if delta is not None:
            return CodecProblem(
                "codec_chain_float_order",
                f"codec chain puts {step.kind} after {delta.kind}; Gorilla, FPC and ALP do their "
                "own delta encoding and cannot follow Delta or DoubleDelta",
            )
        float_series = (
            next((b for b in earlier if b.kind in _FLOAT_SERIES_KINDS), None)
            if step.kind == "ALP"
            else None
        )
        if float_series is not None:
            return CodecProblem(
                "codec_chain_float_order",
                f"codec chain puts ALP after {float_series.kind}; ClickHouse creates the column "
                "but rejects every insert, so ALP cannot follow Gorilla, FPC or ALP",
            )
    return None


def _type_problem(steps: list[_ChainStep], column_type: str) -> CodecProblem | None:
    values = codec_value_types(column_type) or []
    for step in steps:
        # An explicit Delta/Gorilla size bypasses leaf checks; float reachability is checked below.
        if (
            isinstance(step.codec, _CodecDeltaLike)
            and step.codec.kind in {"Delta", "Gorilla"}
            and step.codec.size is not None
        ):
            continue
        accepts = _TYPE_RULES.get(step.codec.kind) if step.codec is not None else None
        rejected = (
            next((value for value in values if not accepts(value)), None)
            if accepts is not None
            else None
        )
        if step.kind == "Gorilla":
            rejected = next(
                (
                    value for value in values
                    if value.width is None
                    or value.width not in (1, 2, 4, 8)
                ),
                None,
            )
        if rejected is None:
            continue
        where = "" if rejected.type == js_trim(column_type) else f" in {js_trim(column_type)}"
        return CodecProblem(
            "codec_type_unsupported",
            f"codec {step.kind} does not support type {rejected.type}{where}",
        )
    float_series = next((step for step in steps if step.kind in _FLOAT_SERIES_KINDS), None)
    if float_series is not None and codec_has_reachable_float(column_type) is False:
        return CodecProblem(
            "codec_type_unsupported",
            f"codec {float_series.kind} does not support type {js_trim(column_type)}: "
            "no float leaf reachable through Nullable, Array or Tuple",
        )
    return None


_NUMERIC_FAMILIES: Final = frozenset(
    {"int", "bool", "float", "bfloat16", "decimal", "date", "time", "enum", "ipv4"}
)


def _has_width(value: CodecValueType, widths: tuple[int, ...]) -> bool:
    return value.width is None or value.width in widths


_TYPE_RULES: Final[dict[str, Callable[[CodecValueType], bool]]] = {
    "Delta": lambda v: v.width in (1, 2, 4, 8),
    "DoubleDelta": lambda v: v.family in _NUMERIC_FAMILIES and _has_width(v, (1, 2, 4, 8)),
    "GCD": lambda v: v.family in {"int", "decimal", "date", "bool"},
    "T64": lambda v: (
        v.family in {"int", "decimal", "date", "time", "enum", "bool", "ipv4"}
        and _has_width(v, (1, 2, 4, 8))
    ),
    "FPC": lambda v: v.family == "float",
    "ALP": lambda v: v.family == "float",
}
"""The value types each codec accepts, as ClickHouse 26.3 checks them."""
