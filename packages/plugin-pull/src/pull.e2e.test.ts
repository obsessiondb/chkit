import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { ResolvedChxConfig } from '@chkit/core'
import { createClickHouseExecutor, type ClickHouseExecutor } from '@chkit/clickhouse'
import {
  getRequiredEnv,
  quoteIdent,
  createPrefix,
  waitForTable,
} from '@chkit/clickhouse/e2e-testkit'

import { createPullPlugin } from './index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createResolvedConfig(clickhouse: NonNullable<ResolvedChxConfig['clickhouse']>): ResolvedChxConfig {
  return {
    schema: ['./placeholder-schema.ts'],
    outDir: './chkit',
    migrationsDir: './chkit/migrations',
    metaDir: './chkit/meta',
    plugins: [],
    check: {
      failOnPending: true,
      failOnChecksumMismatch: true,
      failOnDrift: true,
    },
    safety: {
      allowDestructive: false,
    },
    clickhouse,
  }
}

const runTag = process.env.GITHUB_RUN_ID?.trim() || `${Date.now()}_${Math.floor(Math.random() * 100000)}`
const targetDatabase = `chkit_e2e_pull_${runTag}`
const noiseDatabase = `chkit_e2e_pull_noise_${runTag}`

describe('@chkit/plugin-pull live env e2e', () => {
  const liveEnv = getRequiredEnv()
  let executor: ClickHouseExecutor

  beforeAll(async () => {
    executor = createClickHouseExecutor({
      url: liveEnv.clickhouseUrl,
      username: liveEnv.clickhouseUser,
      password: liveEnv.clickhousePassword,
      database: 'default',
    })

    await executor.execute(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(targetDatabase)}`)
    await executor.execute(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(noiseDatabase)}`)
  })

  afterAll(async () => {
    try {
      await executor.execute(`DROP DATABASE IF EXISTS ${quoteIdent(targetDatabase)}`)
    } catch {
      // Best-effort cleanup for shared e2e environment.
    }

    try {
      await executor.execute(`DROP DATABASE IF EXISTS ${quoteIdent(noiseDatabase)}`)
    } catch {
      // Best-effort cleanup for shared e2e environment.
    }

    await executor.close()
  })

  test('validates required env variables are present', () => {
    expect(() => getRequiredEnv()).not.toThrow()
  })

  test(
    'pulls table fixtures from dedicated database and excludes out-of-scope objects',
    async () => {
      const prefix = createPrefix('pull_objects')
      const eventsTable = `${prefix}events`
      const accountsTable = `${prefix}accounts`
      const eventsView = `${prefix}events_view`
      const eventsRollupTable = `${prefix}events_rollup`
      const eventsMaterializedView = `${prefix}events_mv`
      const noiseTable = `${prefix}noise_table`

      const dir = await mkdtemp(join(tmpdir(), 'chkit-plugin-pull-e2e-'))
      const pulledSchemaPath = join(dir, 'src/db/schema/pulled.ts')

      const plugin = createPullPlugin({
        outFile: pulledSchemaPath,
        overwrite: true,
      })
      const command = plugin.commands[0]
      if (!command) {
        throw new Error('Pull plugin command not registered')
      }

      try {
        await executor.execute(
          `CREATE TABLE ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)} (id UInt64, source String, received_at DateTime64(3) DEFAULT now64(3)) ENGINE = MergeTree() PARTITION BY toYYYYMM(received_at) PRIMARY KEY (id) ORDER BY (id) SETTINGS index_granularity = 8192`
        )

        // Wait for table to be visible before creating dependent objects
        await waitForTable(executor, targetDatabase, eventsTable)

        await executor.execute(
          `CREATE TABLE ${quoteIdent(targetDatabase)}.${quoteIdent(accountsTable)} (id UInt64, email Nullable(String), updated_at DateTime DEFAULT now()) ENGINE = MergeTree() PRIMARY KEY (id) ORDER BY (id)`
        )
        await executor.execute(
          `CREATE VIEW ${quoteIdent(targetDatabase)}.${quoteIdent(eventsView)} AS SELECT id, source FROM ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)}`
        )
        await executor.execute(
          `CREATE TABLE ${quoteIdent(targetDatabase)}.${quoteIdent(eventsRollupTable)} (id UInt64, c UInt64) ENGINE = MergeTree() ORDER BY (id)`
        )

        // Wait for rollup table before creating MV that depends on it
        await waitForTable(executor, targetDatabase, eventsRollupTable)

        await executor.execute(
          `CREATE MATERIALIZED VIEW ${quoteIdent(targetDatabase)}.${quoteIdent(eventsMaterializedView)} TO ${quoteIdent(targetDatabase)}.${quoteIdent(eventsRollupTable)} AS SELECT id, count() AS c FROM ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)} GROUP BY id`
        )
        await executor.execute(
          `CREATE TABLE ${quoteIdent(noiseDatabase)}.${quoteIdent(noiseTable)} (id UInt64) ENGINE = MergeTree() ORDER BY (id)`
        )

        const output: unknown[] = []
        const exitCode = await command.run({
          args: [],
          flags: { '--database': [targetDatabase] },
          jsonMode: true,
          options: {},
          configPath: join(dir, 'clickhouse.config.ts'),
          config: createResolvedConfig({
            url: liveEnv.clickhouseUrl,
            username: liveEnv.clickhouseUser,
            password: liveEnv.clickhousePassword,
            database: 'default',
            secure: liveEnv.clickhouseUrl.startsWith('https://'),
          }),
          print(value) {
            output.push(value)
          },
        })

        expect(exitCode).toBe(0)

        const payload = output[0] as {
          ok: boolean
          command: string
          outFile: string
          definitionCount: number
          tableCount: number
          databases: string[]
        }
        expect(payload.ok).toBe(true)
        expect(payload.command).toBe('schema')
        expect(payload.definitionCount).toBe(5)
        expect(payload.tableCount).toBe(3)
        expect(payload.databases).toEqual([targetDatabase])
        expect(payload.outFile).toBe(pulledSchemaPath)

        const pulledSchema = await readFile(pulledSchemaPath, 'utf8')
        expect(pulledSchema).toContain(`database: "${targetDatabase}"`)
        expect(pulledSchema).toContain(`name: "${eventsTable}"`)
        expect(pulledSchema).toContain(`name: "${accountsTable}"`)
        expect(pulledSchema).toContain('default: "fn:now64(3)"')
        expect(pulledSchema).toContain('nullable: true')
        expect(pulledSchema).toContain('partitionBy: "toYYYYMM(received_at)"')
        expect(pulledSchema).toContain(`name: "${eventsView}"`)
        expect(pulledSchema).toContain(`name: "${eventsMaterializedView}"`)
        expect(pulledSchema).toContain('materializedView({')
        expect(pulledSchema).not.toContain(noiseDatabase)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    240_000
  )
})
