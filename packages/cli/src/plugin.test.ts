import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  BACKFILL_PLUGIN_ENTRY,
  CLI_ENTRY,
  CORE_ENTRY,
  PULL_PLUGIN_ENTRY,
  CODEGEN_PLUGIN_ENTRY,
  createFixture,
  runCli,
} from './testkit.test'

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

  test('chkit plugin backfill plan writes deterministic state artifact', async () => {
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

      const first = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T12:00:00.000Z',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(first.exitCode).toBe(0)
      const firstPayload = JSON.parse(first.stdout) as {
        ok: boolean
        planId: string
        chunkCount: number
        chunkHours: number
        existed: boolean
        planPath: string
      }
      expect(firstPayload.ok).toBe(true)
      expect(firstPayload.chunkCount).toBe(2)
      expect(firstPayload.chunkHours).toBe(6)
      expect(firstPayload.existed).toBe(false)
      expect(existsSync(firstPayload.planPath)).toBe(true)

      const second = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T12:00:00.000Z',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(second.exitCode).toBe(0)
      const secondPayload = JSON.parse(second.stdout) as {
        planId: string
        existed: boolean
      }
      expect(secondPayload.planId).toBe(firstPayload.planId)
      expect(secondPayload.existed).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin backfill run and status complete planned chunks', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin({ defaults: { chunkHours: 2 } })\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const planned = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T06:00:00.000Z',
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
      expect(runPayload.chunkCounts.done).toBe(3)
      expect(runPayload.chunkCounts.total).toBe(3)
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
        chunkCounts: { done: number; failed: number }
      }
      expect(statusPayload.status).toBe('completed')
      expect(statusPayload.chunkCounts.done).toBe(3)
      expect(statusPayload.chunkCounts.failed).toBe(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin backfill fail then resume without replaying done chunks', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin({ defaults: { chunkHours: 2, maxRetriesPerChunk: 1 } })\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const planned = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T06:00:00.000Z',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(planned.exitCode).toBe(0)
      const planPayload = JSON.parse(planned.stdout) as {
        planId: string
        planPath: string
      }
      const planState = JSON.parse(await readFile(planPayload.planPath, 'utf8')) as {
        chunks: Array<{ id: string }>
      }
      const failChunkId = planState.chunks[1]?.id
      expect(failChunkId).toBeTruthy()

      const failedRun = runCli([
        'plugin',
        'backfill',
        'run',
        '--plan-id',
        planPayload.planId,
        '--simulate-fail-chunk',
        failChunkId as string,
        '--simulate-fail-count',
        '1',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(failedRun.exitCode).toBe(1)
      const failedPayload = JSON.parse(failedRun.stdout) as {
        status: string
        chunkCounts: { done: number; failed: number }
      }
      expect(failedPayload.status).toBe('failed')
      expect(failedPayload.chunkCounts.done).toBe(1)
      expect(failedPayload.chunkCounts.failed).toBe(1)

      const resumed = runCli([
        'plugin',
        'backfill',
        'resume',
        '--plan-id',
        planPayload.planId,
        '--replay-failed',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(resumed.exitCode).toBe(0)
      const resumedPayload = JSON.parse(resumed.stdout) as {
        status: string
        chunkCounts: { done: number }
        runPath: string
      }
      expect(resumedPayload.status).toBe('completed')
      expect(resumedPayload.chunkCounts.done).toBe(3)

      const runState = JSON.parse(await readFile(resumedPayload.runPath, 'utf8')) as {
        chunks: Array<{ id: string; attempts: number }>
      }
      const firstChunkId = planState.chunks[0]?.id
      const firstChunk = runState.chunks.find((chunk) => chunk.id === firstChunkId)
      expect(firstChunk?.attempts).toBe(1)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit check --json includes backfill plugin result and fails on required pending backfill', async () => {
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

      const planned = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T06:00:00.000Z',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(planned.exitCode).toBe(0)

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        failedChecks: string[]
        plugins: {
          backfill?: {
            evaluated: boolean
            ok: boolean
            findingCodes: string[]
            requiredCount: number
            activeRuns: number
            failedRuns: number
          }
        }
      }
      expect(payload.ok).toBe(false)
      expect(payload.failedChecks).toContain('plugin:backfill')
      expect(payload.plugins.backfill?.evaluated).toBe(true)
      expect(payload.plugins.backfill?.ok).toBe(false)
      expect(payload.plugins.backfill?.findingCodes).toContain('backfill_required_pending')
      expect(payload.plugins.backfill?.requiredCount).toBe(1)
      expect(payload.plugins.backfill?.activeRuns).toBe(0)
      expect(payload.plugins.backfill?.failedRuns).toBe(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit check --json passes backfill plugin when required backfill is completed', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin({ defaults: { chunkHours: 2 } })\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const planned = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T06:00:00.000Z',
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
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(ran.exitCode).toBe(0)

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        failedChecks: string[]
        plugins: {
          backfill?: {
            evaluated: boolean
            ok: boolean
            findingCodes: string[]
            requiredCount: number
            failedRuns: number
          }
        }
      }
      expect(payload.ok).toBe(true)
      expect(payload.failedChecks).not.toContain('plugin:backfill')
      expect(payload.plugins.backfill?.evaluated).toBe(true)
      expect(payload.plugins.backfill?.ok).toBe(true)
      expect(payload.plugins.backfill?.findingCodes).toEqual([])
      expect(payload.plugins.backfill?.requiredCount).toBe(0)
      expect(payload.plugins.backfill?.failedRuns).toBe(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin backfill resume enforces compatibility check unless force override is provided', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin({ defaults: { chunkHours: 2, maxRetriesPerChunk: 1 } })\n`,
        'utf8'
      )
      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './backfill-plugin.ts', options: { defaults: { chunkHours: 2, maxRetriesPerChunk: 1 } } }],\n}\n`,
        'utf8'
      )

      const planned = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T06:00:00.000Z',
        '--config',
        fixture.configPath,
        '--json',
      ])
      const planPayload = JSON.parse(planned.stdout) as { planId: string; planPath: string }
      const planState = JSON.parse(await readFile(planPayload.planPath, 'utf8')) as {
        chunks: Array<{ id: string }>
      }

      const failed = runCli([
        'plugin',
        'backfill',
        'run',
        '--plan-id',
        planPayload.planId,
        '--simulate-fail-chunk',
        planState.chunks[1]?.id as string,
        '--simulate-fail-count',
        '1',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(failed.exitCode).toBe(1)

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './backfill-plugin.ts', options: { defaults: { chunkHours: 2, maxRetriesPerChunk: 5 } } }],\n}\n`,
        'utf8'
      )

      const blockedResume = runCli([
        'plugin',
        'backfill',
        'resume',
        '--plan-id',
        planPayload.planId,
        '--replay-failed',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(blockedResume.exitCode).toBe(2)
      expect(blockedResume.stdout).toContain('compatibility check failed')

      const forcedResume = runCli([
        'plugin',
        'backfill',
        'resume',
        '--plan-id',
        planPayload.planId,
        '--replay-failed',
        '--force-compatibility',
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(forcedResume.exitCode).toBe(0)
      const forcedPayload = JSON.parse(forcedResume.stdout) as { status: string }
      expect(forcedPayload.status).toBe('completed')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit plugin backfill cancel and doctor provide operator remediation flow', async () => {
    const fixture = await createFixture()
    const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
    try {
      await writeFile(
        pluginPath,
        `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport default createBackfillPlugin({ defaults: { chunkHours: 2, maxRetriesPerChunk: 1 } })\n`,
        'utf8'
      )
      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [{ resolve: './backfill-plugin.ts' }],\n}\n`,
        'utf8'
      )

      const planned = runCli([
        'plugin',
        'backfill',
        'plan',
        '--target',
        'app.users',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to',
        '2026-01-01T06:00:00.000Z',
        '--config',
        fixture.configPath,
        '--json',
      ])
      const planPayload = JSON.parse(planned.stdout) as { planId: string; planPath: string }
      const planState = JSON.parse(await readFile(planPayload.planPath, 'utf8')) as {
        chunks: Array<{ id: string }>
      }

      runCli([
        'plugin',
        'backfill',
        'run',
        '--plan-id',
        planPayload.planId,
        '--simulate-fail-chunk',
        planState.chunks[1]?.id as string,
        '--simulate-fail-count',
        '1',
        '--config',
        fixture.configPath,
        '--json',
      ])

      const cancelled = runCli([
        'plugin',
        'backfill',
        'cancel',
        '--plan-id',
        planPayload.planId,
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(cancelled.exitCode).toBe(0)
      const cancelPayload = JSON.parse(cancelled.stdout) as { status: string }
      expect(cancelPayload.status).toBe('cancelled')

      const doctor = runCli([
        'plugin',
        'backfill',
        'doctor',
        '--plan-id',
        planPayload.planId,
        '--config',
        fixture.configPath,
        '--json',
      ])
      expect(doctor.exitCode).toBe(1)
      const doctorPayload = JSON.parse(doctor.stdout) as {
        issueCodes: string[]
        recommendations: string[]
      }
      expect(doctorPayload.issueCodes).toContain('backfill_required_pending')
      expect(doctorPayload.recommendations.join(' ')).toContain('backfill resume')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

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
      expect(content).toContain('export interface AppUsersRow')
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
      expect(payload.error).toContain('Invalid plugin option "bigintMode"')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit check --json includes codegen plugin result and fails when output is missing', async () => {
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
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        failedChecks: string[]
        plugins: {
          codegen?: {
            evaluated: boolean
            ok: boolean
            findingCodes: string[]
            outFile: string
          }
        }
      }
      expect(payload.ok).toBe(false)
      expect(payload.failedChecks).toContain('plugin:codegen')
      expect(payload.plugins.codegen?.evaluated).toBe(true)
      expect(payload.plugins.codegen?.ok).toBe(false)
      expect(payload.plugins.codegen?.findingCodes).toContain('codegen_missing_output')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('chkit check --json passes plugin:codegen when output is current', async () => {
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
      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        failedChecks: string[]
        plugins: {
          codegen?: {
            evaluated: boolean
            ok: boolean
            findingCodes: string[]
          }
        }
      }
      expect(payload.ok).toBe(true)
      expect(payload.failedChecks).not.toContain('plugin:codegen')
      expect(payload.plugins.codegen?.evaluated).toBe(true)
      expect(payload.plugins.codegen?.ok).toBe(true)
      expect(payload.plugins.codegen?.findingCodes).toEqual([])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
