import { describe, expect, test } from 'bun:test'

import matrix from '../test/fixtures/ttl-partition-matrix.json'
import { ttlPartitionVerdict } from './ttl-partition.js'

// Every verdict Tinybird's own chtoolset gave (recorded with parity/probe-ttl.py).
const columnTypes = new Map(matrix.columns.map((column) => [column.name, column.type]))
const cases = matrix.cases as Array<[string, string, string]>

describe('ttlPartitionVerdict', () => {
  test('the matrix covers every verdict', () => {
    expect(new Set(cases.map(([, , verdict]) => verdict))).toEqual(new Set(['unchecked', 'compatible', 'incompatible']))
  })

  test('reproduces every verdict recorded from Tinybird', () => {
    const mismatches = cases
      .map(([partitionKey, ttl, verdict]) => ({ partitionKey, ttl, expected: verdict, actual: ttlPartitionVerdict({ partitionKey, ttl, columnTypes }) }))
      .filter((entry) => entry.actual !== entry.expected)
    expect(mismatches).toEqual([])
  })

  test('is unchecked without a partition key or a TTL', () => {
    expect(ttlPartitionVerdict({ partitionKey: undefined, ttl: 'ts + toIntervalDay(1)', columnTypes })).toBe('unchecked')
    expect(ttlPartitionVerdict({ partitionKey: 'toDate(ts)', ttl: undefined, columnTypes })).toBe('unchecked')
  })
})
