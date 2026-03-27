import { describe, expect, test } from 'bun:test'

import { buildChunkBoundaries } from './chunking/build.js'
import { buildChunkSql } from './chunking/sql.js'
import { buildPlannedChunks } from './chunking/analyze.js'
import type { PartitionInfo, SortKeyInfo } from './types.js'

const GiB = 1024 ** 3

function buildChunksWithSql(input: {
  planId: string
  target: string
  partitions: PartitionInfo[]
  maxChunkBytes: number
  sortKey?: SortKeyInfo
  sortKeyRanges?: Map<string, { min: string; max: string }>
  requireIdempotencyToken: boolean
  mvAsQuery?: string
  targetColumns?: string[]
}) {
  const boundaries = buildChunkBoundaries({
    partitions: input.partitions,
    maxChunkBytes: input.maxChunkBytes,
    sortKey: input.sortKey,
    sortKeyRanges: input.sortKeyRanges,
  })

  const planned = buildPlannedChunks({
    planId: input.planId,
    partitions: input.partitions,
    boundaries,
    requireIdempotencyToken: input.requireIdempotencyToken,
  })

  return planned.map(chunk => ({
    ...chunk,
    sqlTemplate: buildChunkSql({
      planId: input.planId,
      chunk,
      target: input.target,
      sortKey: input.sortKey,
      mvAsQuery: input.mvAsQuery,
      targetColumns: input.targetColumns,
    }),
  }))
}

describe('buildChunksWithSql', () => {
  const basePlanId = 'abc1234567890123'

  test('small partition produces one chunk with _partition_id filter only', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 1000, bytesOnDisk: 5 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T23:59:59.000Z' },
    ]

    const chunks = buildChunksWithSql({
      planId: basePlanId,
      target: 'default.events',
      partitions,
      maxChunkBytes: 10 * GiB,
      requireIdempotencyToken: true,
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.sqlTemplate).toContain("WHERE _partition_id = '202501'")
    expect(chunks[0]?.partitionId).toBe('202501')
    expect(chunks[0]?.estimatedBytes).toBe(5 * GiB)
  })

  test('large partition with datetime sort key produces sub-chunks with parseDateTimeBestEffort', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 10000, bytesOnDisk: 30 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
    ]
    const sortKey: SortKeyInfo = { column: 'event_time', type: 'DateTime', category: 'datetime' }
    const sortKeyRanges = new Map([
      ['202501', { min: '2025-01-01 00:00:00', max: '2025-01-31 00:00:00' }],
    ])

    const chunks = buildChunksWithSql({
      planId: basePlanId,
      target: 'default.events',
      partitions,
      maxChunkBytes: 10 * GiB,
      sortKey,
      sortKeyRanges,
      requireIdempotencyToken: true,
    })

    expect(chunks).toHaveLength(3)
    for (const chunk of chunks) {
      expect(chunk.sqlTemplate).toContain("WHERE _partition_id = '202501'")
      expect(chunk.sqlTemplate).toContain('event_time >= parseDateTimeBestEffort(')
      expect(chunk.sqlTemplate).toContain('event_time < parseDateTimeBestEffort(')
      expect(chunk.partitionId).toBe('202501')
    }
  })

  test('chunk IDs are deterministic for same input', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 1000, bytesOnDisk: 5 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
    ]

    const first = buildChunksWithSql({
      planId: basePlanId,
      target: 'default.events',
      partitions,
      maxChunkBytes: 10 * GiB,
      requireIdempotencyToken: true,
    })

    const second = buildChunksWithSql({
      planId: basePlanId,
      target: 'default.events',
      partitions,
      maxChunkBytes: 10 * GiB,
      requireIdempotencyToken: true,
    })

    expect(first[0]?.id).toBe(second[0]?.id)
    expect(first[0]?.idempotencyToken).toBe(second[0]?.idempotencyToken)
  })

  test('idempotency tokens are empty when not required', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 1000, bytesOnDisk: 5 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
    ]

    const chunks = buildChunksWithSql({
      planId: basePlanId,
      target: 'default.events',
      partitions,
      maxChunkBytes: 10 * GiB,
      requireIdempotencyToken: false,
    })

    expect(chunks[0]?.idempotencyToken).toBe('')
    expect(chunks[0]?.sqlTemplate).not.toContain('insert_deduplication_token')
  })

  test('SQL templates include correct INSERT and SELECT structure', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 1000, bytesOnDisk: 5 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
    ]

    const chunks = buildChunksWithSql({
      planId: basePlanId,
      target: 'default.events',
      partitions,
      maxChunkBytes: 10 * GiB,
      requireIdempotencyToken: true,
    })

    const sql = chunks[0]?.sqlTemplate ?? ''
    expect(sql).toContain(`/* chkit backfill plan=${basePlanId}`)
    expect(sql).toContain('INSERT INTO default.events')
    expect(sql).toContain('SELECT *')
    expect(sql).toContain('FROM default.events')
    expect(sql).toContain('SETTINGS async_insert=0')
  })

  test('numeric sort key sub-chunks use direct comparison', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 10000, bytesOnDisk: 20 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
    ]
    const sortKey: SortKeyInfo = { column: 'id', type: 'UInt64', category: 'numeric' }
    const sortKeyRanges = new Map([
      ['202501', { min: '100', max: '200' }],
    ])

    const chunks = buildChunksWithSql({
      planId: basePlanId,
      target: 'default.events',
      partitions,
      maxChunkBytes: 10 * GiB,
      sortKey,
      sortKeyRanges,
      requireIdempotencyToken: false,
    })

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.sqlTemplate).toContain("id >= '100'")
    expect(chunks[0]?.sqlTemplate).toContain("id < '150'")
    expect(chunks[0]?.sqlTemplate).not.toContain('parseDateTimeBestEffort')
  })
})
