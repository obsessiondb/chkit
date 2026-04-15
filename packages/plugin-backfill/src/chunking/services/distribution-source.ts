import { buildWhereClauseFromRanges } from '../sql.js'
import type {
  ChunkRange,
  PlannerContext,
  SortKey,
  StringPrefixBucket,
  TemporalBucket,
} from '../types.js'

type QueryContext = Pick<PlannerContext, 'database' | 'table' | 'query' | 'querySettings'>

export async function probeStringPrefixDistribution(
  context: QueryContext,
  partitionId: string,
  ranges: ChunkRange[],
  sortKey: SortKey,
  dimensionIndex: number,
  depth: number,
  sortKeys: SortKey[],
): Promise<StringPrefixBucket[]> {
  const range = ranges.find((candidate) => candidate.dimensionIndex === dimensionIndex)
  if (!range?.from || !range.to) return []

  const rows = await context.query<{ prefix: string; cnt: string }>(`
SELECT
  substring(${sortKey.name}, 1, ${depth}) AS prefix,
  count() AS cnt
FROM ${context.database}.${context.table}
WHERE ${buildWhereClauseFromRanges(partitionId, ranges, sortKeys)}
GROUP BY prefix
ORDER BY prefix`,
    context.querySettings,
  )

  return rows.map((row) => ({
    value: row.prefix,
    rowCount: Number(row.cnt),
    isExactValue: Buffer.from(row.prefix, 'latin1').length < depth,
  }))
}

export interface StringKeyBucket {
  value: string
  rowCount: number
}

export async function probeStringKeyDistribution(
  context: QueryContext,
  partitionId: string,
  ranges: ChunkRange[],
  sortKey: SortKey,
  dimensionIndex: number,
  sortKeys: SortKey[],
  limit: number,
): Promise<StringKeyBucket[] | undefined> {
  const range = ranges.find((candidate) => candidate.dimensionIndex === dimensionIndex)
  if (!range?.from || !range.to) return undefined

  const rows = await context.query<{ key: string; cnt: string }>(`
SELECT
  ${sortKey.name} AS key,
  count() AS cnt
FROM ${context.database}.${context.table}
WHERE ${buildWhereClauseFromRanges(partitionId, ranges, sortKeys)}
GROUP BY key
ORDER BY cnt DESC
LIMIT ${limit + 1}`,
    context.querySettings,
  )

  if (rows.length > limit) return undefined

  return rows.map((row) => ({
    value: row.key,
    rowCount: Number(row.cnt),
  }))
}

export async function probeTemporalDistribution(
  context: QueryContext,
  partitionId: string,
  ranges: ChunkRange[],
  sortKeys: SortKey[],
  dimensionIndex: number,
  grain: 'day' | 'hour',
): Promise<TemporalBucket[]> {
  const sortKey = sortKeys[dimensionIndex]
  if (!sortKey || sortKey.category !== 'datetime') return []

  const bucketExpression = grain === 'day'
    ? `toStartOfDay(${sortKey.name})`
    : `toStartOfHour(${sortKey.name})`

  const rows = await context.query<{ bucket: string; cnt: string }>(`
SELECT
  formatDateTime(${bucketExpression}, '%Y-%m-%dT%H:%i:%sZ') AS bucket,
  count() AS cnt
FROM ${context.database}.${context.table}
WHERE ${buildWhereClauseFromRanges(partitionId, ranges, sortKeys)}
GROUP BY bucket
ORDER BY bucket`,
    context.querySettings,
  )

  return rows.map((row) => ({
    start: row.bucket,
    rowCount: Number(row.cnt),
  }))
}
