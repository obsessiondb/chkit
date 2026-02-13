import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createPullPlugin, renderSchemaFile } from './index.js'

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
      tableCount: number
      content: string
    }

    expect(payload.ok).toBe(true)
    expect(payload.command).toBe('schema')
    expect(payload.dryrun).toBe(true)
    expect(payload.tableCount).toBe(1)
    expect(payload.content).toContain('const app_users = table({')
    expect(payload.content).toContain('default: "fn:\'\'"')
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
