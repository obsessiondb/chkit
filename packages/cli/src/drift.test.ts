import { describe, expect, test } from 'bun:test'

import { table } from '@chkit/core'

import { compareSchemaObjects, compareTableShape, summarizeDriftReasons } from './drift'

describe('@chkit/cli drift comparer', () => {
  test('emits missing_object reason code when expected object is absent', () => {
    const result = compareSchemaObjects(
      [{ kind: 'table', database: 'app', name: 'events' }],
      [{ kind: 'table', database: 'app', name: 'users' }]
    )

    expect(result.missing).toEqual(['table:app.events'])
    expect(result.objectDrift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_object',
          object: 'table:app.events',
          expectedKind: 'table',
        }),
      ])
    )
  })

  test('emits object-level drift reason codes', () => {
    const result = compareSchemaObjects(
      [
        { kind: 'table', database: 'app', name: 'events' },
        { kind: 'view', database: 'app', name: 'events_view' },
      ],
      [
        { kind: 'table', database: 'app', name: 'events' },
        { kind: 'materialized_view', database: 'app', name: 'events_view' },
        { kind: 'table', database: 'app', name: 'extra_table' },
      ]
    )

    expect(result.missing).toHaveLength(0)
    expect(result.extra).toEqual(['table:app.extra_table'])
    expect(result.kindMismatches).toEqual([
      {
        object: 'app.events_view',
        expected: 'view',
        actual: 'materialized_view',
      },
    ])
    expect(result.objectDrift.map((item) => item.code)).toEqual(
      expect.arrayContaining(['kind_mismatch', 'extra_object'])
    )
  })

  test('summarizes drift reason counts', () => {
    const summary = summarizeDriftReasons({
      objectDrift: [
        { code: 'missing_object', object: 'table:app.events' },
        { code: 'extra_object', object: 'table:app.tmp' },
      ],
      tableDrift: [
        {
          table: 'app.events',
          reasonCodes: ['changed_column', 'engine_mismatch'],
          missingColumns: [],
          extraColumns: [],
          changedColumns: ['ts'],
          settingDiffs: [],
          indexDiffs: [],
          ttlMismatch: false,
          engineMismatch: true,
          primaryKeyMismatch: false,
          orderByMismatch: false,
          uniqueKeyMismatch: false,
          partitionByMismatch: false,
          projectionDiffs: [],
        },
      ],
    })

    expect(summary.total).toBe(4)
    expect(summary.object).toBe(2)
    expect(summary.table).toBe(2)
    expect(summary.counts.missing_object).toBe(1)
    expect(summary.counts.extra_object).toBe(1)
    expect(summary.counts.changed_column).toBe(1)
    expect(summary.counts.engine_mismatch).toBe(1)
  })

  test('returns null for equivalent table shape', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime' },
      ],
      primaryKey: ['id'],
      orderBy: ['id', 'ts'],
      uniqueKey: ['id'],
      partitionBy: 'toYYYYMM(ts)',
      settings: { index_granularity: 8192 },
      indexes: [{ name: 'idx_ts', expression: 'ts', type: 'minmax', granularity: 1 }],
      projections: [{ name: 'p_recent', query: 'SELECT id ORDER BY ts DESC LIMIT 10' }],
      ttl: 'ts + INTERVAL 7 DAY',
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree()',
      primaryKey: '(id)',
      orderBy: '(id, ts)',
      uniqueKey: '(id)',
      partitionBy: 'toYYYYMM(ts)',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime' },
      ],
      settings: { index_granularity: '8192' },
      indexes: [{ name: 'idx_ts', expression: 'ts', type: 'minmax', granularity: 1 }],
      projections: [{ name: 'p_recent', query: 'SELECT id ORDER BY ts DESC LIMIT 10' }],
      ttl: 'ts + INTERVAL 7 DAY',
    })

    expect(result).toBeNull()
  })

  test('treats quoted string defaults and implicit engine settings as equivalent', () => {
    const expected = table({
      database: 'app',
      name: 'users',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'source', type: 'String', default: 'web' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree()',
      primaryKey: '(id)',
      orderBy: '(id)',
      uniqueKey: undefined,
      partitionBy: undefined,
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'source', type: 'String', default: "'web'" },
      ],
      settings: {
        index_granularity: '8192',
        storage_policy: 'default',
      },
      indexes: [],
      projections: [],
      ttl: undefined,
    })

    expect(result).toBeNull()
  })

  test('treats SharedMergeTree and MergeTree as equivalent engine families', () => {
    const expected = table({
      database: 'app',
      name: 'users',
      engine: 'MergeTree()',
      columns: [{ name: 'id', type: 'UInt64' }],
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const result = compareTableShape(expected, {
      engine: 'SharedMergeTree',
      primaryKey: '(id)',
      orderBy: '(id)',
      uniqueKey: undefined,
      partitionBy: undefined,
      columns: [{ name: 'id', type: 'UInt64' }],
      settings: {},
      indexes: [],
      projections: [],
      ttl: undefined,
    })

    expect(result).toBeNull()
  })

  test('treats wrapped low-cardinality nullable column forms as equivalent', () => {
    const expected = table({
      database: 'app',
      name: 'users',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'region', type: 'LowCardinality(String)', nullable: true },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree()',
      primaryKey: '(id)',
      orderBy: '(id)',
      uniqueKey: undefined,
      partitionBy: undefined,
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'region', type: 'LowCardinality(String)', nullable: true },
      ],
      settings: {},
      indexes: [],
      projections: [],
      ttl: undefined,
    })

    expect(result).toBeNull()
  })

  test('emits reason codes for semantic drift', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
      uniqueKey: ['id'],
      settings: { index_granularity: 8192 },
      projections: [{ name: 'p_recent', query: 'SELECT id ORDER BY ts DESC LIMIT 10' }],
      ttl: 'ts + INTERVAL 7 DAY',
    })

    const result = compareTableShape(expected, {
      engine: 'ReplacingMergeTree()',
      primaryKey: '(ts)',
      orderBy: '(id, ts)',
      uniqueKey: '(ts)',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime64(3)' },
        { name: 'source', type: 'String' },
      ],
      settings: { index_granularity: '4096' },
      indexes: [{ name: 'idx_source', expression: 'source', type: 'set', granularity: 1 }],
      projections: [{ name: 'p_fresh', query: 'SELECT id ORDER BY id LIMIT 5' }],
      ttl: undefined,
    })

    expect(result).toBeTruthy()
    if (!result) return
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        'changed_column',
        'extra_column',
        'setting_mismatch',
        'index_mismatch',
        'ttl_mismatch',
        'engine_mismatch',
        'primary_key_mismatch',
        'order_by_mismatch',
        'unique_key_mismatch',
        'projection_mismatch',
      ])
    )
    expect(result.engineMismatch).toBe(true)
    expect(result.primaryKeyMismatch).toBe(true)
    expect(result.orderByMismatch).toBe(true)
    expect(result.uniqueKeyMismatch).toBe(true)
    expect(result.projectionDiffs).toEqual(['p_fresh', 'p_recent'])
  })

  test('emits partition_by_mismatch when partition clause differs', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
      partitionBy: 'toYYYYMM(ts)',
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree()',
      primaryKey: '(id)',
      orderBy: '(id)',
      uniqueKey: undefined,
      partitionBy: 'toYYYYMMDD(ts)',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime' },
      ],
      settings: {},
      indexes: [],
      projections: [],
      ttl: undefined,
    })

    expect(result).toBeTruthy()
    if (!result) return
    expect(result.reasonCodes).toContain('partition_by_mismatch')
    expect(result.partitionByMismatch).toBe(true)
  })
})
