import { buildCountSql, buildEstimateSql, buildWhereClauseFromRanges } from '../sql.js'
import type {
  ChunkRange,
  EstimateFilter,
  PlannerContext,
  RowProbeStrategy,
  SortKey,
} from '../types.js'

export function getRowProbeStrategy(context: Pick<PlannerContext, 'rowProbeStrategy'>): RowProbeStrategy {
  return context.rowProbeStrategy
}

export async function estimateRows(
  context: PlannerContext,
  filter: EstimateFilter,
  sortKeys: SortKey[],
): Promise<number> {
  if (getRowProbeStrategy(context) === 'count') {
    return countRowsExact(context, filter, sortKeys)
  }

  const rows = await context.query<Record<string, string | number | undefined>>(
    buildEstimateSql(filter, sortKeys, context, getRowProbeStrategy(context))
  )

  const firstRow = rows[0]
  if (!firstRow) return 0

  for (const [key, value] of Object.entries(firstRow)) {
    if (!key.toLowerCase().includes('row')) continue
    const parsed = Number(value ?? 0)
    if (Number.isFinite(parsed)) return parsed
  }

  for (const value of Object.values(firstRow)) {
    const parsed = Number(value ?? 0)
    if (Number.isFinite(parsed)) return parsed
  }

  return 0
}

export async function countRowsExact(
  context: Pick<PlannerContext, 'database' | 'table' | 'query'>,
  filter: EstimateFilter,
  sortKeys: SortKey[],
): Promise<number> {
  const rows = await context.query<{ cnt: string }>(buildCountSql(filter, sortKeys, context))
  return Number(rows[0]?.cnt ?? 0)
}

export async function countRows(
  context: Pick<PlannerContext, 'database' | 'table' | 'query'>,
  partitionId: string,
  ranges: ChunkRange[],
  sortKeys: SortKey[],
): Promise<number> {
  const filter: EstimateFilter = {
    partitionId,
    ranges,
    exactDimensionIndex: undefined,
    exactValue: undefined,
  }
  return countRowsExact(context, filter, sortKeys)
}

export async function countPartitionRows(
  context: Pick<PlannerContext, 'database' | 'table' | 'query'>,
  partitionId: string,
): Promise<number> {
  const rows = await context.query<{ cnt: string }>(
    `SELECT count() AS cnt FROM ${context.database}.${context.table} WHERE _partition_id = '${partitionId}'`
  )
  return Number(rows[0]?.cnt ?? 0)
}

export async function getSortKeyRange(
  context: Pick<PlannerContext, 'database' | 'table' | 'query'>,
  partitionId: string,
  ranges: ChunkRange[],
  sortKeys: SortKey[],
  sortKey: SortKey,
): Promise<{ min: string; max: string } | undefined> {
  const rows = await context.query<{ minVal: string; maxVal: string }>(`
SELECT
  toString(min(${sortKey.name})) AS minVal,
  toString(max(${sortKey.name})) AS maxVal
FROM ${context.database}.${context.table}
WHERE ${buildWhereClauseFromRanges(partitionId, ranges, sortKeys)}`)

  if (rows.length === 0) return undefined
  return {
    min: rows[0]?.minVal ?? '',
    max: rows[0]?.maxVal ?? '',
  }
}

export function parsePlannerDateTime(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  return Date.parse(normalized.endsWith('Z') ? normalized : `${normalized}Z`)
}
