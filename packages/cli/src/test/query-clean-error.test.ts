import { describe, expect, test } from 'bun:test'

import { cleanQueryError } from '../commands/query.js'

describe('cleanQueryError (#24)', () => {
  test('strips the injected FORMAT JSONEachRow chkit appends to the human query path', () => {
    const raw = new Error(
      'Code: 62. DB::Exception: Syntax error: failed at position 13 ((): ( FROM users FORMAT JSONEachRow. Unmatched parentheses: (. (SYNTAX_ERROR)',
    )
    const cleaned = cleanQueryError(raw) as Error
    expect(cleaned.message).not.toContain('FORMAT JSONEachRow')
    expect(cleaned.message).toContain('( FROM users.')
  })

  test('strips the injected FORMAT JSON chkit appends to the --json query path', () => {
    const raw = new Error('Syntax error at position 5: SELECT FORMAT JSON. (SYNTAX_ERROR)')
    const cleaned = cleanQueryError(raw) as Error
    expect(cleaned.message).not.toContain('FORMAT JSON')
  })

  test('caps the "Expected one of" token dump', () => {
    const raw = new Error(
      'Syntax error: failed at position 10 (2): 2 3. Expected one of: token, OR, AND, IS NULL, BETWEEN, LIKE, IN, MOD, AS, FROM, WHERE, GROUP BY, ORDER BY, LIMIT, FORMAT, end of query.',
    )
    const cleaned = cleanQueryError(raw) as Error
    expect(cleaned.message).toContain('Expected one of: token, OR, AND, IS NULL, BETWEEN, LIKE, IN, MOD, … (8 more).')
    // None of the capped-off tokens leak.
    expect(cleaned.message).not.toContain('GROUP BY')
  })

  test('returns the original error untouched when there is nothing to clean', () => {
    const raw = new Error('Could not connect to ClickHouse at https://x (connection refused)')
    expect(cleanQueryError(raw)).toBe(raw)
  })

  test('passes non-Error values through unchanged', () => {
    expect(cleanQueryError('boom')).toBe('boom')
    expect(cleanQueryError(undefined)).toBe(undefined)
  })
})
