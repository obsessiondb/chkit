import { describe, expect, test } from 'bun:test'

import {
  extractSourceTableRef,
  findTopLevelKeywords,
  injectSortKeyFilter,
  rewriteSelectColumns,
  splitTopLevel,
} from './sql.js'

describe('findTopLevelKeywords', () => {
  test('finds keywords at the top level in ascending position order', () => {
    const hits = findTopLevelKeywords('SELECT a FROM t', ['SELECT', 'FROM'])
    expect(hits).toEqual([
      { keyword: 'SELECT', position: 0 },
      { keyword: 'FROM', position: 9 },
    ])
  })

  test('ignores keywords nested inside parentheses', () => {
    const hits = findTopLevelKeywords('SELECT a, (SELECT b FROM sub) AS x FROM main', [
      'SELECT',
      'FROM',
    ])
    expect(hits.filter((hit) => hit.keyword === 'SELECT')).toHaveLength(1)
    expect(hits.filter((hit) => hit.keyword === 'FROM')).toHaveLength(1)
  })

  test('ignores keywords inside single-quoted string literals', () => {
    const hits = findTopLevelKeywords("SELECT 'FROM WHERE' FROM t", ['FROM', 'WHERE'])
    expect(hits).toHaveLength(1)
    expect(hits[0]?.keyword).toBe('FROM')
  })

  test('treats a backslash-escaped quote as still inside the string', () => {
    // The escaped quote does not close the literal, so the WHERE inside it is skipped.
    const hits = findTopLevelKeywords("SELECT 'a\\' WHERE b' AS c FROM t", ['WHERE', 'FROM'])
    expect(hits.map((hit) => hit.keyword)).toEqual(['FROM'])
  })

  test('requires a word boundary so substrings do not match', () => {
    expect(findTopLevelKeywords('SELECTED FROM t', ['SELECT'])).toEqual([])
    expect(findTopLevelKeywords('a.WHERE = 1', ['WHERE'])).toEqual([])
  })

  test('matches case-insensitively', () => {
    const hits = findTopLevelKeywords('select a from t', ['SELECT', 'FROM'])
    expect(hits.map((hit) => hit.keyword)).toEqual(['SELECT', 'FROM'])
  })

  test('matches multi-word keywords like GROUP BY', () => {
    const hits = findTopLevelKeywords('SELECT * FROM t GROUP BY g', ['GROUP BY'])
    expect(hits).toHaveLength(1)
    expect(hits[0]?.keyword).toBe('GROUP BY')
  })
})

describe('splitTopLevel', () => {
  test('splits on top-level delimiters', () => {
    expect(splitTopLevel('a, b, c', ',').map((s) => s.trim())).toEqual(['a', 'b', 'c'])
  })

  test('does not split inside parentheses', () => {
    expect(splitTopLevel('a, f(b, c), d', ',').map((s) => s.trim())).toEqual([
      'a',
      'f(b, c)',
      'd',
    ])
  })

  test('does not split inside string literals', () => {
    expect(splitTopLevel("a, 'x, y', b", ',').map((s) => s.trim())).toEqual(['a', "'x, y'", 'b'])
  })

  test('keeps a backslash-escaped quote inside the literal', () => {
    const segments = splitTopLevel("'a\\', b', c", ',')
    expect(segments).toHaveLength(2)
    expect(segments[0]?.trim()).toBe("'a\\', b'")
    expect(segments[1]?.trim()).toBe('c')
  })

  test('returns the whole string when no delimiter is present', () => {
    expect(splitTopLevel('a b c', ',')).toEqual(['a b c'])
  })
})

describe('rewriteSelectColumns', () => {
  test('reorders projection items to match target column order', () => {
    const rewritten = rewriteSelectColumns('SELECT a AS x, b AS y FROM t', ['y', 'x'])
    expect(rewritten).toContain('SELECT b AS y, a AS x')
    expect(rewritten).toContain('FROM t')
  })

  test('does not confuse SELECT/FROM keywords inside string literals', () => {
    const rewritten = rewriteSelectColumns(
      "SELECT 'has FROM inside' AS note, id FROM t",
      ['id', 'note'],
    )
    expect(rewritten).toContain("id, 'has FROM inside' AS note")
    expect(rewritten).toContain('FROM t')
  })

  test('handles backslash-escaped quotes with commas inside a projection item', () => {
    const rewritten = rewriteSelectColumns("SELECT 'a\\', b' AS label, id FROM t", ['id', 'label'])
    expect(rewritten).toContain("id, 'a\\', b' AS label")
    expect(rewritten).toContain('FROM t')
  })

  test('keeps a nested-paren subquery projection item intact', () => {
    const rewritten = rewriteSelectColumns(
      'SELECT id, (SELECT max(v) FROM sub WHERE k = a) AS mx FROM main',
      ['mx', 'id'],
    )
    expect(rewritten).toContain('(SELECT max(v) FROM sub WHERE k = a) AS mx, id')
    expect(rewritten).toContain('FROM main')
  })

  test('preserves trailing clauses after FROM', () => {
    const rewritten = rewriteSelectColumns(
      'SELECT a AS x, b FROM t WHERE c = 1 GROUP BY d',
      ['b', 'x'],
    )
    expect(rewritten).toContain('SELECT b, a AS x')
    expect(rewritten).toContain('FROM t WHERE c = 1 GROUP BY d')
  })

  test('falls through unmatched target columns as bare column references', () => {
    const rewritten = rewriteSelectColumns('SELECT event_time AS ts FROM t', ['ts', 'ingested_at'])
    expect(rewritten).toContain('SELECT event_time AS ts, ingested_at')
  })

  test('returns the query unchanged when FROM is missing', () => {
    expect(rewriteSelectColumns('SELECT a, b', ['b', 'a'])).toBe('SELECT a, b')
  })

  test('returns the query unchanged when SELECT is missing', () => {
    expect(rewriteSelectColumns('DELETE FROM t', ['a'])).toBe('DELETE FROM t')
  })

  test('preserves a leading DISTINCT', () => {
    const rewritten = rewriteSelectColumns('SELECT DISTINCT a AS x, b AS y FROM t', ['y', 'x'])
    expect(rewritten).toContain('SELECT DISTINCT b AS y, a AS x')
  })
})

describe('extractSourceTableRef', () => {
  test('extracts a qualified database.table', () => {
    expect(extractSourceTableRef('SELECT * FROM solana.raw_token_transfers')).toEqual({
      database: 'solana',
      table: 'raw_token_transfers',
    })
  })

  test('stops at a trailing clause', () => {
    expect(
      extractSourceTableRef('SELECT a, count() AS c FROM app.events GROUP BY a ORDER BY c'),
    ).toEqual({ database: 'app', table: 'events' })
  })

  test('ignores a table alias', () => {
    expect(extractSourceTableRef('SELECT * FROM app.events AS e WHERE e.x = 1')).toEqual({
      database: 'app',
      table: 'events',
    })
    expect(extractSourceTableRef('SELECT * FROM app.events e')).toEqual({
      database: 'app',
      table: 'events',
    })
  })

  test('returns a bare table with no database', () => {
    expect(extractSourceTableRef('SELECT count() FROM raw_events')).toEqual({ table: 'raw_events' })
  })

  test('strips backtick-quoted identifiers', () => {
    expect(extractSourceTableRef('SELECT * FROM `app`.`events`')).toEqual({
      database: 'app',
      table: 'events',
    })
  })

  test('ignores a FROM keyword hiding inside a string literal', () => {
    expect(extractSourceTableRef("SELECT 'FROM sneaky' AS note FROM app.events")).toEqual({
      database: 'app',
      table: 'events',
    })
  })

  test('returns undefined for a subquery source', () => {
    expect(extractSourceTableRef('SELECT * FROM (SELECT * FROM app.events) AS s')).toBeUndefined()
  })

  test('returns undefined for a table-function source', () => {
    expect(extractSourceTableRef('SELECT * FROM numbers(10)')).toBeUndefined()
  })

  test('returns undefined when there is no FROM', () => {
    expect(extractSourceTableRef('SELECT 1')).toBeUndefined()
  })
})

describe('injectSortKeyFilter', () => {
  test('adds a WHERE clause when none exists', () => {
    const sql = injectSortKeyFilter('SELECT * FROM t', 'ts', 'numeric', '1', '5')
    expect(sql).toContain("WHERE ts >= '1'")
    expect(sql).toContain("AND ts < '5'")
  })

  test('appends with AND when a WHERE already exists', () => {
    const sql = injectSortKeyFilter('SELECT * FROM t WHERE x = 1', 'ts', 'numeric', '1', '5')
    expect(sql).toContain('WHERE x = 1')
    expect(sql).toContain("AND ts >= '1'")
  })

  test('inserts the filter before a trailing clause', () => {
    const sql = injectSortKeyFilter('SELECT * FROM t GROUP BY g', 'ts', 'numeric', '1', '5')
    expect(sql.indexOf('WHERE ts')).toBeLessThan(sql.indexOf('GROUP BY g'))
    expect(sql).toContain('GROUP BY g')
  })

  test('ignores a trailing-clause keyword that lives inside a string literal', () => {
    const sql = injectSortKeyFilter(
      "SELECT * FROM t WHERE label = 'GROUP BY hack'",
      'ts',
      'numeric',
      '1',
      '5',
    )
    expect(sql).toContain("label = 'GROUP BY hack'")
    expect(sql).toContain("AND ts >= '1'")
    // No fresh WHERE was inserted; the existing one was extended.
    expect(sql.match(/WHERE/g)).toHaveLength(1)
  })
})
