import { describe, expect, test } from 'bun:test'

import { type ResolveScope, resolveNode, SqlResolveError } from './sql-resolve.js'

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
