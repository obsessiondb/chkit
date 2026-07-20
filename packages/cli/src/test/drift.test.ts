import { describe, expect, test } from 'bun:test'

import { table } from '@chkit/core'

import { compareSchemaObjects, compareTableShape, summarizeDriftReasons } from '../commands/drift/compare.js'

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

  // #194: ClickHouse derives PRIMARY KEY from ORDER BY when it is omitted, then
  // omits it from SHOW CREATE. A pulled schema carries the derived primary key,
  // so the live table (no PRIMARY KEY) must not read as drift against it.
  test('treats a primary key derived from ORDER BY as clean', () => {
    const expected = table({
      database: 'bi',
      name: 'price_history',
      engine: 'MergeTree()',
      columns: [
        { name: 'day', type: 'Date' },
        { name: 'csin', type: 'String' },
      ],
      primaryKey: ['day', 'csin'], // what `chkit pull` writes out (derived)
      orderBy: ['day', 'csin'],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree()',
      primaryKey: undefined, // live table has no PRIMARY KEY clause
      orderBy: '(day, csin)',
      columns: [
        { name: 'day', type: 'Date' },
        { name: 'csin', type: 'String' },
      ],
      settings: {},
      indexes: [],
      projections: [],
    })

    expect(result).toBeNull()
  })

  test('still reports primary_key_mismatch when the keys genuinely differ', () => {
    const expected = table({
      database: 'bi',
      name: 'price_history',
      engine: 'MergeTree()',
      columns: [
        { name: 'day', type: 'Date' },
        { name: 'csin', type: 'String' },
      ],
      primaryKey: ['day'],
      orderBy: ['day', 'csin'],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree()',
      primaryKey: '(csin)',
      orderBy: '(day, csin)',
      columns: [
        { name: 'day', type: 'Date' },
        { name: 'csin', type: 'String' },
      ],
      settings: {},
      indexes: [],
      projections: [],
    })

    expect(result?.reasonCodes).toContain('primary_key_mismatch')
  })

  // ClickHouse rewrites a single-column `INDEX (id)` to `INDEX id`, so a schema
  // written with parens must not read as drift against the live table.
  test('treats an index-only projection as clean regardless of index parens', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'receiver', type: 'String' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
      projections: [{ name: 'by_receiver', index: '(receiver)', type: 'basic' }],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree()',
      primaryKey: '(id)',
      orderBy: '(id)',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'receiver', type: 'String' },
      ],
      settings: {},
      indexes: [],
      projections: [{ name: 'by_receiver', index: 'receiver', type: 'basic' }],
    })

    expect(result).toBeNull()
  })

  test('reports projection_mismatch when an index projection changes type', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'receiver', type: 'String' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
      projections: [{ name: 'by_receiver', index: 'receiver, id', type: 'basic' }],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree()',
      primaryKey: '(id)',
      orderBy: '(id)',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'receiver', type: 'String' },
      ],
      settings: {},
      indexes: [],
      projections: [{ name: 'by_receiver', index: 'receiver', type: 'basic' }],
    })

    expect(result?.reasonCodes).toContain('projection_mismatch')
    expect(result?.projectionDiffs).toEqual(['by_receiver'])
  })

  // A SELECT projection and an index-only projection sharing a name are
  // different objects; the fingerprint must not collapse them.
  test('reports projection_mismatch when a select projection becomes index-only', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'receiver', type: 'String' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
      projections: [{ name: 'p', index: 'receiver', type: 'basic' }],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree()',
      primaryKey: '(id)',
      orderBy: '(id)',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'receiver', type: 'String' },
      ],
      settings: {},
      indexes: [],
      projections: [{ name: 'p', query: 'SELECT receiver' }],
    })

    expect(result?.reasonCodes).toContain('projection_mismatch')
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
      indexes: [{ name: 'idx_source', expression: 'source', type: 'set', maxRows: 0, granularity: 1 }],
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
