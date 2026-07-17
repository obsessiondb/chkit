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
  // keeps both groups. Parens inside quoted identifiers and string literals
  // are text, not nesting — `` (`weird)name`) `` is still a single wrapped
  // expression.
  let depth = 0
  let quote: "'" | '"' | '`' | null = null
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quote) {
      if (char === quote && input[i - 1] !== '\\') quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return i === input.length - 1 ? input.slice(1, -1).trim() : input
    }
  }
  return input
}

/** ClickHouse prints one space after every argument separator. */
function spaceAfterCommas(input: string): string {
  let out = ''
  let quote: "'" | '"' | '`' | null = null
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? ''
    if (quote) {
      out += char
      if (char === quote && input[i - 1] !== '\\') quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      out += char
      continue
    }
    // Whitespace is already collapsed to single spaces by normalizeSQLFragment,
    // so a comma is followed by at most one space.
    if (char === ',') {
      out += ', '
      if (input[i + 1] === ' ') i += 1
      continue
    }
    out += char
  }
  return out
}

/**
 * Render an index expression list the way ClickHouse itself echoes it back:
 * a single element is bare (`INDEX b`), several are a tuple (`INDEX (a, b)`).
 *
 * Both halves matter. ClickHouse rewrites `INDEX (b)` to `INDEX b`, so without
 * this a pulled schema would drift against the live table forever; and it
 * rejects `INDEX a, b` outright, so multiple elements must be parenthesized.
 *
 * Must be idempotent: it runs at canonicalize time and again at render time,
 * and a canonical form that keeps changing makes every `generate` re-emit a
 * drop + rebuild of the projection.
 */
export function normalizeProjectionIndex(index: string): string {
  // Peel every redundant layer, not just one: ClickHouse reports `((a, b))`
  // back as `(a, b)`.
  let expression = normalizeSQLFragment(index)
  for (let stripped = stripWrappingParens(expression); stripped !== expression; ) {
    expression = stripped
    stripped = stripWrappingParens(expression)
  }

  const parts = splitTopLevelComma(expression)
  if (parts.length === 0) return ''
  // A lone element is the base case — recursing here would not terminate.
  if (parts.length === 1) return spaceAfterCommas(expression)
  // Each element is peeled too, since ClickHouse reports `(a, (b))` back as
  // `(a, b)` while keeping a genuine nested tuple like `(a, (b, c))`.
  return `(${parts.map(normalizeProjectionIndex).join(', ')})`
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
