import type { ClickHouseExecutor } from './index.js'

function quoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

function stripSelectPrefix(formatted: string): string | null {
  const match = formatted.match(/^SELECT\s+([\s\S]+)$/i)
  return match?.[1]?.trim() ?? null
}

/**
 * Canonicalize SQL fragments through ClickHouse's own formatter, so a schema
 * fragment can be compared against what ClickHouse actually stores. The server
 * rewrites expressions on the way in — spacing, operator precedence parens,
 * `INTERVAL n UNIT` → `toIntervalUnit(n)` — which no local string normalizer can
 * reproduce (#195).
 *
 * `wrap` distinguishes a scalar expression (wrapped as `SELECT <expr>`, prefix
 * stripped back off) from a full `SELECT` query (formatted as-is). Formatting is
 * batched into a single query using `formatQuerySingleLineOrNull`, which yields
 * NULL for a fragment it can't parse rather than failing the whole batch — those
 * are simply left out of the map so the caller falls back to string comparison.
 *
 * Returns a map from the input fragment to its ClickHouse-canonical form. A
 * fragment missing from the map (unparseable, or an empty input) has no entry.
 */
export async function canonicalizeSqlFragments(
  executor: ClickHouseExecutor,
  fragments: readonly string[],
  options: { wrap: boolean }
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const unique = [...new Set(fragments.map((fragment) => fragment.trim()).filter((f) => f.length > 0))]
  if (unique.length === 0) return result

  const arrayLiteral = unique.map(quoteLiteral).join(', ')
  const formatCall = options.wrap
    ? `formatQuerySingleLineOrNull('SELECT ' || fragment)`
    : `formatQuerySingleLineOrNull(fragment)`
  const rows = await executor.query<{ formatted: Array<string | null> }>(
    `SELECT arrayMap(fragment -> ${formatCall}, [${arrayLiteral}]) AS formatted`
  )

  const formatted = rows[0]?.formatted ?? []
  for (let i = 0; i < unique.length; i += 1) {
    const raw = unique[i]
    const value = formatted[i]
    if (raw === undefined || value == null) continue
    const canonical = options.wrap ? stripSelectPrefix(value) : value.trim()
    if (canonical) result.set(raw, canonical)
  }
  return result
}
