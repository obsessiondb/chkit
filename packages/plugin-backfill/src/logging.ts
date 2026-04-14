import { getLogger, type Logger } from '@logtape/logtape'

export const CHKIT_LOGGER_CATEGORY = ['chkit'] as const
export const CHKIT_BACKFILL_LOGGER_CATEGORY = [...CHKIT_LOGGER_CATEGORY, 'backfill'] as const
export const SLOW_CLICKHOUSE_QUERY_MS = 5000
export const SLOW_CLICKHOUSE_QUERY_REPEAT_INITIAL_MS = 5000
export const SLOW_CLICKHOUSE_QUERY_REPEAT_MAX_MS = 30000

export function getBackfillLogger(...segments: string[]): Logger {
  return getLogger([...CHKIT_BACKFILL_LOGGER_CATEGORY, ...segments])
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

export function summarizeSql(sql: string, maxLength = 240): string {
  const normalized = normalizeSql(sql)
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

export function describeSqlOperation(sql: string): string {
  const normalized = normalizeSql(sql)

  const prefixDistribution = normalized.match(/^SELECT substring\((\w+), 1, \d+\) AS prefix, count\(\) AS cnt /)
  if (prefixDistribution?.[1]) return `prefix distribution on ${prefixDistribution[1]}`

  const temporalDistribution = normalized.match(/^SELECT formatDateTime\(toStartOf(Day|Hour)\((\w+)\)/)
  if (temporalDistribution?.[1] && temporalDistribution[2]) {
    return `${temporalDistribution[1].toLowerCase()} distribution on ${temporalDistribution[2]}`
  }

  const minMaxProbe = normalized.match(/^SELECT toString\(min\((\w+)\)\) AS minVal, toString\(max\(\1\)\) AS maxVal /)
  if (minMaxProbe?.[1]) return `range probe on ${minMaxProbe[1]}`

  if (normalized.startsWith('SELECT count() AS cnt FROM ')) return 'row count probe'
  if (normalized.startsWith('SELECT sorting_key FROM system.tables')) return 'sort key introspection'
  if (normalized.startsWith('SELECT name, type FROM system.columns')) return 'column introspection'
  if (normalized.startsWith('SELECT partition_id,')) return 'partition introspection'
  if (normalized.startsWith('SELECT 1 FROM ')) return 'table existence probe'

  return summarizeSql(normalized, 100)
}

export function describeSqlContext(sql: string): string | undefined {
  const normalized = normalizeSql(sql)
  const partitionId = normalized.match(/_partition_id = '([^']+)'/)?.[1]

  if (partitionId) return `partition ${partitionId}`
  return undefined
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}
