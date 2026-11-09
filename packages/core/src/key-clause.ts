import { identifierName, isTrivia, sqlTokens } from './sql-lexer.js'
import { findQuoteEnd, isQuoteChar } from './sql-scan.js'

export function splitTopLevelComma(input: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? ''

    if (isQuoteChar(char)) {
      const end = findQuoteEnd(input, i, char)
      current += input.slice(i, end + 1)
      i = end
      continue
    }

    if (char === '(') {
      depth += 1
      current += char
      continue
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }

    if (char === ',' && depth === 0) {
      const token = current.trim()
      if (token.length > 0) out.push(token)
      current = ''
      continue
    }

    current += char
  }

  const tail = current.trim()
  if (tail.length > 0) out.push(tail)

  return out
}

/**
 * Flattens key entries into one token per key part. An entry may hold several
 * comma-separated parts (`'id, toDate(ts)'`), but one that exactly names a
 * declared column is kept whole, since the name itself may contain a comma.
 */
export function normalizeKeyColumns(
  values: string[] | undefined,
  declaredColumns: ReadonlySet<string> = new Set()
): string[] {
  return (values ?? []).flatMap((value) =>
    declaredColumns.has(value.trim()) ? [value.trim()] : splitTopLevelComma(value.trim())
  )
}

const PLAIN_COLUMN_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A key entry references a table column only when it is a bare identifier.
 * Anything else — function calls like `toDate(ts)`, arithmetic, or tuples — is
 * an expression that ClickHouse validates itself, so it must not be checked
 * against the table's declared column list.
 */
export function isPlainColumnReference(token: string): boolean {
  return PLAIN_COLUMN_REFERENCE.test(token)
}

/**
 * A key clause reduced to what it means, for comparing two clauses only (never
 * rendered). It keeps one entry per token: whitespace and comments go, every
 * identifier compares by its name whether written bare, in backticks or in
 * double quotes (ClickHouse re-quotes names when it stores a key), and a quoted
 * name keeps its commas and spaces. So `` `a, b` `` differs from `` `a`, `b` ``
 * and `` `a b` `` from `ab` (#558), while `toStartOfHour( ts )` matches
 * `toStartOfHour(ts)` and `` `user-id` `` matches `"user-id"`. Pass
 * the clause as rendered (`renderKeyClauseColumns`): a declared column such as
 * `user-id` must already be quoted, or it reads as `user - id`.
 */
export function keyClauseFingerprint(sql: string): string {
  const parts: string[] = []
  for (const token of sqlTokens(sql)) {
    // The lexer reads Unicode whitespace (a no-break space) as punctuation.
    if (isTrivia(token) || (token.kind === 'punctuation' && /^\s$/.test(token.text))) continue
    const name = identifierName(token)
    parts.push(name === undefined ? token.text : `\`${name.replace(/[\\`]/g, '\\$&')}\``)
  }
  return parts.join(' ')
}
