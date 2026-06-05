"""CLI flag parser — mirrors the TypeScript `flags.ts` shape.

This module exists for parity with the TS codebase. The Python CLI itself
uses Typer; this parser is independent and intended for ports/embeddings that
want chkit's exact flag semantics.
"""

from __future__ import annotations

from typing import Final, Literal, TypeAlias, TypedDict

FlagType: TypeAlias = Literal["boolean", "string", "string[]"]

ParsedFlagValue: TypeAlias = str | list[str] | bool | None
ParsedFlags: TypeAlias = dict[str, ParsedFlagValue]


class FlagDef(TypedDict, total=False):
    """Definition of a single CLI flag.

    `name` is the long form including ``--`` prefix. `type` is one of the
    three supported types. `negation` only applies to boolean flags and adds
    a ``--no-<name>`` alias that sets the value to ``False``.
    """

    name: str
    type: FlagType
    description: str
    placeholder: str
    negation: bool


_UNDEFINED: Final[object] = object()


class UnknownFlagError(Exception):
    def __init__(self, flag: str) -> None:
        super().__init__(f"Unknown flag: {flag}")
        self.flag: str = flag


class MissingFlagValueError(Exception):
    def __init__(self, flag: str) -> None:
        super().__init__(f"Missing value for {flag}")
        self.flag: str = flag


def define_flags(defs: list[FlagDef]) -> list[FlagDef]:
    """Identity helper to anchor a flag list at the call site (parity helper)."""
    return defs


def _add_array_value(flags: ParsedFlags, key: str, raw: str) -> None:
    values = [v.strip() for v in raw.split(",")]
    values = [v for v in values if v]
    existing = flags.get(key)
    if isinstance(existing, list):
        existing.extend(values)
    else:
        flags[key] = values


def parse_flags(argv: list[str], flag_defs: list[FlagDef]) -> ParsedFlags:
    """Parse ``argv`` against ``flag_defs``.

    - Positional tokens (not starting with ``--``) are ignored.
    - ``--flag value`` and ``--flag=value`` are both accepted for string and
      ``string[]`` flags.
    - Boolean flags reject the equals form (``--json=true`` raises).
    - Negation flags emit ``--no-<name>`` aliases.
    - ``string[]`` values are split on commas and accumulated across repeats.
    """
    lookup: dict[str, FlagDef] = {}
    negation_map: dict[str, str] = {}

    for entry in flag_defs:
        lookup[entry["name"]] = entry
        if entry["type"] == "boolean" and entry.get("negation"):
            basename = entry["name"][2:] if entry["name"].startswith("--") else entry["name"]
            negation_map[f"--no-{basename}"] = entry["name"]

    flags: ParsedFlags = {}

    i = 0
    while i < len(argv):
        token = argv[i]
        if not token or not token.startswith("--"):
            i += 1
            continue

        eq_idx = token.find("=")
        name = token if eq_idx == -1 else token[:eq_idx]
        inline_value: str | None = None if eq_idx == -1 else token[eq_idx + 1 :]

        if eq_idx == -1 and name in negation_map:
            original_name = negation_map[name]
            flags[original_name] = False
            i += 1
            continue

        definition = lookup.get(name)
        if definition is None:
            raise UnknownFlagError(name)

        flag_type = definition["type"]
        if flag_type == "boolean":
            if inline_value is not None:
                raise UnknownFlagError(token)
            flags[definition["name"]] = True
            i += 1
            continue

        if inline_value is not None:
            value: str = inline_value
        else:
            next_token = argv[i + 1] if i + 1 < len(argv) else None
            if next_token is None or next_token.startswith("--"):
                raise MissingFlagValueError(definition["name"])
            value = next_token
            i += 1

        if flag_type == "string":
            flags[definition["name"]] = value
        elif flag_type == "string[]":
            _add_array_value(flags, definition["name"], value)

        i += 1

    return flags
