export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBacktick = false
  let inBlockComment = false

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''
    const next = sql[i + 1] ?? ''

    if (inBlockComment) {
      current += ch
      if (ch === '*' && next === '/') {
        current += next
        i += 1
        inBlockComment = false
      }
      continue
    }

    if (inSingleQuote) {
      current += ch
      if (ch === "'" && next === "'") {
        current += next
        i += 1
        continue
      }
      if (ch === "'" && sql[i - 1] !== '\\') {
        inSingleQuote = false
      }
      continue
    }

    if (inDoubleQuote) {
      current += ch
      if (ch === '"' && sql[i - 1] !== '\\') {
        inDoubleQuote = false
      }
      continue
    }

    if (inBacktick) {
      current += ch
      if (ch === '`') {
        inBacktick = false
      }
      continue
    }

    if (ch === '/' && next === '*') {
      current += ch
      current += next
      i += 1
      inBlockComment = true
      continue
    }

    if (ch === "'") {
      current += ch
      inSingleQuote = true
      continue
    }

    if (ch === '"') {
      current += ch
      inDoubleQuote = true
      continue
    }

    if (ch === '`') {
      current += ch
      inBacktick = true
      continue
    }

    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed.length > 0) statements.push(`${trimmed};`)
      current = ''
      continue
    }

    current += ch
  }

  const tail = current.trim()
  if (tail.length > 0) statements.push(`${tail};`)
  return statements
}

export function extractExecutableStatements(sql: string): string[] {
  // Strip single-line comments (--) while respecting quoted strings.
  // We can't use a naive line-based filter because `--` inside string
  // literals must be preserved.
  let stripped = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBacktick = false
  let inBlockComment = false
  let inLineComment = false

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''
    const next = sql[i + 1] ?? ''

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        stripped += ch
      }
      continue
    }

    if (inBlockComment) {
      stripped += ch
      if (ch === '*' && next === '/') {
        stripped += next
        i += 1
        inBlockComment = false
      }
      continue
    }

    if (inSingleQuote) {
      stripped += ch
      if (ch === "'" && next === "'") {
        stripped += next
        i += 1
        continue
      }
      if (ch === "'" && sql[i - 1] !== '\\') {
        inSingleQuote = false
      }
      continue
    }

    if (inDoubleQuote) {
      stripped += ch
      if (ch === '"' && sql[i - 1] !== '\\') {
        inDoubleQuote = false
      }
      continue
    }

    if (inBacktick) {
      stripped += ch
      if (ch === '`') {
        inBacktick = false
      }
      continue
    }

    if (ch === '-' && next === '-') {
      inLineComment = true
      i += 1
      continue
    }

    if (ch === '/' && next === '*') {
      stripped += ch
      stripped += next
      i += 1
      inBlockComment = true
      continue
    }

    if (ch === "'") {
      stripped += ch
      inSingleQuote = true
      continue
    }

    if (ch === '"') {
      stripped += ch
      inDoubleQuote = true
      continue
    }

    if (ch === '`') {
      stripped += ch
      inBacktick = true
      continue
    }

    stripped += ch
  }

  return splitSqlStatements(stripped)
}
