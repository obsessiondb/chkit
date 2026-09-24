// Quote-aware SQL scanning primitives. Characters inside a single-quoted
// string, a double-quoted identifier, or a backtick-quoted identifier are
// literal text, not structure — parens and commas there must be ignored.
//
// Every scanner in the codebase shares `nextQuote` so the rule lives in exactly
// one place and the copies cannot drift apart again (#197). Missing backtick
// tracking here is what let a column named `weird)name` truncate a parsed
// table body (#196).

type QuoteChar = "'" | '"' | '`'

/**
 * The quote state after reading `char`, given the previous character and the
 * state before it. `null` means "not inside a quoted literal". A quote closes
 * on a matching, unescaped quote char; ClickHouse's doubled-quote escaping
 * (`''`) falls out correctly as a close immediately followed by a re-open.
 */
export function nextQuote(char: string, prevChar: string, quote: QuoteChar | null): QuoteChar | null {
  if (quote) return char === quote && prevChar !== '\\' ? null : quote
  if (char === "'" || char === '"' || char === '`') return char
  return null
}

/** True when `char` is part of a quoted literal (its body or its delimiters). */
function isQuoted(char: string, prevChar: string, quoteBefore: QuoteChar | null): boolean {
  return quoteBefore !== null || nextQuote(char, prevChar, quoteBefore) !== null
}

/**
 * Peel one layer of wrapping parentheses, but only when the leading `(` closes
 * at the very end — so `(a, b)` becomes `a, b` while `(a), (b)` is left intact.
 */
export function stripWrappingParens(input: string): string {
  if (!input.startsWith('(') || !input.endsWith(')')) return input

  let depth = 0
  let quote: QuoteChar | null = null
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? ''
    const prev = i > 0 ? (input[i - 1] ?? '') : ''
    const quoted = isQuoted(char, prev, quote)
    quote = nextQuote(char, prev, quote)
    if (quoted) continue
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return i === input.length - 1 ? input.slice(1, -1).trim() : input
    }
  }
  return input
}

/**
 * Index of the `)` that matches the `(` at `openIndex`, or undefined when the
 * parens are unbalanced. Quote-aware, so parens inside identifiers/strings
 * don't count.
 */
export function findMatchingParen(input: string, openIndex: number): number | undefined {
  let depth = 0
  let quote: QuoteChar | null = null
  for (let i = openIndex; i < input.length; i += 1) {
    const char = input[i] ?? ''
    const prev = i > 0 ? (input[i - 1] ?? '') : ''
    const quoted = isQuoted(char, prev, quote)
    quote = nextQuote(char, prev, quote)
    if (quoted) continue
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return undefined
}
