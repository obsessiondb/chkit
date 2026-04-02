import type { Partition, PlannerContext, SortKey, SortKeyCategory } from '../types.js'

const NUMERIC_TYPES = /^(U?Int|Float|Decimal)/
const DATETIME_TYPES = /^(Date|DateTime)/

function classifySortKeyType(type: string): SortKeyCategory {
  if (NUMERIC_TYPES.test(type)) return 'numeric'
  if (DATETIME_TYPES.test(type)) return 'datetime'
  return 'string'
}

function boundaryEncodingForCategory(category: SortKeyCategory): SortKey['boundaryEncoding'] {
  return category === 'string' ? 'hex-latin1' : 'literal'
}

function splitTopLevelCsv(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let quote: '\'' | '"' | undefined

  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === undefined) continue

    if (quote) {
      current += char
      if (char === quote && input[index - 1] !== '\\') quote = undefined
      continue
    }

    if (char === '\'' || char === '"') {
      quote = char
      current += char
      continue
    }

    if (char === '(') {
      depth += 1
      current += char
      continue
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }

    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  if (current.trim().length > 0) {
    parts.push(current.trim())
  }

  return parts
}

function resolveSortKeyColumn(expression: string, knownColumns: Set<string>): string | undefined {
  const trimmed = expression.trim()
  if (knownColumns.has(trimmed)) return trimmed

  const identifiers = Array.from(trimmed.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g))
    .map((match) => match[0])
    .filter((identifier): identifier is string => Boolean(identifier))

  const matches = Array.from(new Set(identifiers.filter((identifier) => knownColumns.has(identifier))))
  if (matches.length === 1) return matches[0]
  if (knownColumns.size === 0 && identifiers.length > 0) {
    return identifiers[identifiers.length - 1]
  }
  return undefined
}

export async function introspectPartitions(context: PlannerContext): Promise<Partition[]> {
  await context.query(
    `SELECT 1 FROM ${context.database}.${context.table} LIMIT 1 SETTINGS select_sequential_consistency = 1`
  )

  const rows = await context.query<{
    partition_id: string
    total_rows: string
    total_bytes: string
    total_uncompressed_bytes?: string
    min_time: string
    max_time: string
  }>(`SELECT
  partition_id,
  toString(sum(rows)) AS total_rows,
  toString(sum(bytes_on_disk)) AS total_bytes,
  toString(sum(data_uncompressed_bytes)) AS total_uncompressed_bytes,
  toString(min(min_time)) AS min_time,
  toString(max(max_time)) AS max_time
FROM system.parts
WHERE database = '${context.database}'
  AND table = '${context.table}'
  AND active = 1
GROUP BY partition_id
ORDER BY partition_id
SETTINGS select_sequential_consistency = 1`)

  return rows
    .map((row) => ({
      partitionId: row.partition_id,
      rows: Number(row.total_rows),
      bytesCompressed: Number(row.total_bytes),
      bytesUncompressed: Number(row.total_uncompressed_bytes ?? row.total_bytes),
      minTime: new Date(row.min_time).toISOString(),
      maxTime: new Date(row.max_time).toISOString(),
    }))
    .filter((partition) => {
      if (context.from && partition.maxTime < context.from) return false
      if (context.to && partition.minTime >= context.to) return false
      return true
    })
}

export async function introspectSortKeys(context: PlannerContext): Promise<SortKey[]> {
  const tableRows = await context.query<{ sorting_key: string }>(
    `SELECT sorting_key FROM system.tables WHERE database = '${context.database}' AND name = '${context.table}'`
  )

  const sortingKey = tableRows[0]?.sorting_key
  if (!sortingKey) return []

  const expressions = splitTopLevelCsv(sortingKey)
  if (expressions.length === 0) return []

  const columnRows = await context.query<{ name?: string; type: string }>(
    `SELECT name, type FROM system.columns WHERE database = '${context.database}' AND table = '${context.table}'`
  )

  const typeByName = new Map(
    columnRows
      .filter((row): row is { name: string; type: string } => Boolean(row.name))
      .map((row) => [row.name, row.type])
  )

  const knownColumns = new Set(typeByName.keys())

  return expressions.flatMap((expression, index) => {
    const column = resolveSortKeyColumn(expression, knownColumns)
    const type = column
      ? typeByName.get(column) ?? columnRows[index]?.type ?? columnRows[0]?.type
      : undefined
    if (!column || !type) return []

    const category = classifySortKeyType(type)
    return [{
      name: column,
      type,
      category,
      boundaryEncoding: boundaryEncodingForCategory(category),
    }]
  })
}
