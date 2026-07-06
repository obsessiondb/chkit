export function splitTopLevelComma(input: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0
  let quote: "'" | '"' | '`' | null = null

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? ''
    const prev = i > 0 ? input[i - 1] : ''

    if (quote) {
      current += char
      if (char === quote && prev !== '\\') quote = null
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
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

export function normalizeKeyColumns(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => splitTopLevelComma(value.trim()))
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
