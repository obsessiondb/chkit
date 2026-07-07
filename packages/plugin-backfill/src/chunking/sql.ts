import type {
  Chunk,
  ChunkRange,
  EstimateFilter,
  PlannerContext,
  RowProbeStrategy,
  SortKey,
  TableProfile,
} from './types.js'

/**
 * Top-level clause keywords, in the order they may legally follow a
 * projection. `injectWhereCondition` uses this both to detect an existing
 * `WHERE` and to find the first trailing clause a new condition must be
 * inserted before.
 */
const TRAILING_CLAUSE_KEYWORDS = [
  'WHERE',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'QUALIFY',
  'LIMIT',
  'SETTINGS',
] as const

// ── Chunk execution SQL ──────────────────────────────────────────────────────

export function buildChunkExecutionSql(input: {
  planId: string
  chunk: Chunk
  target: string
  table: Pick<TableProfile, 'sortKeys'>
  sourceTarget?: string
  mvReplayQueries?: string[]
  targetColumns?: string[]
  idempotencyToken?: string
}): string {
  const sourceTarget = input.sourceTarget ?? input.target
  const header = `/* chkit backfill plan=${input.planId} chunk=${input.chunk.id} token=${input.idempotencyToken ?? ''} */`
  const settings = buildSettingsClause(input.idempotencyToken ?? '')
  const chunkConditions = buildChunkConditions(input.chunk, input.table.sortKeys)

  if (input.mvReplayQueries?.length) {
    // Each MV feeding the target becomes a filtered SELECT; UNION ALL replays
    // them in one INSERT so a single query_id and dedup token cover the chunk.
    const selects = input.mvReplayQueries.map((query) => {
      let filtered = injectPartitionFilter(query, input.chunk.partitionId)
      for (const condition of chunkConditions) {
        filtered = injectWhereCondition(filtered, condition)
      }
      if (input.targetColumns?.length) {
        filtered = rewriteSelectColumns(filtered, input.targetColumns)
      }
      return filtered
    })
    return [header, `INSERT INTO ${input.target}`, selects.join('\nUNION ALL\n'), settings].join('\n')
  }

  const lines = [
    header,
    `INSERT INTO ${input.target}`,
    'SELECT *',
    `FROM ${sourceTarget}`,
    `WHERE _partition_id = ${quoteSqlString(input.chunk.partitionId)}`,
  ]

  for (const condition of chunkConditions) {
    lines.push(`  AND ${condition}`)
  }

  lines.push(settings)
  return lines.join('\n')
}

// ── WHERE-clause builders ────────────────────────────────────────────────────

export function buildWhereClauseFromRanges(
  partitionId: string,
  ranges: ChunkRange[],
  sortKeys: SortKey[],
): string {
  const conditions = [`_partition_id = ${quoteSqlString(partitionId)}`]

  for (const range of ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (!sortKey) continue
    conditions.push(...buildRangeBoundConditions(range, sortKey))
  }

  return conditions.join('\n  AND ')
}

export function buildWhereClauseFromChunk(
  chunk: Pick<Chunk, 'partitionId' | 'ranges'>,
  table: Pick<TableProfile, 'sortKeys'>,
): string {
  return buildWhereClauseFromRanges(chunk.partitionId, chunk.ranges, table.sortKeys)
}

export function buildEstimateSql(
  filter: EstimateFilter,
  sortKeys: SortKey[],
  context: PlannerContext,
  rowProbeStrategy: RowProbeStrategy,
): string {
  const whereClause = buildWhereClauseFromFilter(filter, sortKeys)
  if (rowProbeStrategy === 'count') {
    return `SELECT count() AS cnt FROM ${context.database}.${context.table} WHERE ${whereClause}`
  }
  return `EXPLAIN ESTIMATE SELECT count() FROM ${context.database}.${context.table} WHERE ${whereClause}`
}

export function buildCountSql(
  filter: EstimateFilter,
  sortKeys: SortKey[],
  context: Pick<PlannerContext, 'database' | 'table'>,
): string {
  return `SELECT count() AS cnt FROM ${context.database}.${context.table} WHERE ${buildWhereClauseFromFilter(filter, sortKeys)}`
}

// ── Materialized-view query rewriting ────────────────────────────────────────

/**
 * Reorder a materialized-view `SELECT ... FROM ...` projection to match the
 * target table's column order. Projection items are matched to target columns
 * by their alias (`expr AS alias`); unmatched target columns fall through as
 * bare column references. Returns the query untouched when no top-level
 * `SELECT`/`FROM` pair is found (e.g. a non-SELECT statement).
 */
export function rewriteSelectColumns(query: string, targetColumns: string[]): string {
  const trimmed = query.trimEnd()

  const bounds = findSelectProjectionBounds(trimmed)
  if (!bounds) return query

  const projectionStart = bounds.selectPos + 'SELECT'.length
  const rawProjection = trimmed.slice(projectionStart, bounds.fromPos).trim()
  const { prefix, projection } = splitProjectionPrefix(rawProjection)

  const items = splitTopLevel(projection, ',').map((item) => item.trim())
  const aliasMap = buildAliasMap(items)

  const rewritten = targetColumns.map((column) => aliasMap.get(column) ?? column)
  return `${trimmed.slice(0, projectionStart)} ${prefix}${rewritten.join(', ')}\n${trimmed.slice(bounds.fromPos)}`
}

export function injectSortKeyFilter(
  query: string,
  sortKeyColumn: string,
  category: SortKey['category'],
  from: string,
  to: string,
): string {
  let condition: string

  if (category === 'datetime') {
    condition =
      `${sortKeyColumn} >= parseDateTimeBestEffort(${quoteSqlString(from)})\n` +
      `  AND ${sortKeyColumn} < parseDateTimeBestEffort(${quoteSqlString(to)})`
  } else if (category === 'string') {
    condition =
      `${sortKeyColumn} >= unhex('${Buffer.from(from, 'latin1').toString('hex')}')\n` +
      `  AND ${sortKeyColumn} < unhex('${Buffer.from(to, 'latin1').toString('hex')}')`
  } else {
    condition =
      `${sortKeyColumn} >= ${quoteSqlString(from)}\n` +
      `  AND ${sortKeyColumn} < ${quoteSqlString(to)}`
  }

  return injectWhereCondition(query, condition)
}

/** Locate the top-level `SELECT` and the first top-level `FROM` after it. */
function findSelectProjectionBounds(
  sql: string,
): { selectPos: number; fromPos: number } | null {
  const hits = findTopLevelKeywords(sql, ['SELECT', 'FROM'])

  const selectPos = hits.find((hit) => hit.keyword === 'SELECT')?.position ?? -1
  if (selectPos === -1) return null

  const fromPos =
    hits.find((hit) => hit.keyword === 'FROM' && hit.position > selectPos)?.position ?? -1
  if (fromPos === -1) return null

  return { selectPos, fromPos }
}

/** Peel a leading `DISTINCT` off a projection so it survives the rewrite. */
function splitProjectionPrefix(rawProjection: string): { prefix: string; projection: string } {
  const distinctMatch = rawProjection.match(/^DISTINCT\b\s*/i)
  if (!distinctMatch) return { prefix: '', projection: rawProjection }

  const prefix = distinctMatch[0] ?? ''
  return { prefix, projection: rawProjection.slice(prefix.length).trim() }
}

/** Map each aliased projection item (`expr AS alias`) to its full source text. */
function buildAliasMap(items: string[]): Map<string, string> {
  const aliasMap = new Map<string, string>()

  for (const item of items) {
    if (item === '*') continue
    const alias = findColumnAlias(item)
    if (alias !== undefined) aliasMap.set(alias, item)
  }

  return aliasMap
}

/** Return the alias of a projection item, i.e. the text after its last top-level `AS`. */
function findColumnAlias(item: string): string | undefined {
  const asHit = findTopLevelKeywords(item, ['AS']).at(-1)
  if (!asHit) return undefined
  return item.slice(asHit.position + 'AS'.length).trim()
}

function injectPartitionFilter(query: string, partitionId: string): string {
  return injectWhereCondition(query, `_partition_id = ${quoteSqlString(partitionId)}`)
}

/**
 * Insert `condition` into `query`'s WHERE clause, appending with `AND` when a
 * top-level `WHERE` already exists and inserting a fresh `WHERE` otherwise. The
 * condition is placed before the first trailing clause (GROUP BY, ORDER BY, …)
 * so it always lands inside the WHERE.
 */
function injectWhereCondition(query: string, condition: string): string {
  const trimmed = query.trimEnd()
  const hits = findTopLevelKeywords(trimmed, TRAILING_CLAUSE_KEYWORDS)

  const whereHit = hits.find((hit) => hit.keyword === 'WHERE')
  const firstTrailing = hits
    .filter((hit) => hit.keyword !== 'WHERE')
    .filter((hit) => !whereHit || hit.position > whereHit.position)[0]

  const insertAt = firstTrailing ? firstTrailing.position : trimmed.length
  const before = trimmed.slice(0, insertAt).trimEnd()
  const after = trimmed.slice(insertAt)

  if (whereHit) {
    return `${before}\n  AND ${condition}${after ? `\n${after}` : ''}`
  }

  return `${before}\nWHERE ${condition}${after ? `\n${after}` : ''}`
}

// ── SQL string scanner (shared low-level) ────────────────────────────────────
//
// `findTopLevelKeywords` and `splitTopLevel` are exported for direct unit
// testing of the quote/paren-skipping scan they share. They are intentionally
// NOT re-exported through the package entry point (`sdk.ts`) — the package's
// public API is unchanged.

export interface KeywordHit {
  keyword: string
  position: number
}

/**
 * Walk `sql` character by character, tracking parenthesis depth and skipping
 * single-quoted string literals (with backslash escapes). `visit` is invoked
 * for every character that lies outside a string literal and is not a
 * parenthesis, receiving the current paren `depth`.
 *
 * This is the one primitive behind every SQL-structure scan in this module:
 * top-level keyword detection and top-level delimiter splitting both build on
 * it so the quote/paren bookkeeping lives in exactly one place.
 */
function scanSqlTokens(
  sql: string,
  visit: (char: string, index: number, depth: number) => void,
): void {
  let depth = 0

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      continue
    }
    if (char === '\'') {
      index += 1
      while (index < sql.length && sql[index] !== '\'') {
        if (sql[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    visit(char ?? '', index, depth)
  }
}

/**
 * Find each occurrence of `keywords` that starts at the top level (paren depth
 * 0), on a word boundary (preceded by whitespace or start-of-string and
 * followed by whitespace or end-of-string). Matching is case-insensitive;
 * hits are returned in ascending position order.
 */
export function findTopLevelKeywords(sql: string, keywords: readonly string[]): KeywordHit[] {
  const upper = sql.toUpperCase()
  const hits: KeywordHit[] = []

  scanSqlTokens(sql, (_char, index, depth) => {
    if (depth !== 0) return
    if (index > 0 && /\S/.test(sql[index - 1] ?? '')) return

    const keyword = keywords.find((candidate) => keywordStartsAt(sql, upper, index, candidate))
    if (keyword) hits.push({ keyword, position: index })
  })

  return hits
}

/** Whether `keyword` starts at `index` on a trailing word boundary (case-insensitive). */
function keywordStartsAt(sql: string, upper: string, index: number, keyword: string): boolean {
  if (!upper.startsWith(keyword, index)) return false
  const after = index + keyword.length
  return after >= sql.length || /\s/.test(sql[after] ?? '')
}

/** Split `sql` on every top-level (paren depth 0) occurrence of `delimiter`. */
export function splitTopLevel(sql: string, delimiter: string): string[] {
  const segments: string[] = []
  let start = 0

  scanSqlTokens(sql, (char, index, depth) => {
    if (depth === 0 && char === delimiter) {
      segments.push(sql.slice(start, index))
      start = index + 1
    }
  })
  segments.push(sql.slice(start))

  return segments
}

// ── Value formatting & condition helpers ─────────────────────────────────────

function quoteSqlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

function formatBound(value: string, sortKey: SortKey): string {
  if (sortKey.category === 'datetime') {
    return `parseDateTimeBestEffort(${quoteSqlString(value)})`
  }

  if (sortKey.category === 'string') {
    return `unhex('${Buffer.from(value, 'latin1').toString('hex')}')`
  }

  return quoteSqlString(value)
}

/** Build the `>= from` / `< to` conditions for a single range on `sortKey`. */
function buildRangeBoundConditions(range: ChunkRange, sortKey: SortKey): string[] {
  const conditions: string[] = []

  if (range.from !== undefined) {
    conditions.push(`${sortKey.name} >= ${formatBound(range.from, sortKey)}`)
  }
  if (range.to !== undefined) {
    conditions.push(`${sortKey.name} < ${formatBound(range.to, sortKey)}`)
  }

  return conditions
}

function buildSettingsClause(token: string): string {
  if (token) {
    return `SETTINGS async_insert=0, insert_deduplication_token='${token}'`
  }
  return 'SETTINGS async_insert=0'
}

function buildChunkConditions(chunk: Pick<Chunk, 'ranges'>, sortKeys: SortKey[]): string[] {
  return chunk.ranges.flatMap((range) => {
    const sortKey = sortKeys[range.dimensionIndex]
    if (!sortKey) return []
    return buildRangeBoundConditions(range, sortKey)
  })
}

function buildWhereClauseFromFilter(filter: EstimateFilter, sortKeys: SortKey[]): string {
  const conditions = [`_partition_id = ${quoteSqlString(filter.partitionId)}`]

  for (const range of filter.ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (!sortKey) continue

    if (filter.exactDimensionIndex === range.dimensionIndex && filter.exactValue !== undefined) {
      conditions.push(`${sortKey.name} = ${formatBound(filter.exactValue, sortKey)}`)
      continue
    }

    conditions.push(...buildRangeBoundConditions(range, sortKey))
  }

  return conditions.join(' AND ')
}
