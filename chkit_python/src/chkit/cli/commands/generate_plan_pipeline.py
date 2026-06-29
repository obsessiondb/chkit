"""Apply explicit table renames + materialise selected column rename suggestions.

1:1 port of ``packages/cli/src/commands/generate/plan-pipeline.ts``.

Both functions return a new ``MigrationPlan`` with operations sorted by a
stable rank (drops first, then create-database, then renames, alters,
create-table, create-view), then alphabetically by key. The risk
summary is recomputed and the rename suggestions list is filtered.
"""

from __future__ import annotations

from collections.abc import Sequence

from chkit.cli.commands.generate_rename_mappings import (
    ColumnRenameMapping,
    TableRenameMapping,
)
from chkit.core.model import (
    ColumnRenameSuggestion,
    MigrationOperation,
    MigrationOperationType,
    MigrationPlan,
    RiskLevel,
    SchemaDefinition,
    TableDefinition,
    _RiskSummary,
)

# Rank used to order operations within a plan. Drops happen first so the
# subsequent create/alter steps see a clean slate; rename comes after
# create-database so a cross-DB rename can land in a freshly-created DB.
_DROP_RANK = 0
_CREATE_DATABASE_RANK = 1
_ALTER_TABLE_RENAME_RANK = 2
_ALTER_RANK = 3
_CREATE_TABLE_RANK = 4
_CREATE_VIEW_RANK = 5
_FALLBACK_RANK = 6


def apply_selected_rename_suggestions(
    plan: MigrationPlan,
    selected_suggestions: Sequence[ColumnRenameSuggestion],
) -> MigrationPlan:
    """Replace pairs of (drop, add) column ops with a single RENAME COLUMN."""
    if not selected_suggestions:
        return plan

    keys_to_remove: set[str] = set()
    rename_operations: list[MigrationOperation] = []

    for suggestion in selected_suggestions:
        keys_to_remove.add(suggestion.drop_operation_key)
        keys_to_remove.add(suggestion.add_operation_key)
        rename_operations.append(
            MigrationOperation(
                type="alter_table_rename_column",
                key=(
                    f"table:{suggestion.database}.{suggestion.table}"
                    f":column_rename:{suggestion.from_}:{suggestion.to}"
                ),
                risk="caution",
                sql=suggestion.confirmation_sql,
            )
        )

    kept = [op for op in plan.operations if op.key not in keys_to_remove]
    operations = _sorted(kept + rename_operations)

    return MigrationPlan(
        operations=operations,
        risk_summary=_summarize_risk(operations),
        rename_suggestions=[
            suggestion
            for suggestion in plan.rename_suggestions
            if not any(
                _suggestion_matches(suggestion, selected)
                for selected in selected_suggestions
            )
        ],
    )


def apply_explicit_table_renames(
    plan: MigrationPlan,
    mappings: Sequence[TableRenameMapping],
) -> MigrationPlan:
    """Replace pairs of (drop-old, create-new) with a RENAME TABLE statement."""
    if not mappings:
        return plan

    keys_to_remove: set[str] = set()
    extra_operations: list[MigrationOperation] = []
    create_database_keys = {
        op.key for op in plan.operations if op.type == "create_database"
    }

    for mapping in mappings:
        keys_to_remove.add(f"table:{mapping.old_database}.{mapping.old_name}")
        keys_to_remove.add(f"table:{mapping.new_database}.{mapping.new_name}")

        if mapping.old_database != mapping.new_database:
            db_key = f"database:{mapping.new_database}"
            if db_key not in create_database_keys:
                extra_operations.append(
                    MigrationOperation(
                        type="create_database",
                        key=db_key,
                        risk="safe",
                        sql=f"CREATE DATABASE IF NOT EXISTS {mapping.new_database};",
                    )
                )
                create_database_keys.add(db_key)

        extra_operations.append(
            MigrationOperation(
                type="alter_table_rename_table",
                key=f"table:{mapping.new_database}.{mapping.new_name}:rename_table",
                risk="caution",
                sql=(
                    f"RENAME TABLE IF EXISTS "
                    f"{mapping.old_database}.{mapping.old_name} TO "
                    f"{mapping.new_database}.{mapping.new_name};"
                ),
            )
        )

    kept = [op for op in plan.operations if op.key not in keys_to_remove]
    operations = _sorted(kept + extra_operations)

    return MigrationPlan(
        operations=operations,
        risk_summary=_summarize_risk(operations),
        rename_suggestions=list(plan.rename_suggestions),
    )


def build_explicit_column_rename_suggestions(
    plan: MigrationPlan,
    mappings: Sequence[ColumnRenameMapping],
) -> list[ColumnRenameSuggestion]:
    """Match CLI/schema column mappings to existing (drop, add) operation pairs."""
    if not mappings:
        return []

    operation_keys = {op.key for op in plan.operations}
    suggestions: list[ColumnRenameSuggestion] = []
    for mapping in mappings:
        drop_key = f"table:{mapping.database}.{mapping.table}:column:{mapping.from_}"
        add_key = f"table:{mapping.database}.{mapping.table}:column:{mapping.to}"
        if drop_key not in operation_keys or add_key not in operation_keys:
            continue
        reason = (
            "Explicitly confirmed by --rename-column mapping."
            if mapping.source == "cli"
            else "Explicitly confirmed by schema metadata (renamedFrom)."
        )
        suggestions.append(
            ColumnRenameSuggestion(
                kind="column",
                database=mapping.database,
                table=mapping.table,
                from_=mapping.from_,
                to=mapping.to,
                confidence="high",
                reason=reason,
                drop_operation_key=drop_key,
                add_operation_key=add_key,
                confirmation_sql=(
                    f"ALTER TABLE {mapping.database}.{mapping.table} "
                    f"RENAME COLUMN IF EXISTS `{mapping.from_}` TO `{mapping.to}`;"
                ),
            )
        )

    return suggestions


def assert_cli_column_mappings_resolvable(
    cli_mappings: Sequence[ColumnRenameMapping],
    plan: MigrationPlan,
    next_definitions: Sequence[SchemaDefinition],
) -> None:
    """Every CLI column rename must reference an existing planner pair."""
    for mapping in cli_mappings:
        if not _table_exists(next_definitions, mapping.database, mapping.table):
            spec = (
                f"{mapping.database}.{mapping.table}.{mapping.from_}={mapping.to}"
            )
            msg = (
                f'--rename-column mapping "{spec}" is invalid: target table is missing '
                f"from current schema."
            )
            raise ValueError(msg)
        drop_key = f"table:{mapping.database}.{mapping.table}:column:{mapping.from_}"
        add_key = f"table:{mapping.database}.{mapping.table}:column:{mapping.to}"
        has_drop = any(
            op.type == "alter_table_drop_column" and op.key == drop_key
            for op in plan.operations
        )
        has_add = any(
            op.type == "alter_table_add_column" and op.key == add_key
            for op in plan.operations
        )
        if has_drop and has_add:
            continue
        spec = f"{mapping.database}.{mapping.table}.{mapping.from_}={mapping.to}"
        msg = (
            f'--rename-column mapping "{spec}" is invalid: planner did not find '
            f"both matching drop and add operations."
        )
        raise ValueError(msg)


_EXACT_RANKS: dict[str, int] = {
    "create_database": _CREATE_DATABASE_RANK,
    "alter_table_rename_table": _ALTER_TABLE_RENAME_RANK,
    "create_table": _CREATE_TABLE_RANK,
    "create_view": _CREATE_VIEW_RANK,
}


def _rank_operation(op: MigrationOperation) -> int:
    type_: MigrationOperationType = op.type
    if type_.startswith("drop_"):
        return _DROP_RANK
    exact = _EXACT_RANKS.get(type_)
    if exact is not None:
        return exact
    if type_.startswith("alter_"):
        return _ALTER_RANK
    return _FALLBACK_RANK


def _sorted(operations: Sequence[MigrationOperation]) -> list[MigrationOperation]:
    return sorted(operations, key=lambda op: (_rank_operation(op), op.key))


def _summarize_risk(operations: Sequence[MigrationOperation]) -> _RiskSummary:
    counts: dict[RiskLevel, int] = {"safe": 0, "caution": 0, "danger": 0}
    for op in operations:
        counts[op.risk] += 1
    return _RiskSummary(safe=counts["safe"], caution=counts["caution"], danger=counts["danger"])


def _suggestion_matches(
    suggestion: ColumnRenameSuggestion,
    selected: ColumnRenameSuggestion,
) -> bool:
    return (
        suggestion.database == selected.database
        and suggestion.table == selected.table
        and suggestion.from_ == selected.from_
        and suggestion.to == selected.to
    )


def _table_exists(
    definitions: Sequence[SchemaDefinition], database: str, name: str
) -> bool:
    return any(
        isinstance(d, TableDefinition) and d.database == database and d.name == name
        for d in definitions
    )
