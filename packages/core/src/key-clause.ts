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
