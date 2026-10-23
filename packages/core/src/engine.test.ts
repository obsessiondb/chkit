import { describe, expect, test } from 'bun:test'
import {
  canonicalizeDefinitions,
  normalizeEngine,
  planDiff,
  supportsSortOrder,
  table,
  toCreateSQL,
  validateDefinitions,
} from './index.js'

const columns = [
  { name: 'id', type: 'UInt64' },
  { name: 'ts', type: 'DateTime' },
]

const local = () =>
  table({
    database: 'app',
    name: 'events_local',
    engine: 'MergeTree()',
    columns,
    orderBy: ['id'],
    partitionBy: 'toYYYYMM(ts)',
  })

const distributed = (engine: `Distributed(${string})` = 'Distributed(cluster, app, events_local, rand())') =>
  table({ database: 'app', name: 'events', engine, columns })

describe('engines without sort order', () => {
  test('renders a Distributed table without PARTITION BY, PRIMARY KEY or ORDER BY', () => {
    expect(toCreateSQL(distributed())).toBe(
      'CREATE TABLE IF NOT EXISTS app.events\n(\n  `id` UInt64,\n  `ts` DateTime\n) ENGINE = Distributed(cluster, app, events_local, rand())\n;'
    )
  })

  test('renders Memory, Null, Log and Merge tables without key clauses', () => {
    for (const engine of ['Memory', 'Null', 'Log', "Merge(app, '^events')"] as const) {
      const sql = toCreateSQL(table({ database: 'app', name: 't', engine, columns }))
      expect(sql).not.toContain('PRIMARY KEY')
      expect(sql).not.toContain('ORDER BY')
    }
  })

  test('keeps PRIMARY KEY and ORDER BY on every MergeTree-family engine', () => {
    for (const engine of ['MergeTree()', 'ReplicatedMergeTree', 'SharedReplacingMergeTree()']) {
      expect(toCreateSQL({ ...local(), engine })).toContain(
        'PARTITION BY toYYYYMM(ts)\nPRIMARY KEY (`id`)\nORDER BY (`id`)'
      )
    }
    expect(toCreateSQL({ ...local(), primaryKey: [], orderBy: [] })).toContain('PRIMARY KEY ()\nORDER BY ()')
  })

  test('renders only the keys a non-MergeTree sort-order engine sets', () => {
    const sql = toCreateSQL(
      table({ database: 'app', name: 'kv', engine: 'EmbeddedRocksDB', columns, primaryKey: ['id'], orderBy: [] })
    )
    expect(sql).toContain('PRIMARY KEY (`id`)')
    expect(sql).not.toContain('ORDER BY')
  })

  test('classifies engines by ClickHouse sort-order support', () => {
    for (const engine of ['MergeTree', 'ReplicatedAggregatingMergeTree(x)', 'SharedMergeTree', 'EmbeddedRocksDB', 'S3(url)', 'KeeperMap(path)']) {
      expect(supportsSortOrder(engine)).toBe(true)
    }
    for (const engine of ['Distributed(c, d, t)', 'Memory', 'Null()', 'Buffer(d, t, 1, 1, 1, 1, 1, 1, 1)', 'Kafka', 'Merge(d, t)', 'Log']) {
      expect(supportsSortOrder(engine)).toBe(false)
    }
  })

  test('rejects keys on an engine that does not support them', () => {
    const issues = validateDefinitions([
      { ...distributed(), orderBy: ['id'], primaryKey: ['id'] },
      table({ database: 'app', name: 'mem', engine: 'Memory', columns, orderBy: [], partitionBy: 'toYYYYMM(ts)' }),
    ])
    expect(issues.map((issue) => [issue.code, issue.message])).toEqual([
      [
        'engine_unsupported_clause',
        'Table app.events sets primaryKey, orderBy, but engine Distributed does not support PARTITION BY, PRIMARY KEY or ORDER BY (only MergeTree-family engines and a few others such as EmbeddedRocksDB, KeeperMap and S3 do). Remove them. Define the keys on the local table the Distributed table reads from.',
      ],
      [
        'engine_unsupported_clause',
        'Table app.mem sets partitionBy, but engine Memory does not support PARTITION BY, PRIMARY KEY or ORDER BY (only MergeTree-family engines and a few others such as EmbeddedRocksDB, KeeperMap and S3 do). Remove it.',
      ],
    ])
    expect(() => toCreateSQL({ ...distributed(), orderBy: ['id'] })).toThrow('Schema validation failed')
  })

  test('normalizes Distributed identifier arguments to the literals ClickHouse stores', () => {
    expect(normalizeEngine('Distributed(cluster, app, events_local, rand())')).toBe(
      "Distributed('cluster', 'app', 'events_local', rand())"
    )
    expect(normalizeEngine("Distributed('cluster', `app`, \"events_local\")")).toBe(
      "Distributed('cluster', 'app', 'events_local')"
    )
    // Expressions are not evaluated; currentDatabase() reads back as a literal.
    expect(normalizeEngine('Distributed(cluster, currentDatabase(), t, cityHash64(id))')).toBe(
      "Distributed('cluster', currentDatabase(), 't', cityHash64(id))"
    )
  })
})

describe('Distributed table migrations', () => {
  test('creates the local and Distributed tables as separate operations', () => {
    const plan = planDiff([], canonicalizeDefinitions([local(), distributed()]))
    expect(plan.operations.map((op) => [op.type, op.key])).toEqual([
      ['create_database', 'database:app'],
      ['create_table', 'table:app.events'],
      ['create_table', 'table:app.events_local'],
    ])
  })

  test('adds a column to the local and the Distributed table with one ALTER each', () => {
    const before = canonicalizeDefinitions([local(), distributed()])
    const added = [...columns, { name: 'country', type: 'String' }]
    const after = canonicalizeDefinitions([{ ...local(), columns: added }, { ...distributed(), columns: added }])
    expect(planDiff(before, after).operations.map((op) => [op.risk, op.sql])).toEqual([
      ['safe', 'ALTER TABLE app.events_local ADD COLUMN IF NOT EXISTS `country` String;'],
      ['safe', 'ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `country` String;'],
    ])
  })

  test('recreates a Distributed table whose engine arguments change, at caution risk', () => {
    const before = canonicalizeDefinitions([distributed()])
    const after = canonicalizeDefinitions([distributed('Distributed(cluster, app, events_local, cityHash64(id))')])
    expect(planDiff(before, after).operations.map((op) => [op.type, op.risk])).toEqual([
      ['drop_table', 'caution'],
      ['create_table', 'safe'],
    ])
  })

  test('keeps the recreate dangerous when flush_on_detach = 0 drops queued inserts', () => {
    const withSettings = (engine?: `Distributed(${string})`) => ({ ...distributed(engine), settings: { flush_on_detach: 0 } })
    const before = canonicalizeDefinitions([withSettings()])
    const after = canonicalizeDefinitions([withSettings('Distributed(cluster, app, events_local, cityHash64(id))')])
    expect(planDiff(before, after).operations.map((op) => [op.type, op.risk])).toEqual([
      ['drop_table', 'danger'],
      ['create_table', 'safe'],
    ])
  })

  test('does not recreate when only the identifier quoting changes', () => {
    const before = canonicalizeDefinitions([distributed()])
    const after = canonicalizeDefinitions([distributed("Distributed('cluster', 'app', 'events_local', rand())")])
    expect(planDiff(before, after).operations).toEqual([])
  })
})
