"""Table constraints (CHECK / ASSUME), in parity with TS ``constraint.ts``."""

from __future__ import annotations

from typing import Literal

from chkit.core.model import TableConstraintDefinition
from chkit.core.sql_normalizer import normalize_sql_fragment

ConstraintKind = Literal["CHECK", "ASSUME"]


def render_constraint(constraint: TableConstraintDefinition) -> str:
    """``CONSTRAINT `name` CHECK expr`` / ``CONSTRAINT `name` ASSUME expr``."""
    kind = constraint_kind(constraint)
    return f"CONSTRAINT `{constraint.name}` {kind} {constraint_expression(constraint)}"


def constraint_kind(constraint: TableConstraintDefinition) -> ConstraintKind:
    return "CHECK" if constraint.check is not None else "ASSUME"


def constraint_expression(constraint: TableConstraintDefinition) -> str:
    if constraint.check is not None:
        return constraint.check
    return constraint.assume or ""


def canonicalize_constraint(constraint: TableConstraintDefinition) -> TableConstraintDefinition:
    expression = normalize_sql_fragment(constraint_expression(constraint))
    if constraint_kind(constraint) == "CHECK":
        return TableConstraintDefinition(name=constraint.name, check=expression)
    return TableConstraintDefinition(name=constraint.name, assume=expression)


def constraint_problem(constraint: TableConstraintDefinition) -> str | None:
    """Why the constraint cannot be rendered, or None when it is valid."""
    if constraint.check is not None and constraint.assume is not None:
        return 'sets both "check" and "assume"; use one'
    expression = constraint.check if constraint.check is not None else constraint.assume
    if expression is None:
        return 'needs a "check" or "assume" expression'
    if normalize_sql_fragment(expression) == "":
        return "has an empty expression"
    return None
