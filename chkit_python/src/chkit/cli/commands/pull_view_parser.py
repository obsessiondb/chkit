"""Parse VIEW / MATERIALIZED VIEW DDL clauses from `system.tables` rows.

1:1 port of ``packages/plugin-pull/src/view-parser.ts``.

Used by ``chkit pull`` to reconstruct view + MV definitions from their
``create_table_query`` strings. Strips ``DEFINER`` / ``SQL SECURITY``
clauses that managed environments (ObsessionDB) auto-inject before
parsing — these are orthogonal to user-authored schema.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = [
    "MaterializedViewRefreshShape",
    "ToClauseShape",
    "parse_as_clause",
    "parse_refresh_clause",
    "parse_to_clause",
]


@dataclass(frozen=True, slots=True)
class ToClauseShape:
    database: str
    name: str


@dataclass(frozen=True, slots=True)
class DependsOnEntry:
    database: str
    name: str


@dataclass(frozen=True, slots=True)
class MaterializedViewRefreshShape:
    every: str | None = None
    after: str | None = None
    offset: str | None = None
    randomize: str | None = None
    depends_on: list[DependsOnEntry] | None = None
    settings: dict[str, str | int | float] | None = None
    append: bool = False
    empty: bool = False


_DEFINER_RE = re.compile(
    r"\bDEFINER\s*=\s*(?:CURRENT_USER|`[^`]+`|\"[^\"]+\"|[A-Za-z0-9_]+)",
    re.IGNORECASE,
)
_SQL_SECURITY_RE = re.compile(
    r"\bSQL\s+SECURITY\s+(?:DEFINER|INVOKER|NONE)", re.IGNORECASE
)
_AS_CLAUSE_RE = re.compile(r"\bAS\b(.*)$", re.IGNORECASE | re.DOTALL)
_TO_CLAUSE_RE = re.compile(
    r"(?:^|\s)TO\s+((?:`[^`]+`|\"[^\"]+\"|[A-Za-z0-9_]+)"
    r"(?:\.(?:`[^`]+`|\"[^\"]+\"|[A-Za-z0-9_]+))?)",
    re.IGNORECASE,
)

_INTERVAL_TOKEN = (
    r"\d+\s+(?:SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?"
    r"(?:\s+\d+\s+(?:SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?)*"
)
_REFRESH_RE = re.compile(
    rf"\bREFRESH\s+(EVERY|AFTER)\s+({_INTERVAL_TOKEN})", re.IGNORECASE
)
_OFFSET_RE = re.compile(rf"\bOFFSET\s+({_INTERVAL_TOKEN})", re.IGNORECASE)
_RANDOMIZE_RE = re.compile(
    rf"\bRANDOMIZE\s+FOR\s+({_INTERVAL_TOKEN})", re.IGNORECASE
)
_DEPENDS_RE = re.compile(
    r"\bDEPENDS\s+ON\s+(.*?)(?=\bSETTINGS\b|\bAPPEND\b|\bTO\b|\bEMPTY\b|\bAS\b|$)",
    re.IGNORECASE | re.DOTALL,
)
_SETTINGS_RE = re.compile(
    r"\bSETTINGS\s+(.*?)(?=\bAPPEND\b|\bTO\b|\bEMPTY\b|\bAS\b|$)",
    re.IGNORECASE | re.DOTALL,
)
_SETTING_ENTRY_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$")
_UNIT_RE = re.compile(
    r"\b(second|minute|hour|day|week|month|year)s?\b", re.IGNORECASE
)


_QUALIFIED_TWO_PARTS = 2
_MIN_QUOTED_LEN = 2


def _strip_definer_clauses(query: str) -> str:
    return _SQL_SECURITY_RE.sub("", _DEFINER_RE.sub("", query))


def _normalize_interval(value: str) -> str:
    normalized = " ".join(value.split())

    def _to_singular_upper(match: re.Match[str]) -> str:
        unit = match.group(0).upper()
        return unit[:-1] if unit.endswith("S") else unit

    return _UNIT_RE.sub(_to_singular_upper, normalized)


def parse_as_clause(query: str | None) -> str | None:
    """Return the SELECT body from a CREATE VIEW / MV statement, or None."""
    if not query:
        return None
    cleaned = _strip_definer_clauses(query)
    match = _AS_CLAUSE_RE.search(cleaned)
    if match is None or not match.group(1):
        return None
    as_clause = match.group(1).strip().rstrip(";").strip()
    return as_clause or None


def parse_to_clause(query: str | None, fallback_database: str) -> ToClauseShape | None:  # noqa: PLR0911
    """Extract the ``TO db.t`` target of a CREATE MATERIALIZED VIEW."""
    if not query:
        return None
    match = _TO_CLAUSE_RE.search(query)
    if match is None:
        return None
    identifier = match.group(1)
    parts = [p.strip().lstrip("`\"").rstrip("`\"") for p in identifier.split(".")]
    if len(parts) == 1:
        name = parts[0]
        if not name:
            return None
        return ToClauseShape(database=fallback_database, name=name)
    if len(parts) == _QUALIFIED_TWO_PARTS:
        database = parts[0] or fallback_database
        name = parts[1]
        if not database or not name:
            return None
        return ToClauseShape(database=database, name=name)
    return None


def _parse_depends_on(segment: str) -> list[DependsOnEntry]:
    out: list[DependsOnEntry] = []
    for entry in segment.split(","):
        trimmed = entry.strip()
        if not trimmed:
            continue
        parts = [p.strip().lstrip("`\"").rstrip("`\"") for p in trimmed.split(".")]
        if len(parts) == 1 and parts[0]:
            out.append(DependsOnEntry(database="default", name=parts[0]))
        elif len(parts) == _QUALIFIED_TWO_PARTS and parts[0] and parts[1]:
            out.append(DependsOnEntry(database=parts[0], name=parts[1]))
    return out


def _parse_refresh_settings(segment: str) -> dict[str, str | int | float]:
    out: dict[str, str | int | float] = {}
    for entry in segment.split(","):
        match = _SETTING_ENTRY_RE.match(entry)
        if match is None:
            continue
        key = match.group(1)
        raw = match.group(2).strip()
        if len(raw) >= _MIN_QUOTED_LEN and raw.startswith("'") and raw.endswith("'"):
            out[key] = raw[1:-1].replace("''", "'")
            continue
        try:
            as_number = float(raw)
        except ValueError:
            out[key] = raw
            continue
        if as_number.is_integer():
            out[key] = int(as_number)
        else:
            out[key] = as_number
    return out


def parse_refresh_clause(query: str | None) -> MaterializedViewRefreshShape | None:
    """Parse the REFRESH block of a CREATE MATERIALIZED VIEW (or return None)."""
    if not query:
        return None
    cleaned = _strip_definer_clauses(query)
    refresh_match = _REFRESH_RE.search(cleaned)
    if refresh_match is None:
        return None

    every: str | None = None
    after: str | None = None
    if refresh_match.group(1).upper() == "EVERY":
        every = _normalize_interval(refresh_match.group(2))
    else:
        after = _normalize_interval(refresh_match.group(2))

    offset_match = _OFFSET_RE.search(cleaned)
    offset = _normalize_interval(offset_match.group(1)) if offset_match else None

    randomize_match = _RANDOMIZE_RE.search(cleaned)
    randomize = (
        _normalize_interval(randomize_match.group(1)) if randomize_match else None
    )

    depends_on: list[DependsOnEntry] | None = None
    depends_match = _DEPENDS_RE.search(cleaned)
    if depends_match is not None:
        parsed = _parse_depends_on(depends_match.group(1))
        if parsed:
            depends_on = parsed

    settings: dict[str, str | int | float] | None = None
    settings_match = _SETTINGS_RE.search(cleaned)
    if settings_match is not None:
        parsed_settings = _parse_refresh_settings(settings_match.group(1))
        if parsed_settings:
            settings = parsed_settings

    after_refresh = cleaned[refresh_match.start() :]
    before_as = re.split(r"\bAS\b", after_refresh, maxsplit=1, flags=re.IGNORECASE)[0]
    append = bool(re.search(r"\bAPPEND\b", before_as, re.IGNORECASE))
    empty = bool(re.search(r"\bEMPTY\b", before_as, re.IGNORECASE))

    return MaterializedViewRefreshShape(
        every=every,
        after=after,
        offset=offset,
        randomize=randomize,
        depends_on=depends_on,
        settings=settings,
        append=append,
        empty=empty,
    )
