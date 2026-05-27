import { describe, expect, test } from 'bun:test'

import {
  assertStreamedQuerySucceeded,
  ClickHouseStreamedException,
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

type MockClientOptions = {
  commandHeaders?: Record<string, string>
  queryHeaders?: Record<string, string>
  insertHeaders?: Record<string, string>
}

function createMockClient(
  name: string,
  calls: InsertCall[],
  opts: MockClientOptions = {},
) {
  return {
    async command() {
      return {
        query_id: `${name}-command`,
        response_headers: opts.commandHeaders ?? {},
      }
    },
    async query() {
      return {
        query_id: `${name}-query`,
        response_headers: opts.queryHeaders ?? {},
        async json() {
          return []
        },
      }
    },
    async insert(params: { table: string; values: Array<Record<string, unknown>> }) {
      calls.push({ client: name, table: params.table, values: params.values })
      return {
        query_id: `${name}-insert`,
        response_headers: opts.insertHeaders ?? {},
      }
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

  test('assertStreamedQuerySucceeded throws on non-zero exception code header', () => {
    const call = () =>
      assertStreamedQuerySucceeded({
        response_headers: {
          'x-clickhouse-exception-code': '241',
          'x-clickhouse-exception-tag': 'tagvalue',
        },
        query_id: 'qid-1',
        sql: 'INSERT INTO t SELECT 1',
      })

    expect(call).toThrow(ClickHouseStreamedException)
    expect(call).toThrow(/241/)
    expect(call).toThrow(/qid-1/)
    expect(call).toThrow(/tagvalue/)
  })

  test('assertStreamedQuerySucceeded carries structured fields', () => {
    let caught: unknown
    try {
      assertStreamedQuerySucceeded({
        response_headers: {
          'x-clickhouse-exception-code': '241',
          'x-clickhouse-exception-tag': 'tagvalue',
        },
        query_id: 'qid-1',
        sql: 'INSERT INTO t SELECT 1',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClickHouseStreamedException)
    const err = caught as ClickHouseStreamedException
    expect(err.code).toBe('241')
    expect(err.exceptionTag).toBe('tagvalue')
    expect(err.query_id).toBe('qid-1')
  })

  test("assertStreamedQuerySucceeded does not throw when code is '0'", () => {
    assertStreamedQuerySucceeded({
      response_headers: { 'x-clickhouse-exception-code': '0' },
      query_id: 'qid',
      sql: undefined,
    })
  })

  test('assertStreamedQuerySucceeded does not throw on missing header', () => {
    assertStreamedQuerySucceeded({
      response_headers: { 'content-type': 'text/plain' },
      query_id: 'qid',
      sql: undefined,
    })
  })

  test('assertStreamedQuerySucceeded does not throw on undefined response_headers', () => {
    assertStreamedQuerySucceeded({
      response_headers: undefined,
      query_id: 'qid',
      sql: undefined,
    })
  })

  test('executor.command throws when streamed exception is reported via headers', async () => {
    const calls: InsertCall[] = []
    const executor = createExecutorWithClient(
      {
        url: 'http://localhost:8123',
        username: 'default',
        password: '',
        database: 'default',
        secure: false,
      },
      createMockClient('plain', calls, {
        commandHeaders: {
          'x-clickhouse-exception-code': '241',
          'x-clickhouse-exception-tag': 'memlim',
        },
      }),
    )

    await expect(executor.command('INSERT INTO hits SELECT 1')).rejects.toBeInstanceOf(
      ClickHouseStreamedException,
    )
    await expect(executor.command('INSERT INTO hits SELECT 1')).rejects.toThrow(/241/)
    await executor.close()
  })

  test('executor.query throws when streamed exception is reported via headers', async () => {
    const calls: InsertCall[] = []
    const executor = createExecutorWithClient(
      {
        url: 'http://localhost:8123',
        username: 'default',
        password: '',
        database: 'default',
        secure: false,
      },
      createMockClient('plain', calls, {
        queryHeaders: {
          'x-clickhouse-exception-code': '159',
        },
      }),
    )

    await expect(executor.query('SELECT 1')).rejects.toBeInstanceOf(
      ClickHouseStreamedException,
    )
    await executor.close()
  })

  test('executor.query checks exception headers before decoding the response body', async () => {
    // With send_progress_in_http_headers=1, ClickHouse can return HTTP 200,
    // set x-clickhouse-exception-code, then append a plain-text exception
    // block to the body. If we decoded the body first, JSON parsing would
    // throw before the header check ran and the streamed exception would be
    // silently bypassed.
    let jsonCalled = false
    const failingJsonClient = {
      async query() {
        return {
          query_id: 'q-1',
          response_headers: {
            'x-clickhouse-exception-code': '241',
            'x-clickhouse-exception-tag': 'memlim',
          },
          async json() {
            jsonCalled = true
            throw new Error('invalid JSON: trailing exception block')
          },
        }
      },
      async command() {
        return { query_id: 'c-1', response_headers: {} }
      },
      async insert() {
        return { query_id: 'i-1', response_headers: {} }
      },
      async close() {},
    } as unknown as ReturnType<typeof createStatelessClickHouseClient>

    const executor = createExecutorWithClient(
      {
        url: 'http://localhost:8123',
        username: 'default',
        password: '',
        database: 'default',
        secure: false,
      },
      failingJsonClient,
    )

    await expect(executor.query('SELECT 1')).rejects.toBeInstanceOf(
      ClickHouseStreamedException,
    )
    expect(jsonCalled).toBe(false)
    await executor.close()
  })

  test('executor.insert throws when streamed exception is reported via headers', async () => {
    const calls: InsertCall[] = []
    const executor = createExecutorWithClient(
      {
        url: 'http://localhost:8123',
        username: 'default',
        password: '',
        database: 'default',
        secure: false,
      },
      createMockClient('plain', calls, {
        insertHeaders: {
          'x-clickhouse-exception-code': '60',
        },
      }),
    )

    await expect(
      executor.insert({ table: 'hits', values: [{ id: 1 }] }),
    ).rejects.toBeInstanceOf(ClickHouseStreamedException)
    await executor.close()
  })

  test('executor.command succeeds when response_headers carry no exception code', async () => {
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
    )

    await executor.command('CREATE TABLE noop (x UInt64) ENGINE = Memory')
    await executor.close()
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
