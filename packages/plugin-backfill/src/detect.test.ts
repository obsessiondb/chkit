import { describe, expect, test } from 'bun:test'

import { table, materializedView } from '@chkit/core'
import type { SchemaDefinition } from '@chkit/core'

import { detectCandidatesFromTable, extractSchemaTimeColumn, findMvForTarget, findTableForTarget } from './detect.js'

describe('@chkit/plugin-backfill detect', () => {
  test('finds DateTime column in ORDER BY as top candidate', () => {
    const def = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'session_date', type: 'DateTime64', },
        { name: 'data', type: 'String' },
      ],
      engine: 'MergeTree',
      primaryKey: ['session_date'],
      orderBy: ['session_date', 'id'],
    })

    const candidates = detectCandidatesFromTable(def)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.name).toBe('session_date')
    expect(candidates[0]!.source).toBe('order_by')
  })

  test('finds common time column names via column scan', () => {
    const def = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'created_at', type: 'DateTime' },
        { name: 'data', type: 'String' },
      ],
      engine: 'MergeTree',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const candidates = detectCandidatesFromTable(def)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.name).toBe('created_at')
    expect(candidates[0]!.source).toBe('column_scan')
  })

  test('ranks ORDER BY candidates before column scan candidates', () => {
    const def = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ingested_at', type: 'DateTime64' },
        { name: 'event_time', type: 'DateTime' },
      ],
      engine: 'MergeTree',
      primaryKey: ['event_time'],
      orderBy: ['event_time', 'id'],
    })

    const candidates = detectCandidatesFromTable(def)

    expect(candidates).toHaveLength(2)
    expect(candidates[0]!.name).toBe('event_time')
    expect(candidates[0]!.source).toBe('order_by')
    expect(candidates[1]!.name).toBe('ingested_at')
    expect(candidates[1]!.source).toBe('column_scan')
  })

  test('returns empty candidates when no DateTime columns exist', () => {
    const def = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'data', type: 'String' },
      ],
      engine: 'MergeTree',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const candidates = detectCandidatesFromTable(def)

    expect(candidates).toHaveLength(0)
  })

  test('handles DateTime64 with parameters', () => {
    const def = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'created_at', type: "DateTime64(3, 'UTC')" },
      ],
      engine: 'MergeTree',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const candidates = detectCandidatesFromTable(def)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.name).toBe('created_at')
  })

  test('does not duplicate column appearing in both ORDER BY and common names', () => {
    const def = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'event_time', type: 'DateTime' },
      ],
      engine: 'MergeTree',
      primaryKey: ['event_time'],
      orderBy: ['event_time', 'id'],
    })

    const candidates = detectCandidatesFromTable(def)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.name).toBe('event_time')
    expect(candidates[0]!.source).toBe('order_by')
  })

  test('findTableForTarget resolves direct table match', () => {
    const definitions: SchemaDefinition[] = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const found = findTableForTarget(definitions, 'app', 'events')

    expect(found).toBeDefined()
    expect(found!.name).toBe('events')
  })

  test('findTableForTarget resolves MV target to source table', () => {
    const sourceTable = table({
      database: 'app',
      name: 'raw_events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'created_at', type: 'DateTime' },
      ],
      engine: 'MergeTree',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const mv = materializedView({
      database: 'app',
      name: 'events_mv',
      to: { database: 'app', name: 'events_agg' },
      as: 'SELECT * FROM app.raw_events',
    })

    const definitions: SchemaDefinition[] = [sourceTable, mv]
    const found = findTableForTarget(definitions, 'app', 'events_agg')

    expect(found).toBeDefined()
    expect(found!.name).toBe('raw_events')
  })

  test('findTableForTarget returns undefined when no match', () => {
    const definitions: SchemaDefinition[] = [
      table({
        database: 'app',
        name: 'users',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const found = findTableForTarget(definitions, 'app', 'events')

    expect(found).toBeUndefined()
  })

  test('extractSchemaTimeColumn reads plugins.backfill.timeColumn', () => {
    const def = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'event_time', type: 'DateTime' },
      ],
      engine: 'MergeTree',
      primaryKey: ['event_time'],
      orderBy: ['event_time', 'id'],
      plugins: { backfill: { timeColumn: 'event_time' } },
    })

    expect(extractSchemaTimeColumn(def)).toBe('event_time')
  })

  test('extractSchemaTimeColumn returns undefined when no plugins config', () => {
    const def = table({
      database: 'app',
      name: 'events',
      columns: [{ name: 'id', type: 'UInt64' }],
      engine: 'MergeTree',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    expect(extractSchemaTimeColumn(def)).toBeUndefined()
  })

  test('extractSchemaTimeColumn returns undefined when backfill config has no timeColumn', () => {
    const def = table({
      database: 'app',
      name: 'events',
      columns: [{ name: 'id', type: 'UInt64' }],
      engine: 'MergeTree',
      primaryKey: ['id'],
      orderBy: ['id'],
      plugins: { backfill: {} },
    })

    expect(extractSchemaTimeColumn(def)).toBeUndefined()
  })

  test('findMvForTarget returns MV matching target to.database and to.name', () => {
    const mv = materializedView({
      database: 'app',
      name: 'events_mv',
      to: { database: 'app', name: 'events_agg' },
      as: 'SELECT count() FROM app.events',
    })
    const definitions: SchemaDefinition[] = [
      table({
        database: 'app',
        name: 'events_agg',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
      mv,
    ]

    const found = findMvForTarget(definitions, 'app', 'events_agg')

    expect(found).toBeDefined()
    expect(found!.name).toBe('events_mv')
    expect(found!.as).toBe('SELECT count() FROM app.events')
  })

  test('findMvForTarget returns undefined when no MV targets the table', () => {
    const definitions: SchemaDefinition[] = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    expect(findMvForTarget(definitions, 'app', 'events')).toBeUndefined()
  })

  test('findMvForTarget returns first MV when multiple target the same table', () => {
    const mv1 = materializedView({
      database: 'app',
      name: 'hourly_mv',
      to: { database: 'app', name: 'events_agg' },
      as: 'SELECT toStartOfHour(ts) AS ts, count() AS c FROM app.events GROUP BY ts',
    })
    const mv2 = materializedView({
      database: 'app',
      name: 'daily_mv',
      to: { database: 'app', name: 'events_agg' },
      as: 'SELECT toStartOfDay(ts) AS ts, count() AS c FROM app.events GROUP BY ts',
    })
    const definitions: SchemaDefinition[] = [mv1, mv2]

    const found = findMvForTarget(definitions, 'app', 'events_agg')

    expect(found).toBeDefined()
    expect(found!.name).toBe('hourly_mv')
  })
})
