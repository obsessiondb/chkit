import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { __testUtils, createPullPlugin, renderSchemaFile } from './index.js'

describe('@chx/plugin-pull renderSchemaFile', () => {
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

    expect(content).toContain("import { schema, table } from '@chx/core'")
    expect(content).toContain('const app_events = table({')
    expect(content).toContain('default: "fn:now64(3)"')
    expect(content).toContain("export default schema(app_events)")
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

    expect(content).toContain("import { schema, view, materializedView } from '@chx/core'")
    expect(content).toContain('const app_events_view = view({')
    expect(content).toContain('const app_events_mv = materializedView({')
    expect(content).toContain('to: { database: "app", name: "events_rollup" }')
    expect(content).toContain('export default schema(app_events_view, app_events_mv)')
  })
})

describe('@chx/plugin-pull schema command', () => {
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
      args: ['--dryrun'],
      jsonMode: true,
      options: {},
      configPath: '/tmp/clickhouse.config.ts',
      config: {
        schema: ['./schema.ts'],
        outDir: './chx',
        migrationsDir: './chx/migrations',
        metaDir: './chx/meta',
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
      args: ['--dryrun'],
      jsonMode: true,
      options: {},
      configPath: '/tmp/clickhouse.config.ts',
      config: {
        schema: ['./schema.ts'],
        outDir: './chx',
        migrationsDir: './chx/migrations',
        metaDir: './chx/meta',
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
    expect(payload.content).toContain("import { schema, table, view, materializedView } from '@chx/core'")
    expect(payload.content).toContain('const app_users_view = view({')
    expect(payload.content).toContain('const app_users_mv = materializedView({')
  })

  test('writes schema file and fails on existing file without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chx-plugin-pull-'))
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

    const run = async (args: string[]): Promise<{ code: undefined | number; output: unknown[] }> => {
      const output: unknown[] = []
      const code = await command.run({
        args,
        jsonMode: true,
        options: {},
        configPath: '/tmp/clickhouse.config.ts',
        config: {
          schema: ['./schema.ts'],
          outDir: './chx',
          migrationsDir: './chx/migrations',
          metaDir: './chx/meta',
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
      const first = await run([])
      expect(first.code).toBe(0)
      const written = await readFile(outFile, 'utf8')
      expect(written).toContain('const app_users = table({')

      await writeFile(outFile, '// existing\n', 'utf8')
      const second = await run([])
      expect(second.code).toBe(2)
      expect(second.output[0]).toEqual({
        ok: false,
        command: 'schema',
        error: `Output file already exists at ${outFile}. Re-run with --force or set plugin option overwrite=true.`,
      })

      const third = await run(['--force'])
      expect(third.code).toBe(0)
      const forced = await readFile(outFile, 'utf8')
      expect(forced).toContain('export default schema(app_users)')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('@chx/plugin-pull parser helpers', () => {
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
})

describe('@chx/plugin-pull skipped objects summary', () => {
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
