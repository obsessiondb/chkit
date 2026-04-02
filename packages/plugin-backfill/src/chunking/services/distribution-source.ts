import { buildWhereClauseFromRanges } from '../sql.js'
import type {
  ChunkRange,
  PlannerContext,
  SortKey,
  StringPrefixBucket,
  TemporalBucket,
} from '../types.js'

export async function probeStringPrefixDistribution(
  context: Pick<PlannerContext, 'database' | 'table' | 'query'>,
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
ORDER BY prefix`)

  return rows.map((row) => ({
    value: row.prefix,
    rowCount: Number(row.cnt),
    isExactValue: Buffer.from(row.prefix, 'latin1').length < depth,
  }))
}

export async function probeTemporalDistribution(
  context: Pick<PlannerContext, 'database' | 'table' | 'query'>,
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
ORDER BY bucket`)

  return rows.map((row) => ({
    start: row.bucket,
    rowCount: Number(row.cnt),
  }))
}
