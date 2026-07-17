import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { ResolvedChxConfig, TableDefinition } from '@chkit/core'
import { collectDefinitionsFromModule, toCreateSQL } from '@chkit/core'
import { createClickHouseExecutor, type ClickHouseExecutor } from '@chkit/clickhouse'
import {
  getRequiredEnv,
  quoteIdent,
  createPrefix,
  waitForTable,
} from '@chkit/clickhouse/e2e-testkit'

import { createPullPlugin } from './index.js'

// A pulled schema imports from the '@chkit/core' package specifier, which does
// not resolve from a temp dir. Point it at the workspace source instead so the
// generated file can be imported back and rendered.
const CORE_ENTRY = join(import.meta.dir, '../../core/src/index.ts')

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
// Kept out of targetDatabase so the object-count assertions above stay stable.
const projectionDatabase = `chkit_e2e_pull_proj_${runTag}`

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

    await executor.command(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(targetDatabase)}`)
    await executor.command(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(noiseDatabase)}`)
    await executor.command(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(projectionDatabase)}`)
  })

  afterAll(async () => {
    try {
      await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(targetDatabase)}`)
    } catch {
      // Best-effort cleanup for shared e2e environment.
    }

    try {
      await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(noiseDatabase)}`)
    } catch {
      // Best-effort cleanup for shared e2e environment.
    }

    try {
      await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(projectionDatabase)}`)
    } catch {
      // Best-effort cleanup for shared e2e environment.
    }

    await executor.close()
  })

  test('validates required env variables are present', () => {
    expect(() => getRequiredEnv()).not.toThrow()
  })

  // Regression for #183: an index-only projection used to be dropped on pull,
  // so recreating from the pulled schema silently lost it. Recreating the table
  // from the pulled definition must reproduce the projection byte-for-byte,
  // which is also what makes drift read clean.
  test(
    'round-trips an index-only projection from live table through pull and back',
    async () => {
      const prefix = createPrefix('pull_proj')
      const sourceTable = `${prefix}counterparts`
      const recreatedTable = `${prefix}counterparts_copy`

      const dir = await mkdtemp(join(tmpdir(), 'chkit-plugin-pull-proj-e2e-'))
      const pulledSchemaPath = join(dir, 'pulled.ts')

      const plugin = createPullPlugin({ outFile: pulledSchemaPath, overwrite: true })
      const command = plugin.commands[0]
      if (!command) {
        throw new Error('Pull plugin command not registered')
      }

      try {
        await executor.command(
          `CREATE TABLE ${quoteIdent(projectionDatabase)}.${quoteIdent(sourceTable)} (sender String, receiver String, cnt UInt64, PROJECTION by_receiver INDEX (receiver, sender) TYPE basic, PROJECTION agg_by_sender (SELECT sender, sum(cnt) GROUP BY sender)) ENGINE = MergeTree() PRIMARY KEY (sender) ORDER BY (sender, receiver)`
        )
        await waitForTable(executor, projectionDatabase, sourceTable)

        const exitCode = await command.run({
          args: [],
          flags: { '--database': [projectionDatabase] },
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
          print() {},
        })
        expect(exitCode).toBe(0)

        const pulledSchema = await readFile(pulledSchemaPath, 'utf8')
        expect(pulledSchema).toContain(
          '{ name: "by_receiver", index: "(receiver, sender)", type: "basic" },'
        )
        expect(pulledSchema).toContain('{ name: "agg_by_sender", query:')

        // Load the pulled schema back and recreate the table from it — the
        // generate + migrate half of the round trip.
        const modulePath = join(dir, 'importable.ts')
        await writeFile(
          modulePath,
          pulledSchema.replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)),
          'utf8'
        )
        const pulledModule = await import(modulePath)
        const pulledDefinition = collectDefinitionsFromModule(pulledModule).find(
          (definition): definition is TableDefinition =>
            definition.kind === 'table' && definition.name === sourceTable
        )
        expect(pulledDefinition).toBeDefined()
        if (!pulledDefinition) throw new Error('pulled table definition missing')

        const createSQL = toCreateSQL({ ...pulledDefinition, name: recreatedTable })
        expect(createSQL).toContain('PROJECTION `by_receiver` INDEX (receiver, sender) TYPE basic')

        await executor.command(createSQL)
        await waitForTable(executor, projectionDatabase, recreatedTable)

        // The recreated table must be indistinguishable from the source as far
        // as projections go — that equality is exactly what drift compares.
        // Compare keyed by name, not by position: a pulled schema is
        // canonicalized into name order, while the live source keeps creation
        // order, and drift keys by name too.
        const details = await executor.listTableDetails([projectionDatabase])
        const byName = (table: { name: string } | undefined) =>
          [...(details.find((entry) => entry.name === table?.name)?.projections ?? [])].sort(
            (left, right) => left.name.localeCompare(right.name)
          )

        const sourceProjections = byName({ name: sourceTable })
        expect(sourceProjections).toEqual([
          { name: 'agg_by_sender', query: 'SELECT sender, sum(cnt) GROUP BY sender' },
          { name: 'by_receiver', index: '(receiver, sender)', type: 'basic' },
        ])
        expect(byName({ name: recreatedTable })).toEqual(sourceProjections)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    240_000
  )

  test(
    'pulls table fixtures from dedicated database and excludes out-of-scope objects',
    async () => {
      const prefix = createPrefix('pull_objects')
      const eventsTable = `${prefix}events`
      const accountsTable = `${prefix}accounts`
      const eventsView = `${prefix}events_view`
      const eventsRollupTable = `${prefix}events_rollup`
      const eventsMaterializedView = `${prefix}events_mv`
      const eventsRefreshableView = `${prefix}events_rmv`
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
        await executor.command(
          `CREATE TABLE ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)} (id UInt64, source String, received_at DateTime64(3) DEFAULT now64(3), ts DateTime CODEC(Delta, ZSTD)) ENGINE = MergeTree() PARTITION BY toYYYYMM(received_at) PRIMARY KEY (id) ORDER BY (id) SETTINGS index_granularity = 8192`
        )

        // Wait for table to be visible before creating dependent objects
        await waitForTable(executor, targetDatabase, eventsTable)

        await executor.command(
          `CREATE TABLE ${quoteIdent(targetDatabase)}.${quoteIdent(accountsTable)} (id UInt64, email Nullable(String), updated_at DateTime DEFAULT now()) ENGINE = MergeTree() PRIMARY KEY (id) ORDER BY (id)`
        )
        await executor.command(
          `CREATE VIEW ${quoteIdent(targetDatabase)}.${quoteIdent(eventsView)} AS SELECT id, source FROM ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)}`
        )
        await executor.command(
          `CREATE TABLE ${quoteIdent(targetDatabase)}.${quoteIdent(eventsRollupTable)} (id UInt64, c UInt64) ENGINE = MergeTree() ORDER BY (id)`
        )

        // Wait for rollup table before creating MV that depends on it
        await waitForTable(executor, targetDatabase, eventsRollupTable)

        await executor.command(
          `CREATE MATERIALIZED VIEW ${quoteIdent(targetDatabase)}.${quoteIdent(eventsMaterializedView)} TO ${quoteIdent(targetDatabase)}.${quoteIdent(eventsRollupTable)} AS SELECT id, count() AS c FROM ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)} GROUP BY id`
        )
        // Refreshable MV — must use APPEND on replicated (SharedMergeTree) targets,
        // per the ObsessionDB constraint verified on customer-benchmark.
        await executor.command(
          `CREATE MATERIALIZED VIEW ${quoteIdent(targetDatabase)}.${quoteIdent(eventsRefreshableView)} REFRESH EVERY 1 HOUR APPEND TO ${quoteIdent(targetDatabase)}.${quoteIdent(eventsRollupTable)} AS SELECT id, count() AS c FROM ${quoteIdent(targetDatabase)}.${quoteIdent(eventsTable)} GROUP BY id`
        )
        await executor.command(
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
        expect(payload.definitionCount).toBe(6)
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
        // Refreshable MV — assert the refresh block was parsed and rendered
        expect(pulledSchema).toContain(`name: "${eventsRefreshableView}"`)
        expect(pulledSchema).toContain('refresh: {')
        expect(pulledSchema).toContain('every: "1 HOUR",')
        expect(pulledSchema).toContain('append: true,')
        expect(pulledSchema).not.toContain('DEFINER')
        expect(pulledSchema).not.toContain('SQL SECURITY')
        expect(pulledSchema).not.toContain(noiseDatabase)

        // Codec column — assert structured codec is emitted and round-trips
        expect(pulledSchema).toContain('codec: [{ kind: "Delta"')
        expect(pulledSchema).toContain('{ kind: "ZSTD"')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    240_000
  )
})
