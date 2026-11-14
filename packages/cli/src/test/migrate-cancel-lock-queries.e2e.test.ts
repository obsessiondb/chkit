import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import {
  type CliResult,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  heldLockClaim,
  quoteIdent,
  startCli,
  waitForRows,
  waitForTable,
} from './e2e-testkit.js'

// #732: a run killed while its INSERT still loads on the server. The next run
// with --cancel-lock-queries replaces the target (new UUID, empty) before it
// reloads, so the stopped INSERT cannot add rows to the reloaded table.

const TIMEOUT_MS = 180_000
const ROWS = 32
// The declared cluster: the local stack's one-node `cluster`, or ObsessionDB's `default`.
const CLUSTER = process.env.CHKIT_E2E_TARGET === 'obsessiondb' ? 'default' : 'cluster'

interface Fixture {
  dir: string
  config: string
  database: string
  journalTable: string
  migration: string
  executor: ClickHouseExecutor
}

describe('migrate --cancel-lock-queries (#732)', () => {
  test('recovery replaces the target of a killed run, then reloads it exactly once', async () => {
    const fixture = await createFixture('cancel_lock')
    try {
      const killed = migrate(fixture)
      await waitForRows<{ n: string }>(fixture.executor, `SELECT toString(count()) AS n FROM ${table(fixture, 'events')}`, (rows) => Number(rows[0]?.n) > 0, 'the load stores rows')
      killed.kill()
      expect((await killed.result).exitCode).not.toBe(0)
      const before = await targetUUID(fixture)

      const claim = await heldLockClaim(fixture.executor, fixture.database, fixture.journalTable)
      const recovery = await migrate(fixture, ['--break-lock', claim, '--cancel-lock-queries']).result
      expect(recovery.exitCode, formatTestDiagnostic('recovery', recovery)).toBe(0)

      expect(await targetUUID(fixture)).not.toBe(before)
      expect(await countEvents(fixture)).toBe(ROWS)
      // The killed INSERT, if it still runs, writes to the replaced table only.
      await Bun.sleep(5_000)
      expect(await countEvents(fixture)).toBe(ROWS)
      expect(await journalStatuses(fixture)).toBe('completed')

      // The barrier is released: an ordinary run has nothing left to do.
      const rerun = await migrate(fixture).result
      expect(rerun.exitCode, formatTestDiagnostic('re-run', rerun)).toBe(0)
      expect(await countEvents(fixture)).toBe(ROWS)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)
})

function table(fixture: Fixture, name: string): string {
  return `${quoteIdent(fixture.database)}.${quoteIdent(name)}`
}

async function createFixture(label: string): Promise<Fixture> {
  const env = getLiveEnv()
  const prefix = createPrefix(label)
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const migrationsDir = join(dir, 'chkit/migrations')
  await mkdir(migrationsDir, { recursive: true })
  const database = `${prefix}db`
  const migration = `20990101000000_${prefix}load.sql`
  // About 8 s at 0.25 s per row, one row per block and part.
  await writeFile(
    join(migrationsDir, migration),
    [
      '-- operation: sql_statement key=statement:0 risk=safe',
      '-- before-retry: CREATE OR REPLACE TABLE events AS events',
      'INSERT INTO events SELECT id FROM frozen WHERE sleepEachRow(0.25) = 0;',
      '',
    ].join('\n'),
    'utf8',
  )
  const config = join(dir, 'clickhouse.config.ts')
  await writeFile(
    config,
    `export default {\n` +
      `  schema: '${join(dir, 'schema.ts')}',\n` +
      `  outDir: '${join(dir, 'chkit')}',\n` +
      `  migrationsDir: '${migrationsDir}',\n` +
      `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
      `  clickhouse: {\n` +
      `    url: '${env.clickhouseUrl}',\n` +
      `    username: '${env.clickhouseUser}',\n` +
      // The password reaches the CLI through its environment, not the file.
      `    password: process.env.CHKIT_E2E_PASSWORD,\n` +
      `    database: '${database}',\n` +
      `    cluster: '${CLUSTER}',\n` +
      `  },\n}\n`,
    'utf8',
  )
  const fixture: Fixture = {
    dir,
    config,
    database,
    journalTable: createJournalTableName(label),
    migration,
    executor: createLiveExecutor(env),
  }
  const { executor } = fixture
  await executor.command(`CREATE DATABASE ${quoteIdent(database)}`)
  // One-row granules keep the sleep per block below the server's limit.
  await executor.command(`CREATE TABLE ${table(fixture, 'frozen')} (id UInt64) ENGINE = MergeTree ORDER BY id SETTINGS index_granularity = 1`)
  await executor.command(`CREATE TABLE ${table(fixture, 'events')} (id UInt64) ENGINE = MergeTree ORDER BY id`)
  // A cluster journal is created ON CLUSTER with a replicated engine; the
  // local stack has no Keeper, so the journal exists before the first run.
  await executor.command(
    `CREATE TABLE ${table(fixture, fixture.journalTable)} (name String, applied_at DateTime64(3, 'UTC'), checksum String, ` +
      "chkit_version String, migration_completed Bool DEFAULT true, operations Array(Tuple(operation_index Int32, operation_key String, operation_type String, query_id String, status LowCardinality(String), started_at DateTime64(3, 'UTC'), finished_at Nullable(DateTime64(3, 'UTC')), last_error String)) DEFAULT [], " +
      'operation_fingerprints Array(String) DEFAULT []) ENGINE = ReplacingMergeTree(applied_at) ORDER BY (name) SETTINGS index_granularity = 1',
  )
  await waitForTable(executor, database, 'frozen')
  await waitForTable(executor, database, 'events')
  await waitForTable(executor, database, fixture.journalTable)
  await executor.command(`INSERT INTO ${table(fixture, 'frozen')} SELECT number FROM numbers(${ROWS})`)
  return fixture
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
  await fixture.executor.close()
  await rm(fixture.dir, { recursive: true, force: true })
}

function migrate(fixture: Fixture, extraArgs: string[] = []): { result: Promise<CliResult>; kill: () => void } {
  return startCli(fixture.dir, ['migrate', '--config', fixture.config, '--apply', '--json', '--setting', 'max_block_size=1,min_insert_block_size_rows=1,min_insert_block_size_bytes=0', ...extraArgs], {
    CHKIT_JOURNAL_TABLE: fixture.journalTable,
    CHKIT_E2E_PASSWORD: getLiveEnv().clickhousePassword,
    CI: '1',
  })
}

async function targetUUID(fixture: Fixture): Promise<string> {
  const [row] = await fixture.executor.query<{ uuid: string }>(
    `SELECT toString(uuid) AS uuid FROM system.tables WHERE database = '${fixture.database}' AND name = 'events'`,
  )
  return row?.uuid ?? ''
}

async function journalStatuses(fixture: Fixture): Promise<string> {
  const [row] = await fixture.executor.query<{ statuses: string }>(
    `SELECT arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses FROM ${table(fixture, fixture.journalTable)} FINAL ` +
      `WHERE name = '${fixture.migration}' SETTINGS select_sequential_consistency = 1`,
  )
  return row?.statuses ?? ''
}

async function countEvents(fixture: Fixture): Promise<number> {
  const [row] = await fixture.executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table(fixture, 'events')}`)
  return Number(row?.n)
}
