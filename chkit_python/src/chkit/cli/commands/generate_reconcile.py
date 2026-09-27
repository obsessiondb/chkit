"""Narrow snapshot adoption after a manually applied column expression migration."""

from __future__ import annotations

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import SchemaDefinition, TableDefinition


def reconcile_column_expressions(
    previous: list[SchemaDefinition],
    next_: list[SchemaDefinition],
    selected: list[str],
) -> list[SchemaDefinition]:
    current = canonicalize_definitions(next_)
    result = canonicalize_definitions(previous)
    for key in selected:
        index = next(
            (
                i
                for i, item in enumerate(result)
                if isinstance(item, TableDefinition) and f"{item.database}.{item.name}" == key
            ),
            None,
        )
        before = result[index] if index is not None else None
        after = next(
            (
                item
                for item in current
                if isinstance(item, TableDefinition) and f"{item.database}.{item.name}" == key
            ),
            None,
        )
        if not isinstance(before, TableDefinition) or after is None or index is None:
            raise ValueError(
                f"Cannot reconcile {key}: table must exist in both the snapshot and schema."
            )
        columns = []
        for column in before.columns:
            updated = next((item for item in after.columns if item.name == column.name), None)
            columns.append(
                column.model_copy(
                    update={
                        "default": updated.default if updated else None,
                        "default_kind": updated.default_kind if updated else None,
                    }
                )
            )
        candidate = before.model_copy(update={"columns": columns})
        if canonicalize_definitions([candidate]) != [after]:
            raise ValueError(
                f"Cannot reconcile {key}: --reconcile accepts only column expression/kind changes. "
                "Generate other schema changes separately."
            )
        result[index] = candidate
    return result
