import type { PlannedChunk, SortKeyInfo } from './types.js'

function buildSettingsClause(token: string): string {
  if (token) {
    return `SETTINGS async_insert=0, insert_deduplication_token='${token}'`
  }
  return `SETTINGS async_insert=0`
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

function formatBound(value: string, sortKey: SortKeyInfo): string {
  if (sortKey.category === 'datetime') {
    return `parseDateTimeBestEffort(${quoteSqlString(value)})`
  }
  if (sortKey.category === 'string') {
    return `unhex('${Buffer.from(value, 'latin1').toString('hex')}')`
  }
  return quoteSqlString(value)
}

function buildChunkConditions(chunk: PlannedChunk, sortKeys: SortKeyInfo[]): string[] {
  if (chunk.ranges?.length) {
    return chunk.ranges.flatMap((range) => {
      const sortKey = sortKeys[range.dimensionIndex]
      if (!sortKey) return []

      const conditions: string[] = []
      if (range.from !== undefined) {
        conditions.push(`${sortKey.column} >= ${formatBound(range.from, sortKey)}`)
      }
      if (range.to !== undefined) {
        conditions.push(`${sortKey.column} < ${formatBound(range.to, sortKey)}`)
      }
      return conditions
    })
  }

  if (chunk.sortKeyFrom !== undefined && chunk.sortKeyTo !== undefined && sortKeys[0]) {
    return [
      `${sortKeys[0].column} >= ${formatBound(chunk.sortKeyFrom, sortKeys[0])}`,
      `${sortKeys[0].column} < ${formatBound(chunk.sortKeyTo, sortKeys[0])}`,
    ]
  }

  return []
}

export function buildChunkSql(input: {
  planId: string
  chunk: PlannedChunk
  target: string
  sortKey?: SortKeyInfo
  sortKeys?: SortKeyInfo[]
  mvAsQuery?: string
  targetColumns?: string[]
}): string {
  const header = `/* chkit backfill plan=${input.planId} chunk=${input.chunk.id} token=${input.chunk.idempotencyToken} */`
  const settings = buildSettingsClause(input.chunk.idempotencyToken)
  const { chunk } = input
  const sortKeys = input.sortKeys ?? (input.sortKey ? [input.sortKey] : [])
  const chunkConditions = buildChunkConditions(chunk, sortKeys)

  if (input.mvAsQuery) {
    // MV replay: inject partition + sort key filters into the MV's AS query
    let filtered = injectPartitionFilter(input.mvAsQuery, chunk.partitionId)
    for (const condition of chunkConditions) {
      filtered = injectWhereCondition(filtered, condition)
    }
    if (input.targetColumns?.length) {
      filtered = rewriteSelectColumns(filtered, input.targetColumns)
    }
    return [header, `INSERT INTO ${input.target}`, filtered, settings].join('\n')
  }

  // Direct table copy
  const lines = [
    header,
    `INSERT INTO ${input.target}`,
    `SELECT *`,
    `FROM ${input.target}`,
    `WHERE _partition_id = '${chunk.partitionId}'`,
  ]

  for (const condition of chunkConditions) {
    lines.push(`  AND ${condition}`)
  }

  lines.push(settings)
  return lines.join('\n')
}

// --- SQL helpers ---

function injectPartitionFilter(query: string, partitionId: string): string {
  const condition = `_partition_id = '${partitionId}'`
  return injectWhereCondition(query, condition)
}

export function injectSortKeyFilter(
  query: string,
  sortKeyColumn: string,
  category: SortKeyInfo['category'],
  from: string,
  to: string,
): string {
  let condition: string
  if (category === 'datetime') {
    condition = `${sortKeyColumn} >= parseDateTimeBestEffort(${quoteSqlString(from)})\n  AND ${sortKeyColumn} < parseDateTimeBestEffort(${quoteSqlString(to)})`
  } else if (category === 'string') {
    condition = `${sortKeyColumn} >= unhex('${Buffer.from(from, 'latin1').toString('hex')}')\n  AND ${sortKeyColumn} < unhex('${Buffer.from(to, 'latin1').toString('hex')}')`
  } else {
    condition = `${sortKeyColumn} >= ${quoteSqlString(from)}\n  AND ${sortKeyColumn} < ${quoteSqlString(to)}`
  }
  return injectWhereCondition(query, condition)
}

function injectWhereCondition(query: string, condition: string): string {
  const trimmed = query.trimEnd()
  const upper = trimmed.toUpperCase()

  interface KWHit { keyword: string; position: number }
  const hits: KWHit[] = []
  let depth = 0

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (ch === "'") {
      i++
      while (i < trimmed.length && trimmed[i] !== "'") {
        if (trimmed[i] === '\\') i++
        i++
      }
      continue
    }
    if (depth !== 0) continue

    if (i > 0 && /\S/.test(trimmed[i - 1] ?? '')) continue

    const rest = upper.slice(i)
    for (const kw of ['WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'QUALIFY', 'LIMIT', 'SETTINGS']) {
      if (rest.startsWith(kw) && (i + kw.length >= trimmed.length || /\s/.test(trimmed[i + kw.length] ?? ''))) {
        hits.push({ keyword: kw, position: i })
        break
      }
    }
  }

  const whereHit = hits.find(h => h.keyword === 'WHERE')
  const trailingKeywords = ['GROUP BY', 'HAVING', 'ORDER BY', 'QUALIFY', 'LIMIT', 'SETTINGS']
  const firstTrailing = hits
    .filter(h => trailingKeywords.includes(h.keyword))
    .filter(h => !whereHit || h.position > whereHit.position)[0]

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

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (ch === "'") {
      i++
      while (i < trimmed.length && trimmed[i] !== "'") {
        if (trimmed[i] === '\\') i++
        i++
      }
      continue
    }
    if (depth !== 0) continue

    if (i > 0 && /\S/.test(trimmed[i - 1] ?? '')) continue

    const rest = upper.slice(i)
    if (selectPos === -1 && rest.startsWith('SELECT') && (i + 6 >= trimmed.length || /\s/.test(trimmed[i + 6] ?? ''))) {
      selectPos = i
    } else if (selectPos !== -1 && fromPos === -1 && rest.startsWith('FROM') && (i + 4 >= trimmed.length || /\s/.test(trimmed[i + 4] ?? ''))) {
      fromPos = i
    }
  }

  if (selectPos === -1 || fromPos === -1) return query

  const projStart = selectPos + 6
  const projText = trimmed.slice(projStart, fromPos).trim()

  const items: string[] = []
  let itemStart = 0
  depth = 0

  for (let i = 0; i < projText.length; i++) {
    const ch = projText[i]
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (ch === "'") {
      i++
      while (i < projText.length && projText[i] !== "'") {
        if (projText[i] === '\\') i++
        i++
      }
      continue
    }
    if (depth === 0 && ch === ',') {
      items.push(projText.slice(itemStart, i).trim())
      itemStart = i + 1
    }
  }
  items.push(projText.slice(itemStart).trim())

  const aliasMap = new Map<string, string>()
  for (const item of items) {
    if (item === '*') continue

    const itemUpper = item.toUpperCase()
    let asPos = -1
    let d = 0

    for (let i = 0; i < item.length; i++) {
      const ch = item[i]
      if (ch === '(') { d++; continue }
      if (ch === ')') { d--; continue }
      if (ch === "'") {
        i++
        while (i < item.length && item[i] !== "'") {
          if (item[i] === '\\') i++
          i++
        }
        continue
      }
      if (d !== 0) continue
      if (i > 0 && /\S/.test(item[i - 1] ?? '')) continue

      const rest = itemUpper.slice(i)
      if (rest.startsWith('AS') && (i + 2 >= item.length || /\s/.test(item[i + 2] ?? ''))) {
        asPos = i
      }
    }

    if (asPos !== -1) {
      const alias = item.slice(asPos + 2).trim()
      aliasMap.set(alias, item)
    }
  }

  const rewrittenCols = targetColumns.map(col => aliasMap.get(col) ?? col)

  const before = trimmed.slice(0, projStart)
  const after = trimmed.slice(fromPos)
  return `${before} ${rewrittenCols.join(', ')}\n${after}`
}
