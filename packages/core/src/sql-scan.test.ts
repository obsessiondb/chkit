import { describe, expect, test } from 'bun:test'

import fixture from '../../../test/fixtures/sql-scan.json'
import { splitTopLevelComma } from './key-clause.js'
import { normalizeProjectionIndex } from './projection.js'
import { tokenizeSQL } from './sql-lexer.js'
import { normalizeSQLFragment } from './sql-normalizer.js'
import {
  findMatchingParen,
  findQuoteEnd,
  findTopLevelSQLPattern,
  isQuoteChar,
  stripWrappingParens,
} from './sql-scan.js'

describe('splitTopLevelComma', () => {
  test('splits only at top-level commas', () => {
    expect(splitTopLevelComma('a, b, c')).toEqual(['a', 'b', 'c'])
    expect(splitTopLevelComma('cityHash64(a, b), c')).toEqual(['cityHash64(a, b)', 'c'])
  })

  test('ignores commas and parens inside quotes of every kind', () => {
    expect(splitTopLevelComma("'x,y', z")).toEqual(["'x,y'", 'z'])
    expect(splitTopLevelComma('"x,y", z')).toEqual(['"x,y"', 'z'])
    expect(splitTopLevelComma('`a,b`, c')).toEqual(['`a,b`', 'c'])
    expect(splitTopLevelComma('`a)b`, c')).toEqual(['`a)b`', 'c'])
  })

  test('honours backslash escapes and doubled quotes', () => {
    expect(splitTopLevelComma("'a\\\\', b")).toEqual(["'a\\\\'", 'b'])
    expect(splitTopLevelComma("'it''s, ok', b")).toEqual(["'it''s, ok'", 'b'])
  })
})

describe('stripWrappingParens', () => {
  test('peels exactly one wrapping layer, and only a genuine wrapper', () => {
    expect(stripWrappingParens('(a, b)')).toBe('a, b')
    expect(stripWrappingParens('((a, b))')).toBe('(a, b)')
    expect(stripWrappingParens('(a), (b)')).toBe('(a), (b)')
    expect(stripWrappingParens('a, b')).toBe('a, b')
  })

  test('is not fooled by a paren inside a backtick identifier', () => {
    expect(stripWrappingParens('(`w)x`)')).toBe('`w)x`')
    expect(stripWrappingParens('(`w)x`, a)')).toBe('`w)x`, a')
  })

  test('is not fooled by an escaped backslash before a closing quote', () => {
    expect(stripWrappingParens("('a\\\\', ')')")).toBe("'a\\\\', ')'")
  })

  test('reads a paren inside a heredoc as text (#587)', () => {
    expect(stripWrappingParens('($$a)$$)')).toBe('$$a)$$')
    expect(stripWrappingParens('($t$(a$t$)')).toBe('$t$(a$t$')
    // The first `(` closes right after its heredoc, not at the end.
    expect(stripWrappingParens('($$($$) || ($$)$$)')).toBe('($$($$) || ($$)$$)')
  })
})

describe('findQuoteEnd', () => {
  test('returns the index of the closing quote', () => {
    expect(findQuoteEnd("'abc' tail", 0, "'")).toBe(4)
    expect(findQuoteEnd("'a\\'b' tail", 0, "'")).toBe(5)
    expect(findQuoteEnd("'a''b' tail", 0, "'")).toBe(5)
    expect(findQuoteEnd('`a``b` tail', 0, '`')).toBe(5)
  })

  test('a backslash-escaped backslash does not escape the closing quote', () => {
    expect(findQuoteEnd("'a\\\\' tail", 0, "'")).toBe(4)
  })

  test('runs to the end of unterminated input', () => {
    expect(findQuoteEnd("'abc", 0, "'")).toBe(4)
  })
})

describe('findMatchingParen', () => {
  test('finds the close matching the open at the given index', () => {
    expect(findMatchingParen('(a, b) rest', 0)).toBe(5)
    expect(findMatchingParen('f(g(x)) rest', 1)).toBe(6)
  })

  test('ignores parens inside quotes', () => {
    // The ')' inside the quoted region must not close the group.
    expect(findMatchingParen('(`w)x`) tail', 0)).toBe(6)
    expect(findMatchingParen("('a)b') tail", 0)).toBe(6)
  })

  test('returns undefined when unbalanced', () => {
    expect(findMatchingParen('(a, b', 0)).toBeUndefined()
  })

  test('ignores parens inside a heredoc or a comment (#587)', () => {
    expect(findMatchingParen('($$a)$$) tail', 0)).toBe(7)
    expect(findMatchingParen('f($tag$)$tag$) tail', 1)).toBe(13)
    expect(findMatchingParen('(a /* ) */) tail', 0)).toBe(10)
  })

  test('reads a `$` as ClickHouse does where no heredoc closes (#587)', () => {
    // No second `$$`: the `$`s are punctuation and the parens are structure.
    expect(findMatchingParen('($$a) tail', 0)).toBe(4)
    // `f$$` is a name, so the later `$$` opens no heredoc.
    expect(findMatchingParen('(f$$(x) || $$) tail', 0)).toBe(13)
  })
})

// test/fixtures/sql-scan.json is shared with chkit-py (tests/test_sql_scan.py):
// both ports read a heredoc and a comment as text, not structure (#596).
describe('heredoc and comment cases shared with chkit-py (#596)', () => {
  for (const { name, input, expected } of fixture.splitTopLevelComma) {
    test(`splitTopLevelComma: ${name}`, () => {
      expect(splitTopLevelComma(input)).toEqual(expected)
    })
  }

  for (const { name, sql, pattern, expected } of fixture.findTopLevelSQLPattern) {
    test(`findTopLevelSQLPattern: ${name}`, () => {
      expect(findTopLevelSQLPattern(sql, new RegExp(pattern, 'i')) ?? null).toEqual(expected)
    })
  }

  for (const { name, input, expected } of fixture.normalizeProjectionIndex) {
    test(`normalizeProjectionIndex: ${name}`, () => {
      expect(normalizeProjectionIndex(input)).toBe(expected)
    })
  }
})

// The scanners as they were before #596, which skipped only quotes. On input
// without heredocs and comments the lexer-based ones must agree with them.
function legacySplitTopLevelComma(input: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? ''
    if (isQuoteChar(char)) {
      const end = findQuoteEnd(input, i, char)
      current += input.slice(i, end + 1)
      i = end
    } else if (char === ',' && depth === 0) {
      if (current.trim().length > 0) out.push(current.trim())
      current = ''
    } else {
      if (char === '(') depth += 1
      if (char === ')') depth = Math.max(0, depth - 1)
      current += char
    }
  }
  if (current.trim().length > 0) out.push(current.trim())
  return out
}

function legacyFindTopLevelSQLPattern(sql: string, pattern: RegExp): { index: number; length: number } | undefined {
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
    if (depth !== 0 || (/[A-Za-z_]/.test(char ?? '') && i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1] ?? ''))) continue
    const match = sql.slice(i).match(pattern)
    if (match?.index === 0) return { index: i, length: match[0].length }
  }
  return undefined
}

function legacySpaceAfterCommas(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? ''
    if (isQuoteChar(char)) {
      const end = findQuoteEnd(input, i, char)
      out += input.slice(i, end + 1)
      i = end
    } else if (char === ',') {
      out += ', '
      if (input[i + 1] === ' ') i += 1
    } else {
      out += char
    }
  }
  return out
}

function legacyNormalizeProjectionIndex(index: string): string {
  let expression = normalizeSQLFragment(index)
  for (let stripped = stripWrappingParens(expression); stripped !== expression; ) {
    expression = stripped
    stripped = stripWrappingParens(expression)
  }
  const parts = legacySplitTopLevelComma(expression)
  if (parts.length === 0) return ''
  if (parts.length === 1) return legacySpaceAfterCommas(expression)
  return `(${parts.map(legacyNormalizeProjectionIndex).join(', ')})`
}

// Pieces that exercise every branch of the old scanners: quotes of each kind,
// escapes, parens, commas, keywords inside and next to words, and the
// characters that start comments and heredocs (`-`, `/`, `*`, `#`, `$`).
const PIECES = [
  'SETTINGS', 'settings', 'xSETTINGS', '1SETTINGS', '$SETTINGS', 'COMMENT', 'ORDER BY', 'a', 'b_1', '1', '1.5e3',
  '(', ')', ',', ', ', ' ', '\n', '\t', "'", '"', '`', '\\', "''", '$', '-', '/', '*', '#', ';', '=', '.', 'é',
]

// A seeded generator (mulberry32) keeps the inputs the same on every run.
function randomInputs(seed: number, count: number): string[] {
  let state = seed
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const inputs: string[] = []
  while (inputs.length < count) {
    const length = Math.floor(next() * 16)
    let input = ''
    for (let i = 0; i < length; i += 1) input += PIECES[Math.floor(next() * PIECES.length)]
    const hasHeredocOrComment = tokenizeSQL(input).some(
      (token) =>
        token.kind === 'line_comment' ||
        token.kind === 'block_comment' ||
        (token.kind === 'string' && token.text.startsWith('$')),
    )
    if (!hasHeredocOrComment) inputs.push(input)
  }
  return inputs
}

describe('scanners agree with the quote-only ones on input without heredocs or comments (#596)', () => {
  const inputs = randomInputs(596, 3000)

  test('the inputs reach the cases that matter', () => {
    const counts = [
      inputs.filter((input) => legacySplitTopLevelComma(input).length > 1).length,
      inputs.filter((input) => legacyFindTopLevelSQLPattern(input, /\bSETTINGS\b/i) !== undefined).length,
      inputs.filter((input) => /['"`]/.test(input)).length,
      inputs.filter((input) => /[-/*#$]/.test(input)).length,
    ]
    for (const count of counts) expect(count).toBeGreaterThan(300)
  })

  test('splitTopLevelComma', () => {
    for (const input of inputs) expect([input, splitTopLevelComma(input)]).toEqual([input, legacySplitTopLevelComma(input)])
  })

  test('findTopLevelSQLPattern', () => {
    for (const pattern of [/\bSETTINGS\b/i, /\bCOMMENT\b|;/i, /\bORDER\s+BY\b/i]) {
      for (const input of inputs) {
        expect([input, findTopLevelSQLPattern(input, pattern)]).toEqual([input, legacyFindTopLevelSQLPattern(input, pattern)])
      }
    }
  })

  test('normalizeProjectionIndex', () => {
    for (const input of inputs) {
      expect([input, normalizeProjectionIndex(input)]).toEqual([input, legacyNormalizeProjectionIndex(input)])
    }
  })
})
