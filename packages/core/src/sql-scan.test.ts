import { describe, expect, test } from 'bun:test'

import { splitTopLevelComma } from './key-clause.js'
import { findMatchingParen, findQuoteEnd, stripWrappingParens } from './sql-scan.js'

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
