import { describe, expect, test } from 'bun:test'

import {
  createClickHouseExecutor,
  inferSchemaKindFromEngine,
  parseEngineFromCreateTableQuery,
  parseOrderByFromCreateTableQuery,
  parsePartitionByFromCreateTableQuery,
  parsePrimaryKeyFromCreateTableQuery,
  parseProjectionsFromCreateTableQuery,
  parseSettingsFromCreateTableQuery,
  parseTTLFromCreateTableQuery,
  parseUniqueKeyFromCreateTableQuery,
} from './index'

describe('@chkit/clickhouse smoke', () => {
  test('creates executor with execute/query methods', () => {
    const executor = createClickHouseExecutor({
      url: 'http://localhost:8123',
      database: 'default',
    })

    expect(typeof executor.execute).toBe('function')
    expect(typeof executor.query).toBe('function')
    expect(typeof executor.listSchemaObjects).toBe('function')
  })

  test('infers schema kind from ClickHouse engine', () => {
    expect(inferSchemaKindFromEngine('MergeTree')).toBe('table')
    expect(inferSchemaKindFromEngine('View')).toBe('view')
    expect(inferSchemaKindFromEngine('MaterializedView')).toBe('materialized_view')
    expect(inferSchemaKindFromEngine('Dictionary')).toBeNull()
  })

  test('parses settings and ttl from create table query', () => {
    const query = `CREATE TABLE app.events
(
  id UInt64
)
ENGINE = MergeTree
ORDER BY id
TTL toDateTime(id) + INTERVAL 1 DAY
SETTINGS index_granularity = 8192, min_bytes_for_wide_part = 10485760;`

    expect(parseTTLFromCreateTableQuery(query)).toBe('toDateTime(id) + INTERVAL 1 DAY')
    expect(parseSettingsFromCreateTableQuery(query)).toEqual({
      index_granularity: '8192',
      min_bytes_for_wide_part: '10485760',
    })
  })

  test('parses engine/orderBy/primaryKey/uniqueKey/partitionBy from create table query', () => {
    const query = `CREATE TABLE app.events
(
  id UInt64,
  ts DateTime
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
PRIMARY KEY (id)
ORDER BY (id, ts)
UNIQUE KEY (id, ts)
TTL ts + INTERVAL 7 DAY
SETTINGS index_granularity = 8192;`

    expect(parseEngineFromCreateTableQuery(query)).toBe('MergeTree()')
    expect(parsePartitionByFromCreateTableQuery(query)).toBe('toYYYYMM(ts)')
    expect(parsePrimaryKeyFromCreateTableQuery(query)).toBe('(id)')
    expect(parseOrderByFromCreateTableQuery(query)).toBe('(id, ts)')
    expect(parseUniqueKeyFromCreateTableQuery(query)).toBe('(id, ts)')
  })

  test('parses engine without leaking ORDER BY/SETTINGS clauses on single-line queries', () => {
    const query =
      'CREATE TABLE app.events (id UInt64) ENGINE = MergeTree() ORDER BY id SETTINGS index_granularity = 8192;'

    expect(parseEngineFromCreateTableQuery(query)).toBe('MergeTree()')
  })

  test('parses projection definitions from create table query', () => {
    const query = `CREATE TABLE app.events
(
  id UInt64,
  source String,
  PROJECTION p_by_source (SELECT source, count() GROUP BY source),
  PROJECTION \`p_recent\` (SELECT id ORDER BY id LIMIT 10)
)
ENGINE = MergeTree()
ORDER BY id;`

    expect(parseProjectionsFromCreateTableQuery(query)).toEqual([
      {
        name: 'p_by_source',
        query: 'SELECT source, count() GROUP BY source',
      },
      {
        name: 'p_recent',
        query: 'SELECT id ORDER BY id LIMIT 10',
      },
    ])
  })
})
