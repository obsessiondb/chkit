"""CLI flag parser — mirrors the TypeScript `flags.ts` shape.

This module exists for parity with the TS codebase. The Python CLI itself
uses Typer; this parser is independent and intended for ports/embeddings that
want chkit's exact flag semantics.
"""

from __future__ import annotations

from typing import Final, Literal, TypeAlias, TypedDict

from chkit.core.sql_lexer import js_trim

FlagType: TypeAlias = Literal["boolean", "string", "string[]"]

ParsedFlagValue: TypeAlias = str | list[str] | bool | None
ParsedFlags: TypeAlias = dict[str, ParsedFlagValue]


class FlagDef(TypedDict, total=False):
    """Definition of a single CLI flag.

    `name` is the long form including ``--`` prefix. `type` is one of the
    three supported types. `negation` only applies to boolean flags and adds
    a ``--no-<name>`` alias that sets the value to ``False``. `short` is an
    optional short form such as ``-t``, parsed as the long flag (#491).
    """

    name: str
    type: FlagType
    description: str
    placeholder: str
    negation: bool
    short: str


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
    values = [js_trim(v) for v in raw.split(",")]
    values = [v for v in values if v]
    existing = flags.get(key)
    if isinstance(existing, list):
        existing.extend(values)
    else:
        flags[key] = values


def expand_short_flags(argv: list[str], flag_defs: list[FlagDef]) -> list[str]:
    """Rewrite the short flags declared in ``flag_defs`` to their long form.

    ``-t x``, ``-t=x`` and ``-tx`` read as ``--table x`` / ``--table=x``. A
    flag's value is copied as is, even when it looks like a short flag
    (``--name -t``), the same tokens ``parse_flags`` takes as a value. Unknown
    short tokens, bundles such as ``-fy``, positionals and everything after
    ``--`` are left untouched.
    """
    by_name = {entry["name"]: entry for entry in flag_defs}
    by_short = {entry["short"]: entry for entry in flag_defs if entry.get("short")}

    expanded: list[str] = []
    i = 0
    while i < len(argv):
        token = argv[i]
        if token == "--":
            expanded.extend(argv[i:])
            break
        short = None if token.startswith("--") else _expand_short_token(token, by_short)
        definition = short[0] if short else by_name.get(token)
        expanded.append(short[1] if short else token)
        needs_value = (
            definition is not None
            and definition["type"] != "boolean"
            and not (short is not None and "=" in short[1])
        )
        if needs_value and i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            expanded.append(argv[i + 1])
            i += 1
        i += 1
    return expanded


def _expand_short_token(
    token: str, by_short: dict[str, FlagDef]
) -> tuple[FlagDef, str] | None:
    """Expand one ``-x``, ``-x=value`` or ``-xvalue`` token; ``None`` when it
    is not a declared short flag."""
    definition = by_short.get(token[:2])
    if definition is None:
        return None
    rest = token[2:]
    # `-f=1` becomes `--force=1`, which parse_flags rejects like the long form.
    if not rest or rest.startswith("="):
        return definition, f"{definition['name']}{rest}"
    # Only a value flag takes an attached value: `-fy` is not a bundle and stays unknown.
    if definition["type"] == "boolean":
        return None
    return definition, f"{definition['name']}={rest}"


def parse_flags(argv: list[str], flag_defs: list[FlagDef]) -> ParsedFlags:
    """Parse ``argv`` against ``flag_defs``.

    - Positional tokens (not starting with ``-``, or a bare ``-``) are ignored.
    - Declared short flags are expanded first (``expand_short_flags``); any
      other short token (``-x``) raises ``UnknownFlagError`` instead of being
      skipped, which would silently drop it (#491).
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
    argv = expand_short_flags(argv, flag_defs)

    i = 0
    while i < len(argv):
        token = argv[i]
        if not token or token == "-" or not token.startswith("-"):
            i += 1
            continue

        eq_idx = token.find("=")
        name = token if eq_idx == -1 else token[:eq_idx]
        inline_value: str | None = None if eq_idx == -1 else token[eq_idx + 1 :]
        # An undeclared short flag: skipping `-t` would run unscoped (#491).
        if not token.startswith("--"):
            raise UnknownFlagError(name)

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
