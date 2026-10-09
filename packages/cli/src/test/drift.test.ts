import { describe, expect, test } from 'bun:test'

import { type ColumnDefinition, table } from '@chkit/core'

import {
  collectTableSqlFragments,
  compareSchemaObjects,
  compareTableShape,
  type SqlCanonicalizer,
  summarizeDriftReasons,
} from '../commands/drift/compare.js'

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

  test('treats a dictionary like other non-table kinds for existence drift', () => {
    const result = compareSchemaObjects(
      [{ kind: 'dictionary', database: 'app', name: 'users_dict' }],
      []
    )

    expect(result.missing).toEqual(['dictionary:app.users_dict'])
    expect(result.objectDrift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_object',
          object: 'dictionary:app.users_dict',
          expectedKind: 'dictionary',
        }),
      ])
    )
  })

  test('no drift when a dictionary exists on both sides', () => {
    const result = compareSchemaObjects(
      [{ kind: 'dictionary', database: 'app', name: 'users_dict' }],
      [{ kind: 'dictionary', database: 'app', name: 'users_dict' }]
    )

    expect(result.missing).toHaveLength(0)
    expect(result.extra).toHaveLength(0)
    expect(result.objectDrift).toHaveLength(0)
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

  // chkit renders `INDEX name (expr)` and ClickHouse keeps the parentheses in
  // system.data_skipping_indices.expr, so a freshly applied index read back as
  // drift.
  test('treats a skip index as clean when ClickHouse keeps the enclosing parens', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'a', type: 'String' },
        { name: 'b', type: 'String' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
      indexes: [
        { name: 'idx_lower', expression: 'lower(a)', type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 4096, hashFunctions: 2, randomSeed: 0, granularity: 1 },
        { name: 'idx_sum', expression: '(a) || (b)', type: 'set', maxRows: 0, granularity: 1 },
      ],
    })

    const liveLower = { name: 'idx_lower', expression: '(lower(a))', type: 'ngrambf_v1' as const, ngramSize: 3, sizeBytes: 4096, hashFunctions: 2, randomSeed: 0, granularity: 1 }
    const liveConcat = { name: 'idx_sum', expression: '((a) || (b))', type: 'set' as const, maxRows: 0, granularity: 1 }
    const actual = {
      engine: 'MergeTree()',
      primaryKey: '(id)',
      orderBy: '(id)',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'a', type: 'String' },
        { name: 'b', type: 'String' },
      ],
      settings: {},
      indexes: [liveLower, liveConcat],
      projections: [],
    }

    expect(compareTableShape(expected, actual)).toBeNull()
    expect(
      compareTableShape(expected, {
        ...actual,
        indexes: [liveLower, { ...liveConcat, expression: '(a) || (b) || (a)' }],
      })?.reasonCodes
    ).toContain('index_mismatch')
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

  // #234: snapshot columns hold the fn: string; a raw { expression } must
  // compare the same way, never as the text "[object Object]".
  test('compares { expression } and fn: defaults with the introspected expression', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'updated_at', type: 'DateTime64(3)', default: { expression: 'now64(3)' } },
        { name: 'created_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
        { name: 'seen_at', type: 'DateTime', default: { expression: 'now() -- set on insert' } },
        { name: 'note', type: 'String', default: 'a -- b' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree',
      primaryKey: undefined,
      orderBy: 'id',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'updated_at', type: 'DateTime64(3)', default: 'now64(3)' },
        { name: 'created_at', type: 'DateTime64(3)', default: 'now64(3)' },
        { name: 'seen_at', type: 'DateTime', default: 'now()' },
        { name: 'note', type: 'String', default: "'a -- b'" },
      ],
      settings: {},
      indexes: [],
      projections: [],
    })

    expect(result).toBeNull()
  })

  test('reports changed_column when an { expression } default differs from the live one', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'updated_at', type: 'DateTime64(3)', default: { expression: 'now64(3)' } },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree',
      primaryKey: undefined,
      orderBy: 'id',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'updated_at', type: 'DateTime64(3)', default: 'now()' },
      ],
      settings: {},
      indexes: [],
      projections: [],
    })

    expect(result?.reasonCodes).toEqual(['changed_column'])
    expect(result?.changedColumns).toEqual(['updated_at'])
  })

  // Pins the comparison documented under `default` in the DSL reference and in
  // cli/drift.md: tokens, with comments, whitespace and outer parentheses
  // ignored, against the formatting ClickHouse stores. Update those docs
  // together with this test when the comparison changes.
  test('compares expression defaults token by token with the formatting ClickHouse stores', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'label', type: 'String', default: { expression: "concat('id-',\n  toString(id))" } },
        { name: 'kind', type: 'String', default: { expression: "multiIf(\n  id = 1, 'first',\n  'other')" } },
        { name: 'next_id', type: 'UInt64', default: { expression: 'id+1' } },
        { name: 'upper_now', type: 'DateTime', default: { expression: 'NOW()' } },
        { name: 'id_text', type: 'String', default: { expression: 'id::String' } },
        { name: 'later', type: 'DateTime', default: { expression: 'now() + INTERVAL 1 DAY' } },
        { name: 'day', type: 'Date', defaultKind: 'MATERIALIZED', default: { expression: 'toDate(upper_now)' } },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    // system.columns.default_expression for these defaults on ClickHouse 26.3.
    const result = compareTableShape(expected, {
      engine: 'MergeTree',
      primaryKey: undefined,
      orderBy: 'id',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'label', type: 'String', default: "concat('id-', toString(id))" },
        { name: 'kind', type: 'String', default: "multiIf(id = 1, 'first', 'other')" },
        { name: 'next_id', type: 'UInt64', default: 'id + 1' },
        { name: 'upper_now', type: 'DateTime', default: 'now()' },
        { name: 'id_text', type: 'String', default: "CAST(id, 'String')" },
        { name: 'later', type: 'DateTime', default: 'now() + toIntervalDay(1)' },
        { name: 'day', type: 'Date', defaultKind: 'MATERIALIZED', default: 'toDate(upper_now)' },
      ],
      settings: {},
      indexes: [],
      projections: [],
    })

    // Whitespace and line breaks match; ClickHouse's canonical spellings do not.
    expect(result?.changedColumns).toEqual(['id_text', 'later', 'upper_now'])
  })

  // The shared SQL lexer strips every comment ClickHouse accepts before the
  // comparison, so a comment the fingerprint alone cannot skip (`#`, `//`,
  // nested `/* */`, an apostrophe inside one) does not read as drift.
  test('ignores every kind of comment in an expression default', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'hash', type: 'DateTime', default: { expression: "now() # it's the insert time" } },
        { name: 'bang', type: 'DateTime', default: 'fn:now() #! server clock' },
        { name: 'slashes', type: 'Date', default: { expression: 'today() // server date' } },
        { name: 'nested', type: 'DateTime', default: 'fn:now() /* a /* nested */ comment */' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree',
      primaryKey: undefined,
      orderBy: 'id',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'hash', type: 'DateTime', default: 'now()' },
        { name: 'bang', type: 'DateTime', default: 'now()' },
        { name: 'slashes', type: 'Date', default: 'today()' },
        { name: 'nested', type: 'DateTime', default: 'now()' },
      ],
      settings: {},
      indexes: [],
      projections: [],
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

  // #232: comment markers inside a literal default are text, not comments.
  test('compares literal defaults as values, so comment markers inside them are not drift', () => {
    const expected = table({
      database: 'app',
      name: 'notes',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'note', type: 'String', default: 'a -- b' },
        { name: 'tag', type: 'String', default: '# x' },
        { name: 'link', type: 'String', default: 'http://x' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree',
      primaryKey: undefined,
      orderBy: 'id',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'note', type: 'String', default: "'a -- b'" },
        { name: 'tag', type: 'String', default: "'# x'" },
        { name: 'link', type: 'String', default: "'http://x'" },
      ],
      settings: {},
      indexes: [],
      projections: [],
    })

    expect(result).toBeNull()
  })

  // #232: ClickHouse stores no comments, so commented schema SQL must compare
  // equal to what it reports back.
  test('ignores comments in expression defaults, TTL, partition, index and projection SQL', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'name', type: 'String' },
        { name: 'ts', type: 'DateTime', default: 'fn:now() /* server time */' },
      ],
      primaryKey: ['id'],
      orderBy: ['id'],
      partitionBy: 'toYYYYMM(ts) -- monthly',
      ttl: 'ts + toIntervalDay(30) // retention',
      indexes: [{ name: 'idx_name', expression: 'lower(name) -- case-insensitive', type: 'bloom_filter', granularity: 1 }],
      projections: [{ name: 'p_recent', query: 'SELECT id, ts # newest first\nORDER BY ts' }],
    })

    const result = compareTableShape(expected, {
      engine: 'MergeTree',
      primaryKey: undefined,
      orderBy: 'id',
      partitionBy: 'toYYYYMM(ts)',
      ttl: 'ts + toIntervalDay(30)',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'name', type: 'String' },
        { name: 'ts', type: 'DateTime', default: 'now()' },
      ],
      settings: {},
      indexes: [{ name: 'idx_name', expression: 'lower(name)', type: 'bloom_filter', granularity: 1 }],
      projections: [{ name: 'p_recent', query: 'SELECT id, ts ORDER BY ts' }],
    })

    expect(result).toBeNull()
  })

  // #232: chkit backticks key columns in the DDL, so `--`, `#` or `//` in a key
  // column's name is part of the name. ClickHouse reports the key backticked.
  for (const column of ['user--id', '# visits', 'a//b']) {
    test(`compares the key column ${column} as a name, not as a comment`, () => {
      const expected = table({
        database: 'app',
        name: 'visits',
        engine: 'MergeTree()',
        columns: [{ name: column, type: 'UInt64' }],
        primaryKey: [column],
        orderBy: [column],
        uniqueKey: [column],
      })

      const result = compareTableShape(expected, {
        engine: 'MergeTree',
        primaryKey: undefined,
        orderBy: `\`${column}\``,
        uniqueKey: `\`${column}\``,
        columns: [{ name: column, type: 'UInt64' }],
        settings: {},
        indexes: [],
        projections: [],
      })

      expect(result).toBeNull()
    })
  }

  // Unquoted, `user--id` would comment out the rest of the key: the schema's
  // `user--id, ts` would read as `user` and the live `(user--id, ts)` as `(user`.
  test('compares the key columns after one whose name holds a comment marker', () => {
    const expected = table({
      database: 'app',
      name: 'visits',
      engine: 'MergeTree()',
      columns: [
        { name: 'user--id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime' },
        { name: 'received_at', type: 'DateTime' },
      ],
      primaryKey: ['user--id'],
      orderBy: ['user--id', 'ts'],
    })
    const live = (orderBy: string) =>
      compareTableShape(expected, {
        engine: 'MergeTree',
        primaryKey: '`user--id`',
        orderBy,
        columns: [
          { name: 'user--id', type: 'UInt64' },
          { name: 'ts', type: 'DateTime' },
          { name: 'received_at', type: 'DateTime' },
        ],
        settings: {},
        indexes: [],
        projections: [],
      })

    expect(live('(`user--id`, ts)')).toBeNull()
    expect(live('(`user--id`, `received_at`)')?.reasonCodes).toEqual(['order_by_mismatch'])
  })

  // The live clause loses its backticks before its parentheses are unwrapped;
  // the rest must not be read as SQL again, where `--` would start a comment.
  test('compares a parenthesized partition clause past a quoted name that holds --', () => {
    const expected = table({
      database: 'app',
      name: 'visits',
      engine: 'MergeTree()',
      columns: [
        { name: 'user--id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime' },
      ],
      primaryKey: ['user--id'],
      orderBy: ['user--id'],
      partitionBy: '(toYYYYMM(ts), `user--id` % 4)',
    })
    const live = (partitionBy: string) =>
      compareTableShape(expected, {
        engine: 'MergeTree',
        primaryKey: undefined,
        orderBy: '`user--id`',
        partitionBy,
        columns: [
          { name: 'user--id', type: 'UInt64' },
          { name: 'ts', type: 'DateTime' },
        ],
        settings: {},
        indexes: [],
        projections: [],
      })

    expect(live('(toYYYYMM(ts), `user--id` % 4)')).toBeNull()
    expect(live('(toYYYYMM(ts), `user--id` % 8)')?.reasonCodes).toEqual(['partition_by_mismatch'])
  })
})

describe('@chkit/cli drift comparer with quoted identifiers', () => {
  const expected = table({
    database: 'app',
    name: 'events',
    engine: 'MergeTree()',
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 'a b', type: 'String' },
      { name: 'c`d', type: 'String' },
      { name: 'e,f)', type: 'UInt8' },
    ],
    primaryKey: ['id', 'a b'],
    orderBy: ['id', 'a b', 'c`d', 'e,f)'],
  })

  function actualShape(orderBy: string) {
    return {
      engine: 'MergeTree',
      primaryKey: '(id, `a b`)',
      orderBy,
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'a b', type: 'String' },
        { name: 'c`d', type: 'String' },
        { name: 'e,f)', type: 'UInt8' },
      ],
      settings: {},
      indexes: [],
      projections: [],
    }
  }

  test('reports no drift when ClickHouse quotes and escapes key columns', () => {
    expect(compareTableShape(expected, actualShape('(id, `a b`, `c\\`d`, `e,f)`)'))).toBeNull()
  })

  test('still reports order_by_mismatch when the key really differs', () => {
    const result = compareTableShape(expected, actualShape('(id, `a b`, `e,f)`, `c\\`d`)'))
    expect(result?.reasonCodes).toEqual(['order_by_mismatch'])
  })
})

describe('@chkit/cli drift comparer with column expressions', () => {
  const compareColumn = (expected: ColumnDefinition, actual: ColumnDefinition) =>
    compareTableShape(
      table({
        database: 'app',
        name: 'events',
        engine: 'MergeTree()',
        columns: [{ name: 'id', type: 'UInt32' }, expected],
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
      {
        engine: 'MergeTree()',
        primaryKey: 'id',
        orderBy: 'id',
        columns: [{ name: 'id', type: 'UInt32' }, actual],
        settings: {},
        indexes: [],
        projections: [],
      }
    )

  test('an unlexable default is compared instead of throwing', () => {
    const msg: ColumnDefinition = { name: 'msg', type: 'String', default: 'fn:concat(a)' }
    expect(compareColumn({ ...msg, default: 'fn:concat(a' }, msg)?.changedColumns).toEqual(['msg'])
  })

  test('defaultValueOfTypeName matches an expressionless column only when EPHEMERAL', () => {
    const raw: ColumnDefinition = { name: 'raw', type: 'Int64', defaultKind: 'EPHEMERAL' }
    for (const literal of ['Int64', 'BIGINT']) {
      expect(compareColumn({ ...raw, default: `fn:defaultValueOfTypeName( '${literal}' )` }, raw)).toBeNull()
    }
    const zero: ColumnDefinition = { name: 'zero', type: 'Int64', defaultKind: 'MATERIALIZED' }
    expect(compareColumn({ ...zero, default: "fn:defaultValueOfTypeName('Int64')" }, zero)?.changedColumns).toEqual(['zero'])
  })
})

describe('@chkit/cli drift SQL canonicalization (#195)', () => {
  // Stand-in for ClickHouse's formatter: collapse whitespace and space after
  // commas, so `cityHash64(a,b)` and `cityHash64(a, b)` share a canonical form.
  const fakeClickHouseFormat = (fragment: string): string =>
    fragment.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
  const canonicalizer: SqlCanonicalizer = {
    expression: fakeClickHouseFormat,
    query: fakeClickHouseFormat,
  }

  const withSkipIndex = (expression: string) => ({
    database: 'app',
    name: 'events',
    engine: 'MergeTree()',
    columns: [
      { name: 'a', type: 'String' },
      { name: 'b', type: 'String' },
    ],
    primaryKey: ['a'] as string[],
    orderBy: ['a'] as string[],
    indexes: [{ name: 'i', expression, type: 'minmax' as const, granularity: 1 }],
  })

  test('a skip-index expression that differs only in comma spacing reads clean', () => {
    const expected = table(withSkipIndex('cityHash64(a,b)'))
    const actual = {
      engine: 'MergeTree()',
      primaryKey: '(a)',
      orderBy: '(a)',
      columns: [
        { name: 'a', type: 'String' },
        { name: 'b', type: 'String' },
      ],
      settings: {},
      // What ClickHouse actually stores for `cityHash64(a,b)`.
      indexes: [{ name: 'i', expression: 'cityHash64(a, b)', type: 'minmax' as const, granularity: 1 }],
      projections: [],
    }

    // Without the canonicalizer the spacing reads as drift (today's behavior)...
    expect(compareTableShape(expected, actual)?.reasonCodes).toContain('index_mismatch')
    // ...with it, the two are recognized as equal.
    expect(compareTableShape(expected, actual, canonicalizer)).toBeNull()
  })

  test('a genuinely different index expression still drifts under canonicalization', () => {
    const expected = table(withSkipIndex('cityHash64(a,b)'))
    const actual = {
      engine: 'MergeTree()',
      primaryKey: '(a)',
      orderBy: '(a)',
      columns: [
        { name: 'a', type: 'String' },
        { name: 'b', type: 'String' },
      ],
      settings: {},
      indexes: [{ name: 'i', expression: 'sipHash64(a, b)', type: 'minmax' as const, granularity: 1 }],
      projections: [],
    }

    expect(compareTableShape(expected, actual, canonicalizer)?.reasonCodes).toContain('index_mismatch')
  })

  test('collectTableSqlFragments gathers index, ttl, clause elements, and projection queries', () => {
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns: [
        { name: 'a', type: 'String' },
        { name: 'b', type: 'String' },
        { name: 'ts', type: 'DateTime' },
      ],
      primaryKey: ['a'],
      orderBy: ['a', 'b'],
      partitionBy: 'toYYYYMM(ts)',
      ttl: 'ts + toIntervalDay(30)',
      indexes: [{ name: 'i', expression: 'cityHash64(a,b)', type: 'minmax', granularity: 1 }],
      projections: [
        { name: 'p_sel', query: 'SELECT a, count() GROUP BY a' },
        { name: 'p_idx', index: 'b', type: 'basic' },
      ],
    })
    const actual = {
      engine: 'MergeTree()',
      primaryKey: undefined,
      orderBy: '(a, b)',
      columns: [
        { name: 'a', type: 'String' },
        { name: 'b', type: 'String' },
        { name: 'ts', type: 'DateTime' },
      ],
      settings: {},
      indexes: [{ name: 'i', expression: 'cityHash64(a, b)', type: 'minmax' as const, granularity: 1 }],
      partitionBy: 'toYYYYMM(ts)',
      ttl: 'ts + toIntervalDay(30)',
      projections: [
        { name: 'p_sel', query: 'SELECT a, count() GROUP BY a' },
        { name: 'p_idx', index: 'b', type: 'basic' as const },
      ],
    }

    const { expressions, queries } = collectTableSqlFragments(expected, actual)
    // Index expressions and clause elements are collected as expressions...
    expect(expressions).toContain('cityHash64(a,b)')
    expect(expressions).toContain('cityHash64(a, b)')
    expect(expressions).toContain('toYYYYMM(ts)')
    expect(expressions).toContain('a')
    expect(expressions).toContain('b')
    // ...SELECT projections as queries, and the index-only projection is not.
    expect(queries).toContain('SELECT a, count() GROUP BY a')
    expect(queries).not.toContain('b')
  })
  test('key columns reach the canonicalizer still quoted', () => {
    // Like ClickHouse, an unquoted `user--a` parses as `user` plus a comment, so
    // two different names would canonicalize to the same thing.
    const commentAwareFormat: SqlCanonicalizer = {
      expression: (fragment) =>
        fragment.startsWith('`') ? fragment : fragment.replace(/--.*$/, '').trim(),
      query: (fragment) => fragment,
    }
    const columns = [
      { name: 'id', type: 'UInt64' },
      { name: 'user--a', type: 'String' },
      { name: 'user--b', type: 'String' },
    ]
    const expected = table({
      database: 'app',
      name: 'events',
      engine: 'MergeTree()',
      columns,
      primaryKey: ['id'],
      orderBy: ['id', 'user--a'],
    })
    const actual = (orderBy: string) => ({
      engine: 'MergeTree',
      primaryKey: '(id)',
      orderBy,
      columns,
      settings: {},
      indexes: [],
      projections: [],
    })

    expect(collectTableSqlFragments(expected, actual('(id, `user--a`)')).expressions).toContain(
      '`user--a`'
    )
    expect(compareTableShape(expected, actual('(id, `user--a`)'), commentAwareFormat)).toBeNull()
    expect(
      compareTableShape(expected, actual('(id, `user--b`)'), commentAwareFormat)?.reasonCodes
    ).toEqual(['order_by_mismatch'])
  })
})
