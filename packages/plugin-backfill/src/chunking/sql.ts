import type {
  Chunk,
  ChunkRange,
  EstimateFilter,
  PlannerContext,
  RowProbeStrategy,
  SortKey,
  TableProfile,
} from './types.js'

export function quoteSqlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

export function formatBound(value: string, sortKey: SortKey): string {
  if (sortKey.category === 'datetime') {
    return `parseDateTimeBestEffort(${quoteSqlString(value)})`
  }

  if (sortKey.category === 'string') {
    return `unhex('${Buffer.from(value, 'latin1').toString('hex')}')`
  }

  return quoteSqlString(value)
}

export function buildWhereClauseFromRanges(
  partitionId: string,
  ranges: ChunkRange[],
  sortKeys: SortKey[],
): string {
  const conditions = [`_partition_id = ${quoteSqlString(partitionId)}`]

  for (const range of ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (!sortKey) continue

    if (range.from !== undefined) {
      conditions.push(`${sortKey.name} >= ${formatBound(range.from, sortKey)}`)
    }
    if (range.to !== undefined) {
      conditions.push(`${sortKey.name} < ${formatBound(range.to, sortKey)}`)
    }
  }

  return conditions.join('\n  AND ')
}

export function buildWhereClauseFromChunk(
  chunk: Pick<Chunk, 'partitionId' | 'ranges'>,
  table: Pick<TableProfile, 'sortKeys'>,
): string {
  return buildWhereClauseFromRanges(chunk.partitionId, chunk.ranges, table.sortKeys)
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

    const conditions: string[] = []
    if (range.from !== undefined) {
      conditions.push(`${sortKey.name} >= ${formatBound(range.from, sortKey)}`)
    }
    if (range.to !== undefined) {
      conditions.push(`${sortKey.name} < ${formatBound(range.to, sortKey)}`)
    }
    return conditions
  })
}

export function buildChunkExecutionSql(input: {
  planId: string
  chunk: Chunk
  target: string
  table: Pick<TableProfile, 'sortKeys'>
  sourceTarget?: string
  mvAsQuery?: string
  targetColumns?: string[]
  idempotencyToken?: string
}): string {
  const sourceTarget = input.sourceTarget ?? input.target
  const header = `/* chkit backfill plan=${input.planId} chunk=${input.chunk.id} token=${input.idempotencyToken ?? ''} */`
  const settings = buildSettingsClause(input.idempotencyToken ?? '')
  const chunkConditions = buildChunkConditions(input.chunk, input.table.sortKeys)

  if (input.mvAsQuery) {
    let filtered = injectPartitionFilter(input.mvAsQuery, input.chunk.partitionId)
    for (const condition of chunkConditions) {
      filtered = injectWhereCondition(filtered, condition)
    }
    if (input.targetColumns?.length) {
      filtered = rewriteSelectColumns(filtered, input.targetColumns)
    }
    return [header, `INSERT INTO ${input.target}`, filtered, settings].join('\n')
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

function buildWhereClauseFromFilter(
  filter: EstimateFilter,
  sortKeys: SortKey[],
): string {
  const conditions = [`_partition_id = ${quoteSqlString(filter.partitionId)}`]

  for (const range of filter.ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (!sortKey) continue

    if (filter.exactDimensionIndex === range.dimensionIndex && filter.exactValue !== undefined) {
      conditions.push(`${sortKey.name} = ${formatBound(filter.exactValue, sortKey)}`)
      continue
    }

    if (range.from !== undefined) {
      conditions.push(`${sortKey.name} >= ${formatBound(range.from, sortKey)}`)
    }
    if (range.to !== undefined) {
      conditions.push(`${sortKey.name} < ${formatBound(range.to, sortKey)}`)
    }
  }

  return conditions.join(' AND ')
}

function injectPartitionFilter(query: string, partitionId: string): string {
  return injectWhereCondition(query, `_partition_id = ${quoteSqlString(partitionId)}`)
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

function injectWhereCondition(query: string, condition: string): string {
  const trimmed = query.trimEnd()
  const upper = trimmed.toUpperCase()

  interface KeywordHit {
    keyword: string
    position: number
  }

  const hits: KeywordHit[] = []
  let depth = 0

  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index]
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
      while (index < trimmed.length && trimmed[index] !== '\'') {
        if (trimmed[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (depth !== 0) continue
    if (index > 0 && /\S/.test(trimmed[index - 1] ?? '')) continue

    const rest = upper.slice(index)
    for (const keyword of ['WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'QUALIFY', 'LIMIT', 'SETTINGS']) {
      if (
        rest.startsWith(keyword) &&
        (index + keyword.length >= trimmed.length || /\s/.test(trimmed[index + keyword.length] ?? ''))
      ) {
        hits.push({ keyword, position: index })
        break
      }
    }
  }

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

export function rewriteSelectColumns(query: string, targetColumns: string[]): string {
  const trimmed = query.trimEnd()
  const upper = trimmed.toUpperCase()

  let selectPos = -1
  let fromPos = -1
  let depth = 0

  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index]
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
      while (index < trimmed.length && trimmed[index] !== '\'') {
        if (trimmed[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (depth !== 0) continue
    if (index > 0 && /\S/.test(trimmed[index - 1] ?? '')) continue

    const rest = upper.slice(index)
    if (
      selectPos === -1 &&
      rest.startsWith('SELECT') &&
      (index + 6 >= trimmed.length || /\s/.test(trimmed[index + 6] ?? ''))
    ) {
      selectPos = index
    } else if (
      selectPos !== -1 &&
      fromPos === -1 &&
      rest.startsWith('FROM') &&
      (index + 4 >= trimmed.length || /\s/.test(trimmed[index + 4] ?? ''))
    ) {
      fromPos = index
    }
  }

  if (selectPos === -1 || fromPos === -1) return query

  const projectionStart = selectPos + 6
  const rawProjection = trimmed.slice(projectionStart, fromPos).trim()
  let projectionPrefix = ''
  let projection = rawProjection

  const distinctMatch = rawProjection.match(/^DISTINCT\b\s*/i)
  if (distinctMatch) {
    projectionPrefix = distinctMatch[0] ?? ''
    projection = rawProjection.slice(projectionPrefix.length).trim()
  }

  const items: string[] = []
  let itemStart = 0
  depth = 0

  for (let index = 0; index < projection.length; index++) {
    const char = projection[index]
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
      while (index < projection.length && projection[index] !== '\'') {
        if (projection[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (depth === 0 && char === ',') {
      items.push(projection.slice(itemStart, index).trim())
      itemStart = index + 1
    }
  }
  items.push(projection.slice(itemStart).trim())

  const aliasMap = new Map<string, string>()
  for (const item of items) {
    if (item === '*') continue

    const itemUpper = item.toUpperCase()
    let asPos = -1
    let itemDepth = 0

    for (let index = 0; index < item.length; index++) {
      const char = item[index]
      if (char === '(') {
        itemDepth += 1
        continue
      }
      if (char === ')') {
        itemDepth -= 1
        continue
      }
      if (char === '\'') {
        index += 1
        while (index < item.length && item[index] !== '\'') {
          if (item[index] === '\\') index += 1
          index += 1
        }
        continue
      }
      if (itemDepth !== 0) continue
      if (index > 0 && /\S/.test(item[index - 1] ?? '')) continue

      const rest = itemUpper.slice(index)
      if (
        rest.startsWith('AS') &&
        (index + 2 >= item.length || /\s/.test(item[index + 2] ?? ''))
      ) {
        asPos = index
      }
    }

    if (asPos !== -1) {
      aliasMap.set(item.slice(asPos + 2).trim(), item)
    }
  }

  const rewrittenProjection = targetColumns.map((column) => aliasMap.get(column) ?? column)
  return `${trimmed.slice(0, projectionStart)} ${projectionPrefix}${rewrittenProjection.join(', ')}\n${trimmed.slice(fromPos)}`
}
