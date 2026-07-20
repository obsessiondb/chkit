import { describe, expect, test } from 'bun:test'

import { canonicalizeSqlFragments } from './canonicalize.js'
import type { ClickHouseExecutor } from './index.js'

// Minimal executor stand-in: records the SQL it was asked to run and replays a
// canned arrayMap result. Only `query` is exercised by canonicalizeSqlFragments.
function fakeExecutor(reply: Array<string | null>, capture: { sql?: string }): ClickHouseExecutor {
  return {
    async query<T>(sql: string): Promise<T[]> {
      capture.sql = sql
      return [{ formatted: reply } as unknown as T]
    },
  } as unknown as ClickHouseExecutor
}

describe('canonicalizeSqlFragments', () => {
  test('strips the SELECT wrapper and maps each fragment to its canonical form', async () => {
    const capture: { sql?: string } = {}
    const executor = fakeExecutor(['SELECT cityHash64(a, b)', 'SELECT (n * 2) + 1'], capture)

    const map = await canonicalizeSqlFragments(executor, ['cityHash64(a,b)', 'n*2+1'], { wrap: true })

    expect(map.get('cityHash64(a,b)')).toBe('cityHash64(a, b)')
    expect(map.get('n*2+1')).toBe('(n * 2) + 1')
    expect(capture.sql).toContain("formatQuerySingleLineOrNull('SELECT ' || fragment)")
  })

  test('does not wrap when formatting full queries', async () => {
    const capture: { sql?: string } = {}
    const executor = fakeExecutor(['SELECT a, count() GROUP BY a'], capture)

    const map = await canonicalizeSqlFragments(executor, ['SELECT a,count() GROUP BY a'], {
      wrap: false,
    })

    expect(map.get('SELECT a,count() GROUP BY a')).toBe('SELECT a, count() GROUP BY a')
    expect(capture.sql).toContain('formatQuerySingleLineOrNull(fragment)')
  })

  test('omits fragments ClickHouse could not format (null)', async () => {
    const executor = fakeExecutor(['SELECT cityHash64(a, b)', null], {})

    const map = await canonicalizeSqlFragments(executor, ['cityHash64(a,b)', '((bad'], { wrap: true })

    expect(map.get('cityHash64(a,b)')).toBe('cityHash64(a, b)')
    expect(map.has('((bad')).toBe(false)
  })

  test('escapes quotes and backslashes, and dedupes blank/empty input', async () => {
    const capture: { sql?: string } = {}
    const executor = fakeExecutor(["SELECT concat(a, 'x,y')"], capture)

    const map = await canonicalizeSqlFragments(executor, ["concat(a,'x,y')", '', '   '], { wrap: true })

    // Single-quote doubled, blanks dropped — a valid single-element array literal.
    expect(capture.sql).toContain("['concat(a,''x,y'')']")
    expect(map.get("concat(a,'x,y')")).toBe("concat(a, 'x,y')")
  })

  test('returns an empty map without querying when there is nothing to format', async () => {
    let called = false
    const executor = {
      async query() {
        called = true
        return []
      },
    } as unknown as ClickHouseExecutor

    const map = await canonicalizeSqlFragments(executor, ['', '  '], { wrap: true })

    expect(map.size).toBe(0)
    expect(called).toBe(false)
  })

  // Guards against overflowing ClickHouse's max_query_size (256 KiB) on a large
  // schema, which would throw and silently drop the whole run to string
  // comparison — the feature no-opping exactly where it's needed.
  test('splits large input into multiple bounded queries and merges the results', async () => {
    const sqls: string[] = []
    // Echo each literal in the received array back as `SELECT <fragment>`, so
    // every fragment maps to itself regardless of how batching splits them.
    const executor = {
      async query<T>(sql: string): Promise<T[]> {
        sqls.push(sql)
        const literalCount = (sql.match(/'/g)?.length ?? 0) / 2
        return [{ formatted: Array.from({ length: literalCount }, () => 'SELECT ok') } as unknown as T]
      },
    } as unknown as ClickHouseExecutor

    // ~40 bytes of literal each × 8000 ≈ 320 KB → forces several batches.
    const fragments = Array.from({ length: 8000 }, (_, i) => `expr_${i}_${'x'.repeat(30)}`)
    const map = await canonicalizeSqlFragments(executor, fragments, { wrap: true })

    expect(sqls.length).toBeGreaterThan(1)
    for (const sql of sqls) expect(sql.length).toBeLessThan(200_000)
    // Every distinct fragment was formatted across the batches.
    expect(map.size).toBe(fragments.length)
    expect(map.get(fragments[0]!)).toBe('ok')
    expect(map.get(fragments.at(-1)!)).toBe('ok')
  })
})
