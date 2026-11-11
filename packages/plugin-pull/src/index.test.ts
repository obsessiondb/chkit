import { describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { type ColumnDefinition, parseCodec, table } from '@chkit/core'

import { __testUtils, createPullPlugin, PullSchema, renderSchemaFile } from './index.js'

describe('@chkit/plugin-pull options', () => {
  test('createPullPlugin carries factory options into runtime schemas', () => {
    const plugin = createPullPlugin({
      outFile: './schema.ts',
      databases: ['app'],
      overwrite: true,
      introspect: async () => [],
    })
    const command = plugin.commands[0]

    const pluginResult = plugin.optionsSchema?.safeParse({})
    const commandResult = command?.optionsSchema?.safeParse({})

    expect(pluginResult?.success).toBe(true)
    expect(commandResult?.success).toBe(true)
    if (!pluginResult?.success || !commandResult?.success) return
    expect(pluginResult.data.outFile).toBe('./schema.ts')
    expect(commandResult.data.databases).toEqual(['app'])
    expect(commandResult.data.overwrite).toBe(true)
  })
})

describe('@chkit/plugin-pull renderSchemaFile', () => {
  test('preserves DoubleDelta sizes retained by the server in verbatim chains', () => {
    const definition = table({
      database: 'db', name: 't', engine: 'MergeTree()', primaryKey: [], orderBy: [],
      columns: [
        { name: 'widths', type: 'Tuple(UInt32, UInt64)', codec: parseCodec('CODEC(Delta, DoubleDelta(8))') },
        { name: 'types', type: 'Tuple(UInt32, Int32)', codec: parseCodec('CODEC(DoubleDelta(4), T64, ZSTD)') },
      ],
    })
    const output = renderSchemaFile([definition])
    expect(output).toContain('{ kind: "DoubleDelta", size: 8 }')
    expect(output).toContain('{ kind: "DoubleDelta", size: 4 }')
  })

  test('renders a full table + view + refreshable MV schema byte-for-byte', () => {
    const content = renderSchemaFile([
      {
        kind: 'table',
        database: 'app',
        name: 'events',
        engine: 'MergeTree()',
        columns: [
          { name: 'id', type: 'UInt64', codec: { kind: 'ZSTD', level: 3 } },
          { name: 'received_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
          { name: 'source', type: 'String', nullable: true, comment: 'origin' },
          {
            name: 'payload',
            type: 'String',
            codec: [{ kind: 'Delta', size: 4 }, { kind: 'raw', expression: 'LZ4' }, { kind: 'ZSTD' }],
          },
        ],
        primaryKey: ['id'],
        orderBy: ['id', 'received_at'],
        uniqueKey: ['id'],
        partitionBy: 'toYYYYMM(received_at)',
        ttl: 'received_at + INTERVAL 30 DAY',
        settings: { index_granularity: 8192, ttl_only_drop_parts: 1 },
        indexes: [
          { name: 'idx_source', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
          {
            name: 'idx_body',
            expression: 'payload',
            type: 'tokenbf_v1',
            sizeBytes: 256,
            hashFunctions: 2,
            randomSeed: 0,
            granularity: 1,
          },
        ],
        projections: [{ name: 'proj_by_source', query: 'SELECT source, count() GROUP BY source' }],
      },
      {
        kind: 'view',
        database: 'app',
        name: 'events_view',
        as: 'SELECT id FROM app.events',
      },
      {
        kind: 'materialized_view',
        database: 'analytics',
        name: 'daily_mv',
        to: { database: 'analytics', name: 'daily_rollup' },
        refresh: {
          every: '1 HOUR',
          randomize: '30 SECOND',
          dependsOn: [{ database: 'analytics', name: 'upstream' }],
          settings: { refresh_retries: 3 },
          append: true,
        },
        as: 'SELECT toDate(received_at) AS day, count() AS c FROM app.events GROUP BY day',
      },
    ])

    expect(content).toBe(`import { schema, table, view, materializedView, codec } from '@chkit/core'

// Pulled from live ClickHouse metadata via chkit plugin pull schema

const app_events = table({
  database: "app",
  name: "events",
  engine: "MergeTree()",
  columns: [
    { name: "id", type: "UInt64", codec: { kind: "ZSTD", level: 3 } },
    { name: "received_at", type: "DateTime64(3)", default: { expression: "now64(3)" } },
    { name: "source", type: "String", nullable: true, comment: "origin" },
    { name: "payload", type: "String", codec: [{ kind: "Delta", size: 4 }, codec.raw("LZ4"), { kind: "ZSTD", level: 1 }] },
  ],
  primaryKey: ["id"],
  orderBy: ["id", "received_at"],
  uniqueKey: ["id"],
  partitionBy: "toYYYYMM(received_at)",
  ttl: "received_at + INTERVAL 30 DAY",
  settings: {
    index_granularity: 8192, // read-only: a change recreates the table (DROP + CREATE, or --cutover)
    ttl_only_drop_parts: 1,
  },
  indexes: [
    { name: "idx_body", expression: "payload", type: "tokenbf_v1", sizeBytes: 256, hashFunctions: 2, randomSeed: 0, granularity: 1 },
    { name: "idx_source", expression: "source", type: "set", maxRows: 0, granularity: 1 },
  ],
  projections: [
    { name: "proj_by_source", query: "SELECT source, count() GROUP BY source" },
  ],
})

const app_events_view = view({
  database: "app",
  name: "events_view",
  as: "SELECT id FROM app.events",
})

const analytics_daily_mv = materializedView({
  database: "analytics",
  name: "daily_mv",
  to: { database: "analytics", name: "daily_rollup" },
  refresh: {
    every: "1 HOUR",
    randomize: "30 SECOND",
    dependsOn: [
      { database: "analytics", name: "upstream" },
    ],
    settings: {
      refresh_retries: 3,
    },
    append: true,
  },
  as: "SELECT toDate(received_at) AS day, count() AS c FROM app.events GROUP BY day",
})

export default schema(app_events, app_events_view, analytics_daily_mv)
`)
  })

  test('renders deterministic table definitions', () => {
    const content = renderSchemaFile([
      {
        kind: 'table',
        database: 'app',
        name: 'events',
        engine: 'MergeTree()',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'received_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
        ],
        primaryKey: ['id'],
        orderBy: ['id'],
        partitionBy: 'toYYYYMM(received_at)',
      },
    ])

    expect(content).toContain("import { schema, table } from '@chkit/core'")
    expect(content).toContain('const app_events = table({')
    expect(content).toContain('default: { expression: "now64(3)" }')
    expect(content).toContain("export default schema(app_events)")
  })

  test('renders a Distributed table without primaryKey or orderBy (#279)', () => {
    const content = renderSchemaFile([
      {
        kind: 'table',
        database: 'app',
        name: 'events',
        engine: "Distributed('cluster', 'app', 'events_local', rand())",
        columns: [{ name: 'id', type: 'UInt64' }],
        primaryKey: [],
        orderBy: [],
        settings: { flush_on_detach: '0' },
      },
    ])

    expect(content).toContain(`const app_events = table({
  database: "app",
  name: "events",
  engine: "Distributed('cluster', 'app', 'events_local', rand())",
  columns: [
    { name: "id", type: "UInt64" },
  ],
  settings: {`)
    expect(content).not.toContain('primaryKey')
    expect(content).not.toContain('orderBy')
  })

  // #234: canonical definitions carry fn: strings; pulled files show the
  // documented { expression } form.
  test('renders expression defaults as { expression } in either spelling, and literals as literals', () => {
    const render = (receivedAt: ColumnDefinition['default']) =>
      renderSchemaFile([
        {
          kind: 'table',
          database: 'app',
          name: 'events',
          engine: 'MergeTree()',
          columns: [
            { name: 'id', type: 'UInt64' },
            { name: 'received_at', type: 'DateTime64(3)', default: receivedAt },
            { name: 'status', type: 'String', default: 'pending' },
            { name: 'n', type: 'UInt8', default: 0 },
          ],
          primaryKey: ['id'],
          orderBy: ['id'],
        },
      ])

    const fromLegacy = render('fn:now64(3)')
    expect(fromLegacy).toContain('{ name: "received_at", type: "DateTime64(3)", default: { expression: "now64(3)" } },')
    expect(fromLegacy).toContain('{ name: "status", type: "String", default: "pending" },')
    expect(fromLegacy).toContain('{ name: "n", type: "UInt8", default: 0 },')
    expect(render({ expression: 'now64(3)' })).toBe(fromLegacy)
  })

  test('renders defaultKind next to an { expression } default', () => {
    const content = renderSchemaFile([
      {
        kind: 'table',
        database: 'app',
        name: 'events',
        engine: 'MergeTree()',
        columns: [
          { name: 'ts', type: 'DateTime' },
          { name: 'day', type: 'Date', defaultKind: 'MATERIALIZED', default: 'fn:toDate(ts)' },
          { name: 'label', type: 'String', defaultKind: 'ALIAS', default: { expression: 'toString(day)' } },
          { name: 'tag', type: 'String', defaultKind: 'EPHEMERAL', default: 'none' },
        ],
        primaryKey: ['ts'],
        orderBy: ['ts'],
      },
    ])
    expect(content).toContain('{ name: "day", type: "Date", defaultKind: "MATERIALIZED", default: { expression: "toDate(ts)" } },')
    expect(content).toContain('{ name: "label", type: "String", defaultKind: "ALIAS", default: { expression: "toString(day)" } },')
    expect(content).toContain('{ name: "tag", type: "String", defaultKind: "EPHEMERAL", default: "none" },')
  })

  test('renders an index-only projection pulled from a live table', () => {
    const content = renderSchemaFile([
      {
        kind: 'table',
        database: 'solana',
        name: 'address_counterparts',
        engine: 'AggregatingMergeTree()',
        columns: [
          { name: 'sender', type: 'String' },
          { name: 'receiver', type: 'String' },
        ],
        primaryKey: ['sender'],
        orderBy: ['sender', 'receiver'],
        projections: [
          { name: 'by_receiver', index: '(receiver, sender)', type: 'basic' },
          { name: 'agg_by_sender', query: 'SELECT sender, sum(cnt) GROUP BY sender' },
        ],
      },
    ])

    expect(content).toContain(
      '    { name: "by_receiver", index: "(receiver, sender)", type: "basic" },'
    )
    expect(content).toContain(
      '    { name: "agg_by_sender", query: "SELECT sender, sum(cnt) GROUP BY sender" },'
    )
  })

  test('renders structured index args in pulled schema', () => {
    const content = renderSchemaFile([
      {
        kind: 'table',
        database: 'app',
        name: 'events',
        engine: 'MergeTree()',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'source', type: 'String' },
          { name: 'email', type: 'String' },
          { name: 'body', type: 'String' },
          { name: 'name', type: 'String' },
        ],
        primaryKey: ['id'],
        orderBy: ['id'],
        indexes: [
          { name: 'idx_source', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
          { name: 'idx_id', expression: 'id', type: 'minmax', granularity: 3 },
          {
            name: 'idx_bloom',
            expression: 'email',
            type: 'bloom_filter',
            falsePositiveRate: 0.01,
            granularity: 1,
          },
          { name: 'idx_bloom_default', expression: 'email', type: 'bloom_filter', granularity: 1 },
          {
            name: 'idx_body',
            expression: 'body',
            type: 'tokenbf_v1',
            sizeBytes: 256,
            hashFunctions: 2,
            randomSeed: 0,
            granularity: 1,
          },
          {
            name: 'idx_name',
            expression: 'name',
            type: 'ngrambf_v1',
            ngramSize: 3,
            sizeBytes: 256,
            hashFunctions: 2,
            randomSeed: 0,
            granularity: 1,
          },
        ],
      },
    ])

    expect(content).toContain('type: "set", maxRows: 0, granularity: 1')
    expect(content).toContain('type: "minmax", granularity: 3')
    expect(content).toContain('type: "bloom_filter", falsePositiveRate: 0.01, granularity: 1')
    expect(content).toContain(
      'name: "idx_bloom_default", expression: "email", type: "bloom_filter", granularity: 1'
    )
    expect(content).toContain(
      'type: "tokenbf_v1", sizeBytes: 256, hashFunctions: 2, randomSeed: 0, granularity: 1'
    )
    expect(content).toContain(
      'type: "ngrambf_v1", ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0, granularity: 1'
    )
    expect(content).not.toContain('typeArgs')
  })

  test('renders vector, raw indexes and constraints in pulled schema', () => {
    const content = renderSchemaFile([
      {
        kind: 'table',
        database: 'app',
        name: 'vectors',
        engine: 'MergeTree()',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 's', type: 'String' },
          { name: 'embedding', type: 'Array(Float32)' },
        ],
        primaryKey: ['id'],
        orderBy: ['id'],
        indexes: [
          {
            name: 'e', expression: 'embedding', type: 'vector_similarity', method: 'hnsw',
            distanceFunction: 'L2Distance', dimensions: 4, quantization: 'bf16',
            hnswMaxConnectionsPerLayer: 32, hnswCandidateListSizeForConstruction: 128, granularity: 100000000,
          },
          { name: 'sg', expression: 's', type: 'raw', rawType: 'sparse_grams(3, 100, 512, 1, 3, 0)', granularity: 1 },
        ],
        constraints: [
          { name: 'dimension', check: 'length(embedding) = 4' },
          { name: 'a-b', assume: 'id > 0' },
        ],
      },
    ])

    expect(content).toContain(
      '{ name: "e", expression: "embedding", type: "vector_similarity", method: "hnsw", distanceFunction: "L2Distance", dimensions: 4, quantization: "bf16", hnswMaxConnectionsPerLayer: 32, hnswCandidateListSizeForConstruction: 128, granularity: 100000000 },'
    )
    expect(content).toContain(
      '{ name: "sg", expression: "s", type: "raw", rawType: "sparse_grams(3, 100, 512, 1, 3, 0)", granularity: 1 },'
    )
    expect(content).toContain(
      '  constraints: [\n    { name: "a-b", assume: "id > 0" },\n    { name: "dimension", check: "length(embedding) = 4" },\n  ],'
    )
  })

  test('renders view and materialized view definitions', () => {
    const content = renderSchemaFile([
      {
        kind: 'view',
        database: 'app',
        name: 'events_view',
        as: 'SELECT id FROM app.events',
      },
      {
        kind: 'materialized_view',
        database: 'app',
        name: 'events_mv',
        to: { database: 'app', name: 'events_rollup' },
        as: 'SELECT id, count() AS c FROM app.events GROUP BY id',
      },
    ])

    expect(content).toContain("import { schema, view, materializedView } from '@chkit/core'")
    expect(content).toContain('const app_events_view = view({')
    expect(content).toContain('const app_events_mv = materializedView({')
    expect(content).toContain('to: { database: "app", name: "events_rollup" }')
    expect(content).toContain('export default schema(app_events_view, app_events_mv)')
  })

  test('renders the comment of a table, a view and a materialized view exactly (#464)', () => {
    const comment = 'it\'s "q" a\\b C:\\new\\t trail\\ l1\nl2 héllo 世界 🚀 x AS y'
    const content = renderSchemaFile([
      {
        kind: 'table',
        database: 'app',
        name: 'events',
        engine: 'MergeTree()',
        columns: [{ name: 'id', type: 'UInt64', comment }],
        primaryKey: ['id'],
        orderBy: ['id'],
        comment,
      },
      { kind: 'view', database: 'app', name: 'v', as: 'SELECT id FROM app.events', comment },
      { kind: 'materialized_view', database: 'app', name: 'mv', to: { database: 'app', name: 'events' }, as: 'SELECT 1 AS id', comment },
    ])
    const literal = JSON.stringify(comment)
    // A MergeTree table carries index_granularity, so its settings come before the comment (#466).
    expect(content).toContain(
      `  orderBy: ["id"],\n  settings: {\n    index_granularity: 8192, // read-only: a change recreates the table (DROP + CREATE, or --cutover)\n  },\n  comment: ${literal},\n})`
    )
    expect(content).toContain(`  as: "SELECT id FROM app.events",\n  comment: ${literal},\n})`)
    expect(content).toContain(`  as: "SELECT 1 AS id",\n  comment: ${literal},\n})`)
    expect(content).toContain(`{ name: "id", type: "UInt64", comment: ${literal} }`)
  })

  test('renders a dictionary definition with a hidden-secret note', () => {
    const content = renderSchemaFile([
      {
        kind: 'dictionary',
        database: 'app',
        name: 'users_dict',
        attributes: [
          { name: 'id', type: 'UInt64' },
          { name: 'name', type: 'String' },
          { name: 'email', type: 'String', default: '' },
        ],
        primaryKey: ['id'],
        source: "MYSQL(host 'db' port 3306 user 'reader' password '[HIDDEN]' db 'app' table 'users')",
        layout: 'HASHED()',
        lifetime: '300',
        comment: 'User lookup dictionary',
      },
    ])

    expect(content).toContain("import { schema, dictionary } from '@chkit/core'")
    expect(content).toContain(
      "// NOTE: password redacted by ClickHouse — replace '[HIDDEN]' with your credential (e.g. process.env.X)."
    )
    expect(content).toContain('const app_users_dict = dictionary({')
    expect(content).toContain('{ name: "id", type: "UInt64" }')
    expect(content).toContain('{ name: "email", type: "String", default: "" }')
    expect(content).toContain('primaryKey: ["id"]')
    expect(content).toContain(
      'source: "MYSQL(host \'db\' port 3306 user \'reader\' password \'[HIDDEN]\' db \'app\' table \'users\')"'
    )
    expect(content).toContain('layout: "HASHED()"')
    expect(content).toContain('lifetime: "300"')
    expect(content).toContain('comment: "User lookup dictionary"')
    expect(content).toContain('export default schema(app_users_dict)')
  })

  test('renders a dictionary with range, settings, and a bidirectional attribute', () => {
    const content = renderSchemaFile([
      {
        kind: 'dictionary',
        database: 'app',
        name: 'rates_dict',
        attributes: [
          { name: 'id', type: 'UInt64' },
          { name: 'parent_id', type: 'UInt64', hierarchical: true, bidirectional: true },
          { name: 'start_date', type: 'DateTime' },
          { name: 'end_date', type: 'DateTime' },
        ],
        primaryKey: ['id'],
        source: "HTTP(url 'http://example.com/rates' format 'TSV')",
        layout: 'RANGE_HASHED()',
        lifetime: '300',
        range: { min: 'start_date', max: 'end_date' },
        settings: { dictionary_use_async_executor: 1, max_threads: 8 },
      },
    ])

    expect(content).toContain('{ name: "parent_id", type: "UInt64", hierarchical: true, bidirectional: true }')
    expect(content).toContain('range: { min: "start_date", max: "end_date" }')
    expect(content).toContain('settings: {')
    expect(content).toContain('dictionary_use_async_executor: 1')
    expect(content).toContain('max_threads: 8')
  })

  test('renders refreshable materialized view with full refresh block', () => {
    const content = renderSchemaFile([
      {
        kind: 'materialized_view',
        database: 'analytics',
        name: 'daily_mv',
        to: { database: 'analytics', name: 'daily_rollup' },
        refresh: {
          every: '1 HOUR',
          randomize: '30 SECOND',
          dependsOn: [{ database: 'analytics', name: 'upstream' }],
          settings: { refresh_retries: 3 },
          append: true,
        },
        as: 'SELECT 1',
      },
    ])
    expect(content).toContain('refresh: {')
    expect(content).toContain('every: "1 HOUR",')
    expect(content).toContain('randomize: "30 SECOND",')
    expect(content).toContain('dependsOn: [')
    expect(content).toContain('{ database: "analytics", name: "upstream" },')
    expect(content).toContain('settings: {')
    expect(content).toContain('refresh_retries: 3,')
    expect(content).toContain('append: true,')
  })
})

describe('@chkit/plugin-pull schema command', () => {
  test('supports --dryrun with json payload', async () => {
    const plugin = createPullPlugin({
      databases: ['app'],
      introspect: async () => [
        {
          database: 'app',
          name: 'users',
          engine: 'MergeTree()',
          primaryKey: '(id)',
          orderBy: '(id)',
          columns: [
            { name: 'id', type: 'UInt64' },
            { name: 'email', type: 'String', default: "''" },
            { name: 'domain', type: 'String', defaultKind: 'MATERIALIZED', default: 'domain(email)' },
            { name: 'raw', type: 'String', defaultKind: 'EPHEMERAL' },
          ],
          settings: {},
          indexes: [],
          projections: [],
        },
      ],
    })

    const command = plugin.commands[0]
    if (!command) throw new Error('missing command')

    const logs: unknown[] = []
    const code = await command.run({
      args: [],
      flags: { '--dryrun': true },
      jsonMode: true,
      options: PullSchema.parse({ databases: ['app'] }),
      rawOptions: { databases: ['app'] },
      configPath: '/tmp/clickhouse.config.ts',
      config: {
        schema: ['./schema.ts'],
        outDir: './chkit',
        migrationsDir: './chkit/migrations',
        metaDir: './chkit/meta',
        plugins: [],
        check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
        safety: { allowDestructive: false },
        clickhouse: {
          url: 'http://localhost:8123',
          username: 'default',
          password: '',
          database: 'default',
          secure: false,
        },
      },
      print(value) {
        logs.push(value)
      },
    })

    expect(code).toBe(0)
    const payload = logs[0] as {
      ok: boolean
      command: string
      dryrun: boolean
      definitionCount: number
      tableCount: number
      content: string
    }

    // chkit-py emits the same keys in the same order (#487).
    expect(Object.keys(payload)).toEqual([
      'ok',
      'command',
      'outFile',
      'definitionCount',
      'tableCount',
      'databases',
      'skippedObjects',
      'dryrun',
      'warnings',
      'content',
    ])
    expect(payload.ok).toBe(true)
    expect(payload.command).toBe('schema')
    expect(payload.dryrun).toBe(true)
    expect(payload.definitionCount).toBe(1)
    expect(payload.tableCount).toBe(1)
    expect(payload.content).toContain('const app_users = table({')
    expect(payload.content).toContain(`default: { expression: "''" }`)
    // Introspected expressions of every kind keep their defaultKind (#216) and
    // are written in the { expression } form (#234).
    expect(payload.content).toContain(
      '{ name: "domain", type: "String", defaultKind: "MATERIALIZED", default: { expression: "domain(email)" } },'
    )
    expect(payload.content).toContain('{ name: "raw", type: "String", defaultKind: "EPHEMERAL" },')
  })

  test('unwraps key tuples whose identifiers contain parens', async () => {
    const plugin = createPullPlugin({
      databases: ['app'],
      introspect: async () => [
        {
          database: 'app',
          name: 'events',
          engine: 'MergeTree()',
          primaryKey: '(`w)x`, id)',
          orderBy: '(`w)x`, id)',
          columns: [
            { name: 'id', type: 'UInt64' },
            { name: 'w)x', type: 'String' },
          ],
          settings: {},
          indexes: [],
          projections: [],
        },
      ],
    })

    const command = plugin.commands[0]
    if (!command) throw new Error('missing command')

    const logs: unknown[] = []
    const code = await command.run({
      args: [],
      flags: { '--dryrun': true },
      jsonMode: true,
      options: PullSchema.parse({ databases: ['app'] }),
      rawOptions: { databases: ['app'] },
      configPath: '/tmp/clickhouse.config.ts',
      config: {
        schema: ['./schema.ts'],
        outDir: './chkit',
        migrationsDir: './chkit/migrations',
        metaDir: './chkit/meta',
        plugins: [],
        check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
        safety: { allowDestructive: false },
        clickhouse: {
          url: 'http://localhost:8123',
          username: 'default',
          password: '',
          database: 'default',
          secure: false,
        },
      },
      print(value) {
        logs.push(value)
      },
    })

    expect(code).toBe(0)
    const payload = logs[0] as { content: string }
    expect(payload.content).toContain('orderBy: ["`w)x`", "id"],')
    expect(payload.content).toContain('primaryKey: ["`w)x`", "id"],')
  })

  test('excludes ObsessionDB metadata tables from pulled schema output', async () => {
    const introspectedTable = (name: string) => ({
      database: 'app',
      name,
      engine: 'MergeTree()',
      primaryKey: '(id)',
      orderBy: '(id)',
      columns: [{ name: 'id', type: 'UInt64' }],
      settings: {},
      indexes: [],
      projections: [],
    })
    const plugin = createPullPlugin({
      databases: ['app'],
      introspect: async () => [
        introspectedTable('events'),
        introspectedTable('metadata_folder'),
        introspectedTable('metadata_table_folder'),
        introspectedTable('metadata_table_tag'),
      ],
    })

    const command = plugin.commands[0]
    if (!command) throw new Error('missing command')

    const logs: unknown[] = []
    const code = await command.run({
      args: [],
      flags: { '--dryrun': true },
      jsonMode: true,
      options: PullSchema.parse({ databases: ['app'] }),
      rawOptions: { databases: ['app'] },
      configPath: '/tmp/clickhouse.config.ts',
      config: {
        schema: ['./schema.ts'],
        outDir: './chkit',
        migrationsDir: './chkit/migrations',
        metaDir: './chkit/meta',
        plugins: [],
        check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
        safety: { allowDestructive: false },
        clickhouse: {
          url: 'http://localhost:8123',
          username: 'default',
          password: '',
          database: 'default',
          secure: false,
        },
      },
      print(value) {
        logs.push(value)
      },
    })

    expect(code).toBe(0)
    const payload = logs[0] as { definitionCount: number; tableCount: number; content: string }
    expect(payload.definitionCount).toBe(1)
    expect(payload.tableCount).toBe(1)
    expect(payload.content).toContain('const app_events = table({')
    expect(payload.content).not.toContain('metadata_folder')
    expect(payload.content).not.toContain('metadata_table_folder')
    expect(payload.content).not.toContain('metadata_table_tag')
  })

  test('supports introspected view and materialized_view objects', async () => {
    const plugin = createPullPlugin({
      databases: ['app'],
      introspect: async () => [
        {
          database: 'app',
          name: 'users',
          engine: 'MergeTree()',
          primaryKey: '(id)',
          orderBy: '(id)',
          columns: [{ name: 'id', type: 'UInt64' }],
          settings: {},
          indexes: [],
          projections: [],
        },
        {
          kind: 'view',
          database: 'app',
          name: 'users_view',
          as: 'SELECT id FROM app.users',
        },
        {
          kind: 'materialized_view',
          database: 'app',
          name: 'users_mv',
          to: { database: 'app', name: 'users_rollup' },
          as: 'SELECT id, count() AS c FROM app.users GROUP BY id',
        },
      ],
    })

    const command = plugin.commands[0]
    if (!command) throw new Error('missing command')

    const logs: unknown[] = []
    const code = await command.run({
      args: [],
      flags: { '--dryrun': true },
      jsonMode: true,
      options: PullSchema.parse({ databases: ['app'] }),
      rawOptions: { databases: ['app'] },
      configPath: '/tmp/clickhouse.config.ts',
      config: {
        schema: ['./schema.ts'],
        outDir: './chkit',
        migrationsDir: './chkit/migrations',
        metaDir: './chkit/meta',
        plugins: [],
        check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
        safety: { allowDestructive: false },
        clickhouse: {
          url: 'http://localhost:8123',
          username: 'default',
          password: '',
          database: 'default',
          secure: false,
        },
      },
      print(value) {
        logs.push(value)
      },
    })

    expect(code).toBe(0)
    const payload = logs[0] as {
      definitionCount: number
      tableCount: number
      content: string
    }
    expect(payload.definitionCount).toBe(3)
    expect(payload.tableCount).toBe(1)
    expect(payload.content).toContain("import { schema, table, view, materializedView } from '@chkit/core'")
    expect(payload.content).toContain('const app_users_view = view({')
    expect(payload.content).toContain('const app_users_mv = materializedView({')
  })

  test('warns when an introspected dictionary SOURCE(...) password is [HIDDEN]', async () => {
    const plugin = createPullPlugin({
      databases: ['app'],
      introspect: async () => [
        {
          kind: 'dictionary',
          database: 'app',
          name: 'users_dict',
          attributes: [{ name: 'id', type: 'UInt64' }],
          primaryKey: ['id'],
          source: "MYSQL(host 'db' port 3306 user 'reader' password '[HIDDEN]' db 'app' table 'users')",
          layout: 'HASHED()',
          lifetime: '300',
        },
      ],
    })

    const command = plugin.commands[0]
    if (!command) throw new Error('missing command')

    const logs: unknown[] = []
    const code = await command.run({
      args: [],
      flags: { '--dryrun': true },
      jsonMode: true,
      options: PullSchema.parse({ databases: ['app'] }),
      rawOptions: { databases: ['app'] },
      configPath: '/tmp/clickhouse.config.ts',
      config: {
        schema: ['./schema.ts'],
        outDir: './chkit',
        migrationsDir: './chkit/migrations',
        metaDir: './chkit/meta',
        plugins: [],
        check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
        safety: { allowDestructive: false },
        clickhouse: {
          url: 'http://localhost:8123',
          username: 'default',
          password: '',
          database: 'default',
          secure: false,
        },
      },
      print(value) {
        logs.push(value)
      },
    })

    expect(code).toBe(0)
    const payload = logs[0] as { warnings: string[] }
    expect(
      payload.warnings.some(
        (warning) => warning.includes('app.users_dict') && warning.includes('[HIDDEN]')
      )
    ).toBe(true)
  })

  test('warns when an introspected dictionary SOURCE(...) password is plain text', async () => {
    const plugin = createPullPlugin({
      databases: ['app'],
      introspect: async () => [
        {
          kind: 'dictionary',
          database: 'app',
          name: 'users_dict',
          attributes: [{ name: 'id', type: 'UInt64' }],
          primaryKey: ['id'],
          source: "MYSQL(host 'db' port 3306 user 'reader' password 'super-secret-pw' db 'app' table 'users')",
          layout: 'HASHED()',
          lifetime: '300',
        },
      ],
    })

    const command = plugin.commands[0]
    if (!command) throw new Error('missing command')

    const logs: unknown[] = []
    const code = await command.run({
      args: [],
      flags: { '--dryrun': true },
      jsonMode: true,
      options: PullSchema.parse({ databases: ['app'] }),
      rawOptions: { databases: ['app'] },
      configPath: '/tmp/clickhouse.config.ts',
      config: {
        schema: ['./schema.ts'],
        outDir: './chkit',
        migrationsDir: './chkit/migrations',
        metaDir: './chkit/meta',
        plugins: [],
        check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
        safety: { allowDestructive: false },
        clickhouse: {
          url: 'http://localhost:8123',
          username: 'default',
          password: '',
          database: 'default',
          secure: false,
        },
      },
      print(value) {
        logs.push(value)
      },
    })

    expect(code).toBe(0)
    const payload = logs[0] as { warnings: string[] }
    expect(
      payload.warnings.some(
        (warning) => warning.includes('app.users_dict') && warning.includes('plain-text password')
      )
    ).toBe(true)
  })

  test('writes schema file and fails on existing file without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-plugin-pull-'))
    const outFile = join(dir, 'schema.ts')

    const plugin = createPullPlugin({
      databases: ['app'],
      introspect: async () => [
        {
          database: 'app',
          name: 'users',
          engine: 'MergeTree()',
          primaryKey: '(id)',
          orderBy: '(id)',
          columns: [{ name: 'id', type: 'UInt64' }],
          settings: {},
          indexes: [],
          projections: [],
        },
      ],
      outFile,
    })

    const command = plugin.commands[0]
    if (!command) throw new Error('missing command')

    const run = async (flags: Record<string, string | string[] | boolean | undefined> = {}): Promise<{ code: undefined | number; output: unknown[] }> => {
      const output: unknown[] = []
      const overwrite = flags['--force'] === true || flags['--overwrite'] === true
      const code = await command.run({
        args: [],
        flags,
        jsonMode: true,
        options: PullSchema.parse({ databases: ['app'], outFile, overwrite }),
        rawOptions: { databases: ['app'], outFile },
        configPath: '/tmp/clickhouse.config.ts',
        config: {
          schema: ['./schema.ts'],
          outDir: './chkit',
          migrationsDir: './chkit/migrations',
          metaDir: './chkit/meta',
          plugins: [],
          check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
          safety: { allowDestructive: false },
          clickhouse: {
            url: 'http://localhost:8123',
            username: 'default',
            password: '',
            database: 'default',
            secure: false,
          },
        },
        print(value) {
          output.push(value)
        },
      })
      return { code, output }
    }

    try {
      const first = await run()
      expect(first.code).toBe(0)
      const written = await readFile(outFile, 'utf8')
      expect(written).toContain('const app_users = table({')

      await writeFile(outFile, '// existing\n', 'utf8')
      const second = await run()
      expect(second.code).toBe(2)
      expect(second.output[0]).toEqual({
        ok: false,
        command: 'schema',
        error: `Output file already exists at ${outFile}. Re-run with --force or set plugin option overwrite=true.`,
      })

      const third = await run({ '--force': true })
      expect(third.code).toBe(0)
      const forced = await readFile(outFile, 'utf8')
      expect(forced).toContain('export default schema(app_users)')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes the output path as given, without following symlinks (#702)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-plugin-pull-symlink-'))
    const project = join(dir, 'project')
    const elsewhere = join(dir, 'elsewhere')
    await mkdir(join(elsewhere, 'real'), { recursive: true })
    await mkdir(project)
    await writeFile(join(elsewhere, 'target.ts'), '// target\n', 'utf8')
    await symlink(join(elsewhere, 'target.ts'), join(project, 'link.ts'))
    await symlink(join(elsewhere, 'real'), join(project, 'linkdir'))
    await symlink(join(dir, 'nowhere', 'f.ts'), join(project, 'dangling.ts'))

    const plugin = createPullPlugin({
      databases: ['app'],
      introspect: async () => [
        {
          database: 'app',
          name: 'users',
          engine: 'MergeTree()',
          primaryKey: '(id)',
          orderBy: '(id)',
          columns: [{ name: 'id', type: 'UInt64' }],
          settings: {},
          indexes: [],
          projections: [],
        },
      ],
    })
    const command = plugin.commands[0]
    if (!command) throw new Error('missing command')

    const pull = async (outFile: string): Promise<unknown> => {
      const output: unknown[] = []
      const code = await command.run({
        args: [],
        flags: { '--force': true },
        jsonMode: true,
        options: PullSchema.parse({ databases: ['app'], outFile, overwrite: true }),
        rawOptions: { databases: ['app'], outFile },
        configPath: join(project, 'clickhouse.config.ts'),
        config: {
          schema: ['./schema.ts'],
          outDir: './chkit',
          migrationsDir: './chkit/migrations',
          metaDir: './chkit/meta',
          plugins: [],
          check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
          safety: { allowDestructive: false },
          clickhouse: {
            url: 'http://localhost:8123',
            username: 'default',
            password: '',
            database: 'default',
            secure: false,
          },
        },
        print(value) {
          output.push(value)
        },
      })
      expect(code).toBe(0)
      return (output[0] as { outFile: string }).outFile
    }

    try {
      // A symlinked output file is replaced by the pulled file; its target is untouched.
      expect(await pull(join(project, 'link.ts'))).toBe(join(project, 'link.ts'))
      expect((await lstat(join(project, 'link.ts'))).isSymbolicLink()).toBe(false)
      expect(await readFile(join(project, 'link.ts'), 'utf8')).toContain('const app_users = table({')
      expect(await readFile(join(elsewhere, 'target.ts'), 'utf8')).toBe('// target\n')

      // A dangling symlink is replaced too; nothing is created where it pointed.
      expect(await pull(join(project, 'dangling.ts'))).toBe(join(project, 'dangling.ts'))
      expect((await lstat(join(project, 'dangling.ts'))).isFile()).toBe(true)
      expect((await readdir(dir)).sort()).toEqual(['elsewhere', 'project'])

      // A symlinked directory is reported as given and written through by the OS.
      expect(await pull(join(project, 'linkdir', 's.ts'))).toBe(join(project, 'linkdir', 's.ts'))
      expect(await readFile(join(elsewhere, 'real', 's.ts'), 'utf8')).toContain('const app_users = table({')

      // `..` after a symlinked directory is taken by text, not from the link target.
      expect(await pull(`${project}/linkdir/../x.ts`)).toBe(join(project, 'x.ts'))
      expect(await readFile(join(project, 'x.ts'), 'utf8')).toContain('const app_users = table({')
      expect((await readdir(elsewhere)).sort()).toEqual(['real', 'target.ts'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('@chkit/plugin-pull parser helpers', () => {
  test('parseAsClause extracts trailing query and trims semicolon', () => {
    const asClause = __testUtils.parseAsClause(`CREATE VIEW app.v AS
SELECT id
FROM app.users;`)
    expect(asClause).toBe('SELECT id\nFROM app.users')
  })

  test('parseAsClause skips an AS inside the comment literal (#464)', () => {
    expect(
      __testUtils.parseAsClause("CREATE VIEW db.v (`id` UInt64) COMMENT 'it\\'s a view AS x' AS SELECT id FROM db.events")
    ).toBe('SELECT id FROM db.events')
    expect(
      __testUtils.parseAsClause(
        "CREATE MATERIALIZED VIEW db.mv TO db.totals (`id` UInt64) COMMENT 'sums AS totals' AS SELECT id, note FROM db.src"
      )
    ).toBe('SELECT id, note FROM db.src')
  })

  test('mapSystemTableRowToDefinition takes the comment of a view, materialized view and dictionary from system.tables (#464)', () => {
    const comment = 'line1\nline2 back\\slash it\'s AS x'
    expect(
      __testUtils.mapSystemTableRowToDefinition({
        database: 'db',
        name: 'v',
        engine: 'View',
        create_table_query: "CREATE VIEW db.v (`id` UInt64) COMMENT 'line1\\nline2 back\\\\slash it\\'s AS x' AS SELECT id FROM db.t",
        comment,
      })
    ).toEqual({ kind: 'view', database: 'db', name: 'v', as: 'SELECT id FROM db.t', comment })
    expect(
      __testUtils.mapSystemTableRowToDefinition({
        database: 'db',
        name: 'mv',
        engine: 'MaterializedView',
        create_table_query: "CREATE MATERIALIZED VIEW db.mv TO db.t (`id` UInt64) COMMENT 'maps x TO y' AS SELECT id FROM db.src",
        comment: 'maps x TO y',
      })
    ).toEqual({
      kind: 'materialized_view',
      database: 'db',
      name: 'mv',
      to: { database: 'db', name: 't' },
      as: 'SELECT id FROM db.src',
      comment: 'maps x TO y',
    })
    expect(
      __testUtils.mapSystemTableRowToDefinition({
        database: 'db',
        name: 'd',
        engine: 'Dictionary',
        create_table_query:
          "CREATE DICTIONARY db.d (`id` UInt64) PRIMARY KEY id SOURCE(NULL()) LIFETIME(MIN 0 MAX 300) LAYOUT(HASHED()) COMMENT 'line1\\nline2 back\\\\slash it\\'s AS x'",
        comment,
      })
    ).toMatchObject({ kind: 'dictionary', comment })
  })

  test('parseToClause ignores a TO inside the comment of a materialized view with an inner table', () => {
    expect(
      __testUtils.parseToClause(
        "CREATE MATERIALIZED VIEW db.mv (`id` UInt64) ENGINE = MergeTree ORDER BY id COMMENT 'maps x TO y' AS SELECT id FROM db.src",
        'db'
      )
    ).toBeNull()
  })

  test('parseAsClause returns null when AS clause is missing', () => {
    const asClause = __testUtils.parseAsClause('CREATE VIEW app.v')
    expect(asClause).toBeNull()
  })

  test('parseToClause handles quoted db/table identifiers', () => {
    const to = __testUtils.parseToClause(
      'CREATE MATERIALIZED VIEW app.mv TO "analytics"."events_rollup" AS SELECT 1',
      'app'
    )
    expect(to).toEqual({ database: 'analytics', name: 'events_rollup' })
  })

  test('parseToClause falls back to source database when TO has only table name', () => {
    const to = __testUtils.parseToClause(
      'CREATE MATERIALIZED VIEW app.mv TO events_rollup AS SELECT 1',
      'app'
    )
    expect(to).toEqual({ database: 'app', name: 'events_rollup' })
  })

  test('parseToClause returns null when TO clause is absent', () => {
    const to = __testUtils.parseToClause('CREATE MATERIALIZED VIEW app.mv AS SELECT 1', 'app')
    expect(to).toBeNull()
  })

  test('mapSystemTableRowToDefinition returns null when materialized view misses TO', () => {
    const definition = __testUtils.mapSystemTableRowToDefinition({
      database: 'app',
      name: 'mv_bad',
      engine: 'MaterializedView',
      create_table_query: 'CREATE MATERIALIZED VIEW app.mv_bad AS SELECT 1',
    })
    expect(definition).toBeNull()
  })

  test('parseRefreshClause returns null when no REFRESH present', () => {
    const refresh = __testUtils.parseRefreshClause(
      'CREATE MATERIALIZED VIEW app.mv TO app.t AS SELECT 1'
    )
    expect(refresh).toBeNull()
  })

  test('parseRefreshClause extracts REFRESH EVERY + APPEND', () => {
    const refresh = __testUtils.parseRefreshClause(
      'CREATE MATERIALIZED VIEW app.mv REFRESH EVERY 30 SECOND APPEND TO app.t AS SELECT 1'
    )
    expect(refresh).toEqual({ every: '30 SECOND', append: true })
  })

  test('parseRefreshClause extracts AFTER + OFFSET + RANDOMIZE + SETTINGS', () => {
    const refresh = __testUtils.parseRefreshClause(
      `CREATE MATERIALIZED VIEW app.mv
REFRESH AFTER 10 MINUTE OFFSET 5 MINUTE RANDOMIZE FOR 30 SECOND SETTINGS refresh_retries = 3, refresh_retry_initial_backoff_ms = 100
TO app.t AS SELECT 1`
    )
    expect(refresh).toEqual({
      after: '10 MINUTE',
      offset: '5 MINUTE',
      randomize: '30 SECOND',
      settings: { refresh_retries: 3, refresh_retry_initial_backoff_ms: 100 },
    })
  })

  test('parseRefreshClause extracts DEPENDS ON list', () => {
    const refresh = __testUtils.parseRefreshClause(
      'CREATE MATERIALIZED VIEW app.mv REFRESH EVERY 1 HOUR DEPENDS ON analytics.upstream_mv, other.dep TO app.t AS SELECT 1'
    )
    expect(refresh?.dependsOn).toEqual([
      { database: 'analytics', name: 'upstream_mv' },
      { database: 'other', name: 'dep' },
    ])
  })

  test('parseRefreshClause reads quoted DEPENDS ON names as ClickHouse means them', () => {
    // create_table_query as ClickHouse 26.3 returns it (#631); chkit-py's
    // test_pull.py asserts the same.
    const refresh = __testUtils.parseRefreshClause(
      'CREATE MATERIALIZED VIEW d.mv2 REFRESH EVERY 1 HOUR DEPENDS ON d.r1, d.`we\\`ird`, d.`a.b`, d.`x\\``, d.`has AS kw`, d.`q"d`, `a, b`.`TO` TO d.dst (`a` UInt8) DEFINER = default SQL SECURITY DEFINER AS SELECT a FROM d.src'
    )
    expect(refresh?.dependsOn).toEqual([
      { database: 'd', name: 'r1' },
      { database: 'd', name: 'we`ird' },
      { database: 'd', name: 'a.b' },
      { database: 'd', name: 'x`' },
      { database: 'd', name: 'has AS kw' },
      { database: 'd', name: 'q"d' },
      { database: 'a, b', name: 'TO' },
    ])
  })

  test('parseRefreshClause decodes escapes in quoted DEPENDS ON names as ClickHouse does (#631, #639)', () => {
    const refresh = __testUtils.parseRefreshClause(
      'CREATE MATERIALIZED VIEW d.mv REFRESH EVERY 1 HOUR DEPENDS ON d.`x\\ny`, d.`b\\x41` TO d.dst AS SELECT 1'
    )
    expect(refresh?.dependsOn).toEqual([
      { database: 'd', name: 'x\ny' },
      { database: 'd', name: 'bA' },
    ])
  })

  test('parseRefreshClause ignores DEPENDS ON text inside a string or the SELECT', () => {
    const refresh = __testUtils.parseRefreshClause(
      "CREATE MATERIALIZED VIEW d.mv REFRESH EVERY 1 HOUR TO d.dst AS SELECT 'DEPENDS ON d.x' AS c"
    )
    expect(refresh).toEqual({ every: '1 HOUR' })
  })

  test('parseRefreshClause DEPENDS ON entries trim JavaScript whitespace', () => {
    // chkit-py's test_name_trim.py asserts the same (#580). ClickHouse quotes
    // these names, so they are quoted here too (#631).
    const refresh = __testUtils.parseRefreshClause(
      'CREATE MATERIALIZED VIEW app.mv REFRESH EVERY 1 HOUR DEPENDS ON `\ufeffapp`.`src\x85`, `\ufeffother` TO app.t AS SELECT 1'
    )
    expect(refresh?.dependsOn).toEqual([
      { database: 'app', name: 'src\x85' },
      { database: 'default', name: 'other' },
    ])
  })

  test('parseRefreshClause ignores DEFINER / SQL SECURITY noise that Cloud auto-injects', () => {
    const cloudDdl = `CREATE MATERIALIZED VIEW app.mv
REFRESH EVERY 30 SECOND APPEND TO app.t
(\`day\` Date, \`total\` UInt64)
DEFINER = default SQL SECURITY DEFINER
AS SELECT today() AS day, toUInt64(1) AS total`
    const refresh = __testUtils.parseRefreshClause(cloudDdl)
    expect(refresh).toEqual({ every: '30 SECOND', append: true })
    // parseAsClause should also strip DEFINER/SQL SECURITY out of the AS body
    const asClause = __testUtils.parseAsClause(cloudDdl)
    expect(asClause).not.toContain('DEFINER')
    expect(asClause).not.toContain('SQL SECURITY')
    expect(asClause).toContain('SELECT today() AS day')
  })

  test('mapSystemTableRowToDefinition attaches parsed refresh metadata', () => {
    const definition = __testUtils.mapSystemTableRowToDefinition({
      database: 'app',
      name: 'mv',
      engine: 'MaterializedView',
      create_table_query:
        'CREATE MATERIALIZED VIEW app.mv REFRESH EVERY 1 HOUR APPEND TO app.t AS SELECT 1',
    })
    expect(definition).toEqual({
      kind: 'materialized_view',
      database: 'app',
      name: 'mv',
      to: { database: 'app', name: 't' },
      as: 'SELECT 1',
      refresh: { every: '1 HOUR', append: true },
    })
  })

  test('mapSystemTableRowToDefinition parses a dictionary row', () => {
    const definition = __testUtils.mapSystemTableRowToDefinition({
      database: 'app',
      name: 'users_dict',
      engine: 'Dictionary',
      create_table_query: `CREATE DICTIONARY app.users_dict
(
  \`id\` UInt64,
  \`name\` String
)
PRIMARY KEY id
SOURCE(MYSQL(host 'db' port 3306 user 'reader' password '[HIDDEN]' db 'app' table 'users'))
LAYOUT(HASHED())
LIFETIME(MIN 0 MAX 300)`,
    })
    expect(definition).toEqual({
      kind: 'dictionary',
      database: 'app',
      name: 'users_dict',
      attributes: [
        { name: 'id', type: 'UInt64' },
        { name: 'name', type: 'String' },
      ],
      primaryKey: ['id'],
      source: "MYSQL(host 'db' port 3306 user 'reader' password '[HIDDEN]' db 'app' table 'users')",
      layout: 'HASHED()',
      lifetime: 'MIN 0 MAX 300',
    })
  })

  test('mapSystemTableRowToDefinition parses a dictionary row with RANGE and SETTINGS', () => {
    const definition = __testUtils.mapSystemTableRowToDefinition({
      database: 'app',
      name: 'rates_dict',
      engine: 'Dictionary',
      create_table_query: `CREATE DICTIONARY app.rates_dict
(
  \`id\` UInt64,
  \`start_date\` DateTime,
  \`end_date\` DateTime
)
PRIMARY KEY id
SOURCE(HTTP(url 'http://example.com/rates' format 'TSV'))
LIFETIME(MIN 0 MAX 300)
LAYOUT(RANGE_HASHED())
RANGE(MIN start_date MAX end_date)
SETTINGS(dictionary_use_async_executor = 1)`,
    })
    expect(definition).toEqual({
      kind: 'dictionary',
      database: 'app',
      name: 'rates_dict',
      attributes: [
        { name: 'id', type: 'UInt64' },
        { name: 'start_date', type: 'DateTime' },
        { name: 'end_date', type: 'DateTime' },
      ],
      primaryKey: ['id'],
      source: "HTTP(url 'http://example.com/rates' format 'TSV')",
      layout: 'RANGE_HASHED()',
      lifetime: 'MIN 0 MAX 300',
      range: { min: 'start_date', max: 'end_date' },
      settings: { dictionary_use_async_executor: 1 },
    })
  })

  test('mapSystemTableRowToDefinition returns null for a dictionary with an unparsable query', () => {
    const definition = __testUtils.mapSystemTableRowToDefinition({
      database: 'app',
      name: 'broken_dict',
      engine: 'Dictionary',
      create_table_query: '',
    })
    expect(definition).toBeNull()
  })
})

describe('@chkit/plugin-pull skipped objects summary', () => {
  test('counts only unsupported or unparsed objects in selected databases', () => {
    const summary = __testUtils.summarizeSkippedObjects(
      [
        { kind: 'table', database: 'app', name: 'users' },
        { kind: 'view', database: 'app', name: 'users_view' },
        { kind: 'materialized_view', database: 'app', name: 'users_mv' },
        { kind: 'view', database: 'ignored_db', name: 'off_scope_view' },
      ],
      [
        {
          kind: 'table',
          database: 'app',
          name: 'users',
          engine: 'MergeTree()',
          columns: [{ name: 'id', type: 'UInt64' }],
          primaryKey: ['id'],
          orderBy: ['id'],
        },
        {
          kind: 'view',
          database: 'app',
          name: 'users_view',
          as: 'SELECT id FROM app.users',
        },
      ],
      ['app']
    )

    expect(summary).toEqual([{ kind: 'materialized_view', count: 1 }])
  })
})
