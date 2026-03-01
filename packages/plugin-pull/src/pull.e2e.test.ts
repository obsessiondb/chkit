import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { ResolvedChxConfig } from '@chkit/core'

import { createPullPlugin } from './index.js'

interface LiveEnv {
  clickhouseUrl: string
  clickhouseUser: string
  clickhousePassword: string
}

function getRequiredEnv(): LiveEnv {
  const clickhouseHost = process.env.CLICKHOUSE_HOST?.trim()
  const clickhouseUrl =
    process.env.CLICKHOUSE_URL?.trim() || (clickhouseHost ? `https://${clickhouseHost}` : '')
  const clickhouseUser = process.env.CLICKHOUSE_USER?.trim() || 'default'
  const clickhousePassword = process.env.CLICKHOUSE_PASSWORD?.trim() || ''

  if (!clickhouseUrl) {
    throw new Error('Missing CLICKHOUSE_URL or CLICKHOUSE_HOST')
  }

  if (!clickhousePassword) {
    throw new Error('Missing CLICKHOUSE_PASSWORD')
  }

  return { clickhouseUrl, clickhouseUser, clickhousePassword }
}

function quoteIdent(value: string): string {
  return '`' + value.replace(/`/g, '``') + '`'
}

async function runSql(url: string, username: string, password: string, sql: string): Promise<void> {
  const auth = Buffer.from(`${username}:${password}`).toString('base64')
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`ClickHouse SQL failed (${response.status}): ${body}`)
  }
}

async function dropDatabase(url: string, username: string, password: string, database: string): Promise<void> {
  await runSql(url, username, password, `DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
}

async function retry(attempts: number, delayMs: number, fn: () => Promise<void>): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fn()
      return
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

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

function createPrefix(label: string): string {
  return `chkit_e2e_pull_${label}_${Date.now()}_${Math.floor(Math.random() * 100000)}_`
}

const runTag = process.env.GITHUB_RUN_ID?.trim() || `${Date.now()}_${Math.floor(Math.random() * 100000)}`
const targetDatabase = `chkit_e2e_pull_${runTag}`
const noiseDatabase = `chkit_e2e_pull_noise_${runTag}`

describe('@chkit/plugin-pull live env e2e', () => {
  const liveEnv = getRequiredEnv()

  beforeAll(async () => {
    await retry(5, 1000, async () => {
      await runSql(
        liveEnv.clickhouseUrl,
        liveEnv.clickhouseUser,
        liveEnv.clickhousePassword,
        `CREATE DATABASE IF NOT EXISTS ${quoteIdent(targetDatabase)}`
      )
      await runSql(
        liveEnv.clickhouseUrl,
        liveEnv.clickhouseUser,
        liveEnv.clickhousePassword,
        `CREATE DATABASE IF NOT EXISTS ${quoteIdent(noiseDatabase)}`
      )
    })
  })

  afterAll(async () => {
    try {
      await dropDatabase(
        liveEnv.clickhouseUrl,
        liveEnv.clickhouseUser,
        liveEnv.clickhousePassword,
        targetDatabase
      )
    } catch {
      // Best-effort cleanup for shared e2e environment.
    }

    try {
      await dropDatabase(
        liveEnv.clickhouseUrl,
        liveEnv.clickhouseUser,
        liveEnv.clickhousePassword,
        noiseDatabase
      )
    } catch {
      // Best-effort cleanup for shared e2e environment.
    }
  })

  test('validates required env variables are present', () => {
    expect(() => getRequiredEnv()).not.toThrow()
  })

  test(
    'pulls table fixtures from dedicated database and excludes out-of-scope objects',
    async () => {
      const prefix = createPrefix('objects')
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
        // ClickHouse Cloud DDL is eventually consistent; retry the first table creation.
        await retry(3, 2000, () =>
          runSql(
            liveEnv.clickhouseUrl,
            liveEnv.clickhouseUser,
            liveEnv.clickhousePassword,
            `CREATE TABLE ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)} (id UInt64, source String, received_at DateTime64(3) DEFAULT now64(3)) ENGINE = MergeTree() PARTITION BY toYYYYMM(received_at) PRIMARY KEY (id) ORDER BY (id) SETTINGS index_granularity = 8192`
          )
        )
        await runSql(
          liveEnv.clickhouseUrl,
          liveEnv.clickhouseUser,
          liveEnv.clickhousePassword,
          `CREATE TABLE ${quoteIdent(targetDatabase)}.${quoteIdent(accountsTable)} (id UInt64, email Nullable(String), updated_at DateTime DEFAULT now()) ENGINE = MergeTree() PRIMARY KEY (id) ORDER BY (id)`
        )
        await runSql(
          liveEnv.clickhouseUrl,
          liveEnv.clickhouseUser,
          liveEnv.clickhousePassword,
          `CREATE VIEW ${quoteIdent(targetDatabase)}.${quoteIdent(eventsView)} AS SELECT id, source FROM ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)}`
        )
        await runSql(
          liveEnv.clickhouseUrl,
          liveEnv.clickhouseUser,
          liveEnv.clickhousePassword,
          `CREATE TABLE ${quoteIdent(targetDatabase)}.${quoteIdent(eventsRollupTable)} (id UInt64, c UInt64) ENGINE = MergeTree() ORDER BY (id)`
        )

        // ClickHouse Cloud DDL is eventually consistent; TO targets may lag visibility.
        await retry(5, 2000, () =>
          runSql(
            liveEnv.clickhouseUrl,
            liveEnv.clickhouseUser,
            liveEnv.clickhousePassword,
            `CREATE MATERIALIZED VIEW ${quoteIdent(targetDatabase)}.${quoteIdent(eventsMaterializedView)} TO ${quoteIdent(targetDatabase)}.${quoteIdent(eventsRollupTable)} AS SELECT id, count() AS c FROM ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)} GROUP BY id`
          )
        )
        await retry(3, 2000, () =>
          runSql(
            liveEnv.clickhouseUrl,
            liveEnv.clickhouseUser,
            liveEnv.clickhousePassword,
            `CREATE TABLE ${quoteIdent(noiseDatabase)}.${quoteIdent(noiseTable)} (id UInt64) ENGINE = MergeTree() ORDER BY (id)`
          )
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
