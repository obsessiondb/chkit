import { describe, expect, test } from 'bun:test'

import { analyzeAndChunk } from './analyze.js'
import { buildChunkSql } from './sql.js'
import type { SortKeyInfo } from './types.js'

const MiB = 1024 ** 2

type RowValue = string | number

interface FixtureRow {
  _partition_id: string
  event_time: string
  [key: string]: RowValue
}

function isoAt(day: number, hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 0, day, hour, minute, 0)).toISOString()
}

function createFixtureQuery(input: {
  database: string
  table: string
  rows: FixtureRow[]
  sortKeys: Array<{ column: string; type: string }>
  bytesPerRow?: number
  uncompressedBytesPerRow?: number
}) {
  const bytesPerRow = input.bytesPerRow ?? 1024
  const uncompressedBytesPerRow = input.uncompressedBytesPerRow ?? bytesPerRow * 2

  return async function query<T>(sql: string): Promise<T[]> {
    if (sql.includes(`SELECT 1 FROM ${input.database}.${input.table} LIMIT 1`)) {
      return [{ ok: 1 }] as T[]
    }

    if (sql.includes('FROM system.parts')) {
      const partitions = summarizePartitions(input.rows, bytesPerRow, uncompressedBytesPerRow)
      return partitions as T[]
    }

    if (sql.includes('FROM system.tables')) {
      return [{ sorting_key: input.sortKeys.map((key) => key.column).join(', ') }] as T[]
    }

    if (sql.includes('FROM system.columns')) {
      return input.sortKeys.map((key) => ({ name: key.column, type: key.type })) as T[]
    }

    const filteredRows = filterRows(sql, input.rows)

    if (sql.includes('substring(')) {
      const match = sql.match(/substring\((\w+), 1, (\d+)\) AS prefix/)
      const column = match?.[1]
      const depth = Number(match?.[2] ?? 0)
      if (!column || depth <= 0) return [] as T[]

      const grouped = new Map<string, number>()
      for (const row of filteredRows) {
        const value = String(row[column] ?? '')
        const prefix = Buffer.from(value, 'latin1').subarray(0, depth).toString('latin1')
        grouped.set(prefix, (grouped.get(prefix) ?? 0) + 1)
      }

      return Array.from(grouped.entries())
        .sort(([left], [right]) => compareLatin1(left, right))
        .map(([prefix, cnt]) => ({ prefix, cnt: String(cnt) })) as T[]
    }

    if (sql.includes('formatDateTime(toStartOfDay(') || sql.includes('formatDateTime(toStartOfHour(')) {
      const grain = sql.includes('toStartOfDay(') ? 'day' : 'hour'
      const columnMatch = sql.match(/toStartOf(?:Day|Hour)\((\w+)\)/)
      const column = columnMatch?.[1]
      if (!column) return [] as T[]

      const grouped = new Map<string, number>()
      for (const row of filteredRows) {
        const bucket = grain === 'day'
          ? toStartOfDay(String(row[column]))
          : toStartOfHour(String(row[column]))
        grouped.set(bucket, (grouped.get(bucket) ?? 0) + 1)
      }

      return Array.from(grouped.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([bucket, cnt]) => ({ bucket, cnt: String(cnt) })) as T[]
    }

    if (sql.includes('toString(min(') && sql.includes('toString(max(')) {
      const match = sql.match(/toString\(min\((\w+)\)\) AS minVal,\s+toString\(max\(\1\)\) AS maxVal/s)
      const column = match?.[1]
      if (!column || filteredRows.length === 0) return [] as T[]

      const values = filteredRows.map((row) => row[column]).filter((value) => value !== undefined)
      if (values.length === 0) return [] as T[]

      return [{
        minVal: formatValueForMinMax(values.reduce((current, candidate) => compareValues(candidate, current) < 0 ? candidate : current)),
        maxVal: formatValueForMinMax(values.reduce((current, candidate) => compareValues(candidate, current) > 0 ? candidate : current)),
      }] as T[]
    }

    if (sql.includes('SELECT count() AS cnt')) {
      return [{ cnt: String(filteredRows.length) }] as T[]
    }

    return [] as T[]
  }
}

function summarizePartitions(rows: FixtureRow[], bytesPerRow: number, uncompressedBytesPerRow: number) {
  const byPartition = new Map<string, FixtureRow[]>()
  for (const row of rows) {
    const list = byPartition.get(row._partition_id)
    if (list) list.push(row)
    else byPartition.set(row._partition_id, [row])
  }

  return Array.from(byPartition.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([partitionId, partitionRows]) => ({
      partition_id: partitionId,
      total_rows: String(partitionRows.length),
      total_bytes: String(partitionRows.length * bytesPerRow),
      total_uncompressed_bytes: String(partitionRows.length * uncompressedBytesPerRow),
      min_time: String(partitionRows.reduce((min, row) => row.event_time < min ? row.event_time : min, partitionRows[0]?.event_time ?? '')),
      max_time: String(partitionRows.reduce((max, row) => row.event_time > max ? row.event_time : max, partitionRows[0]?.event_time ?? '')),
    }))
}

function filterRows(sql: string, rows: FixtureRow[]): FixtureRow[] {
  const whereMatch = sql.match(/WHERE\s+([\s\S]*?)(?:GROUP BY|ORDER BY|SETTINGS|$)/i)
  if (!whereMatch?.[1]) return rows

  const clauses = whereMatch[1]
    .split(/\s+AND\s+/)
    .map((clause) => clause.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  return rows.filter((row) => clauses.every((clause) => evaluateClause(clause, row)))
}

function evaluateClause(clause: string, row: FixtureRow): boolean {
  let match = clause.match(/^_partition_id = '([^']+)'$/)
  if (match) return row._partition_id === match[1]

  match = clause.match(/^(\w+) >= parseDateTimeBestEffort\('([^']+)'\)$/)
  if (match) return Date.parse(String(row[match[1]])) >= Date.parse(match[2])

  match = clause.match(/^(\w+) < parseDateTimeBestEffort\('([^']+)'\)$/)
  if (match) return Date.parse(String(row[match[1]])) < Date.parse(match[2])

  match = clause.match(/^(\w+) >= unhex\('([0-9a-f]+)'\)$/i)
  if (match) return compareLatin1(String(row[match[1]] ?? ''), Buffer.from(match[2], 'hex').toString('latin1')) >= 0

  match = clause.match(/^(\w+) < unhex\('([0-9a-f]+)'\)$/i)
  if (match) return compareLatin1(String(row[match[1]] ?? ''), Buffer.from(match[2], 'hex').toString('latin1')) < 0

  match = clause.match(/^(\w+) >= '([^']+)'$/)
  if (match) return comparePrimitive(row[match[1]], match[2]) >= 0

  match = clause.match(/^(\w+) < '([^']+)'$/)
  if (match) return comparePrimitive(row[match[1]], match[2]) < 0

  match = clause.match(/^(\w+) >= (-?\d+(?:\.\d+)?)$/)
  if (match) return Number(row[match[1]]) >= Number(match[2])

  match = clause.match(/^(\w+) < (-?\d+(?:\.\d+)?)$/)
  if (match) return Number(row[match[1]]) < Number(match[2])

  throw new Error(`Unsupported test clause: ${clause}`)
}

function comparePrimitive(left: RowValue | undefined, right: string): number {
  if (typeof left === 'number') return left - Number(right)
  return String(left ?? '').localeCompare(right)
}

function compareValues(left: RowValue, right: RowValue): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return compareLatin1(String(left), String(right))
}

function formatValueForMinMax(value: RowValue): string {
  return typeof value === 'number' ? String(value) : String(value)
}

function compareLatin1(left: string, right: string): number {
  return Buffer.from(left, 'latin1').compare(Buffer.from(right, 'latin1'))
}

function toStartOfDay(value: string): string {
  const date = new Date(value)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0)).toISOString()
}

function toStartOfHour(value: string): string {
  const date = new Date(value)
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    0,
    0,
  )).toISOString()
}

async function planFixture(input: {
  rows: FixtureRow[]
  sortKeys: Array<{ column: string; type: string }>
  maxChunkBytes: number
}) {
  const query = createFixtureQuery({
    database: 'app',
    table: 'events',
    rows: input.rows,
    sortKeys: input.sortKeys,
  })

  return analyzeAndChunk({
    database: 'app',
    table: 'events',
    maxChunkBytes: input.maxChunkBytes,
    requireIdempotencyToken: true,
    query,
  })
}

function strategyIds(chunk: { lineage?: Array<{ strategyId: string }> }): string[] {
  return chunk.lineage?.map((step) => step.strategyId) ?? []
}

function buildSqlForChunk(chunk: Awaited<ReturnType<typeof planFixture>>['chunks'][number], sortKeys: SortKeyInfo[]) {
  return buildChunkSql({
    planId: 'fixture-plan',
    chunk,
    target: 'app.events',
    sortKey: sortKeys[0],
    sortKeys,
  })
}

function requireChunk<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing expected chunk: ${label}`)
  }
  return value
}

describe('smart chunking integration', () => {
  test('keeps small partitions as a single metadata chunk', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      _partition_id: 'p_small',
      event_time: isoAt(1, index),
      id: index,
    }))

    const result = await planFixture({
      rows,
      sortKeys: [{ column: 'id', type: 'UInt64' }],
      maxChunkBytes: 64 * MiB,
    })

    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0]?.estimateReason).toBe('partition-metadata')
    expect(strategyIds(result.chunks[0] ?? {})).toHaveLength(0)
  })

  test('uses quantile range splitting for wide numeric distributions', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      _partition_id: 'p_quantile',
      event_time: isoAt(2, index % 24),
      id: index,
    }))

    const result = await planFixture({
      rows,
      sortKeys: [{ column: 'id', type: 'UInt64' }],
      maxChunkBytes: 30 * 1024,
    })

    expect(result.chunks.length).toBeGreaterThanOrEqual(3)
    expect(result.chunks.every((chunk) => strategyIds(chunk).includes('quantile-range-split'))).toBe(true)
    const estimatedRows = result.chunks.map((chunk) => chunk.estimatedRows ?? 0)
    expect(Math.max(...estimatedRows) - Math.min(...estimatedRows)).toBeLessThanOrEqual(4)
  })

  test('falls back to equal-width splitting when quantile boundaries collapse', async () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({
      _partition_id: 'p_equal',
      event_time: isoAt(3, index % 24),
      id: 100 + (index % 2),
    }))

    const result = await planFixture({
      rows,
      sortKeys: [{ column: 'id', type: 'UInt64' }],
      maxChunkBytes: 20 * 1024,
    })

    expect(result.chunks.length).toBeGreaterThan(1)
    expect(result.chunks.some((chunk) => strategyIds(chunk).includes('equal-width-split'))).toBe(true)
  })

  test('uses string-prefix splitting for string-distributed partitions', async () => {
    const rows: FixtureRow[] = []
    for (const prefix of ['apple', 'apricot', 'banana', 'berry', 'citrus']) {
      for (let index = 0; index < 24; index++) {
        rows.push({
          _partition_id: 'p_string',
          event_time: isoAt(4, index % 24),
          slug: `${prefix}-${index.toString().padStart(2, '0')}`,
        })
      }
    }

    const result = await planFixture({
      rows,
      sortKeys: [{ column: 'slug', type: 'String' }],
      maxChunkBytes: 24 * 1024,
    })

    expect(result.chunks.length).toBeGreaterThan(2)
    expect(result.chunks.some((chunk) => strategyIds(chunk).includes('string-prefix-split'))).toBe(true)

    const sql = buildSqlForChunk(requireChunk(result.chunks[0], 'string-prefix first chunk'), result.sortKeys)
    expect(sql).toContain("unhex('")
  })

  test('combines string-prefix and temporal splitting for hot-key time windows', async () => {
    const rows: FixtureRow[] = []

    for (let day = 1; day <= 3; day++) {
      for (let hour = 0; hour < 24; hour++) {
        rows.push({
          _partition_id: 'p_combo_temporal',
          event_time: isoAt(10 + day, hour),
          user_id: 'hot',
          score: 1000 + day * 24 + hour,
        })
      }
    }

    for (let index = 0; index < 18; index++) {
      rows.push({
        _partition_id: 'p_combo_temporal',
        event_time: isoAt(10, index),
        user_id: `cold-${index}`,
        score: index,
      })
    }

    const result = await planFixture({
      rows,
      sortKeys: [
        { column: 'user_id', type: 'String' },
        { column: 'event_time', type: 'DateTime' },
      ],
      maxChunkBytes: 18 * 1024,
    })

    const hotChunks = result.chunks.filter((chunk) =>
      strategyIds(chunk).includes('temporal-bucket-split') &&
      (chunk.ranges?.some((range) => range.dimensionIndex === 0) ?? false) &&
      (chunk.ranges?.some((range) => range.dimensionIndex === 1) ?? false)
    )

    expect(hotChunks.length).toBeGreaterThan(0)
    expect(hotChunks.every((chunk) => chunk.isHotKey || (chunk.hotKeyValue !== undefined))).toBe(true)

    const sql = buildSqlForChunk(requireChunk(hotChunks[0], 'temporal combo chunk'), result.sortKeys)
    expect(sql).toContain('user_id >=')
    expect(sql).toContain('event_time >=')
    expect(sql).toContain('parseDateTimeBestEffort')
  })

  test('combines string-prefix and quantile splitting on secondary numeric dimensions', async () => {
    const rows: FixtureRow[] = []

    for (let index = 0; index < 96; index++) {
      rows.push({
        _partition_id: 'p_combo_numeric',
        event_time: isoAt(20, index % 24),
        account: 'vip',
        seq: index,
      })
    }

    for (let index = 0; index < 24; index++) {
      rows.push({
        _partition_id: 'p_combo_numeric',
        event_time: isoAt(20, index % 24),
        account: `free-${index}`,
        seq: index,
      })
    }

    const result = await planFixture({
      rows,
      sortKeys: [
        { column: 'account', type: 'String' },
        { column: 'seq', type: 'UInt64' },
      ],
      maxChunkBytes: 24 * 1024,
    })

    const comboChunks = result.chunks.filter((chunk) =>
      strategyIds(chunk).includes('quantile-range-split') &&
      (chunk.ranges?.some((range) => range.dimensionIndex === 0) ?? false) &&
      (chunk.ranges?.some((range) => range.dimensionIndex === 1) ?? false)
    )

    expect(comboChunks.length).toBeGreaterThan(0)

    const sql = buildSqlForChunk(requireChunk(comboChunks[0], 'numeric combo chunk'), result.sortKeys)
    expect(sql).toContain('account >=')
    expect(sql).toContain("seq >= '")
  })
})
