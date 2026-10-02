import { describe, expect, test } from 'bun:test'

import { serializeSnapshot } from '@chkit/codegen'
import {
  canonicalizeDefinitions,
  createSnapshot,
  dictionary,
  materializedView,
  table,
  view,
  type SchemaDefinition,
  type Snapshot,
} from '@chkit/core'

import { diffSnapshotDefinitions, parseSnapshotDocument } from '../../runtime/snapshot-document.js'

const GENERATED_AT = '2026-01-02T03:04:05.678Z'

const usersTable = table({
  database: 'app',
  name: 'users',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'email', type: 'String' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})

const eventsTable = table({
  database: 'app',
  name: 'events',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'source', type: 'String' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})

const usersView = view({ database: 'app', name: 'users_view', as: 'SELECT id FROM app.users' })

function snapshotText(definitions: SchemaDefinition[], generatedAt = GENERATED_AT): string {
  const snapshot: Snapshot = { version: 1, generatedAt, definitions: canonicalizeDefinitions(definitions) }
  return serializeSnapshot(snapshot)
}

/** Wrap the `generatedAt` line in git conflict markers, as two branches that each ran `generate` produce. */
function conflictOnGeneratedAt(text: string, markers: { open: string; close: string; separator: string }): string {
  return text
    .split('\n')
    .flatMap((line) =>
      line.includes('"generatedAt"')
        ? [markers.open, line, markers.separator, '  "generatedAt": "2026-01-01T00:00:00.000Z",', markers.close]
        : [line],
    )
    .join('\n')
}

function expectParsed(raw: string): Snapshot {
  const parsed = parseSnapshotDocument(raw)
  if (parsed.status !== 'ok') throw new Error(`expected a readable snapshot, got ${parsed.reason}`)
  return parsed.snapshot
}

describe('parseSnapshotDocument', () => {
  test('reads a snapshot written by generate and returns canonical definitions', () => {
    const snapshot = expectParsed(snapshotText([usersView, usersTable]))

    expect(snapshot.generatedAt).toBe(GENERATED_AT)
    expect(snapshot.definitions).toEqual(canonicalizeDefinitions([usersTable, usersView]))
    expect(snapshot.definitions.map((definition) => definition.kind)).toEqual(['table', 'view'])
  })

  test('canonicalizes entries that an older chkit stored differently', () => {
    const raw = JSON.stringify({
      version: 1,
      generatedAt: GENERATED_AT,
      definitions: [{ kind: 'view', database: 'app', name: 'v', as: 'SELECT  id\n   FROM app.users' }],
    })

    const snapshot = expectParsed(raw)

    expect(snapshot.definitions).toEqual(canonicalizeDefinitions([view({ database: 'app', name: 'v', as: 'SELECT id FROM app.users' })]))
  })

  test('defaults missing fields like before', () => {
    expect(parseSnapshotDocument('{}')).toEqual({
      status: 'ok',
      snapshot: { version: 1, generatedAt: '', definitions: [] },
    })
  })

  test('reports an empty file', () => {
    expect(parseSnapshotDocument('')).toEqual({ status: 'unreadable', reason: 'empty' })
    expect(parseSnapshotDocument('  \n')).toEqual({ status: 'unreadable', reason: 'empty' })
  })

  test('detects git conflict markers around the generatedAt line', () => {
    const raw = conflictOnGeneratedAt(snapshotText([usersTable]), {
      open: '<<<<<<< HEAD',
      separator: '=======',
      close: '>>>>>>> feature',
    })

    expect(parseSnapshotDocument(raw)).toEqual({ status: 'unreadable', reason: 'conflict_markers' })
  })

  test('detects conflict markers that split a definition between the two sides', () => {
    const raw = [
      '{',
      '  "version": 1,',
      `  "generatedAt": "${GENERATED_AT}",`,
      '  "definitions": [',
      '    {',
      '      "database": "app",',
      '<<<<<<< HEAD',
      '      "name": "v_m1",',
      '      "as": "SELECT 1",',
      '=======',
      '      "name": "v_m2",',
      '      "as": "SELECT 2",',
      '>>>>>>> 06bdb86 (B)',
      '      "kind": "view"',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n')

    expect(parseSnapshotDocument(raw)).toEqual({ status: 'unreadable', reason: 'conflict_markers' })
  })

  test('detects diff3 markers, longer markers and CRLF line endings', () => {
    const diff3 = conflictOnGeneratedAt(snapshotText([usersTable]), {
      open: '<<<<<<< HEAD',
      separator: `||||||| base\n  "generatedAt": "2025-12-31T00:00:00.000Z",\n=======`,
      close: '>>>>>>> feature',
    })
    const longMarkersWithCrlf = conflictOnGeneratedAt(snapshotText([usersTable]), {
      open: '<<<<<<<<<< ours',
      separator: '==========',
      close: '>>>>>>>>>> theirs',
    }).replaceAll('\n', '\r\n')

    expect(parseSnapshotDocument(diff3)).toEqual({ status: 'unreadable', reason: 'conflict_markers' })
    expect(parseSnapshotDocument(longMarkersWithCrlf)).toEqual({ status: 'unreadable', reason: 'conflict_markers' })
  })

  test('reports other unparseable text as invalid JSON', () => {
    expect(parseSnapshotDocument('{ "version": 1,')).toEqual({ status: 'unreadable', reason: 'invalid_json' })
    expect(parseSnapshotDocument('{ "version": 1 } <<<<<<< HEAD')).toEqual({
      status: 'unreadable',
      reason: 'invalid_json',
    })
    expect(parseSnapshotDocument('{\n======= x\n}')).toEqual({ status: 'unreadable', reason: 'invalid_json' })
  })

  test('never reads marker-like text inside a valid snapshot as a conflict', () => {
    const markerView = view({
      database: 'app',
      name: 'markers',
      as: "SELECT '=======' AS a, '<<<<<<< HEAD' AS b, '>>>>>>> feature' AS c",
    })

    const snapshot = expectParsed(snapshotText([markerView]))

    expect(snapshot.definitions).toEqual(canonicalizeDefinitions([markerView]))
  })
})

describe('diffSnapshotDefinitions', () => {
  test('reports no differences for identical definitions', () => {
    const definitions = canonicalizeDefinitions([usersTable, eventsTable, usersView])

    expect(diffSnapshotDefinitions(definitions, definitions)).toEqual({ added: [], removed: [], changed: [] })
  })

  test('lists added, removed and changed keys in canonical order', () => {
    const otherView = view({ database: 'app', name: 'events_view', as: 'SELECT id FROM app.events' })
    const usersWithCreatedAt = table({
      ...usersTable,
      columns: [...usersTable.columns, { name: 'created_at', type: 'DateTime' }],
    })
    const previous = canonicalizeDefinitions([usersTable, eventsTable, usersView])
    const next = canonicalizeDefinitions([usersWithCreatedAt, usersView, otherView])

    expect(diffSnapshotDefinitions(previous, next)).toEqual({
      added: ['view:app.events_view'],
      removed: ['table:app.events'],
      changed: ['table:app.users'],
    })
  })

  test('ignores object key order and keys holding undefined', () => {
    const viewA = canonicalizeDefinitions([{ database: 'app', name: 'v', as: 'SELECT 1', kind: 'view' }])
    const viewB = canonicalizeDefinitions([{ kind: 'view', as: 'SELECT 1', name: 'v', database: 'app', comment: undefined }])
    const tableA = canonicalizeDefinitions([usersTable])
    const tableB = canonicalizeDefinitions([
      table({
        orderBy: ['id'],
        primaryKey: ['id'],
        engine: 'MergeTree()',
        columns: [
          { type: 'UInt64', name: 'id' },
          { type: 'String', name: 'email' },
        ],
        name: 'users',
        database: 'app',
      }),
    ])

    expect(diffSnapshotDefinitions(viewA, viewB)).toEqual({ added: [], removed: [], changed: [] })
    expect(diffSnapshotDefinitions(tableA, tableB)).toEqual({ added: [], removed: [], changed: [] })
  })

  test('treats a different column order as a change', () => {
    const reordered = table({ ...usersTable, columns: [...usersTable.columns].reverse() })

    expect(
      diffSnapshotDefinitions(canonicalizeDefinitions([usersTable]), canonicalizeDefinitions([reordered])),
    ).toEqual({ added: [], removed: [], changed: ['table:app.users'] })
  })

  test('finds no differences after a round trip through the written file', () => {
    const definitions: SchemaDefinition[] = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64', codec: [{ kind: 'Delta', size: 8 }, { kind: 'ZSTD', level: 3 }] },
          { name: 'ts', type: 'DateTime64(3)', default: 'fn:now64(3)', comment: ' created ' },
          { name: 'source', type: 'LowCardinality(String)', nullable: true },
          { name: 'body', type: 'String' },
        ],
        engine: 'ReplacingMergeTree(ts)',
        primaryKey: ['id'],
        orderBy: ['id', 'ts'],
        partitionBy: 'toYYYYMM(ts)',
        ttl: 'toDateTime(ts) + INTERVAL 30 DAY',
        settings: { index_granularity: 8192, allow_nullable_key: 1 },
        indexes: [
          { name: 'idx_src', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
          { name: 'idx_body', expression: 'body', type: 'text', tokenizer: 'splitByNonAlpha' },
        ],
        projections: [{ name: 'p_ts', query: 'SELECT id, ts ORDER BY ts' }],
        comment: 'events table',
      }),
      view({ database: 'app', name: 'v_events', as: 'SELECT id\n  FROM   app.events', comment: 'v' }),
      materializedView({
        database: 'app',
        name: 'mv_refresh',
        to: { database: 'app', name: 'events' },
        as: 'SELECT id, ts, source, body FROM app.events',
        refresh: { every: '1 hours', dependsOn: [{ database: 'app', name: 'mv_other' }], settings: { b: 1, a: 2 } },
      }),
      dictionary({
        database: 'app',
        name: 'dict_src',
        attributes: [
          { name: 'id', type: 'UInt64' },
          { name: 'source', type: 'String', default: '' },
        ],
        primaryKey: ['id'],
        source: "CLICKHOUSE(TABLE 'events' DB 'app')",
        layout: 'HASHED()',
        lifetime: 'MIN 0 MAX 300',
      }),
    ]

    const reread = expectParsed(serializeSnapshot(createSnapshot(definitions)))

    expect(reread.definitions).toHaveLength(4)
    expect(diffSnapshotDefinitions(reread.definitions, canonicalizeDefinitions(definitions))).toEqual({
      added: [],
      removed: [],
      changed: [],
    })
  })
})
