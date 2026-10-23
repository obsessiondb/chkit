import { quoteIdentifier } from './identifier.js'
import type { TableConstraintDefinition } from './model-types.js'
import { normalizeSQLFragment } from './sql-normalizer.js'

export type ConstraintKind = 'CHECK' | 'ASSUME'

/** `CONSTRAINT name CHECK expr` / `CONSTRAINT name ASSUME expr`. */
export function renderConstraint(constraint: TableConstraintDefinition): string {
  return `CONSTRAINT ${quoteIdentifier(constraint.name)} ${constraintKind(constraint)} ${constraintExpression(constraint)}`
}

export function constraintKind(constraint: TableConstraintDefinition): ConstraintKind {
  return constraint.check !== undefined ? 'CHECK' : 'ASSUME'
}

export function constraintExpression(constraint: TableConstraintDefinition): string {
  return constraint.check ?? constraint.assume ?? ''
}

export function canonicalizeConstraint(constraint: TableConstraintDefinition): TableConstraintDefinition {
  const expression = normalizeSQLFragment(constraintExpression(constraint))
  return constraintKind(constraint) === 'CHECK'
    ? { name: constraint.name, check: expression }
    : { name: constraint.name, assume: expression }
}

/** Why a constraint cannot be rendered, or undefined when it is valid. */
export function constraintProblem(constraint: TableConstraintDefinition): string | undefined {
  const check = typeof constraint.check === 'string' ? constraint.check : undefined
  const assume = typeof constraint.assume === 'string' ? constraint.assume : undefined
  if (check !== undefined && assume !== undefined) return 'sets both "check" and "assume"; use one'
  const expression = check ?? assume
  if (expression === undefined) return 'needs a "check" or "assume" expression'
  if (normalizeSQLFragment(expression) === '') return 'has an empty expression'
  return undefined
}
