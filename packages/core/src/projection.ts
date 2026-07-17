import type { IndexProjectionDefinition, ProjectionDefinition } from './model-types.js'
import { splitTopLevelComma } from './key-clause.js'
import { normalizeSQLFragment } from './sql-normalizer.js'

export function isIndexProjection(
  projection: ProjectionDefinition
): projection is IndexProjectionDefinition {
  return 'index' in projection
}

function stripWrappingParens(input: string): string {
  if (!input.startsWith('(') || !input.endsWith(')')) return input

  // Only strip when the leading paren closes at the very end, so `(a), (b)`
  // keeps both groups.
  let depth = 0
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return i === input.length - 1 ? input.slice(1, -1).trim() : input
    }
  }
  return input
}

/**
 * Render an index expression list the way ClickHouse itself echoes it back:
 * a single element is bare (`INDEX b`), several are a tuple (`INDEX (a, b)`).
 *
 * Both halves matter. ClickHouse rewrites `INDEX (b)` to `INDEX b`, so without
 * this a pulled schema would drift against the live table forever; and it
 * rejects `INDEX a, b` outright, so multiple elements must be parenthesized.
 */
export function normalizeProjectionIndex(index: string): string {
  const parts = splitTopLevelComma(stripWrappingParens(normalizeSQLFragment(index)))
  if (parts.length === 0) return ''
  return parts.length === 1 ? (parts[0] ?? '') : `(${parts.join(', ')})`
}

export function canonicalizeProjection(projection: ProjectionDefinition): ProjectionDefinition {
  // Rebuilt field-by-field rather than spread: the planner compares projections
  // with JSON.stringify, which is key-order sensitive.
  if (isIndexProjection(projection)) {
    return {
      name: projection.name,
      index: normalizeProjectionIndex(projection.index),
      type: projection.type.trim(),
    }
  }
  return {
    name: projection.name,
    query: normalizeSQLFragment(projection.query),
  }
}

export function renderProjectionBody(projection: ProjectionDefinition): string {
  return isIndexProjection(projection)
    ? `INDEX ${normalizeProjectionIndex(projection.index)} TYPE ${projection.type.trim()}`
    : `(${projection.query})`
}
