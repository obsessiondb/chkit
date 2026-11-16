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
  })
})
