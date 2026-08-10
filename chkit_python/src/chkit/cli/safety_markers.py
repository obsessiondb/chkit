"""Parse `-- operation:` markers and scan SQL for destructive statements.

1:1 port of ``packages/cli/src/runtime/safety-markers.ts``.

Three layers:

1. ``extract_migration_operation_summaries`` — structured parse of the
   ``-- operation: <type> key=<key> risk=<risk>`` lines emitted by
   ``write_migration``. Each summary also carries any ``-- before-retry:``
   SQL associated with it (run before each retry).

2. ``collect_destructive_operation_markers`` — among those summaries,
   keep the ``risk=danger`` ones and decorate them with human-readable
   ``reason``/``impact``/``recommendation``. Detects table recreate
   (drop+create same key in one migration) and emits a louder warning.

3. ``scan_destructive_sql_statements`` + ``collect_unmarked_destructive_statements``
   — defense-in-depth pass over the executable SQL (comments stripped)
   that catches hand-written destructive statements lacking a planner
   marker. Used so a hand-edited migration still requires
   ``--allow-destructive``.

Re-exports ``extract_executable_statements`` for callers that need both
the parser and the splitter together.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from chkit.core.sql_splitter import extract_executable_statements

__all__ = [
    "DestructiveOperationMarker",
    "MigrationOperationMode",
    "MigrationOperationSummary",
    "ScannedDestructiveStatement",
    "collect_destructive_operation_markers",
    "collect_unmarked_destructive_statements",
    "extract_executable_statements",
    "extract_migration_operation_summaries",
    "migration_contains_danger_operation",
    "migration_contains_destructive_sql",
    "scan_destructive_sql_statements",
]


MigrationOperationMode = Literal["sync", "async"]

_PREVIEW_MAX_LEN = 120
_PREVIEW_TRUNCATE_LEN = 117

_BEFORE_RETRY_PREFIX = "-- before-retry:"

_OPERATION_LINE = re.compile(
    r"^([a-z_]+)\s+key=(\S+)\s+risk=([a-z_]+)(?:\s+mode=([a-z_]+))?$"
)

_OBJECT_KEY_RE = re.compile(
    r"\b(?:TABLE|VIEW|DATABASE|DICTIONARY)\s+(?:IF\s+EXISTS\s+)?`?([\w.]+)`?",
    re.IGNORECASE,
)

# Destructive SQL keyword rules. Each requires the noun keyword that
# follows the verb, so a `truncate(x)` function call is NOT mistaken for
# `TRUNCATE TABLE`.
_DESTRUCTIVE_SQL_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("drop_database", re.compile(r"\bDROP\s+DATABASE\b", re.IGNORECASE)),
    (
        "drop_materialized_view",
        re.compile(r"\bDROP\s+MATERIALIZED\s+VIEW\b", re.IGNORECASE),
    ),
    ("drop_view", re.compile(r"\bDROP\s+VIEW\b", re.IGNORECASE)),
    ("drop_table", re.compile(r"\bDROP\s+(?:TEMPORARY\s+)?TABLE\b", re.IGNORECASE)),
    ("drop_dictionary", re.compile(r"\bDROP\s+DICTIONARY\b", re.IGNORECASE)),
    ("alter_table_drop_column", re.compile(r"\bDROP\s+COLUMN\b", re.IGNORECASE)),
    (
        "truncate_table",
        re.compile(r"\bTRUNCATE\s+(?:TABLE|DATABASE|ALL\s+TABLES)\b", re.IGNORECASE),
    ),
    (
        "detach",
        re.compile(
            r"\bDETACH\s+(?:TABLE|VIEW|DICTIONARY|DATABASE|PARTITION|PART)\b",
            re.IGNORECASE,
        ),
    ),
)


@dataclass(frozen=True, slots=True)
class DestructiveOperationMarker:
    migration: str
    type: str
    key: str
    risk: str
    warning_code: str
    reason: str
    impact: str
    recommendation: str
    summary: str


@dataclass(frozen=True, slots=True)
class MigrationOperationSummary:
    type: str
    key: str
    risk: str
    mode: MigrationOperationMode
    before_retry: str | None
    summary: str


@dataclass(frozen=True, slots=True)
class ScannedDestructiveStatement:
    type: str
    statement: str


@dataclass(frozen=True, slots=True)
class _OperationDetail:
    warning_code: str
    reason: str
    impact: str
    recommendation: str


def migration_contains_danger_operation(sql: str) -> bool:
    return len(_extract_destructive_operation_summaries(sql)) > 0


def _extract_destructive_operation_summaries(sql: str) -> list[str]:
    out: list[str] = []
    for raw_line in sql.split("\n"):
        line = raw_line.strip()
        if line.startswith("-- operation:") and "risk=danger" in line:
            out.append(re.sub(r"^-- operation:\s*", "", line))
    return out


def _parse_operation_line(
    summary: str, before_retry: str | None
) -> MigrationOperationSummary | None:
    match = _OPERATION_LINE.match(summary)
    if match is None:
        return None
    raw_mode = match.group(4)
    mode: MigrationOperationMode = "async" if raw_mode == "async" else "sync"
    return MigrationOperationSummary(
        type=match.group(1),
        key=match.group(2),
        risk=match.group(3),
        mode=mode,
        before_retry=before_retry,
        summary=summary,
    )


def _strip_trailing_semicolon(value: str) -> str:
    return re.sub(r";\s*$", "", value).strip()


def extract_migration_operation_summaries(sql: str) -> list[MigrationOperationSummary]:
    """Parse every ``-- operation:`` block in ``sql`` with its before-retry SQL."""
    lines = [line.strip() for line in sql.split("\n")]
    summaries: list[MigrationOperationSummary] = []
    for i, line in enumerate(lines):
        if not line.startswith("-- operation:"):
            continue
        summary = re.sub(r"^-- operation:\s*", "", line)

        before_retry: str | None = None
        for j in range(i + 1, len(lines)):
            nxt = lines[j]
            if nxt == "":
                continue
            if not nxt.startswith("--"):
                break
            if nxt.startswith(_BEFORE_RETRY_PREFIX):
                before_retry = _strip_trailing_semicolon(
                    nxt[len(_BEFORE_RETRY_PREFIX) :].strip()
                )
                if before_retry == "":
                    before_retry = None
                break

        parsed = _parse_operation_line(summary, before_retry)
        if parsed is not None:
            summaries.append(parsed)
    return summaries


def _describe_destructive_operation(
    type_: str, *, recreate: bool = False
) -> _OperationDetail:
    if type_ == "drop_table" and recreate:
        return _OperationDetail(
            warning_code="table_recreate_data_loss",
            reason=(
                "A change to engine, ORDER BY, PRIMARY KEY, PARTITION BY, or "
                "UNIQUE KEY can only be applied by dropping and recreating "
                "this table."
            ),
            impact=(
                "ALL ROWS are permanently deleted — the table is recreated "
                "empty and existing data is NOT copied over."
            ),
            recommendation=(
                "Back up the data first, or migrate via a temporary table "
                "(rename, INSERT ... SELECT, then drop) before approving."
            ),
        )
    if type_ == "drop_table":
        return _OperationDetail(
            warning_code="drop_table_data_loss",
            reason=(
                "Dropping a table removes table data and metadata from the "
                "target database."
            ),
            impact=(
                "Queries that depend on this table will fail until it is "
                "recreated and repopulated."
            ),
            recommendation="Verify backups and downstream dependencies before approving.",
        )
    if type_ == "alter_table_drop_column":
        return _OperationDetail(
            warning_code="drop_column_irreversible",
            reason=(
                "Dropping a column permanently removes stored values for that column."
            ),
            impact=(
                "Applications or analytics depending on the column will break "
                "or return incomplete data."
            ),
            recommendation="Confirm the column is deprecated and no readers still require it.",
        )
    if type_ in {"drop_view", "drop_materialized_view"}:
        return _OperationDetail(
            warning_code="drop_view_dependency_break",
            reason=(
                "Dropping a view removes a query interface used by clients and pipelines."
            ),
            impact=(
                "Dependent workloads may fail until compatible replacements are in place."
            ),
            recommendation="Confirm replacement view rollout and dependency readiness.",
        )
    if type_ == "drop_dictionary":
        return _OperationDetail(
            warning_code="drop_dictionary_dependency_break",
            reason=(
                "Dropping a dictionary removes a lookup source used by "
                "dictGet() calls and joins."
            ),
            impact=(
                "Queries and materialized views that call dictGet() against "
                "this dictionary will fail."
            ),
            recommendation=(
                "Confirm no queries or views still reference this dictionary "
                "before approving."
            ),
        )
    return _OperationDetail(
        warning_code="destructive_operation_review_required",
        reason="This operation is marked destructive by planner risk classification.",
        impact="Execution may cause irreversible schema or data changes.",
        recommendation="Review SQL and dependency impact before approving.",
    )


def collect_destructive_operation_markers(
    migration: str, sql: str
) -> list[DestructiveOperationMarker]:
    """Decorate planner ``risk=danger`` markers with reason/impact details.

    A drop_table whose key is ALSO re-created in the same migration gets
    the louder ``table_recreate_data_loss`` warning instead of the plain
    ``drop_table_data_loss`` one.
    """
    created_table_keys = {
        op.key
        for op in extract_migration_operation_summaries(sql)
        if op.type == "create_table"
    }
    markers: list[DestructiveOperationMarker] = []
    for summary in _extract_destructive_operation_summaries(sql):
        parsed = _parse_operation_line(summary, None)
        type_ = parsed.type if parsed is not None else "unknown"
        key = parsed.key if parsed is not None else "unknown"
        risk = parsed.risk if parsed is not None else "danger"
        recreate = type_ == "drop_table" and key in created_table_keys
        detail = _describe_destructive_operation(type_, recreate=recreate)
        markers.append(
            DestructiveOperationMarker(
                migration=migration,
                type=type_,
                key=key,
                risk=risk,
                warning_code=detail.warning_code,
                reason=detail.reason,
                impact=detail.impact,
                recommendation=detail.recommendation,
                summary=summary,
            )
        )
    return markers


_LINE_COMMENT_RE = re.compile(r"^\s*--.*$", re.MULTILINE)


def _strip_line_comments(statement: str) -> str:  # noqa: PLR0912
    """Remove `-- ...` line comments outside string literals.

    The Python sql_splitter preserves comments inside the statement text;
    the TS equivalent strips them in ``extractExecutableStatements``. To
    keep destructive-SQL classification identical across the two ports
    we strip line comments here too. A more thorough rewrite of the
    splitter is tracked in DRIFT.md.
    """
    out: list[str] = []
    in_single = in_double = in_backtick = False
    i = 0
    n = len(statement)
    while i < n:
        ch = statement[i]
        nxt = statement[i + 1] if i + 1 < n else ""
        if in_single:
            out.append(ch)
            if ch == "'" and statement[i - 1 : i] != "\\":
                in_single = False
        elif in_double:
            out.append(ch)
            if ch == '"' and statement[i - 1 : i] != "\\":
                in_double = False
        elif in_backtick:
            out.append(ch)
            if ch == "`":
                in_backtick = False
        elif ch == "-" and nxt == "-":
            # Skip until end of line (or end of string).
            while i < n and statement[i] != "\n":
                i += 1
            continue
        elif ch == "'":
            in_single = True
            out.append(ch)
        elif ch == '"':
            in_double = True
            out.append(ch)
        elif ch == "`":
            in_backtick = True
            out.append(ch)
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def _classify_destructive_statement(statement: str) -> str | None:
    cleaned = _strip_line_comments(statement)
    for type_, pattern in _DESTRUCTIVE_SQL_RULES:
        if pattern.search(cleaned):
            return type_
    return None


def _extract_object_key(statement: str) -> str:
    match = _OBJECT_KEY_RE.search(statement)
    return match.group(1) if match is not None else "unknown"


def scan_destructive_sql_statements(sql: str) -> list[ScannedDestructiveStatement]:
    """Defense-in-depth scan: flag destructive SQL with no matching planner marker.

    Generated migrations emit exactly one ``-- operation:`` marker per
    statement, in order (the 1:1 invariant relied on by apply). A
    marker-covered position is trusted to the planner's risk
    classification. Only marker-less positions are flagged.
    """
    statements = extract_executable_statements(sql)
    operations = extract_migration_operation_summaries(sql)
    found: list[ScannedDestructiveStatement] = []
    for i, statement in enumerate(statements):
        if i < len(operations):
            continue
        type_ = _classify_destructive_statement(statement)
        if type_ is not None:
            found.append(
                ScannedDestructiveStatement(type=type_, statement=statement.strip())
            )
    return found


def migration_contains_destructive_sql(sql: str) -> bool:
    return len(scan_destructive_sql_statements(sql)) > 0


def collect_unmarked_destructive_statements(
    migration: str, sql: str
) -> list[DestructiveOperationMarker]:
    """Synthesize destructive markers for hand-written destructive SQL.

    Migrations carry no planner markers when authored by hand. These would
    otherwise slip past the ``risk=danger`` check; this layer keeps the
    ``--allow-destructive`` gate honest.
    """
    out: list[DestructiveOperationMarker] = []
    for entry in scan_destructive_sql_statements(sql):
        detail = _describe_destructive_operation(entry.type)
        preview = (
            entry.statement
            if len(entry.statement) <= _PREVIEW_MAX_LEN
            else f"{entry.statement[:_PREVIEW_TRUNCATE_LEN]}..."
        )
        out.append(
            DestructiveOperationMarker(
                migration=migration,
                type=entry.type,
                key=_extract_object_key(entry.statement),
                risk="danger",
                warning_code=detail.warning_code,
                reason=detail.reason,
                impact=detail.impact,
                recommendation=detail.recommendation,
                summary=f"unmarked destructive SQL: {preview}",
            )
        )
    return out
