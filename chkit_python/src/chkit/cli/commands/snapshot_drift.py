"""Inspect local drift without turning unsupported Kafka changes into SQL."""

from chkit.cli.table_scope import TableScope, filter_plan_by_table_scope
from chkit.core.model import (
    ChxValidationError,
    MigrationPlan,
    SchemaDefinition,
    ValidationIssue,
)
from chkit.core.planner import plan_diff


def plan_snapshot_drift(
    previous: list[SchemaDefinition],
    current: list[SchemaDefinition],
    scope: TableScope,
) -> tuple[MigrationPlan, list[ValidationIssue]]:
    """Report blocked replacements alongside the remaining, plannable changes.

    Migration generation still fails on these issues. Read-only checks can
    report them and continue inspecting other tables, including scoped checks.
    """
    issues: list[ValidationIssue] = []
    while True:
        try:
            plan = plan_diff(previous, current)
            break
        except ChxValidationError as error:
            if not error.issues or any(
                issue.code != "kafka_change_requires_replacement" for issue in error.issues
            ):
                raise
            blocked = {(issue.kind, issue.database, issue.name) for issue in error.issues}
            issues.extend(
                issue
                for issue in error.issues
                if not scope.enabled or f"{issue.database}.{issue.name}" in scope.matched_tables
            )
            previous = [d for d in previous if (d.kind, d.database, d.name) not in blocked]
            current = [d for d in current if (d.kind, d.database, d.name) not in blocked]
    if scope.enabled:
        plan = filter_plan_by_table_scope(plan, set(scope.matched_tables)).plan
    return plan, issues
