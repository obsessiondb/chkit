import { describe, expect, test } from 'bun:test'

import { canonicalizeSqlFragments } from './canonicalize.js'
import { createLiveExecutor, getLiveEnv } from './e2e-testkit.js'

describe('canonicalizeSqlFragments e2e', () => {
  test('a name that is a SELECT modifier stays part of the expression', async () => {
    const executor = createLiveExecutor(getLiveEnv())
    const map = await canonicalizeSqlFragments(
      executor,
      ['all + id', 'distinct + id', 'id', '`all` + id', 'cityHash64(a,b)', 'ts + INTERVAL 5 YEAR', 'ts + INTERVAL 1 DAY DELETE'],
      { wrap: true },
    )
    await executor.close()

    // Read as `SELECT all + id`, the server would take `all` as the modifier.
    expect(map.get('all + id')).toBe('`all` + id')
    expect(map.get('all + id')).toBe(map.get('`all` + id'))
    expect(map.get('all + id')).not.toBe(map.get('id'))
    expect(map.get('distinct + id')).toBe('`distinct` + id')
    expect(map.get('cityHash64(a,b)')).toBe('cityHash64(a, b)')
    expect(map.get('ts + INTERVAL 5 YEAR')).toBe('ts + toIntervalYear(5)')
    // A TTL element with an action does not parse in parentheses; it formats as before.
    expect(map.get('ts + INTERVAL 1 DAY DELETE')).toBe('ts + toIntervalDay(1) AS DELETE')
  })

  test('a name that is a clause keyword formats as a bare SELECT does', async () => {
    const executor = createLiveExecutor(getLiveEnv())
    const keywords = ['from', 'where', 'group', 'order', 'limit', 'settings', 'format', 'union', 'except', 'intersect', 'having', 'with']
    const fragments = [...keywords, ...keywords.map((keyword) => `lower(${keyword})`)]
    const map = await canonicalizeSqlFragments(executor, fragments, { wrap: true })
    const bare = new Map<string, string | null>()
    for (const fragment of fragments) {
      const rows = await executor.query<{ formatted: string | null }>(
        `SELECT formatQuerySingleLineOrNull('SELECT ' || '${fragment}') AS formatted`
      )
      bare.set(fragment, rows[0]?.formatted?.replace(/^SELECT /, '') ?? null)
    }
    await executor.close()

    // `SELECT 0, from` does not parse, so `from` is formatted on its own.
    for (const fragment of fragments) expect([fragment, map.get(fragment) ?? null]).toEqual([fragment, bare.get(fragment) ?? null])
    expect(map.has('from')).toBe(true)
  }, 60_000)

  test('a fragment led by all or distinct is not retried as a bare SELECT', async () => {
    const executor = createLiveExecutor(getLiveEnv())
    const map = await canonicalizeSqlFragments(executor, ['all from', 'ALL from', 'distinct from', 'from'], {
      wrap: true,
    })
    await executor.close()

    // `SELECT all from` would format as `SELECT from`, matching a live `from`.
    expect(map.get('from')).toBeDefined()
    for (const fragment of ['all from', 'ALL from', 'distinct from']) {
      expect([fragment, map.get(fragment) ?? null]).toEqual([fragment, null])
    }
  })
})

test('SQL UDF storage matches for arrays, constant tuple casts and arithmetic; body drift remains visible', async () => {
  const executor = createLiveExecutor(getLiveEnv())
  const name = `obs18_${crypto.randomUUID().replaceAll('-', '')}`
  const database = getLiveEnv().clickhouseDatabase
  const view = `${name}_view`
  try {
    for (const [definition, query] of [
      ['(x, y) -> x - y', `SELECT ${name}(number + 2, number * 2) AS value FROM numbers(3)`],
      ["(text, categories) -> CAST(tuple('unknown', toFloat64(0)), 'Tuple(category String, confidence Float64)')", `SELECT ${name}(toString(number), ['a,b', 'c']) AS value FROM numbers(3)`],
    ] as const) {
      await executor.command(`CREATE OR REPLACE FUNCTION ${name} AS ${definition}`)
      await executor.command(`CREATE OR REPLACE VIEW ${database}.${view} AS ${query}`)
      const rows = await executor.query<{ as_select: string }>(`SELECT as_select FROM system.tables WHERE database='${database}' AND name='${view}'`)
      const stored = rows[0]?.as_select
      expect(stored).toBeDefined()
      if (!stored) throw new Error('Missing stored view query')
      expect(stored).not.toContain(`${name}(`)
      const map = await canonicalizeSqlFragments(executor, [query, stored], { wrap: false, storedQueryPairs: [[query, stored]] })
      expect(map.get(query)).toBe(map.get(stored))
    }
    const query = `SELECT ${name}(toString(number), ['a,b', 'c']) AS value FROM numbers(3)`
    const stored = (await executor.query<{ as_select: string }>(`SELECT as_select FROM system.tables WHERE database='${database}' AND name='${view}'`))[0]?.as_select
    if (!stored) throw new Error('Missing stored view query')
    await executor.command(`CREATE OR REPLACE FUNCTION ${name} AS (text, categories) -> CAST(tuple('changed', toFloat64(0)), 'Tuple(category String, confidence Float64)')`)
    const changed = await canonicalizeSqlFragments(executor, [query, stored], { wrap: false, storedQueryPairs: [[query, stored]] })
    expect(changed.get(query)).not.toBe(changed.get(stored))
  } finally {
    await executor.command(`DROP VIEW IF EXISTS ${database}.${view}`)
    await executor.command(`DROP FUNCTION IF EXISTS ${name}`)
    await executor.close()
  }
})

test('invalid UTF-8 in a SQL UDF definition cannot match a replacement-character literal', async () => {
  const executor = createLiveExecutor(getLiveEnv())
  const name = `obs18_bytes_${crypto.randomUUID().replaceAll('-', '')}`
  try {
    await executor.command(`CREATE FUNCTION ${name} AS () -> '\\xff'`)
    const query = `SELECT ${name}() AS value`
    const actual = "SELECT '\uFFFD' AS value"
    const map = await canonicalizeSqlFragments(executor, [query, actual], { wrap: false, storedQueryPairs: [[query, actual]] })
    expect(map.get(query)).toBeDefined()
    expect(map.get(actual)).toBeDefined()
    expect(map.get(query)).not.toBe(map.get(actual))
  } finally {
    await executor.command(`DROP FUNCTION IF EXISTS ${name}`)
    await executor.close()
  }
})

test('shared tuple UDF queries retain literal inputs and compare independently of pair order', async () => {
  const executor = createLiveExecutor(getLiveEnv())
  const name = `obs18_shared_${crypto.randomUUID().replaceAll('-', '')}`
  const body = "CAST(tuple(if(length(text) + length(toString(categories)) >= 0, 'unknown', 'unknown'), toFloat64(0)), 'Tuple(category String, confidence Float64)')"
  try {
    await executor.command(`CREATE FUNCTION ${name} AS (text, categories) -> ${body}`)
    const original = `SELECT ${name}('original input', map('lead', 'original prompt')) AS verdict`
    const changed = original.replace('original prompt', 'changed prompt')
    const stored = `SELECT ${body.replaceAll('length(text)', "length('original input')").replaceAll('toString(categories)', "toString(map('lead', 'original prompt'))")} AS verdict`
    for (const pairs of [[[original, stored], [changed, stored]], [[changed, stored], [original, stored]]] as const) {
      const map = await canonicalizeSqlFragments(executor, [original, stored, changed], { wrap: false, storedQueryPairs: pairs })
      expect(map.get(original)).toBe(map.get(stored))
      expect(map.get(changed)).not.toBe(map.get(stored))
    }
    expect(await executor.query(original)).toEqual([{ verdict: { category: 'unknown', confidence: 0 } }])
  } finally {
    await executor.command(`DROP FUNCTION IF EXISTS ${name}`)
    await executor.close()
  }
})
