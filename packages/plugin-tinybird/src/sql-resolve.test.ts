import { describe, expect, test } from 'bun:test'

import { tokenizeSQL } from '@chkit/core'

import { type ResolveScope, resolveNode, SqlResolveError, unresolvedTable } from './sql-resolve.js'

function scope(nodes: Record<string, string>, extra: Partial<ResolveScope> = {}): ResolveScope {
  return {
    database: 'analytics',
    datasources: new Set(['events', 'users', 'my-table']),
    untranslatableDatasources: new Map([['sampled', 'no SAMPLE BY']]),
    nodes: new Map(Object.entries(nodes)),
    pipes: new Map(),
    ...extra,
  }
}

const resolve = (sql: string, extra: Partial<ResolveScope> = {}) => resolveNode('n', scope({ n: sql }, extra)).sql

describe('resolveNode', () => {
  test('qualifies datasources and aliases them with their name, before FINAL', () => {
    expect(resolve('SELECT * FROM events')).toBe('SELECT * FROM analytics.events AS events')
    expect(resolve('SELECT * FROM users FINAL WHERE 1')).toBe('SELECT * FROM analytics.users AS users FINAL WHERE 1')
    expect(resolve('SELECT * FROM `my-table`')).toBe('SELECT * FROM analytics.`my-table` AS `my-table`')
  })

  test('keeps the alias the SQL gives', () => {
    expect(resolve('SELECT e.a FROM events e')).toBe('SELECT e.a FROM analytics.events e')
    expect(resolve('SELECT e.a FROM events AS e FINAL')).toBe('SELECT e.a FROM analytics.events AS e FINAL')
  })

  test('finds tables after every JOIN, in comma lists and in subqueries', () => {
    expect(resolve('SELECT 1 FROM events e LEFT ANY JOIN users ON 1 INNER JOIN (SELECT 1 FROM users) AS x ON 1')).toBe(
      'SELECT 1 FROM analytics.events e LEFT ANY JOIN analytics.users AS users ON 1 INNER JOIN (SELECT 1 FROM analytics.users AS users) AS x ON 1'
    )
    expect(resolve('SELECT 1 FROM events, users AS u WHERE 1')).toBe('SELECT 1 FROM analytics.events AS events, analytics.users AS u WHERE 1')
    expect(resolve('SELECT 1 FROM events WHERE id IN (SELECT id FROM users)')).toBe(
      'SELECT 1 FROM analytics.events AS events WHERE id IN (SELECT id FROM analytics.users AS users)'
    )
    expect(resolve('SELECT exists(SELECT 1 FROM users)')).toBe('SELECT exists(SELECT 1 FROM analytics.users AS users)')
    expect(resolve('SELECT 1 FROM (SELECT id FROM users WHERE 1) AS u, events')).toBe(
      'SELECT 1 FROM (SELECT id FROM analytics.users AS users WHERE 1) AS u, analytics.events AS events'
    )
    expect(resolve('SELECT a, b FROM events WHERE x IN (1, 2) AND y = 1')).toBe('SELECT a, b FROM analytics.events AS events WHERE x IN (1, 2) AND y = 1')
    expect(resolve('SELECT a FROM events LIMIT 1 BY a, b')).toBe('SELECT a FROM analytics.events AS events LIMIT 1 BY a, b')
  })

  test('leaves what is not a table alone', () => {
    expect(resolve("SELECT extract(DAY FROM ts), trim(BOTH ' ' FROM s) FROM events")).toBe(
      "SELECT extract(DAY FROM ts), trim(BOTH ' ' FROM s) FROM analytics.events AS events"
    )
    expect(resolve('SELECT * FROM numbers(10)')).toBe('SELECT * FROM numbers(10)')
    expect(resolve('SELECT * FROM system.numbers LIMIT 1')).toBe('SELECT * FROM system.numbers LIMIT 1')
    expect(resolve('SELECT x FROM events ARRAY JOIN arr AS x LEFT ARRAY JOIN other AS y')).toBe(
      'SELECT x FROM analytics.events AS events ARRAY JOIN arr AS x LEFT ARRAY JOIN other AS y'
    )
    expect(resolve("SELECT 'FROM users' -- FROM users\nFROM events")).toBe("SELECT 'FROM users' -- FROM users\nFROM analytics.events AS events")
  })

  test('a CTE hides a datasource only in the query that declares it', () => {
    expect(resolve('SELECT * FROM (WITH events AS (SELECT 1) SELECT * FROM events) x, events')).toBe(
      'SELECT * FROM (WITH events AS (SELECT 1) SELECT * FROM events) x, analytics.events AS events'
    )
    expect(resolve('WITH events AS (SELECT 1) SELECT * FROM (SELECT * FROM events) AS x')).toBe('WITH events AS (SELECT 1) SELECT * FROM (SELECT * FROM events) AS x')
  })

  test('resolves a datasource named like a keyword', () => {
    const extra = { datasources: new Set(['window', 'events']) }
    expect(resolve('SELECT * FROM window', extra)).toBe('SELECT * FROM analytics.window AS `window`')
    expect(resolve('SELECT * FROM events WINDOW w AS (ORDER BY 1)', extra)).toBe('SELECT * FROM analytics.events AS events WINDOW w AS (ORDER BY 1)')
  })

  test('leaves CTE names alone', () => {
    expect(resolve('WITH recent AS (SELECT * FROM users), other AS (SELECT 1) SELECT * FROM recent, other')).toBe(
      'WITH recent AS (SELECT * FROM analytics.users AS users), other AS (SELECT 1) SELECT * FROM recent, other'
    )
  })

  test('inlines other nodes as aliased subqueries, recursively', () => {
    const resolved = resolveNode(
      'final',
      scope({
        base: 'SELECT id FROM events',
        mid: 'SELECT id FROM base -- trailing comment',
        final: 'SELECT * FROM mid AS m JOIN base ON 1',
      })
    )
    expect(resolved.sql).toBe(
      'SELECT * FROM (\nSELECT id FROM (\nSELECT id FROM analytics.events AS events\n) AS base -- trailing comment\n) AS m JOIN (\nSELECT id FROM analytics.events AS events\n) AS base ON 1'
    )
    expect([...resolved.datasources]).toEqual(['events'])
  })

  test('inlines the output node of a referenced pipe', () => {
    const pipes = new Map([['top_users', { outputNode: 'endpoint', nodes: new Map([['endpoint', 'SELECT id FROM users']]) }]])
    const resolved = resolveNode('endpoint', scope({ endpoint: 'SELECT * FROM top_users' }, { pipes }))
    expect(resolved.sql).toBe('SELECT * FROM (\nSELECT id FROM analytics.users AS users\n) AS top_users')
    expect([...resolved.pipes]).toEqual(['top_users'])
  })

  test('resolves queries in parens that open with another paren', () => {
    const node = 'SELECT id FROM events'
    const inline = (sql: string) => resolveNode('n', scope({ a: node, n: sql })).sql
    const a = '(\nSELECT id FROM analytics.events AS events\n) AS a'
    expect(inline('WITH x AS ((SELECT id FROM a) INTERSECT SELECT id FROM a) SELECT count() FROM x')).toBe(
      `WITH x AS ((SELECT id FROM ${a}) INTERSECT SELECT id FROM ${a}) SELECT count() FROM x`
    )
    expect(inline('WITH x AS (SELECT id FROM a INTERSECT SELECT id FROM a) SELECT count() FROM x')).toBe(
      `WITH x AS (SELECT id FROM ${a} INTERSECT SELECT id FROM ${a}) SELECT count() FROM x`
    )
    expect(inline('WITH x AS (SELECT id from a) SELECT count() from x')).toBe(`WITH x AS (SELECT id from ${a}) SELECT count() from x`)
    expect(inline('SELECT count() FROM ((SELECT id FROM a) UNION ALL SELECT id FROM a)')).toBe(
      `SELECT count() FROM ((SELECT id FROM ${a}) UNION ALL SELECT id FROM ${a})`
    )
    expect(inline('SELECT 1 FROM events UNION ALL ((SELECT 1 FROM a) UNION ALL SELECT 1 FROM a)')).toBe(
      `SELECT 1 FROM analytics.events AS events UNION ALL ((SELECT 1 FROM ${a}) UNION ALL SELECT 1 FROM ${a})`
    )
    expect(inline('SELECT * FROM (SELECT 1) AS y, ((SELECT 1 FROM a) UNION ALL SELECT 1 FROM a) AS z')).toBe(
      `SELECT * FROM (SELECT 1) AS y, ((SELECT 1 FROM ${a}) UNION ALL SELECT 1 FROM ${a}) AS z`
    )
    expect(inline('SELECT ((SELECT max(id) FROM a) - 1) AS m, extract(DAY FROM ts) FROM events')).toBe(
      `SELECT ((SELECT max(id) FROM ${a}) - 1) AS m, extract(DAY FROM ts) FROM analytics.events AS events`
    )
    // `FROM` in substring/extract/trim arguments is scalar, even after a leading subquery.
    expect(inline('SELECT substring((SELECT 1) FROM a FOR 1) FROM (SELECT 1 AS a)')).toBe('SELECT substring((SELECT 1) FROM a FOR 1) FROM (SELECT 1 AS a)')
    expect(inline('SELECT `TRIM`(BOTH (SELECT 1) FROM a) FROM (SELECT 1 AS a)')).toBe('SELECT `TRIM`(BOTH (SELECT 1) FROM a) FROM (SELECT 1 AS a)')
  })

  test('unresolvedTable finds a project name left after FROM or JOIN, outside CTEs', () => {
    const known = new Set(['a', 'events'])
    const missed = (sql: string) => unresolvedTable(tokenizeSQL(sql), new Map(), known)
    expect(missed('SELECT 1 FROM a')).toBe('a')
    expect(missed('SELECT 1 FROM x LEFT JOIN `events` ON 1')).toBe('events')
    expect(missed('WITH a AS (SELECT 1) SELECT * FROM a')).toBeUndefined()
    expect(missed('SELECT 1 FROM system.a, numbers(1) ARRAY JOIN a')).toBeUndefined()
    expect(missed("SELECT 'FROM a' -- FROM a\nFROM other")).toBeUndefined()
    expect(missed('SELECT extract(DAY FROM events), substring(s FROM a), trim(BOTH x FROM events) FROM t')).toBeUndefined()
    expect(missed('SELECT trim(BOTH x FROM (SELECT 1 FROM a))')).toBe('a')
    expect(unresolvedTable(tokenizeSQL('SELECT 1 FROM a'), new Map([[6, '(SELECT 1) AS a']]), known)).toBeUndefined()
  })

  test('drops a trailing semicolon', () => {
    expect(resolve('SELECT 1 FROM events;\n')).toBe('SELECT 1 FROM analytics.events AS events')
  })

  test('reports what it cannot resolve', () => {
    expect(() => resolve('SELECT * FROM nowhere')).toThrow(SqlResolveError)
    expect(() => resolve('SELECT * FROM nowhere')).toThrow('reads nowhere, which is not a datasource, a node of this pipe or a pipe of the project')
    expect(() => resolve('SELECT * FROM sampled')).toThrow('reads datasource sampled, which does not translate (no SAMPLE BY)')
    expect(() => resolve('SELECT * FROM tinybird.datasources_ops_log')).toThrow('Tinybird service datasource tinybird.datasources_ops_log')
    expect(() => resolve('SELECT * FROM other_ws.events')).toThrow('a datasource of another Tinybird workspace')
    expect(() => resolveNode('a', scope({ a: 'SELECT * FROM b', b: 'SELECT * FROM a' }))).toThrow('cycle: a → b → a')
  })
})
