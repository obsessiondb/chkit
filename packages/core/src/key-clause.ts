import { isTrivia, type SQLToken, sqlTokens } from './sql-lexer.js'
import { stringLiteral } from './text-index-sql.js'

/**
 * Split on commas outside parentheses. The input is read with the SQL lexer, so
 * a comma or paren in a string, quoted name, heredoc (`$$a, b$$`) or comment is
 * text (#596). Comments are dropped, each leaving one space so the tokens
 * around it never fuse: a part is trimmed and its callers rejoin parts on one
 * line, where a kept `--` comment would swallow the rest. An unterminated
 * block comment is kept as written for ClickHouse to report.
 */
export function splitTopLevelComma(input: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0

  for (const token of sqlTokens(input)) {
    if (token.kind === 'line_comment' || (token.kind === 'block_comment' && token.terminated)) {
      current += ' '
      continue
    }
    if (token.kind === 'punctuation') {
      if (token.text === '(') depth += 1
      else if (token.text === ')') depth = Math.max(0, depth - 1)
      else if (token.text === ',' && depth === 0) {
        const part = current.trim()
        if (part.length > 0) out.push(part)
        current = ''
        continue
      }
    }
    current += token.text
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
 * `toStartOfHour(ts)` and `` `user-id` `` matches `"user-id"`. Pass the clause
 * as rendered (`renderKeyClauseColumns`): a declared column such as `user-id`
 * must already be quoted, or it reads as `user - id`.
 */
export function keyClauseFingerprint(sql: string): string {
  const parts: string[] = []
  for (const token of sqlTokens(sql)) {
    // The lexer reads Unicode whitespace (a no-break space) as punctuation.
    if (isTrivia(token) || (token.kind === 'punctuation' && /^\s$/.test(token.text))) continue
    parts.push(nameFingerprint(token, parts.at(-1) === '.') ?? token.text)
  }
  return parts.join(' ')
}

// A name as the bytes ClickHouse reads from it, in one canonical spelling, so
// `` `a\x41` `` matches `aA` while `` `a\q` `` keeps its backslash (ClickHouse
// decodes escapes in a quoted name as in a string literal). A bare NULL is the
// literal and stays as written, unless a dot qualifies it (`c.null`, the null
// map of a Nullable column): ClickHouse always quotes a column named `null`.
// It does not quote one named `true`, `false`, `inf` or `nan`, so those compare
// as names however they are written.
function nameFingerprint(token: SQLToken, qualified: boolean): string | undefined {
  if (token.kind === 'identifier') {
    return token.text.toLowerCase() === 'null' && !qualified ? undefined : `\`${stringLiteral(token.text)}`
  }
  if (token.kind !== 'quoted_identifier' || !token.terminated) return undefined
  const quote = token.text[0] ?? ''
  const body = token.text.slice(1, -1)
  // As a string literal body: the doubled quote becomes an escaped one, and a
  // bare `'` is escaped so it is never read as half of a doubled `''`.
  let literal = ''
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? ''
    if (char === '\\') {
      literal += body.slice(i, i + 2)
      i += 1
    } else if (char === quote && body[i + 1] === quote) {
      literal += `\\${quote}`
      i += 1
    } else {
      literal += char === "'" ? "\\'" : char
    }
  }
  try {
    return `\`${stringLiteral(literal)}`
  } catch {
    // An invalid escape (`\xZZ`) is compared as written.
    return undefined
  }
}
