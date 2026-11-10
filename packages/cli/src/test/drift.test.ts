import { describe, expect, test } from 'bun:test'

import {
  type ColumnDefinition,
  type SkipIndexDefinition,
  type TableConstraintDefinition,
  type TableInput,
  materializedView,
  parseCodec,
  table,
  view,
} from '@chkit/core'

import {
  collectTableSqlFragments,
  collectViewSqlQueries,
  compareObjectComments,
  compareSchemaObjects,
  compareTableShape,
  compareViewShape,
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

  test('reports a changed comment on any object kind with both values (#464)', () => {
    const drift = compareObjectComments(
      [
        { kind: 'table', database: 'app', name: 'events', comment: 'a\\b' },
        { kind: 'view', database: 'app', name: 'v' },
        { kind: 'materialized_view', database: 'app', name: 'mv', comment: 'same' },
        { kind: 'dictionary', database: 'app', name: 'd', comment: 'dict' },
        { kind: 'table', database: 'app', name: 'missing', comment: 'x' },
      ],
      [
        { kind: 'table', database: 'app', name: 'events', comment: 'a\\b' },
        { kind: 'view', database: 'app', name: 'v', comment: 'server' },
        { kind: 'materialized_view', database: 'app', name: 'mv', comment: 'same' },
        { kind: 'dictionary', database: 'app', name: 'd', comment: '' },
      ]
    )
    expect(drift).toEqual([
      { code: 'comment_mismatch', object: 'app.v', expected: '', actual: 'server' },
      { code: 'comment_mismatch', object: 'app.d', expected: 'dict', actual: '' },
    ])
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

  test('equates inline Nullable types with the introspected nullable property', () => {
    for (const type of ['String', "DateTime64(3, 'UTC')", 'Decimal(12, 3)']) {
      const inline = { name: 'value', type: `Nullable(${type})` }
      const property = { name: 'value', type, nullable: true }
      expect(compareColumn(inline, property)).toBeNull()
      expect(compareColumn(property, inline)).toBeNull()
      expect(compareColumn(property, property)).toBeNull()
    }
  })

  test('equates a nullable LowCardinality column with the stored LowCardinality(Nullable(T))', () => {
    const stored = { name: 'value', type: 'LowCardinality(Nullable(String))' }
    const property = { name: 'value', type: 'LowCardinality(String)', nullable: true }
    expect(compareColumn(property, stored)).toBeNull()
    expect(compareColumn(stored, property)).toBeNull()
  })

  test('preserves real type, nullability and wrapper differences', () => {
    const differences: Array<[ColumnDefinition, ColumnDefinition]> = [
      [{ name: 'value', type: 'Nullable(String)' }, { name: 'value', type: 'String' }],
      [{ name: 'value', type: 'String' }, { name: 'value', type: 'String', nullable: true }],
      [{ name: 'value', type: 'Nullable(String)' }, { name: 'value', type: 'UInt64', nullable: true }],
      [{ name: 'value', type: 'Nullable(String)', nullable: true }, { name: 'value', type: 'String', nullable: true }],
      [{ name: 'value', type: 'Array(Nullable(String))' }, { name: 'value', type: 'Array(String)' }],
    ]
    for (const [expected, actual] of differences) {
      expect(compareColumn(expected, actual)).toMatchObject({
        changedColumns: ['value'],
        reasonCodes: ['changed_column'],
      })
      expect(compareColumn(actual, expected)?.changedColumns).toEqual(['value'])
    }
  })

  test('keeps defaults, comments and default kinds in nullable column comparisons', () => {
    const expected = { name: 'value', type: 'Nullable(String)', default: 'a', comment: 'original' }
    const actual = { name: 'value', type: 'String', nullable: true, default: "'a'", comment: 'original' }
    expect(compareColumn(expected, actual)).toBeNull()
    for (const column of [
      { ...actual, default: "'b'" },
      { ...actual, comment: 'changed' },
      { ...actual, defaultKind: 'MATERIALIZED' },
    ] satisfies ColumnDefinition[]) {
      expect(compareColumn(expected, column)?.changedColumns).toEqual(['value'])
    }
  })

  // #383: a codec added, removed or changed on the server is drift, while the
  // forms ClickHouse fills in (ZSTD(1), LZ4HC(0), no DoubleDelta width, no FPC
  // float size) are not.
  test('compares column codecs in the form ClickHouse stores them', () => {
    const column = { name: 'value', type: 'Float64' }
    const live = (compressionCodec: string) => ({ ...column, codec: parseCodec(compressionCodec) })
    expect(compareColumn({ ...column, codec: { kind: 'ZSTD' } }, live('CODEC(ZSTD(1))'))).toBeNull()
    expect(compareColumn({ ...column, codec: { kind: 'LZ4HC' } }, live('CODEC(LZ4HC(0))'))).toBeNull()
    expect(compareColumn(
      { ...column, codec: [{ kind: 'DoubleDelta', size: 8 }, { kind: 'FPC', level: 12, floatSize: 8 }, { kind: 'LZ4' }] },
      live('CODEC(DoubleDelta, FPC(12), LZ4)')
    )).toBeNull()
    expect(compareColumn(column, live(''))).toBeNull()

    const differences: Array<[ColumnDefinition, ColumnDefinition]> = [
      [{ ...column, codec: { kind: 'ZSTD', level: 3 } }, live('CODEC(LZ4)')],
      [column, live('CODEC(ZSTD(3))')],
      [{ ...column, codec: { kind: 'ZSTD', level: 3 } }, live('')],
      [{ ...column, codec: [{ kind: 'Delta', size: 1 }, { kind: 'LZ4' }] }, live('CODEC(Delta(8), LZ4)')],
      [{ ...column, codec: [{ kind: 'FPC', level: 12, floatSize: 8 }, { kind: 'LZ4' }] }, live('CODEC(FPC(5), LZ4)')],
    ]
    for (const [expected, actual] of differences) {
      expect(compareColumn(expected, actual)).toMatchObject({
        changedColumns: ['value'],
        reasonCodes: ['changed_column'],
      })
    }
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

  // A schema may write more than one pair (`((s))`); ObsessionDB keeps the one
  // chkit renders and stock ClickHouse none, so every enclosing pair is peeled,
  // quote-aware (#512).
  test.each([
    ['((lower(a)))', 'lower(a)'],
    ['((lower(a)))', '(lower(a))'],
    ["(a = ')(')", "a = ')('"],
    ['((a, b))', 'a, b'],
  ])('treats the skip index expression %s as clean against the stored %s', (declared, stored) => {
    const index = { name: 'idx', type: 'set' as const, maxRows: 0, granularity: 1 }
    const columns = [
      { name: 'id', type: 'UInt64' },
      { name: 'a', type: 'String' },
      { name: 'b', type: 'String' },
    ]
    const expected = table({
      database: 'app', name: 'events', engine: 'MergeTree()', columns, primaryKey: ['id'], orderBy: ['id'],
      indexes: [{ ...index, expression: declared }],
    })
    const actual = {
      engine: 'MergeTree()', primaryKey: '(id)', orderBy: '(id)', columns, settings: {},
      indexes: [{ ...index, expression: stored }], projections: [],
    }
    expect(compareTableShape(expected, actual)).toBeNull()
    expect(
      compareTableShape(expected, { ...actual, indexes: [{ ...index, expression: `(${stored}) || 'x'` }] })?.reasonCodes
    ).toContain('index_mismatch')
  })

  test('peels only the skip index parentheses that enclose the expression, reading heredocs as strings', () => {
    const columns = [{ name: 'id', type: 'UInt64' }, { name: 'a', type: 'String' }]
    const index = { name: 'idx', type: 'set' as const, maxRows: 0, granularity: 1 }
    const expected = table({
      database: 'app', name: 'events', engine: 'MergeTree()', columns, primaryKey: ['id'], orderBy: ['id'],
      indexes: [{ ...index, expression: '((equals(a, $$($$)) OR (equals(a, $$)$$)))' }],
    })
    const actual = {
      engine: 'MergeTree()', primaryKey: '(id)', orderBy: '(id)', columns, settings: {},
      indexes: [{ ...index, expression: "equals(a, '(') OR equals(a, ')')" }], projections: [],
    }
    expect(collectTableSqlFragments(expected, actual).expressions).toContain('(equals(a, $$($$)) OR (equals(a, $$)$$))')
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

  // ObsessionDB and ClickHouse Cloud store Replicated* as Shared*, without the path and replica (#669).
  const replicatedOnShared: Array<[string, string, boolean]> = [
    ['ReplicatedMergeTree()', 'SharedMergeTree', false],
    ["ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')", 'SharedMergeTree', false],
    ["ReplicatedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', v)", 'SharedReplacingMergeTree(v)', false],
    ['ReplicatedReplacingMergeTree(v)', 'SharedReplacingMergeTree(v)', false],
    // ObsessionDB keeps an expression path as written.
    [
      "ReplicatedReplacingMergeTree(concat('/clickhouse/tables/', currentDatabase()), '{replica}', v)",
      "SharedReplacingMergeTree(concat('/clickhouse/tables/', currentDatabase()), '{replica}', v)",
      false,
    ],
    ['ReplicatedReplacingMergeTree($$/clickhouse/tables/{uuid}$$, $${replica}$$, v)', 'SharedReplacingMergeTree(v)', false],
    ['ReplicatedVersionedCollapsingMergeTree(id, v)', 'SharedVersionedCollapsingMergeTree(id, v)', false],
    ['ReplicatedReplacingMergeTree(v)', 'SharedMergeTree', true],
    ["ReplicatedReplacingMergeTree('/p', '{replica}', v)", 'SharedReplacingMergeTree(id)', true],
    // A server without Shared engines really has a non-replicated table.
    ['ReplicatedMergeTree()', 'MergeTree', true],
  ]
  for (const [expectedEngine, actualEngine, mismatch] of replicatedOnShared) {
    test(`${expectedEngine} against ${actualEngine} ${mismatch ? 'is' : 'is not'} an engine mismatch`, () => {
      const expected = table({
        database: 'app',
        name: 'users',
        engine: expectedEngine,
        columns: [{ name: 'id', type: 'UInt64' }, { name: 'v', type: 'UInt64' }],
        primaryKey: ['id'],
        orderBy: ['id'],
      })

      const result = compareTableShape(expected, {
        engine: actualEngine,
        primaryKey: '(id)',
        orderBy: '(id)',
        uniqueKey: undefined,
        partitionBy: undefined,
        columns: [{ name: 'id', type: 'UInt64' }, { name: 'v', type: 'UInt64' }],
        settings: {},
        indexes: [],
        projections: [],
        ttl: undefined,
      })

      expect(result?.engineMismatch ?? false).toBe(mismatch)
    })
  }

  // Column names and string literals in engine arguments are case-sensitive (#673).
  // The server rewrites the case of function names and operator keywords only.
  const engineArgumentCase: Array<[string, string, boolean]> = [
    ['CollapsingMergeTree(Sign)', 'CollapsingMergeTree(sign)', true],
    ['ReplacingMergeTree(Ver)', 'ReplacingMergeTree(ver)', true],
    ['VersionedCollapsingMergeTree(Sign, Version)', 'VersionedCollapsingMergeTree(sign, Version)', true],
    ['SummingMergeTree((Value, Version))', 'SummingMergeTree((value, Version))', true],
    ["GraphiteMergeTree('graphite_rollup')", "GraphiteMergeTree('Graphite_Rollup')", true],
    ["ReplicatedReplacingMergeTree('/p', '{replica}', Ver)", 'SharedReplacingMergeTree(ver)', true],
    ["Distributed(c, app, t, Sign)", "Distributed('c', 'app', 't', sign)", true],
    ['ReplacingMergeTree(And)', 'ReplacingMergeTree(and)', true],
    ['SummingMergeTree((From, Value))', 'SummingMergeTree((from, Value))', true],
    ['CollapsingMergeTree(Sign)', 'CollapsingMergeTree(Sign)', false],
    ['ReplacingMergeTree( Ver )', 'ReplacingMergeTree(Ver)', false],
    ["ReplicatedReplacingMergeTree('/p', '{replica}', Ver)", 'SharedReplacingMergeTree(Ver)', false],
    ['Distributed(c, app, t, RAND())', "Distributed('c', 'app', 't', rand())", false],
    ['Distributed(c, app, t, If(Sign > 1, 1, 0))', "Distributed('c', 'app', 't', if(Sign > 1, 1, 0))", false],
    ['Distributed(c, app, t, Path is not null and TRUE)', "Distributed('c', 'app', 't', Path IS NOT NULL AND true)", false],
    ['Distributed(c, app, t, id is distinct from 0)', "Distributed('c', 'app', 't', id IS DISTINCT FROM 0)", false],
    ["Distributed(c, app, t, s not like 'a')", "Distributed('c', 'app', 't', s NOT LIKE 'a')", false],
  ]
  for (const [expectedEngine, actualEngine, mismatch] of engineArgumentCase) {
    test(`engine ${expectedEngine} against ${actualEngine} ${mismatch ? 'is' : 'is not'} a mismatch`, () => {
      const expected = table({
        database: 'app',
        name: 'events',
        engine: expectedEngine,
        columns: [{ name: 'id', type: 'UInt64' }],
        primaryKey: ['id'],
        orderBy: ['id'],
      })

      const result = compareTableShape(expected, {
        engine: actualEngine,
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

      expect(result?.engineMismatch ?? false).toBe(mismatch)
    })
  }

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

function compareColumn(expected: ColumnDefinition, actual: ColumnDefinition) {
  return compareTableShape(table({
    database: 'app',
    name: 'events',
    engine: 'MergeTree()',
    columns: [expected],
    orderBy: [],
  }), {
    engine: 'MergeTree()',
    columns: [actual],
    settings: {},
    indexes: [],
    projections: [],
  })
}

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

describe('@chkit/cli drift comparer: a quoted key column holding a comma or space (#558)', () => {
  const columns = [
    { name: 'id', type: 'UInt64' },
    { name: 'a', type: 'String' },
    { name: 'b', type: 'String' },
    { name: 'a, b', type: 'String' },
    { name: 'a b', type: 'String' },
    { name: 'ab', type: 'String' },
  ]
  const expected = (orderBy: string[]) =>
    table({ database: 'app', name: 'events', engine: 'MergeTree()', columns, orderBy })
  // What system.tables reports; primary_key is the sorting key here.
  const actual = (key: string) => ({
    engine: 'MergeTree',
    primaryKey: key,
    orderBy: key,
    columns,
    settings: {},
    indexes: [],
    projections: [],
  })

  test('columns a, b against one column named `a, b` drift', () => {
    expect(compareTableShape(expected(['id', 'a', 'b']), actual('id, `a, b`'))?.reasonCodes).toEqual([
      'primary_key_mismatch',
      'order_by_mismatch',
    ])
    expect(compareTableShape(expected(['id', 'a, b']), actual('id, a, b'))?.reasonCodes).toEqual([
      'primary_key_mismatch',
      'order_by_mismatch',
    ])
  })

  test('a column named `a b` against a column named ab drifts', () => {
    expect(compareTableShape(expected(['id', 'a b']), actual('id, ab'))?.reasonCodes).toEqual([
      'primary_key_mismatch',
      'order_by_mismatch',
    ])
  })

  test('the key as ClickHouse reports it reads clean, with or without a canonicalizer', () => {
    const schema = expected(['id', 'a, b', 'a b', 'cityHash64(a,b)'])
    const live = actual('id, `a, b`, `a b`, cityHash64(a, b)')
    expect(compareTableShape(schema, live)).toBeNull()
    const canonicalizer: SqlCanonicalizer = { expression: (fragment) => fragment, query: () => null }
    expect(compareTableShape(schema, live, canonicalizer)).toBeNull()
  })

  test('a column named null drifts against the NULL literal, a column named true does not', () => {
    // ClickHouse always quotes a column named null, and writes one named true bare.
    expect(compareTableShape(expected(['id', 'if(`null` = 1, id, 0)']), actual('id, if(NULL = 1, id, 0)'))?.reasonCodes).toEqual([
      'primary_key_mismatch',
      'order_by_mismatch',
    ])
    expect(compareTableShape(expected(['id', 'if(`true` = 1, id, 0)']), actual('id, if(true = 1, id, 0)'))).toBeNull()
    // A null after a dot is the null map of a Nullable column, which ClickHouse quotes.
    expect(compareTableShape(expected(['id', 'if(a.null, 0, 1)']), actual('id, if(a.`null`, 0, 1)'))).toBeNull()
  })

  test('an expression split across entries or spaced differently reads clean', () => {
    expect(compareTableShape(expected(['id', 'cityHash64(a', 'b)']), actual('id, cityHash64(a, b)'))).toBeNull()
    expect(compareTableShape(expected(['id', 'toStartOfHour( id )']), actual('(id, toStartOfHour(id))'))).toBeNull()
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

describe('@chkit/cli drift: vector indexes, raw indexes and constraints (#278)', () => {
  // Stand-in for ClickHouse's formatter on the shapes used below: it adds the
  // parentheses ClickHouse stores around `IN` and arithmetic.
  const formatted: Record<string, string> = {
    "s IN ('a','b') AND (id+1)*2 > 0": "(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)",
    'sparse_grams(3,100, 512,1,3,0)': 'sparse_grams(3, 100, 512, 1, 3, 0)',
  }
  const canonicalizer: SqlCanonicalizer = {
    expression: (fragment) => formatted[fragment] ?? fragment,
    query: (fragment) => fragment,
  }
  const vector = {
    name: 'e', expression: 'embedding', type: 'vector_similarity' as const,
    method: 'hnsw' as const, distanceFunction: 'cosineDistance' as const, dimensions: 4,
  }
  const rawSparse = { name: 'sg', expression: 's', type: 'raw' as const, rawType: 'sparse_grams(3,100, 512,1,3,0)', granularity: 1 }
  const expected = (overrides: Partial<TableInput> = {}) => table({
    database: 'app',
    name: 'vectors',
    engine: 'MergeTree()',
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 's', type: 'String' },
      { name: 'embedding', type: 'Array(Float32)' },
    ],
    orderBy: ['id'],
    indexes: [vector, rawSparse],
    constraints: [
      { name: 'dimension', check: 'length(embedding) = 4' },
      { name: 'c3', check: "s IN ('a','b') AND (id+1)*2 > 0" },
    ],
    ...overrides,
  })
  const liveVector = { ...vector, granularity: 100_000_000 }
  const liveSparse = { ...rawSparse, rawType: 'sparse_grams(3, 100, 512, 1, 3, 0)' }
  const liveDimension = { name: 'dimension', check: 'length(embedding) = 4' }
  const liveC3 = { name: 'c3', check: "(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)" }
  const actual = (overrides: { indexes?: SkipIndexDefinition[]; constraints?: TableConstraintDefinition[] } = {}) => ({
    engine: 'MergeTree',
    primaryKey: undefined,
    orderBy: 'id',
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 's', type: 'String' },
      { name: 'embedding', type: 'Array(Float32)' },
    ],
    settings: {},
    indexes: overrides.indexes ?? [liveVector, liveSparse],
    projections: [],
    constraints: overrides.constraints ?? [liveDimension, liveC3],
  })

  test('what ClickHouse echoes back reads clean', () => {
    expect(compareTableShape(expected(), actual(), canonicalizer)).toBeNull()
  })

  test('every fragment the comparison canonicalizes is collected', () => {
    const { expressions } = collectTableSqlFragments(expected(), actual())
    expect(expressions).toContain("s IN ('a','b') AND (id+1)*2 > 0")
    expect(expressions).toContain('sparse_grams(3,100, 512,1,3,0)')
  })

  test('a missing, extra or changed constraint drifts', () => {
    const missing = compareTableShape(expected(), actual({ constraints: [liveDimension] }), canonicalizer)
    expect(missing?.reasonCodes).toEqual(['constraint_mismatch'])
    expect(missing?.constraintDiffs).toEqual(['c3'])

    const extra = compareTableShape(expected({ constraints: [] }), actual(), canonicalizer)
    expect(extra?.constraintDiffs).toEqual(['c3', 'dimension'])

    const kind = compareTableShape(
      expected(),
      actual({ constraints: [{ name: 'dimension', assume: 'length(embedding) = 4' }, liveC3] }),
      canonicalizer
    )
    expect(kind?.constraintDiffs).toEqual(['dimension'])
  })

  test('a changed vector index or granularity drifts', () => {
    const changed = compareTableShape(
      expected(),
      actual({ indexes: [{ ...liveVector, distanceFunction: 'L2Distance' }, liveSparse] }),
      canonicalizer
    )
    expect(changed?.indexDiffs).toEqual(['e'])

    const granularity = compareTableShape(expected(), actual({ indexes: [{ ...liveVector, granularity: 1 }, liveSparse] }), canonicalizer)
    expect(granularity?.indexDiffs).toEqual(['e'])
  })

  test('a structured index matches the same type written raw', () => {
    const raw = { name: 'e', expression: 'embedding', type: 'raw' as const, rawType: "vector_similarity('hnsw', 'cosineDistance', 4)", granularity: 100_000_000 }
    expect(compareTableShape(expected({ indexes: [raw, rawSparse] }), actual(), canonicalizer)).toBeNull()
  })
})

describe('@chkit/cli drift: view and materialized view queries (#382)', () => {
  // Stand-in for ClickHouse's formatter: spaces after commas, `!=` spaced.
  const format = (fragment: string): string =>
    fragment.replace(/\s*,\s*/g, ', ').replace(/\s*!=\s*/g, ' != ').trim()
  const canonicalizer: SqlCanonicalizer = { expression: format, query: format }
  const dailyRevenue = view({
    database: 'app',
    name: 'daily_revenue',
    as: 'SELECT day,sum(amount) AS revenue FROM orders GROUP BY day',
  })
  const ordersMv = materializedView({
    database: 'app',
    name: 'orders_mv',
    to: { database: 'app', name: 'orders_by_day' },
    as: "SELECT day, amount FROM orders WHERE status!='Refunded'",
  })

  test('a query ClickHouse reformatted and qualified with the session database reads clean', () => {
    const live = { query: 'SELECT day, sum(amount) AS revenue FROM app.orders GROUP BY day' }
    expect(compareViewShape(dailyRevenue, live, 'app', canonicalizer)).toEqual([])
  })

  test('a qualifier for another database is kept, so a changed source database drifts', () => {
    const live = { query: 'SELECT day, sum(amount) AS revenue FROM other.orders GROUP BY day' }
    expect(compareViewShape(dailyRevenue, live, 'app', canonicalizer)).toEqual([
      {
        code: 'query_mismatch',
        object: 'app.daily_revenue',
        expected: 'SELECT day, sum(amount) AS revenue FROM orders GROUP BY day',
        actual: 'SELECT day, sum(amount) AS revenue FROM other.orders GROUP BY day',
      },
    ])
  })

  test('a materialized view with an extra WHERE condition drifts', () => {
    const live = {
      query: "SELECT day, amount FROM app.orders WHERE status != 'Refunded' AND amount > 0",
      to: { database: 'app', name: 'orders_by_day' },
    }
    expect(compareViewShape(ordersMv, live, 'app', canonicalizer)).toMatchObject([
      { code: 'query_mismatch', object: 'app.orders_mv' },
    ])
  })

  test('a materialized view writing to another target drifts', () => {
    const live = {
      query: "SELECT day, amount FROM app.orders WHERE status != 'Refunded'",
      to: { database: 'app', name: 'orders_by_week' },
    }
    expect(compareViewShape(ordersMv, live, 'app', canonicalizer)).toEqual([
      {
        code: 'target_mismatch',
        object: 'app.orders_mv',
        expected: 'app.orders_by_day',
        actual: 'app.orders_by_week',
      },
    ])
  })

  test('a query that cannot be formatted is not compared', () => {
    const live = { query: 'SELECT something else entirely' }
    expect(compareViewShape(dailyRevenue, live, 'app')).toEqual([])
    const unformattable: SqlCanonicalizer = { expression: format, query: () => null }
    expect(compareViewShape(dailyRevenue, live, 'app', unformattable)).toEqual([])
  })

  test('a query in which ClickHouse hid a secret is not compared', () => {
    const remoteView = view({
      database: 'app',
      name: 'remote_one',
      as: "SELECT * FROM remote('127.0.0.1', system.one, 'default', 'chkit-ci')",
    })
    const live = { query: "SELECT * FROM remote('127.0.0.1', system.one, 'default', '[HIDDEN]')" }
    expect(collectViewSqlQueries(remoteView, live)).toEqual([])
    expect(compareViewShape(remoteView, live, 'app', canonicalizer)).toEqual([])
  })

  test('a materialized view recreated with an inner table drifts', () => {
    const live = { query: "SELECT day, amount FROM app.orders WHERE status != 'Refunded'" }
    expect(compareViewShape(ordersMv, live, 'app', canonicalizer)).toEqual([
      { code: 'target_mismatch', object: 'app.orders_mv', expected: 'app.orders_by_day', actual: '' },
    ])
  })

  test('only a database qualifier in front of a name is removed', () => {
    const expected = view({ database: 'app', name: 'v', as: "SELECT app, 'app.x', t.app.c FROM `app`.t" })
    const live = { query: "SELECT app, 'app.x', t.app.c FROM t" }
    expect(compareViewShape(expected, live, 'app', canonicalizer)).toEqual([])
  })

  test('the session database qualifier ClickHouse adds to a dictionary name is removed', () => {
    const expected = view({
      database: 'app',
      name: 'v',
      as: "SELECT id, dictGet('users', 'name', id) AS n, dictHas('users', id) AS h FROM t",
    })
    const live = { query: "SELECT id, dictGet('app.users', 'name', id) AS n, dictHas('app.users', id) AS h FROM app.t" }
    expect(compareViewShape(expected, live, 'app', canonicalizer)).toEqual([])
    const elsewhere = { query: "SELECT id, dictGet('other.users', 'name', id) AS n, dictHas('app.users', id) AS h FROM t" }
    expect(compareViewShape(expected, elsewhere, 'app', canonicalizer)).toMatchObject([{ code: 'query_mismatch' }])
  })
})

describe('@chkit/cli drift comparer on what ClickHouse stores (#466)', () => {
  test('compares a column type in the spacing ClickHouse stores, quotes as written', () => {
    const pairs: Array<[string, string]> = [
      ['Decimal(10,2)', 'Decimal(10, 2)'],
      ["DateTime64(3,'UTC')", "DateTime64(3, 'UTC')"],
      ['Map(String,UInt64)', 'Map(String, UInt64)'],
      ['Tuple(a UInt8,b String)', 'Tuple(a UInt8, b String)'],
      ["Enum8('a'=1,'b'=2)", "Enum8('a' = 1, 'b' = 2)"],
    ]
    for (const [declared, stored] of pairs) {
      expect(compareColumn({ name: 'value', type: declared }, { name: 'value', type: stored })).toBeNull()
    }
    expect(compareColumn({ name: 'value', type: 'Decimal(10,2)', nullable: true }, { name: 'value', type: 'Decimal(10, 2)', nullable: true })).toBeNull()
    expect(compareColumn({ name: 'value', type: "Enum8('a b'=1)" }, { name: 'value', type: "Enum8('a  b' = 1)" })?.changedColumns).toEqual(['value'])
  })

  test('compares a literal default by value, as generate does', () => {
    const same: Array<[ColumnDefinition['default'], string]> = [
      [1e21, '1e21'],
      // ClickHouse stores `9007199254740993.` as the Float64 it reads.
      [{ expression: '9007199254740993.' }, '9007199254740992.'],
      [2.0, '2.'],
      ["it's", "'it\\'s'"],
      // The `)` inside the heredoc is text, so the outer pair still wraps it (#587).
      [{ expression: '($$a)$$)' }, "'a)'"],
    ]
    for (const [declared, stored] of same) {
      expect(compareColumn({ name: 'value', type: 'Float64', default: declared }, { name: 'value', type: 'Float64', default: stored })).toBeNull()
    }
    const changed: Array<[ColumnDefinition['default'], string]> = [
      [{ expression: '18446744073709551615' }, '18446744073709551614'],
      ['e', "'\\e'"],
    ]
    for (const [declared, stored] of changed) {
      expect(compareColumn({ name: 'value', type: 'String', default: declared }, { name: 'value', type: 'String', default: stored })?.changedColumns).toEqual(['value'])
    }
  })

  test('takes a live table without index_granularity as the configured server default', () => {
    const expected = table({
      database: 'app', name: 'events', engine: 'MergeTree()', orderBy: ['id'],
      columns: [{ name: 'id', type: 'UInt64' }],
      settings: { index_granularity: 4096 },
    })
    const actual = { engine: 'MergeTree()', orderBy: '(id)', primaryKey: '(id)', columns: [{ name: 'id', type: 'UInt64' }], settings: {}, indexes: [], projections: [] }
    expect(compareTableShape(expected, actual, undefined, 4096)).toBeNull()
    expect(compareTableShape(expected, actual)?.settingDiffs).toEqual(['index_granularity'])
  })
})

describe('@chkit/cli drift: text index expressions as ClickHouse stores them', () => {
  // Stand-in for ClickHouse's formatter on the fragments under test. The real
  // formatter runs over test/fixtures/text-index-expressions.json in
  // text-index.e2e.test.ts.
  const formatted = new Map([
    ["if(NOT a AND b, s, '')", "if((NOT a) AND b, s, '')"],
    ["if((NOT a) AND b, s, '')", "if((NOT a) AND b, s, '')"],
  ])
  const canonicalizer: SqlCanonicalizer = {
    expression: (fragment) => formatted.get(fragment) ?? null,
    query: () => null,
  }
  const columns: ColumnDefinition[] = [
    { name: 'id', type: 'UInt64' },
    { name: 's', type: 'String' },
    { name: 'a', type: 'UInt8' },
    { name: 'b', type: 'UInt8' },
  ]
  const textIndex = (expression: string, tokenizer = 'splitByNonAlpha') => ({
    name: 'idx',
    type: 'text' as const,
    expression,
    tokenizer,
  })
  const expected = (expression: string, tokenizer?: string) =>
    table({
      database: 'app',
      name: 'docs',
      engine: 'MergeTree()',
      columns,
      primaryKey: ['id'],
      orderBy: ['id'],
      indexes: [textIndex(expression, tokenizer)],
    })
  // What ClickHouse stores: ObsessionDB keeps the outer parentheses (#512).
  const actual = (expression: string) => ({
    engine: 'MergeTree()',
    primaryKey: '(id)',
    orderBy: '(id)',
    columns,
    settings: {},
    indexes: [{ ...textIndex(expression), granularity: 100000000 }],
    projections: [],
  })

  test('the text index expression reaches the canonicalizer, outer parentheses peeled', () => {
    const { expressions } = collectTableSqlFragments(
      expected("if(NOT a AND b, s, '')"),
      actual("(if((NOT a) AND b, s, ''))"),
    )
    expect(expressions).toContain("if(NOT a AND b, s, '')")
    expect(expressions).toContain("if((NOT a) AND b, s, '')")
  })

  test('the spaces inside a string literal reach the canonicalizer intact', () => {
    const { expressions } = collectTableSqlFragments(
      expected("concat(s,  '  ')"),
      actual("concat(s, '  ')"),
    )
    expect(expressions).toContain("concat(s, '  ')")
  })

  test('NOT a AND b reads clean against the parentheses ClickHouse adds', () => {
    const live = actual("(if((NOT a) AND b, s, ''))")
    expect(compareTableShape(expected("if(NOT a AND b, s, '')"), live)?.indexDiffs).toEqual(['idx'])
    expect(compareTableShape(expected("if(NOT a AND b, s, '')"), live, canonicalizer)).toBeNull()
  })

  test('a different tokenizer still drifts when the expressions canonicalize equal', () => {
    const detail = compareTableShape(
      expected("if(NOT a AND b, s, '')", "splitByString([' '])"),
      actual("if((NOT a) AND b, s, '')"),
      canonicalizer,
    )
    expect(detail?.indexDiffs).toEqual(['idx'])
  })
})
