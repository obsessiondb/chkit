import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
    { name: "received_at", type: "DateTime64(3)", default: "fn:now64(3)" },
    { name: "source", type: "String", nullable: true, comment: "origin" },
    { name: "payload", type: "String", codec: [{ kind: "Delta", size: 4 }, codec.raw("LZ4"), { kind: "ZSTD", level: 1 }] },
  ],
  primaryKey: ["id"],
  orderBy: ["id", "received_at"],
  uniqueKey: ["id"],
  partitionBy: "toYYYYMM(received_at)",
  ttl: "received_at + INTERVAL 30 DAY",
  settings: {
    index_granularity: 8192,
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
    expect(content).toContain('default: "fn:now64(3)"')
    expect(content).toContain("export default schema(app_events)")
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

    expect(payload.ok).toBe(true)
    expect(payload.command).toBe('schema')
    expect(payload.dryrun).toBe(true)
    expect(payload.definitionCount).toBe(1)
    expect(payload.tableCount).toBe(1)
    expect(payload.content).toContain('const app_users = table({')
    expect(payload.content).toContain('default: "fn:\'\'"')
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
})

describe('@chkit/plugin-pull parser helpers', () => {
  test('parseAsClause extracts trailing query and trims semicolon', () => {
    const asClause = __testUtils.parseAsClause(`CREATE VIEW app.v AS
SELECT id
FROM app.users;`)
    expect(asClause).toBe('SELECT id\nFROM app.users')
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
