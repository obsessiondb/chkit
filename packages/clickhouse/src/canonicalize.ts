import { isTrivia, tokenizeSQL } from '@chkit/core'

import type { ClickHouseExecutor } from './index.js'

function quoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

function stripSelectPrefix(formatted: string): string | null {
  const match = formatted.match(/^SELECT\s+([\s\S]+)$/i)
  return match?.[1]?.trim() ?? null
}

// Keep each batched query well under ClickHouse's default max_query_size
// (262144 bytes) so a large schema doesn't overflow a single query — which would
// throw and silently drop the whole run back to string comparison.
const MAX_BATCH_LITERAL_BYTES = 128_000

function batchFragments(fragments: readonly string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0
  for (const fragment of fragments) {
    const cost = quoteLiteral(fragment).length + 2 // literal + ", " separator
    if (current.length > 0 && size + cost > MAX_BATCH_LITERAL_BYTES) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(fragment)
    size += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** One row of `system.functions` as used for name normalization. */
export interface FunctionRegistryRow {
  name: string
  case_insensitive: number | boolean
  alias_to: string
}

/**
 * Case-resolution rules for function names, derived from `system.functions`.
 * `exact` maps every registered name to its canonical form (`alias_to` when
 * set, else the name itself); `insensitive` does the same keyed by lowercased
 * name, but only for names ClickHouse resolves case-insensitively.
 */
export interface FunctionRegistry {
  exact: ReadonlyMap<string, string>
  insensitive: ReadonlyMap<string, string>
}

export function buildFunctionRegistry(rows: readonly FunctionRegistryRow[]): FunctionRegistry {
  const exact = new Map<string, string>()
  const insensitive = new Map<string, string>()
  for (const row of rows) {
    const canonical = row.alias_to || row.name
    exact.set(row.name, canonical)
    if (row.case_insensitive) insensitive.set(row.name.toLowerCase(), canonical)
  }
  return { exact, insensitive }
}

/**
 * Load the server's function-name resolution rules once for a canonicalize
 * run. A view written with `FLOOR` or `LCASE` is stored as `floor` / `lower`,
 * while user-defined (case-sensitive) functions stay as written — only
 * `system.functions` tells the two apart (#729 review). If the registry
 * cannot be read, names are left as written: no normalization is safer than
 * lowercasing case-sensitive names.
 */
async function loadFunctionRegistry(
  executor: ClickHouseExecutor,
  onUnavailable?: (error: unknown) => void
): Promise<FunctionRegistry> {
  try {
    const rows = await executor.query<FunctionRegistryRow>(
      'SELECT name, case_insensitive, alias_to FROM system.functions'
    )
    return buildFunctionRegistry(rows)
  } catch (error) {
    onUnavailable?.(error)
    return buildFunctionRegistry([])
  }
}

/**
 * Resolve every function-call name in a SQL fragment the way ClickHouse does
 * when it stores a query (#729): a registered name rewrites to its canonical
 * form (`CEILING` -> `ceil`, `LCASE` -> `lower`), an unregistered or
 * case-sensitive name keeps its written form — so `rv_f` and `RV_f` still
 * compare different, and drift output keeps readable case (`toUnixTimestamp`).
 * Only an identifier followed by `(` is a call, and only when it is not
 * qualified by a dot: `analytics.FLOOR` names a parameterized view, and
 * ClickHouse normalizes the whole compound name, not its last part — leaving
 * it as written keeps two differently-cased views distinct. Strings, quoted
 * identifiers, comments and plain names keep their case.
 */
export function normalizeFunctionNames(sql: string, registry: FunctionRegistry): string {
  const tokens = tokenizeSQL(sql)
  let out = ''
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    let text = token.text
    if (token.kind === 'identifier') {
      let previous = i - 1
      let preceding = tokens[previous]
      while (preceding !== undefined && isTrivia(preceding)) {
        previous -= 1
        preceding = tokens[previous]
      }
      let next = i + 1
      let following = tokens[next]
      while (following !== undefined && isTrivia(following)) {
        next += 1
        following = tokens[next]
      }
      if (preceding?.text !== '.' && following?.text === '(') {
        text = registry.exact.get(text) ?? registry.insensitive.get(text.toLowerCase()) ?? text
      }
    }
    out += text
  }
  return out
}

/**
 * Canonicalize SQL fragments through ClickHouse's own formatter, so a schema
 * fragment can be compared against what ClickHouse actually stores. The server
 * rewrites expressions on the way in — spacing, operator precedence parens,
 * `INTERVAL n UNIT` → `toIntervalUnit(n)` — which no local string normalizer can
 * reproduce (#195). Function-call names are then resolved through the server's
 * `system.functions` registry, since the server canonicalizes their case and
 * aliases on write but the formatter does not (#729).
 *
 * `wrap` distinguishes a scalar expression (wrapped as `SELECT <expr>`, prefix
 * stripped back off) from a full `SELECT` query (formatted as-is). Formatting is
 * batched into a single query using `formatQuerySingleLineOrNull`, which yields
 * NULL for a fragment it can't parse rather than failing the whole batch — those
 * are simply left out of the map so the caller falls back to string comparison.
 * So is a result that is not valid UTF-8 (a literal such as '\xff'): the client
 * would decode its bytes to U+FFFD, and two different literals would match.
 *
 * Returns a map from the input fragment to its ClickHouse-canonical form. A
 * fragment missing from the map (unparseable, or an empty input) has no entry.
 */
export async function canonicalizeSqlFragments(
  executor: ClickHouseExecutor,
  fragments: readonly string[],
  options: { wrap: boolean; onRegistryUnavailable?: (error: unknown) => void }
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const unique = [...new Set(fragments.map((fragment) => fragment.trim()).filter((f) => f.length > 0))]
  if (unique.length === 0) return result

  const registry = await loadFunctionRegistry(executor, options.onRegistryUnavailable)

  const formatCall = options.wrap
    ? `formatQuerySingleLineOrNull('SELECT ' || fragment)`
    : `formatQuerySingleLineOrNull(fragment)`

  for (const batch of batchFragments(unique)) {
    const arrayLiteral = batch.map(quoteLiteral).join(', ')
    const rows = await executor.query<{ formatted: Array<string | null> }>(
      `SELECT arrayMap(f -> if(isValidUTF8(f), f, NULL), arrayMap(fragment -> ${formatCall}, [${arrayLiteral}])) AS formatted`
    )
    const formatted = rows[0]?.formatted ?? []
    for (let i = 0; i < batch.length; i += 1) {
      const raw = batch[i]
      const value = formatted[i]
      if (raw === undefined || value == null) continue
      const canonical = options.wrap ? stripSelectPrefix(value) : value.trim()
      if (canonical) result.set(raw, normalizeFunctionNames(canonical, registry))
    }
  }
  return result
}
