import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createClickHouseExecutor } from '@chkit/clickhouse'

import {
  BACKFILL_PLUGIN_ENTRY,
  CLI_ENTRY,
  CORE_ENTRY,
  PULL_PLUGIN_ENTRY,
  CODEGEN_PLUGIN_ENTRY,
  createFixture,
  runCli,
} from './testkit.test'

function getClickHouseEnv(): {
  url: string
  username: string
  password: string
  database: string
} {
  const host = process.env.CLICKHOUSE_HOST?.trim()
  const url = process.env.CLICKHOUSE_URL?.trim() || (host ? `https://${host}` : '')
  const username = process.env.CLICKHOUSE_USER?.trim() || 'default'
  const password = process.env.CLICKHOUSE_PASSWORD?.trim() || ''
  const database = process.env.CLICKHOUSE_DB?.trim() || 'default'
  if (!url) throw new Error('Missing CLICKHOUSE_URL or CLICKHOUSE_HOST')
  if (!password) throw new Error('Missing CLICKHOUSE_PASSWORD')
  return { url, username, password, database }
}

function clickhouseConfigBlock(env: { url: string; username: string; password: string; database: string }): string {
  return `clickhouse: {\n    url: '${env.url}',\n    username: '${env.username}',\n    password: '${env.password}',\n    database: '${env.database}',\n  },`
}

async function waitForParts(
  db: ReturnType<typeof createClickHouseExecutor>,
  database: string,
  table: string,
  expectedPartitions: number,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      // Sync replica state for the target table first, then check system.parts
      await db.query(`SELECT 1 FROM ${database}.${table} LIMIT 1 SETTINGS select_sequential_consistency = 1`)
    } catch {
      // Table may not be visible yet on managed ClickHouse (DDL propagation)
      await new Promise((r) => setTimeout(r, 500))
      continue
    }
    const rows = await db.query<{ cnt: string }>(
      `SELECT count(DISTINCT partition) AS cnt FROM system.parts WHERE database = '${database}' AND table = '${table}' AND active SETTINGS select_sequential_consistency = 1`
    )
    const count = Number(rows[0]?.cnt ?? 0)
    if (count >= expectedPartitions) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for ${expectedPartitions} partitions in ${database}.${table}`)
}

describe('plugin runtime', () => {
  test('generate --dryrun --json applies onPlanCreated hook output', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'plan-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport default definePlugin({\n  manifest: { name: 'plan-augment', apiVersion: 1 },\n  hooks: {\n    onPlanCreated({ plan }) {\n      return {\n        ...plan,\n        operations: [\n          ...plan.operations,\n          {\n            type: 'create_database',\n            key: 'database:plugin_db',\n            risk: 'safe',\n            sql: 'CREATE DATABASE IF NOT EXISTS plugin_db;',\n          },\n        ],\n        riskSummary: {\n          safe: plan.riskSummary.safe + 1,\n          caution: plan.riskSummary.caution,\n          danger: plan.riskSummary.danger,\n        },\n      }\n    },\n  },\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './plan-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        operations: Array<{ key: string; type: string }>
      }
      expect(payload.operations.some((operation) => operation.key === 'database:plugin_db')).toBe(true)
      expect(payload.operations.some((operation) => operation.type === 'create_database')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('plugin command namespace executes configured plugin command', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'commands-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport default definePlugin({\n  manifest: { name: 'echoer', apiVersion: 1 },\n  commands: [\n    {\n      name: 'echo',\n      description: 'Echo args for tests',\n      run({ args, jsonMode, print }) {\n        if (jsonMode) {\n          print({ ok: true, args })\n          return\n        }\n        print(args.join(','))\n      },\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './commands-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'plugin',
        'echoer',
        'echo',
        'alpha',
        'beta',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { ok: boolean; args: string[] }
      expect(payload.ok).toBe(true)
      expect(payload.args).toEqual(['alpha', 'beta'])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('onBeforePluginCommand intercepts another plugin command', async () => {
    const fixture = await createFixture()
    const targetPath = join(fixture.dir, 'target-plugin.ts')
    const interceptorPath = join(fixture.dir, 'interceptor-plugin.ts')
    try {
      await writeFile(
        targetPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport default definePlugin({\n  manifest: { name: 'target', apiVersion: 1 },\n  commands: [\n    {\n      name: 'greet',\n      description: 'Original greet',\n      run({ print }) {\n        print({ source: 'original' })\n        return 0\n      },\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        interceptorPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport default definePlugin({\n  manifest: { name: 'interceptor', apiVersion: 1 },\n  hooks: {\n    onBeforePluginCommand(context) {\n      if (context.targetPlugin === 'target' && context.command === 'greet') {\n        context.print({ source: 'intercepted', target: context.targetPlugin })\n        return { handled: true, exitCode: 0 }\n      }\n      return { handled: false }\n    },\n  },\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [\n    { resolve: './target-plugin.ts' },\n    { resolve: './interceptor-plugin.ts' },\n  ],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'plugin',
        'target',
        'greet',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { source: string; target: string }
      expect(payload.source).toBe('intercepted')
      expect(payload.target).toBe('target')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('onBeforePluginCommand returning handled: false falls through to original', async () => {
    const fixture = await createFixture()
    const targetPath = join(fixture.dir, 'target-plugin.ts')
    const interceptorPath = join(fixture.dir, 'interceptor-plugin.ts')
    try {
      await writeFile(
        targetPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport default definePlugin({\n  manifest: { name: 'target', apiVersion: 1 },\n  commands: [\n    {\n      name: 'greet',\n      description: 'Original greet',\n      run({ print }) {\n        print({ source: 'original' })\n        return 0\n      },\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        interceptorPath,
        `import { definePlugin } from '${CLI_ENTRY}'\n\nexport default definePlugin({\n  manifest: { name: 'interceptor', apiVersion: 1 },\n  hooks: {\n    onBeforePluginCommand() {\n      return { handled: false }\n    },\n  },\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [\n    { resolve: './target-plugin.ts' },\n    { resolve: './interceptor-plugin.ts' },\n  ],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'plugin',
        'target',
        'greet',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { source: string }
      expect(payload.source).toBe('original')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('plugin pull schema command writes pulled schema artifact', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'pull-plugin.ts')
    const outFile = join(fixture.dir, 'pulled-schema.ts')

    try {
      await writeFile(
        pluginPath,
        `import { createPullPlugin } from '${PULL_PLUGIN_ENTRY}'\n\nexport default createPullPlugin({\n  outFile: '${outFile}',\n  databases: ['app'],\n  introspect: async () => [\n    {\n      database: 'app',\n      name: 'users',\n      engine: 'MergeTree()',\n      primaryKey: '(id)',\n      orderBy: '(id)',\n      columns: [\n        { name: 'id', type: 'UInt64' },\n        { name: 'email', type: 'String' },\n      ],\n      settings: {},\n      indexes: [],\n      projections: [],\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  clickhouse: {\n    url: 'http://localhost:8123',\n    username: 'default',\n    password: '',\n    database: 'default',\n  },\n  plugins: [{ resolve: './pull-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli([
        'plugin',
        'pull',
        'schema',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        command: string
        outFile: string
        tableCount: number
      }
      expect(payload.ok).toBe(true)
      expect(payload.command).toBe('schema')
      expect(payload.outFile).toBe(outFile)
      expect(payload.tableCount).toBe(1)
      expect(existsSync(outFile)).toBe(true)
      const content = await readFile(outFile, 'utf8')
      expect(content).toContain('const app_users = table({')
      expect(content).toContain('export default schema(app_users)')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('pull root command runs pull plugin schema command', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'pull-plugin.ts')
    const outFile = join(fixture.dir, 'pulled-schema-root.ts')

    try {
      await writeFile(
        pluginPath,
        `import { createPullPlugin } from '${PULL_PLUGIN_ENTRY}'\n\nexport default createPullPlugin({\n  outFile: '${outFile}',\n  databases: ['app'],\n  introspect: async () => [\n    {\n      database: 'app',\n      name: 'events',\n      engine: 'MergeTree()',\n      primaryKey: '(id)',\n      orderBy: '(id)',\n      columns: [\n        { name: 'id', type: 'UInt64' },\n      ],\n      settings: {},\n      indexes: [],\n      projections: [],\n    },\n  ],\n})\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  clickhouse: {\n    url: 'http://localhost:8123',\n    username: 'default',\n    password: '',\n    database: 'default',\n  },\n  plugins: [{ resolve: './pull-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['pull', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { ok: boolean; command: string; tableCount: number }
      expect(payload.ok).toBe(true)
      expect(payload.command).toBe('schema')
      expect(payload.tableCount).toBe(1)
      expect(existsSync(outFile)).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin backfill plan writes state artifact', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_plan_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin()\n`,
          'utf8'
        )

        await writeFile(
          fixture.configPath,
          `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
          'utf8'
        )

        const result = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(result.exitCode).toBe(0)
        const payload = JSON.parse(result.stdout) as {
          ok: boolean
          planId: string
          chunkCount: number
          planPath: string
        }
        expect(payload.ok).toBe(true)
        expect(payload.planId).toMatch(/^[a-f0-9]{16}$/)
        expect(payload.chunkCount).toBeGreaterThanOrEqual(1)
        expect(existsSync(payload.planPath)).toBe(true)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit plugin backfill run and status complete planned chunks', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_run_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin()\n`,
          'utf8'
        )

        await writeFile(
          fixture.configPath,
          `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
          'utf8'
        )

        const planned = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(planned.exitCode).toBe(0)
        const planPayload = JSON.parse(planned.stdout) as { planId: string }

        const ran = runCli([
          'plugin',
          'backfill',
          'run',
          '--plan-id',
          planPayload.planId,
          '--poll-interval',
          '1000',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(ran.exitCode).toBe(0)
        const runPayload = JSON.parse(ran.stdout) as {
          status: string
          chunkCounts: { done: number; total: number; failed: number }
        }
        expect(runPayload.status).toBe('completed')
        expect(runPayload.chunkCounts.total).toBeGreaterThanOrEqual(1)
        expect(runPayload.chunkCounts.done).toBe(runPayload.chunkCounts.total)
        expect(runPayload.chunkCounts.failed).toBe(0)

        const status = runCli([
          'plugin',
          'backfill',
          'status',
          '--plan-id',
          planPayload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(status.exitCode).toBe(0)
        const statusPayload = JSON.parse(status.stdout) as {
          status: string
          chunkCounts: { done: number; total: number; failed: number }
        }
        expect(statusPayload.status).toBe('completed')
        expect(statusPayload.chunkCounts.done).toBe(statusPayload.chunkCounts.total)
        expect(statusPayload.chunkCounts.failed).toBe(0)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit plugin backfill resume on completed run is a no-op', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_resume_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin()\n`,
          'utf8'
        )

        await writeFile(
          fixture.configPath,
          `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
          'utf8'
        )

        const planned = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(planned.exitCode).toBe(0)
        const planPayload = JSON.parse(planned.stdout) as { planId: string }

        const ran = runCli([
          'plugin',
          'backfill',
          'run',
          '--plan-id',
          planPayload.planId,
          '--poll-interval',
          '1000',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(ran.exitCode).toBe(0)
        const ranPayload = JSON.parse(ran.stdout) as { status: string }
        expect(ranPayload.status).toBe('completed')

        const resumed = runCli([
          'plugin',
          'backfill',
          'resume',
          '--plan-id',
          planPayload.planId,
          '--poll-interval',
          '1000',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(resumed.exitCode).toBe(0)
        const resumedPayload = JSON.parse(resumed.stdout) as { noop?: boolean }
        expect(resumedPayload.noop).toBe(true)
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit check --json requires clickhouse config', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for check')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit check --json requires clickhouse config even with completed backfill', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin({ chunkHours: 2 })\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for check')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin backfill resume requires existing run state', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_compat_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin()\n`,
          'utf8'
        )
        await writeFile(
          fixture.configPath,
          `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
          'utf8'
        )

        const planned = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(planned.exitCode).toBe(0)
        const planPayload = JSON.parse(planned.stdout) as { planId: string }

        const blockedResume = runCli([
          'plugin',
          'backfill',
          'resume',
          '--plan-id',
          planPayload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(blockedResume.exitCode).toBe(2)
        expect(blockedResume.stdout).toContain('Run state not found')
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit plugin backfill cancel and doctor provide operator remediation flow', async () => {
    const chEnv = getClickHouseEnv()
    const chConfig = clickhouseConfigBlock(chEnv)
    const tableName = `chkit_e2e_bf_doctor_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const db = createClickHouseExecutor(chEnv)
    try {
      await db.command(`CREATE TABLE ${chEnv.database}.${tableName} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (1, '2026-01-01 12:00:00'), (2, '2026-01-02 12:00:00')`)
      await waitForParts(db, chEnv.database, tableName, 2)

      const fixture = await createFixture()
      const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
      try {
        await writeFile(
          pluginPath,
          `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin()\n`,
          'utf8'
        )
        await writeFile(
          fixture.configPath,
          `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  ${chConfig}\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
          'utf8'
        )

        const planned = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2026-01-03T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        const planPayload = JSON.parse(planned.stdout) as { planId: string }

        runCli([
          'plugin',
          'backfill',
          'run',
          '--plan-id',
          planPayload.planId,
          '--poll-interval',
          '1000',
          '--config',
          fixture.configPath,
          '--json',
        ])

        // Doctor on completed run should report no issues
        const doctorOk = runCli([
          'plugin',
          'backfill',
          'doctor',
          '--plan-id',
          planPayload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(doctorOk.exitCode).toBe(0)

        // Cancel on completed run should fail
        const cancelCompleted = runCli([
          'plugin',
          'backfill',
          'cancel',
          '--plan-id',
          planPayload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(cancelCompleted.exitCode).toBe(2)
        expect(cancelCompleted.stdout).toContain('already completed')

        // Insert data for the second plan's time range
        await db.command(`INSERT INTO ${chEnv.database}.${tableName} VALUES (4, '2026-01-05 12:00:00'), (5, '2026-01-06 12:00:00')`)
        await waitForParts(db, chEnv.database, tableName, 4)

        // Plan a second backfill that we won't run — doctor should flag it
        const planned2 = runCli([
          'plugin',
          'backfill',
          'plan',
          '--target',
          `${chEnv.database}.${tableName}`,
          '--from',
          '2026-01-04T00:00:00.000Z',
          '--to',
          '2026-01-07T00:00:00.000Z',
          '--config',
          fixture.configPath,
          '--json',
        ])
        const plan2Payload = JSON.parse(planned2.stdout) as { planId: string }

        const doctor2 = runCli([
          'plugin',
          'backfill',
          'doctor',
          '--plan-id',
          plan2Payload.planId,
          '--config',
          fixture.configPath,
          '--json',
        ])
        expect(doctor2.exitCode).toBe(1)
        const doctorPayload = JSON.parse(doctor2.stdout) as {
          issueCodes: string[]
          recommendations: string[]
        }
        expect(doctorPayload.issueCodes).toContain('backfill_plan_missing')
        expect(doctorPayload.recommendations.join(' ')).toContain('backfill run')
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    } finally {
      await db.command(`DROP TABLE IF EXISTS ${chEnv.database}.${tableName}`)
      await db.close()
    }
  }, 120_000)

  test('chkit codegen writes output file', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './codegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        outFile: string
        mode: string
      }
      expect(payload.ok).toBe(true)
      expect(payload.mode).toBe('write')
      expect(payload.outFile).toBe(outFile)

      const content = await readFile(outFile, 'utf8')
      expect(content).toContain('export type AppUsersRow = {')
      expect(content.endsWith('\n')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit codegen writes output file with typed inline plugin registration', async () => {
    const fixture = await createFixture()
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        fixture.configPath,
        `import { defineConfig } from '${CORE_ENTRY}'\nimport { codegen } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default defineConfig({\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [codegen({ outFile: './src/generated/chkit-types.ts' })],\n})\n`,
        'utf8'
      )

      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        outFile: string
        mode: string
      }
      expect(payload.ok).toBe(true)
      expect(payload.mode).toBe('write')
      expect(payload.outFile).toBe(outFile)
      expect(existsSync(outFile)).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit generate runs codegen plugin when runOnGenerate is enabled', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './codegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(result.exitCode).toBe(0)
      expect(existsSync(outFile)).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit generate skips codegen plugin when runOnGenerate is false', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './codegen-plugin.ts', options: { runOnGenerate: false } }],\n}\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(result.exitCode).toBe(0)
      expect(existsSync(outFile)).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit codegen --check passes when output is up-to-date', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './codegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      runCli(['codegen', '--config', fixture.configPath, '--json'])
      const result = runCli(['codegen', '--check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { ok: boolean; mode: string; findingCodes: string[] }
      expect(payload.ok).toBe(true)
      expect(payload.mode).toBe('check')
      expect(payload.findingCodes).toEqual([])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit codegen --check fails on drifted output', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    const outFile = join(fixture.dir, 'src/generated/chkit-types.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './codegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      runCli(['codegen', '--config', fixture.configPath, '--json'])
      await writeFile(outFile, '// drifted\n', 'utf8')
      const result = runCli(['codegen', '--check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as { ok: boolean; findingCodes: string[]; mode: string }
      expect(payload.ok).toBe(false)
      expect(payload.mode).toBe('check')
      expect(payload.findingCodes.length).toBe(1)
      expect(['codegen_stale_output', 'codegen_missing_output']).toContain(payload.findingCodes[0])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('codegen root command fails when codegen plugin is not configured', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Codegen plugin is not configured')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('pull root command fails when pull plugin is not configured', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['pull', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Pull plugin is not configured')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('codegen returns exit code 2 for invalid plugin options', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './codegen-plugin.ts', options: { bigintMode: 'nope' } }],\n}\n`,
        'utf8'
      )

      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(2)
      const payload = JSON.parse(result.stdout) as { ok: boolean; error: string }
      expect(payload.ok).toBe(false)
      expect(payload.error).toContain('bigintMode:')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit check --json requires clickhouse config with codegen plugin', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'codegen-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createCodegenPlugin } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default createCodegenPlugin()\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './codegen-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for check')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
