import type { PartitionInfo, SortKeyInfo } from './types.js'

const NUMERIC_TYPES = new Set([
  'Int8', 'Int16', 'Int32', 'Int64', 'Int128', 'Int256',
  'UInt8', 'UInt16', 'UInt32', 'UInt64', 'UInt128', 'UInt256',
  'Float32', 'Float64',
])

const DATETIME_TYPES = new Set(['Date', 'Date32', 'DateTime', 'DateTime64'])

function classifySortKeyType(type: string): SortKeyInfo['category'] {
  if (NUMERIC_TYPES.has(type)) return 'numeric'
  if (DATETIME_TYPES.has(type)) return 'datetime'
  if (type.startsWith('DateTime64(')) return 'datetime'
  if (type.startsWith("DateTime('")) return 'datetime'
  return 'string'
}

export async function queryPartitionInfo(input: {
  database: string
  table: string
  from?: string
  to?: string
  query: <T>(sql: string) => Promise<T[]>
}): Promise<PartitionInfo[]> {
  // Force replica sync on the target table before reading system.parts.
  // select_sequential_consistency is only effective on user tables, not system
  // tables, so this preliminary query ensures the replica has caught up with
  // all pending writes before we inspect part metadata.
  await input.query(
    `SELECT 1 FROM ${input.database}.${input.table} LIMIT 1 SETTINGS select_sequential_consistency = 1`
  )

  const rows = await input.query<{
    partition_id: string
    total_rows: string
    total_bytes: string
    total_uncompressed_bytes?: string
    min_time: string
    max_time: string
  }>(
    `SELECT
  partition_id,
  toString(sum(rows)) AS total_rows,
  toString(sum(bytes_on_disk)) AS total_bytes,
  toString(sum(data_uncompressed_bytes)) AS total_uncompressed_bytes,
  toString(min(min_time)) AS min_time,
  toString(max(max_time)) AS max_time
FROM system.parts
WHERE database = '${input.database}'
  AND table = '${input.table}'
  AND active = 1
GROUP BY partition_id
ORDER BY partition_id
SETTINGS select_sequential_consistency = 1`
  )

  const partitions: PartitionInfo[] = rows.map((row) => ({
    partitionId: row.partition_id,
    rows: Number(row.total_rows),
    bytesOnDisk: Number(row.total_bytes),
    bytesUncompressed: Number(row.total_uncompressed_bytes ?? row.total_bytes),
    minTime: new Date(row.min_time).toISOString(),
    maxTime: new Date(row.max_time).toISOString(),
  }))

  return partitions.filter((p) => {
    if (input.from && p.maxTime < input.from) return false
    if (input.to && p.minTime >= input.to) return false
    return true
  })
}

function extractSortKeyColumns(sortingKey: string): string[] {
  return sortingKey
    .split(',')
    .map((part) => part.trim())
    .map((part) => {
      if (!part) return undefined
      const match = part.match(/^\w+\((\w+)\)$/)
      return match ? match[1] : part
    })
    .filter((part): part is string => Boolean(part && part.length > 0))
}

export async function querySortKeys(input: {
  database: string
  table: string
  query: <T>(sql: string) => Promise<T[]>
}): Promise<SortKeyInfo[]> {
  const tableRows = await input.query<{ sorting_key: string }>(
    `SELECT sorting_key FROM system.tables WHERE database = '${input.database}' AND name = '${input.table}'`
  )

  const sortingKey = tableRows[0]?.sorting_key
  if (!sortingKey) return []

  const columnNames = extractSortKeyColumns(sortingKey)
  if (columnNames.length === 0) return []

  const inList = columnNames.map((name) => `'${name}'`).join(', ')
  const columnRows = await input.query<{ name?: string; type: string }>(
    `SELECT name, type FROM system.columns WHERE database = '${input.database}' AND table = '${input.table}' AND name IN (${inList})`
  )
  const typeByName = new Map(
    columnRows.map((row, index) => [row.name ?? columnNames[index] ?? columnNames[0], row.type])
  )

  return columnNames.map((column) => {
    const type = typeByName.get(column) ?? 'String'
    return {
      column,
      type,
      category: classifySortKeyType(type),
    }
  })
}

export async function querySortKeyInfo(input: {
  database: string
  table: string
  query: <T>(sql: string) => Promise<T[]>
}): Promise<SortKeyInfo | undefined> {
  return (await querySortKeys(input))[0]
}

export async function querySortKeyRanges(input: {
  database: string
  table: string
  sortKeyColumn: string
  partitionIds: string[]
  query: <T>(sql: string) => Promise<T[]>
}): Promise<Map<string, { min: string; max: string }>> {
  if (input.partitionIds.length === 0) return new Map()

  const inList = input.partitionIds.map((id) => `'${id}'`).join(', ')
  const rows = await input.query<{
    partition_id: string
    min_val: string
    max_val: string
  }>(
    `SELECT _partition_id AS partition_id, toString(min(${input.sortKeyColumn})) AS min_val, toString(max(${input.sortKeyColumn})) AS max_val FROM ${input.database}.${input.table} WHERE _partition_id IN (${inList}) GROUP BY _partition_id SETTINGS select_sequential_consistency = 1`
  )

  const result = new Map<string, { min: string; max: string }>()
  for (const row of rows) {
    result.set(row.partition_id, { min: row.min_val, max: row.max_val })
  }
  return result
}

export async function introspectTable(input: {
  database: string
  table: string
  from?: string
  to?: string
  query: <T>(sql: string) => Promise<T[]>
}): Promise<{ partitions: PartitionInfo[]; sortKey?: SortKeyInfo; sortKeys: SortKeyInfo[] }> {
  const partitions = await queryPartitionInfo(input)
  const sortKeys = await querySortKeys({
    database: input.database,
    table: input.table,
    query: input.query,
  })

  return { partitions, sortKey: sortKeys[0], sortKeys }
}
