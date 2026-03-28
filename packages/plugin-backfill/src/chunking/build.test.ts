import { describe, expect, test } from 'bun:test'

import { buildChunkBoundaries } from './build.js'
import type { PartitionInfo, SortKeyInfo } from './types.js'

const GiB = 1024 ** 3

describe('buildChunkBoundaries', () => {
  test('small partition produces one chunk boundary', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 1000, bytesOnDisk: 5 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T23:59:59.000Z' },
    ]

    const boundaries = buildChunkBoundaries({
      partitions,
      maxChunkBytes: 10 * GiB,
    })

    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]?.partitionId).toBe('202501')
    expect(boundaries[0]?.sortKeyFrom).toBeUndefined()
    expect(boundaries[0]?.sortKeyTo).toBeUndefined()
    expect(boundaries[0]?.estimatedBytes).toBe(5 * GiB)
  })

  test('large partition produces multiple sub-chunks with sort key ranges', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 10000, bytesOnDisk: 30 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
    ]
    const sortKey: SortKeyInfo = { column: 'event_time', type: 'DateTime', category: 'datetime' }
    const sortKeyRanges = new Map([
      ['202501', { min: '2025-01-01 00:00:00', max: '2025-01-31 00:00:00' }],
    ])

    const boundaries = buildChunkBoundaries({
      partitions,
      maxChunkBytes: 10 * GiB,
      sortKey,
      sortKeyRanges,
    })

    expect(boundaries).toHaveLength(3)
    for (const b of boundaries) {
      expect(b.partitionId).toBe('202501')
      expect(b.sortKeyFrom).toBeDefined()
      expect(b.sortKeyTo).toBeDefined()
    }
  })

  test('large partition without sort key produces single chunk', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 10000, bytesOnDisk: 30 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
    ]

    const boundaries = buildChunkBoundaries({
      partitions,
      maxChunkBytes: 10 * GiB,
    })

    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]?.estimatedBytes).toBe(30 * GiB)
  })

  test('mixed sizes produce correct boundary counts', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 500, bytesOnDisk: 5 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
      { partitionId: '202502', rows: 5000, bytesOnDisk: 25 * GiB, minTime: '2025-02-01T00:00:00.000Z', maxTime: '2025-02-28T00:00:00.000Z' },
    ]
    const sortKey: SortKeyInfo = { column: 'event_time', type: 'DateTime', category: 'datetime' }
    const sortKeyRanges = new Map([
      ['202502', { min: '2025-02-01 00:00:00', max: '2025-02-28 00:00:00' }],
    ])

    const boundaries = buildChunkBoundaries({
      partitions,
      maxChunkBytes: 10 * GiB,
      sortKey,
      sortKeyRanges,
    })

    // First partition: 5 GiB < 10 GiB -> 1 boundary
    // Second partition: 25 GiB / 10 GiB = 3 sub-boundaries
    expect(boundaries).toHaveLength(4)

    const p1 = boundaries.filter((b) => b.partitionId === '202501')
    const p2 = boundaries.filter((b) => b.partitionId === '202502')
    expect(p1).toHaveLength(1)
    expect(p2).toHaveLength(3)
  })

  test('large partition with min === max sort key produces single chunk', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 10000, bytesOnDisk: 30 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
    ]
    const sortKey: SortKeyInfo = { column: 'event_type', type: 'String', category: 'string' }
    const sortKeyRanges = new Map([
      ['202501', { min: 'click', max: 'click' }],
    ])

    const boundaries = buildChunkBoundaries({
      partitions,
      maxChunkBytes: 10 * GiB,
      sortKey,
      sortKeyRanges,
    })

    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]?.partitionId).toBe('202501')
    expect(boundaries[0]?.sortKeyFrom).toBeUndefined()
    expect(boundaries[0]?.sortKeyTo).toBeUndefined()
  })

  test('numeric sort key produces numeric range sub-chunks', () => {
    const partitions: PartitionInfo[] = [
      { partitionId: '202501', rows: 10000, bytesOnDisk: 20 * GiB, minTime: '2025-01-01T00:00:00.000Z', maxTime: '2025-01-31T00:00:00.000Z' },
    ]
    const sortKey: SortKeyInfo = { column: 'id', type: 'UInt64', category: 'numeric' }
    const sortKeyRanges = new Map([
      ['202501', { min: '100', max: '200' }],
    ])

    const boundaries = buildChunkBoundaries({
      partitions,
      maxChunkBytes: 10 * GiB,
      sortKey,
      sortKeyRanges,
    })

    expect(boundaries).toHaveLength(2)
    expect(boundaries[0]?.sortKeyFrom).toBe('100')
    expect(boundaries[0]?.sortKeyTo).toBe('150')
    expect(boundaries[1]?.sortKeyFrom).toBe('150')
    expect(boundaries[1]?.sortKeyTo).toBe('201')
  })
})
