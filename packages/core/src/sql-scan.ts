/** Find a clause/delimiter outside quoted strings, identifiers and parentheses. */
export function findTopLevelSQLPattern(
  sql: string,
  pattern: RegExp,
): { index: number; length: number } | undefined {
  let quote: string | undefined
  let depth = 0
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) {
        if (sql[i + 1] === quote) i += 1
        else quote = undefined
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      continue
    }
    if (
      depth !== 0 ||
      (/[A-Za-z_]/.test(char ?? '') && i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1] ?? ''))
    )
      continue
    const match = sql.slice(i).match(pattern)
    if (match?.index === 0) return { index: i, length: match[0].length }
  }
  return undefined
}
