// Quote-aware SQL scanning primitives. Characters inside a single-quoted
// string, a double-quoted identifier, or a backtick-quoted identifier are
// literal text, not structure — parens and commas there must be ignored.
//
// Every scanner skips quoted regions through `findQuoteEnd`, so the escaping
// rule lives in exactly one place and the copies cannot drift apart again
// (#197).

type QuoteChar = "'" | '"' | '`'

export function isQuoteChar(char: string | undefined): char is QuoteChar {
  return char === "'" || char === '"' || char === '`'
}

// Index of the quote closing the one at `start`; honours backslash escapes and
// doubled quotes. Unterminated input runs to the end of the string.
export function findQuoteEnd(sql: string, start: number, quote: string): number {
  for (let i = start + 1; i < sql.length; i += 1) {
    if (sql[i] === '\\') i += 1
    else if (sql[i] === quote) {
      if (sql[i + 1] === quote) i += 1
      else return i
    }
  }
  return sql.length
}

/**
 * Peel one layer of wrapping parentheses, but only when the leading `(` closes
 * at the very end — so `(a, b)` becomes `a, b` while `(a), (b)` is left intact.
 */
export function stripWrappingParens(input: string): string {
  if (!input.startsWith('(') || !input.endsWith(')')) return input
  const close = findMatchingParen(input, 0)
  return close === input.length - 1 ? input.slice(1, -1).trim() : input
}

/**
 * Index of the `)` that matches the `(` at `openIndex`, or undefined when the
 * parens are unbalanced.
 */
export function findMatchingParen(input: string, openIndex: number): number | undefined {
  let depth = 0
  for (let i = openIndex; i < input.length; i += 1) {
    const char = input[i]
    if (isQuoteChar(char)) i = findQuoteEnd(input, i, char)
    else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return undefined
}

/** Find a clause/delimiter outside quoted strings, identifiers and parentheses. */
export function findTopLevelSQLPattern(
  sql: string,
  pattern: RegExp,
): { index: number; length: number } | undefined {
  let depth = 0
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    if (isQuoteChar(char)) {
      i = findQuoteEnd(sql, i, char)
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
