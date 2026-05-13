import { describe, expect, test } from 'bun:test'

import {
  createClickHouseExecutor,
  createExecutorWithClient,
  createSessionClickHouseClient,
  createStatelessClickHouseExecutor,
  createStatelessClickHouseClient,
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

type InsertCall = {
  client: string
  table: string
  values: Array<Record<string, unknown>>
}

function createMockClient(name: string, calls: InsertCall[]) {
  return {
    async command() {
      return { query_id: `${name}-command` }
    },
    async query() {
      return {
        query_id: `${name}-query`,
        response_headers: {},
        async json() {
          return []
        },
      }
    },
    async insert(params: { table: string; values: Array<Record<string, unknown>> }) {
      calls.push({ client: name, table: params.table, values: params.values })
      return { query_id: `${name}-insert` }
    },
    async close() {},
  } as unknown as ReturnType<typeof createStatelessClickHouseClient>
}

describe('@chkit/clickhouse smoke', () => {
  test('creates executor with command/query methods', () => {
    const executor = createClickHouseExecutor({
      url: 'http://localhost:8123',
      database: 'default',
    })

    expect(typeof executor.command).toBe('function')
    expect(typeof executor.query).toBe('function')
    expect(typeof executor.listSchemaObjects).toBe('function')
  })

  test('creates stateless executor with command/query methods', () => {
    const executor = createStatelessClickHouseExecutor({
      url: 'http://localhost:8123',
      database: 'default',
    })

    expect(typeof executor.command).toBe('function')
    expect(typeof executor.query).toBe('function')
    expect(typeof executor.listSchemaObjects).toBe('function')
  })

  test('exposes stateless and session-bound client constructors', async () => {
    const config = {
      url: 'http://localhost:8123',
      database: 'default',
    }
    const stateless = createStatelessClickHouseClient(config)
    const session = createSessionClickHouseClient(config)

    expect(typeof stateless.query).toBe('function')
    expect(typeof session.query).toBe('function')

    await Promise.all([stateless.close(), session.close()])
  })

  test('uses compressed client for compressed inserts', async () => {
    const calls: InsertCall[] = []
    const executor = createExecutorWithClient(
      {
        url: 'http://localhost:8123',
        username: 'default',
        password: '',
        database: 'default',
        secure: false,
      },
      createMockClient('plain', calls),
      { createCompressedClient: () => createMockClient('compressed', calls) },
    )

    await executor.insert({ table: 'default.users', values: [{ id: 1 }], compressed: true })

    expect(calls).toEqual([
      { client: 'compressed', table: 'default.users', values: [{ id: 1 }] },
    ])
    await executor.close()
  })

  test('uses plain client when insert compression is false or omitted', async () => {
    const calls: InsertCall[] = []
    let compressedClientCreated = false
    const executor = createExecutorWithClient(
      {
        url: 'http://localhost:8123',
        username: 'default',
        password: '',
        database: 'default',
        secure: false,
      },
      createMockClient('plain', calls),
      {
        createCompressedClient: () => {
          compressedClientCreated = true
          return createMockClient('compressed', calls)
        },
      },
    )

    await executor.insert({ table: 'default.users', values: [{ id: 1 }] })
    await executor.insert({ table: 'default.users', values: [{ id: 2 }], compressed: false })

    expect(compressedClientCreated).toBe(false)
    expect(calls).toEqual([
      { client: 'plain', table: 'default.users', values: [{ id: 1 }] },
      { client: 'plain', table: 'default.users', values: [{ id: 2 }] },
    ])
    await executor.close()
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
