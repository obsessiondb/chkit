import { describe, expect, test } from 'bun:test'

import {
  buildFunctionRegistry,
  canonicalizeSqlFragments,
  normalizeFunctionNames,
  type FunctionRegistryRow,
} from './canonicalize.js'
import type { ClickHouseExecutor } from './index.js'

// A small system.functions stand-in: the case-insensitive entries the drift
// tests exercise, plus camelCase natives that must keep their written case.
const TEST_REGISTRY_ROWS: FunctionRegistryRow[] = [
  { name: 'floor', case_insensitive: 1, alias_to: '' },
  { name: 'ceil', case_insensitive: 1, alias_to: '' },
  { name: 'ceiling', case_insensitive: 1, alias_to: 'ceil' },
  { name: 'lower', case_insensitive: 1, alias_to: '' },
  { name: 'lcase', case_insensitive: 1, alias_to: 'lower' },
  { name: 'count', case_insensitive: 1, alias_to: '' },
  { name: 'substring', case_insensitive: 1, alias_to: '' },
  { name: 'cityHash64', case_insensitive: 0, alias_to: '' },
  { name: 'toUnixTimestamp', case_insensitive: 0, alias_to: '' },
  { name: 'concat', case_insensitive: 0, alias_to: '' },
]

const TEST_REGISTRY = buildFunctionRegistry(TEST_REGISTRY_ROWS)

// Minimal executor stand-in: records the SQL it was asked to run, answers the
// system.functions read from `registryRows` (or throws for it when they are
// null), and replays a canned arrayMap result for the formatting query.
function fakeExecutor(
  reply: Array<string | null>,
  capture: { sql?: string },
  registryRows: FunctionRegistryRow[] | null = TEST_REGISTRY_ROWS
): ClickHouseExecutor {
  return {
    async query<T>(sql: string): Promise<T[]> {
      capture.sql = sql
      if (sql.includes('system.functions')) {
        if (registryRows === null) throw new Error('system.functions unreadable')
        return registryRows as unknown as T[]
      }
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
        if (sql.includes('system.functions')) return [] as unknown as T[]
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

  test('resolves case-insensitive names and aliases like the server (#729)', async () => {
    // The formatter echoes the written names while the stored query carries
    // ClickHouse's canonical names; after registry normalization both agree.
    const writtenQuery =
      'SELECT FLOOR(toUnixTimestamp(ts) / 300) AS bucket, CEILING(x), LCASE(s) FROM drift_repro.events'
    const storedQuery =
      'SELECT floor(toUnixTimestamp(ts) / 300) AS bucket, ceil(x), lower(s) FROM drift_repro.events'
    const written = fakeExecutor([writtenQuery], {})
    const stored = fakeExecutor([storedQuery], {})

    const writtenMap = await canonicalizeSqlFragments(written, [writtenQuery], { wrap: false })
    const storedMap = await canonicalizeSqlFragments(stored, [storedQuery], { wrap: false })

    expect(writtenMap.get(writtenQuery)).toBe(storedMap.get(storedQuery))
    // Registered camelCase names keep their readable case in drift output.
    expect(writtenMap.get(writtenQuery)).toContain('toUnixTimestamp')
  })

  test('keeps case-sensitive function names distinct', async () => {
    // User-defined functions are case-sensitive: lowercasing them would hide
    // a real change between rv731_f and RV731_F.
    const a = fakeExecutor(['SELECT rv731_f(x)'], {})
    const b = fakeExecutor(['SELECT RV731_F(x)'], {})

    const mapA = await canonicalizeSqlFragments(a, ['SELECT rv731_f(x)'], { wrap: false })
    const mapB = await canonicalizeSqlFragments(b, ['SELECT RV731_F(x)'], { wrap: false })

    expect(mapA.get('SELECT rv731_f(x)')).toBe('SELECT rv731_f(x)')
    expect(mapB.get('SELECT RV731_F(x)')).toBe('SELECT RV731_F(x)')
    expect(mapA.get('SELECT rv731_f(x)')).not.toBe(mapB.get('SELECT RV731_F(x)'))
  })

  test('still formats when system.functions cannot be read', async () => {
    const executor = fakeExecutor(['SELECT FLOOR(x)'], {}, null)

    const map = await canonicalizeSqlFragments(executor, ['SELECT FLOOR(x)'], { wrap: false })

    // No registry, no name normalization — names stay exactly as formatted.
    expect(map.get('SELECT FLOOR(x)')).toBe('SELECT FLOOR(x)')
  })

  test('normalizeFunctionNames leaves literals, quoted identifiers and aliases alone', () => {
    expect(
      normalizeFunctionNames("SELECT FLOOR(x) AS FLOOR, 'LOWER(' -- UPPER(\nFROM `MAX(`", TEST_REGISTRY)
    ).toBe("SELECT floor(x) AS FLOOR, 'LOWER(' -- UPPER(\nFROM `MAX(`")
    expect(normalizeFunctionNames('count ()', TEST_REGISTRY)).toBe('count ()')
    expect(normalizeFunctionNames('LCASE(s)', TEST_REGISTRY)).toBe('lower(s)')
    expect(normalizeFunctionNames('toUnixTimestamp(ts)', TEST_REGISTRY)).toBe('toUnixTimestamp(ts)')
  })
})
