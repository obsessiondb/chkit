import { describe, expect, test } from 'bun:test'

import { splitTopLevelComma } from './key-clause.js'
import { findMatchingParen, stripWrappingParens } from './sql-scan.js'

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
})
