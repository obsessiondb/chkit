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
})
