// Quote-aware SQL scanning primitives. Characters inside a single-quoted
// string, a double-quoted identifier, or a backtick-quoted identifier are
// literal text, not structure — parens and commas there must be ignored.
//
// A scanner that skips only quoted regions does so through `findQuoteEnd`, so
// the escaping rule lives in exactly one place (#197). `findMatchingParen`,
// `findTopLevelSQLPattern` and `splitTopLevelComma` read with the SQL lexer
// instead, which also knows heredocs and comments (#587, #596).

import { type SQLToken, sqlTokens } from './sql-lexer.js'

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
 * parens are unbalanced. The input is read with the SQL lexer, so a paren in a
 * string, quoted name, heredoc (`$$)$$`) or comment is text (#587).
 */
export function findMatchingParen(input: string, openIndex: number): number | undefined {
  let depth = 0
  for (const token of sqlTokens(input.slice(openIndex))) {
    if (token.kind !== 'punctuation') continue
    if (token.text === '(') depth += 1
    else if (token.text === ')') {
      depth -= 1
      if (depth === 0) return openIndex + token.start
    }
  }
  return undefined
}

/**
 * Find a clause/delimiter outside parentheses, strings, quoted identifiers,
 * heredocs and comments. The input is read with the SQL lexer (#596); the
 * pattern is tried at every position of the other tokens that does not start
 * inside a word, and may run on past the token it starts in.
 */
export function findTopLevelSQLPattern(
  sql: string,
  pattern: RegExp,
): { index: number; length: number } | undefined {
  let depth = 0
  for (const token of sqlTokens(sql)) {
    if (token.kind === 'punctuation' && token.text === '(') {
      depth += 1
      continue
    }
    if (token.kind === 'punctuation' && token.text === ')') {
      depth -= 1
      continue
    }
    if (depth !== 0 || isTextToken(token)) continue
    for (let i = token.start; i < token.end; i += 1) {
      if (/[A-Za-z_]/.test(sql[i] ?? '') && i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) continue
      const match = sql.slice(i).match(pattern)
      if (match?.index === 0) return { index: i, length: match[0].length }
    }
  }
  return undefined
}

// A string, heredoc, quoted name or comment: its characters are never structure.
function isTextToken(token: SQLToken): boolean {
  return (
    token.kind === 'string' ||
    token.kind === 'quoted_identifier' ||
    token.kind === 'line_comment' ||
    token.kind === 'block_comment'
  )
}
