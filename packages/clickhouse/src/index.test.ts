import { describe, expect, test } from 'bun:test'

import {
  assertStreamedQuerySucceeded,
  ClickHouseStreamedException,
  createClickHouseExecutor,
  createExecutorWithClient,
  createSessionClickHouseClient,
  createStatelessClickHouseExecutor,
  createStatelessClickHouseClient,
  formatConnectionError,
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

  // Verbatim SHOW CREATE TABLE output from ClickHouse 26.3, including its own
  // pretty-printing of the SELECT body. Index-only projections used to be
  // dropped here, which is what made `chkit pull` lose them entirely.
  test('parses index-only projections alongside select projections', () => {
    const query = `CREATE TABLE default.address_counterparts
(
    \`sender\` String,
    \`receiver\` String,
    \`cnt\` UInt64,
    PROJECTION by_receiver INDEX (receiver, sender) TYPE basic,
    PROJECTION agg_by_sender
    (
        SELECT
            sender,
            sum(cnt)
        GROUP BY sender
    )
)
ENGINE = SharedMergeTree
ORDER BY (sender, receiver)
SETTINGS storage_policy = 's3', index_granularity = 8192`

    expect(parseProjectionsFromCreateTableQuery(query)).toEqual([
      { name: 'by_receiver', index: '(receiver, sender)', type: 'basic' },
      { name: 'agg_by_sender', query: 'SELECT sender, sum(cnt) GROUP BY sender' },
    ])
  })

  // ClickHouse drops the parens around a single-column index expression, so the
  // parser sees the bare form even when the table was created with `INDEX (b)`.
  test('parses a single-column index projection with a backticked name', () => {
    const query = `CREATE TABLE app.events
(
  \`a\` String,
  \`b\` String,
  PROJECTION \`p_one\` INDEX b TYPE basic
)
ENGINE = MergeTree
ORDER BY a`

    expect(parseProjectionsFromCreateTableQuery(query)).toEqual([
      { name: 'p_one', index: 'b', type: 'basic' },
    ])
  })

  // Regression for #190: a PROJECTION whose SELECT body contains ORDER BY sits
  // in the column list, before the table-level clauses. The parsers used to
  // match that inner ORDER BY and swallow the engine into orderBy/primaryKey.
  test('ignores clause keywords inside a projection SELECT body', () => {
    const query = `CREATE TABLE bi.price_history (\`day\` Date, \`csin\` String, \`min_price\` UInt32, \`_version\` UInt64 DEFAULT now64(), PROJECTION by_csin_day (SELECT csin, day, min_price ORDER BY csin, day)) ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/bi/price_history_new', '{replica}', _version) PARTITION BY toYYYYMM(day) ORDER BY (day, csin) TTL day + toIntervalYear(5) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild'`

    expect(parseEngineFromCreateTableQuery(query)).toBe(
      "ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/bi/price_history_new', '{replica}', _version)"
    )
    expect(parseOrderByFromCreateTableQuery(query)).toBe('(day, csin)')
    expect(parsePrimaryKeyFromCreateTableQuery(query)).toBeUndefined()
    expect(parsePartitionByFromCreateTableQuery(query)).toBe('toYYYYMM(day)')
    expect(parseTTLFromCreateTableQuery(query)).toBe('day + toIntervalYear(5)')
    expect(parseSettingsFromCreateTableQuery(query)).toEqual({
      index_granularity: '8192',
      deduplicate_merge_projection_mode: "'rebuild'",
    })
    expect(parseProjectionsFromCreateTableQuery(query)).toEqual([
      { name: 'by_csin_day', query: 'SELECT csin, day, min_price ORDER BY csin, day' },
    ])
  })

  // A column-level TTL lives in the column list too, and must not be mistaken
  // for the table-level TTL / SETTINGS.
  test('reads table-level TTL past a column-level TTL', () => {
    const query = `CREATE TABLE app.events (\`id\` UInt64, \`ts\` DateTime, \`tmp\` String TTL ts + toIntervalDay(1)) ENGINE = MergeTree ORDER BY id TTL ts + toIntervalYear(1) SETTINGS index_granularity = 8192`

    expect(parseTTLFromCreateTableQuery(query)).toBe('ts + toIntervalYear(1)')
    expect(parseOrderByFromCreateTableQuery(query)).toBe('id')
    expect(parseSettingsFromCreateTableQuery(query)).toEqual({ index_granularity: '8192' })
  })

  // Regression for #196: a backtick-quoted column name containing a paren used
  // to unbalance the body scan and truncate the parse, dropping the projection.
  test('handles a backtick column name containing a paren', () => {
    const query = `CREATE TABLE app.events (\`id\` UInt64, \`weird)name\` String, PROJECTION p INDEX id TYPE basic) ENGINE = MergeTree ORDER BY id`

    expect(parseProjectionsFromCreateTableQuery(query)).toEqual([
      { name: 'p', index: 'id', type: 'basic' },
    ])
    expect(parseOrderByFromCreateTableQuery(query)).toBe('id')
  })

  test('keeps backtick identifiers intact inside key clauses', () => {
    const query = `CREATE TABLE app.events (\`id\` UInt64, \`w)x\` String) ENGINE = MergeTree ORDER BY (\`w)x\`, id)`

    expect(parseOrderByFromCreateTableQuery(query)).toBe('(`w)x`, id)')
  })
})

describe('formatConnectionError', () => {
  // The full server blurb chkit must NOT leak (Cloud reset URL + on-disk paths).
  const rawAuthBlurb =
    'default: Authentication failed: password is incorrect, or there is no user with such name\n\n' +
    'If you use ClickHouse Cloud, the password can be reset at https://clickhouse.cloud/\n' +
    'The password for default user is typically located at /etc/clickhouse-server/users.d/default-password.xml\n'

  test('replaces a wrong-password error (code 194) with one clean line', () => {
    const error = Object.assign(new Error(rawAuthBlurb), { code: '194', type: 'REQUIRED_PASSWORD' })
    const message = formatConnectionError(error, 'https://db.example.com:443', 'default')
    expect(message).toBe(
      'Authentication failed for user "default" at https://db.example.com:443. Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD.',
    )
    expect(message).not.toContain('clickhouse.cloud')
    expect(message).not.toContain('/etc/clickhouse-server')
  })

  test('detects AUTHENTICATION_FAILED (code 516) by type', () => {
    const error = Object.assign(new Error('Authentication failed'), { type: 'AUTHENTICATION_FAILED' })
    expect(formatConnectionError(error, 'https://x', 'admin')).toBe(
      'Authentication failed for user "admin" at https://x. Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD.',
    )
  })

  test('detects auth failure by message alone (no code/type)', () => {
    const error = new Error('default: Authentication failed: password is incorrect')
    expect(formatConnectionError(error, 'https://x')).toBe(
      'Authentication failed for the configured user at https://x. Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD.',
    )
  })

  test('still formats network errors (regression: ECONNREFUSED path intact)', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    expect(formatConnectionError(error, 'https://x')).toBe(
      'Could not connect to ClickHouse at https://x (connection refused)',
    )
  })

  test('detects a host typo from the message when .code is stripped (#11)', () => {
    // Some @clickhouse/client / Node versions surface the failure only in the
    // message with no .code, so the bare-code match misses it and the raw
    // library string leaks.
    const error = new Error('getaddrinfo ENOTFOUND db.exampl-typo.com. Was there a typo in the url or port?')
    expect(formatConnectionError(error, 'https://db.exampl-typo.com:8443')).toBe(
      'Could not connect to ClickHouse at https://db.exampl-typo.com:8443 (host not found)',
    )
  })

  test('detects connection refused from the message alone (no .code)', () => {
    expect(formatConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:8443'), 'https://x')).toBe(
      'Could not connect to ClickHouse at https://x (connection refused)',
    )
  })

  test('returns undefined for unrecognized errors (caller rethrows raw)', () => {
    expect(formatConnectionError(new Error('Unknown data type family: Nope'), 'https://x')).toBeUndefined()
  })
})
