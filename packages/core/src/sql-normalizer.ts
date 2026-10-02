import { isKafkaEngine, normalizeKafkaEngine } from './kafka.js'
import { type SQLToken, tokenizeSQL } from './sql-lexer.js'
import { textExpressionFingerprint, textSQLFingerprint } from './text-index-sql.js'

const SYNTHETIC_EPHEMERAL_DEFAULT = /^defaultValueOfTypeName\s*\(\s*'(?:[^'\\]|\\.|'')*'\s*\)$/s

/**
 * Compare expression tokens while preserving quoted values and identifier case.
 * SQL the lexer cannot read (e.g. an unterminated quote) falls back to its
 * normalizeSQLFragment form, encoded as a JSON string so it never equals a token
 * list.
 */
export function sqlExpressionFingerprint(value: string): string {
  try {
    return textSQLFingerprint(textExpressionFingerprint(value))
  } catch {
    return JSON.stringify(normalizeSQLFragment(value))
  }
}

/**
 * Whether `expression` is the default ClickHouse stores for a bare EPHEMERAL
 * column. ClickHouse synthesizes defaultValueOfTypeName('<type as written>');
 * the literal keeps alias spellings (BIGINT, TEXT) that system.columns.type
 * canonicalizes, so any single string literal counts.
 */
export function isSyntheticEphemeralDefault(expression: string): boolean {
  return SYNTHETIC_EPHEMERAL_DEFAULT.test(expression.trim())
}

/**
 * Canonical one-line form of a SQL fragment: a view or materialized view `as`,
 * `partitionBy`, `ttl`, a skip index expression, a projection, a dictionary
 * `source`/`layout`/`lifetime`, or the same clauses read back from ClickHouse.
 *
 * Comments are dropped and every run of whitespace becomes one space, inside
 * string literals too. Comments must go before the newlines do: a `--`, `//`,
 * `# ` or `#!` comment ends at its newline, so on a single line it would swallow
 * the rest of the fragment and the `;` the renderer appends after it (#232).
 * Comment syntax is ClickHouse's, from the shared lexer: markers inside string
 * literals, quoted identifiers and heredocs are text, and an unterminated block
 * comment or string is kept as written for ClickHouse to report.
 *
 * A dropped comment leaves one space, so the tokens around it never fuse: a
 * minus, an empty block comment and a minus become `- -`, not a `--` comment.
 * Text without comments or a stray `#` normalizes exactly as a plain
 * whitespace collapse would, and the result is stable: normalizing it again
 * changes nothing.
 */
export function normalizeSQLFragment(value: string): string {
  let out = ''
  let separator = ''
  let afterBareHash = false
  for (const token of tokenizeSQL(value)) {
    if (separatesTokens(token)) {
      // `#` not followed by a space or `!` is a syntax error in ClickHouse.
      // A space after it would turn it into a `# ` comment that hides the rest
      // of the fragment, so keep the error visible with a newline instead.
      separator = afterBareHash ? '\n' : ' '
      continue
    }
    if (out !== '') out += separator
    out += token.text.replace(/\s+/g, ' ')
    separator = ''
    afterBareHash = token.kind === 'punctuation' && token.text === '#'
  }
  // An unterminated string or block comment at the end can still end in a space.
  return out.trim()
}

export function normalizeEngine(engine: string): string {
  if (isKafkaEngine(engine)) return normalizeKafkaEngine(engine)
  let normalized = engine.trim().replace(/^Shared/, '')
  if (!normalized.includes('(')) {
    normalized += '()'
  }
  return normalized
}

// Whitespace and closed comments. The lexer reads Unicode whitespace such as a
// no-break space as punctuation; ClickHouse skips it like a space, and chkit
// has always collapsed it like one.
function separatesTokens(token: SQLToken): boolean {
  if (token.kind === 'whitespace') return true
  if (token.kind === 'line_comment' || token.kind === 'block_comment') return token.terminated
  return token.kind === 'punctuation' && /^\s$/.test(token.text)
}
