"""``--table`` selector parsing, resolution, and plan filtering.

1:1 port of ``packages/cli/src/runtime/table-scope.ts``.

This is the foundation for the ``--table`` flag across ``generate``,
``migrate``, ``status``, ``check`` and ``drift``. It exposes:

- ``TableScope`` — the resolved result handed to each command.
- ``parse_table_selector`` — turn a CLI string into structured intent.
- ``resolve_table_scope`` — intersect a selector with a set of known
  table keys.
- ``filter_plan_by_table_scope`` / ``build_scoped_snapshot_definitions``
  — narrow a ``MigrationPlan`` or a snapshot down to the selected tables.

TS lives under ``runtime/``; Python keeps CLI helpers flat under
``chkit.cli``. See ``DRIFT.md`` for the path-layout note.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from chkit.core.model import (
    MigrationOperation,
    MigrationPlan,
    SchemaDefinition,
    TableDefinition,
    _RiskSummary,
)

# Module-private "magic" constants kept named so the comparisons in
# parse_table_selector read clearly.
_MAX_WILDCARDS = 1


@dataclass(frozen=True, slots=True)
class TableScope:
    """Result of resolving a ``--table`` selector against available tables."""

    enabled: bool
    matched_tables: tuple[str, ...] = field(default_factory=tuple)
    match_count: int = 0
    selector: str | None = None


@dataclass(frozen=True, slots=True)
class _ParsedTableSelector:
    mode: Literal["exact", "prefix"]
    value: str
    database: str | None = None


@dataclass(frozen=True, slots=True)
class TableScopeFilterResult:
    plan: MigrationPlan
    omitted_operation_count: int


class _RenameMapping(Protocol):
    """Duck-typed view of a table rename mapping.

    Defined here so this module doesn't depend on
    ``generate_rename_mappings`` (matches the TS file-level isolation).
    """

    old_database: str
    old_name: str
    new_database: str
    new_name: str


def _table_key(database: str, name: str) -> str:
    return f"{database}.{name}"


def table_keys_from_definitions(
    definitions: Sequence[SchemaDefinition],
) -> list[str]:
    """Return the sorted unique set of ``database.table`` keys for tables."""
    keys = {
        _table_key(d.database, d.name)
        for d in definitions
        if isinstance(d, TableDefinition)
    }
    return sorted(keys)


def parse_table_selector(input_: str) -> _ParsedTableSelector:
    """Parse a CLI ``--table`` value into structured intent.

    Supported shapes::

        events                  → exact, table=events
        events_*                → prefix, table starts with "events_"
        analytics.events        → exact, database=analytics, table=events
        analytics.events_*      → prefix, database=analytics

    Raises ``ValueError`` for empty input, bare ``*``, mid-string ``*``,
    multiple ``*``, or an empty database qualifier.
    """
    selector = input_.strip()
    if not selector:
        msg = (
            'Invalid --table selector "". Expected <table>, <table_prefix*>, '
            "<database.table>, or <database.table_prefix*>."
        )
        raise ValueError(msg)

    dot = selector.find(".")
    if dot == -1:
        database: str | None = None
        table_token = selector
    else:
        database = selector[:dot].strip()
        table_token = selector[dot + 1 :].strip()

    if database is not None and (not database or "*" in database):
        msg = (
            f'Invalid --table selector "{selector}". Database qualifier must '
            f'be non-empty and cannot contain "*".'
        )
        raise ValueError(msg)

    if not table_token or table_token == "*":
        msg = (
            f'Invalid --table selector "{selector}". A bare "*" is not supported; '
            f"use an exact table or trailing wildcard prefix."
        )
        raise ValueError(msg)

    wildcards = sum(1 for char in table_token if char == "*")
    if wildcards > _MAX_WILDCARDS or (
        wildcards == 1 and not table_token.endswith("*")
    ):
        msg = (
            f'Invalid --table selector "{selector}". "*" is only allowed as a '
            f"trailing suffix (for example, events_*)."
        )
        raise ValueError(msg)

    if "*" in table_token[:-1]:
        msg = (
            f'Invalid --table selector "{selector}". "*" is only allowed as a '
            f"trailing suffix (for example, events_*)."
        )
        raise ValueError(msg)

    if table_token.endswith("*"):
        value = table_token[:-1]
        if not value:
            msg = (
                f'Invalid --table selector "{selector}". A bare "*" is not '
                f"supported; use an exact table or trailing wildcard prefix."
            )
            raise ValueError(msg)
        return _ParsedTableSelector(database=database, mode="prefix", value=value)

    return _ParsedTableSelector(database=database, mode="exact", value=table_token)


def resolve_table_scope(
    selector: str | None, available_tables: Sequence[str]
) -> TableScope:
    """Intersect a selector with the known set of ``db.table`` keys."""
    if not selector:
        return TableScope(enabled=False, matched_tables=(), match_count=0)

    parsed = parse_table_selector(selector)
    normalized = sorted(set(available_tables))

    matched: list[str] = []
    for candidate in normalized:
        dot = candidate.find(".")
        if dot <= 0 or dot == len(candidate) - 1:
            continue
        database = candidate[:dot]
        table = candidate[dot + 1 :]
        if parsed.database is not None and parsed.database != database:
            continue
        if parsed.mode == "exact":
            if table == parsed.value:
                matched.append(candidate)
        elif table.startswith(parsed.value):
            matched.append(candidate)

    return TableScope(
        enabled=True,
        matched_tables=tuple(matched),
        match_count=len(matched),
        selector=selector,
    )


def table_key_from_operation_key(operation_key: str) -> str | None:
    """``table:db.t:rest`` → ``db.t``. Returns None for non-table operations."""
    prefix = "table:"
    if not operation_key.startswith(prefix):
        return None
    target = operation_key[len(prefix) :]
    next_segment = target.find(":")
    return target if next_segment == -1 else target[:next_segment]


def database_key_from_operation_key(operation_key: str) -> str | None:
    """``database:foo`` → ``foo``. Returns None for non-database operations."""
    prefix = "database:"
    if not operation_key.startswith(prefix):
        return None
    return operation_key[len(prefix) :]


def filter_plan_by_table_scope(
    plan: MigrationPlan,
    matched_tables: frozenset[str] | set[str],
    *,
    rename_mappings: Sequence[_RenameMapping] | None = None,
) -> TableScopeFilterResult:
    """Drop operations + rename suggestions that don't touch the matched tables.

    Rename mappings are expanded both ways: if ``old`` is selected the ``new``
    key is also kept (and vice versa) so a rename's drop+create pair stays
    together in the filtered plan.
    """
    if not matched_tables:
        return TableScopeFilterResult(
            plan=MigrationPlan(
                operations=[],
                risk_summary=_RiskSummary(safe=0, caution=0, danger=0),
                rename_suggestions=[],
            ),
            omitted_operation_count=len(plan.operations),
        )

    selected_tables: set[str] = set(matched_tables)
    for mapping in rename_mappings or ():
        old_key = _table_key(mapping.old_database, mapping.old_name)
        new_key = _table_key(mapping.new_database, mapping.new_name)
        if old_key in selected_tables or new_key in selected_tables:
            selected_tables.add(old_key)
            selected_tables.add(new_key)

    selected_databases = {key.split(".", 1)[0] for key in selected_tables}

    def _keeps(op: MigrationOperation) -> bool:
        target_table = table_key_from_operation_key(op.key)
        if target_table is not None:
            return target_table in selected_tables
        target_database = database_key_from_operation_key(op.key)
        if target_database is not None:
            return target_database in selected_databases
        return False

    operations = [op for op in plan.operations if _keeps(op)]

    rename_suggestions = [
        s
        for s in plan.rename_suggestions
        if _table_key(s.database, s.table) in selected_tables
    ]

    counts = {"safe": 0, "caution": 0, "danger": 0}
    for op in operations:
        counts[op.risk] += 1

    return TableScopeFilterResult(
        plan=MigrationPlan(
            operations=operations,
            risk_summary=_RiskSummary(
                safe=counts["safe"], caution=counts["caution"], danger=counts["danger"]
            ),
            rename_suggestions=rename_suggestions,
        ),
        omitted_operation_count=len(plan.operations) - len(operations),
    )


def build_scoped_snapshot_definitions(
    *,
    previous_definitions: Sequence[SchemaDefinition],
    next_definitions: Sequence[SchemaDefinition],
    matched_tables: frozenset[str] | set[str],
    rename_mappings: Sequence[_RenameMapping] | None = None,
) -> list[SchemaDefinition]:
    """Build the snapshot subset for ``--table``-scoped ``generate``.

    Starts from the previous snapshot, then for each selected table:
      * remove the entry if it no longer exists in the new schema (drop)
      * otherwise replace with the new schema's version (update)

    Non-table definitions and tables outside the scope pass through
    unchanged. Rename mappings extend the selected set the same way as in
    ``filter_plan_by_table_scope``.
    """
    if not matched_tables:
        return list(previous_definitions)

    selected_tables: set[str] = set(matched_tables)
    for mapping in rename_mappings or ():
        old_key = _table_key(mapping.old_database, mapping.old_name)
        new_key = _table_key(mapping.new_database, mapping.new_name)
        if old_key in selected_tables or new_key in selected_tables:
            selected_tables.add(old_key)
            selected_tables.add(new_key)

    # Preserve insertion order from previous_definitions; later we merge in
    # next_definitions's selected tables.
    result: dict[str, SchemaDefinition] = {}
    for definition in previous_definitions:
        key = f"{definition.kind}:{definition.database}.{definition.name}"
        result[key] = definition

    next_table_keys = {
        _table_key(d.database, d.name)
        for d in next_definitions
        if isinstance(d, TableDefinition)
    }

    for key in list(result):
        definition = result[key]
        if not isinstance(definition, TableDefinition):
            continue
        current_table_key = _table_key(definition.database, definition.name)
        if current_table_key not in selected_tables:
            continue
        if current_table_key not in next_table_keys:
            del result[key]

    for definition in next_definitions:
        if not isinstance(definition, TableDefinition):
            continue
        current_table_key = _table_key(definition.database, definition.name)
        if current_table_key not in selected_tables:
            continue
        key = f"{definition.kind}:{definition.database}.{definition.name}"
        result[key] = definition

    return list(result.values())
