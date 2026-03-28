import { describe, expect, test } from 'bun:test'

import { introspectTable, queryPartitionInfo, querySortKeyInfo, querySortKeyRanges } from './introspect.js'

describe('queryPartitionInfo', () => {
  test('maps system.parts rows to PartitionInfo array', async () => {
    const mockRows = [
      { partition_id: '202501', total_rows: '1000', total_bytes: '5000000', min_time: '2025-01-01 00:00:00', max_time: '2025-01-31 23:59:59' },
      { partition_id: '202502', total_rows: '2000', total_bytes: '8000000', min_time: '2025-02-01 00:00:00', max_time: '2025-02-28 23:59:59' },
    ]

    const result = await queryPartitionInfo({
      database: 'default',
      table: 'events',
      query: async () => mockRows as never,
    })

    expect(result).toHaveLength(2)
    expect(result[0]?.partitionId).toBe('202501')
    expect(result[0]?.rows).toBe(1000)
    expect(result[0]?.bytesOnDisk).toBe(5000000)
    expect(result[1]?.partitionId).toBe('202502')
    expect(result[1]?.rows).toBe(2000)
  })

  test('filters out partitions before --from', async () => {
    const mockRows = [
      { partition_id: '202501', total_rows: '1000', total_bytes: '5000000', min_time: '2025-01-01 00:00:00', max_time: '2025-01-31 23:59:59' },
      { partition_id: '202503', total_rows: '3000', total_bytes: '9000000', min_time: '2025-03-01 00:00:00', max_time: '2025-03-31 23:59:59' },
    ]

    const result = await queryPartitionInfo({
      database: 'default',
      table: 'events',
      from: '2025-02-01T00:00:00.000Z',
      query: async () => mockRows as never,
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.partitionId).toBe('202503')
  })

  test('filters out partitions at or after --to', async () => {
    const mockRows = [
      { partition_id: '202501', total_rows: '1000', total_bytes: '5000000', min_time: '2025-01-01 00:00:00', max_time: '2025-01-31 23:59:59' },
      { partition_id: '202503', total_rows: '3000', total_bytes: '9000000', min_time: '2025-03-01 00:00:00', max_time: '2025-03-31 23:59:59' },
    ]

    const result = await queryPartitionInfo({
      database: 'default',
      table: 'events',
      to: '2025-03-01T00:00:00.000Z',
      query: async () => mockRows as never,
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.partitionId).toBe('202501')
  })
})

describe('querySortKeyInfo', () => {
  test('returns sort key info for table with DateTime sorting key', async () => {
    const query = async <T>(sql: string) => {
      if (sql.includes('system.tables')) {
        return [{ sorting_key: 'event_time' }] as T[]
      }
      if (sql.includes('system.columns')) {
        return [{ type: 'DateTime' }] as T[]
      }
      return [] as T[]
    }

    const result = await querySortKeyInfo({
      database: 'default',
      table: 'events',
      query,
    })

    expect(result).toBeDefined()
    expect(result?.column).toBe('event_time')
    expect(result?.type).toBe('DateTime')
    expect(result?.category).toBe('datetime')
  })

  test('returns numeric category for Int64 sorting key', async () => {
    const query = async <T>(sql: string) => {
      if (sql.includes('system.tables')) return [{ sorting_key: 'id' }] as T[]
      if (sql.includes('system.columns')) return [{ type: 'Int64' }] as T[]
      return [] as T[]
    }

    const result = await querySortKeyInfo({ database: 'default', table: 'events', query })

    expect(result?.category).toBe('numeric')
  })

  test('returns string category for String sorting key', async () => {
    const query = async <T>(sql: string) => {
      if (sql.includes('system.tables')) return [{ sorting_key: 'name' }] as T[]
      if (sql.includes('system.columns')) return [{ type: 'String' }] as T[]
      return [] as T[]
    }

    const result = await querySortKeyInfo({ database: 'default', table: 'events', query })

    expect(result?.category).toBe('string')
  })

  test('extracts column name from function expression', async () => {
    const query = async <T>(sql: string) => {
      if (sql.includes('system.tables')) return [{ sorting_key: 'toDate(event_time)' }] as T[]
      if (sql.includes('system.columns')) return [{ type: 'DateTime' }] as T[]
      return [] as T[]
    }

    const result = await querySortKeyInfo({ database: 'default', table: 'events', query })

    expect(result?.column).toBe('event_time')
  })

  test('returns undefined when table has no sorting key', async () => {
    const query = async <T>(sql: string) => {
      if (sql.includes('system.tables')) return [{ sorting_key: '' }] as T[]
      return [] as T[]
    }

    const result = await querySortKeyInfo({ database: 'default', table: 'events', query })

    expect(result).toBeUndefined()
  })

  test('returns first column from multi-column sorting key', async () => {
    const query = async <T>(sql: string) => {
      if (sql.includes('system.tables')) return [{ sorting_key: 'event_time, id' }] as T[]
      if (sql.includes('system.columns')) return [{ type: 'DateTime' }] as T[]
      return [] as T[]
    }

    const result = await querySortKeyInfo({ database: 'default', table: 'events', query })

    expect(result?.column).toBe('event_time')
  })
})

describe('querySortKeyRanges', () => {
  test('returns min/max per partition', async () => {
    const query = async <T>() => {
      return [
        { partition_id: '202501', min_val: '2025-01-01 00:00:00', max_val: '2025-01-31 23:59:59' },
        { partition_id: '202502', min_val: '2025-02-01 00:00:00', max_val: '2025-02-28 23:59:59' },
      ] as T[]
    }

    const result = await querySortKeyRanges({
      database: 'default',
      table: 'events',
      sortKeyColumn: 'event_time',
      partitionIds: ['202501', '202502'],
      query,
    })

    expect(result.size).toBe(2)
    expect(result.get('202501')?.min).toBe('2025-01-01 00:00:00')
    expect(result.get('202502')?.max).toBe('2025-02-28 23:59:59')
  })

  test('returns empty map for empty partition list', async () => {
    const query = async <T>() => [] as T[]

    const result = await querySortKeyRanges({
      database: 'default',
      table: 'events',
      sortKeyColumn: 'event_time',
      partitionIds: [],
      query,
    })

    expect(result.size).toBe(0)
  })
})

describe('introspectTable', () => {
  test('returns partitions and sort key in a single call', async () => {
    const query = async <T>(sql: string) => {
      if (sql.includes('system.parts')) {
        return [
          { partition_id: '202501', total_rows: '1000', total_bytes: '5000000', min_time: '2025-01-01 00:00:00', max_time: '2025-01-31 23:59:59' },
        ] as T[]
      }
      if (sql.includes('system.tables')) {
        return [{ sorting_key: 'event_time' }] as T[]
      }
      if (sql.includes('system.columns')) {
        return [{ type: 'DateTime' }] as T[]
      }
      return [] as T[]
    }

    const result = await introspectTable({
      database: 'default',
      table: 'events',
      query,
    })

    expect(result.partitions).toHaveLength(1)
    expect(result.partitions[0]?.partitionId).toBe('202501')
    expect(result.sortKey).toBeDefined()
    expect(result.sortKey?.column).toBe('event_time')
    expect(result.sortKey?.category).toBe('datetime')
  })

  test('returns undefined sortKey when table has no sorting key', async () => {
    const query = async <T>(sql: string) => {
      if (sql.includes('system.parts')) {
        return [
          { partition_id: '202501', total_rows: '1000', total_bytes: '5000000', min_time: '2025-01-01 00:00:00', max_time: '2025-01-31 23:59:59' },
        ] as T[]
      }
      if (sql.includes('system.tables')) {
        return [{ sorting_key: '' }] as T[]
      }
      return [] as T[]
    }

    const result = await introspectTable({
      database: 'default',
      table: 'events',
      query,
    })

    expect(result.partitions).toHaveLength(1)
    expect(result.sortKey).toBeUndefined()
  })
})
