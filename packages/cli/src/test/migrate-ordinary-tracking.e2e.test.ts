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

// #733 review: query tracking must not change what an ordinary migrate needs
// or does. A user without the REMOTE grant applies as before (A), and a
// migrate with nothing pending exits without taking the lock (E).

const TIMEOUT_MS = 180_000
// The declared cluster: the local stack's one-node `cluster`, or ObsessionDB's `default`.
const CLUSTER = process.env.CHKIT_E2E_TARGET === 'obsessiondb' ? 'default' : 'cluster'
const PASSWORD = 'Restricted-e2e-Pw-733'

interface Fixture {
  root: string
  database: string
  journalTable: string
  user: string
  executor: ClickHouseExecutor
}

describe('ordinary migrate with query tracking (#733)', () => {
  test('a user without the REMOTE grant applies, re-runs and runs untracked or with tracking off', async () => {
    const fixture = await createFixture('track_remote')
    try {
      const project = await writeProject(fixture, 'restricted', ['INSERT INTO events SELECT number FROM numbers(3);'])
      const apply = await migrate(fixture, project, fixture.user, PASSWORD).result
      expect(apply.exitCode, formatTestDiagnostic('restricted apply', apply)).toBe(0)
      expect(await countEvents(fixture)).toBe(3)

      const noop = await migrate(fixture, project, fixture.user, PASSWORD).result
      expect(noop.exitCode, formatTestDiagnostic('restricted no-op', noop)).toBe(0)
      const off = await migrate(fixture, project, fixture.user, PASSWORD, { CHKIT_MIGRATE_QUERY_TRACKING: 'off' }).result
      expect(off.exitCode, formatTestDiagnostic('tracking off', off)).toBe(0)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)

  test('a migrate with nothing pending exits 0 while another run holds the lock', async () => {
    const fixture = await createFixture('track_noop')
    try {
      const env = getLiveEnv()
      // About 8 s at 0.25 s per row: long enough to hold the lock.
      const loading = await writeProject(fixture, 'loading', ['INSERT INTO events SELECT number FROM numbers(32) WHERE sleepEachRow(0.25) = 0;'])
      const empty = await writeProject(fixture, 'empty', [])
      const holder = migrate(fixture, loading, env.clickhouseUser, env.clickhousePassword)
      await waitForRows<{ n: string }>(
        fixture.executor,
        `SELECT toString(count()) AS n FROM ${table(fixture, fixture.journalTable)} WHERE startsWith(name, '__chkit_migrate_lock__/') SETTINGS select_sequential_consistency = 1`,
        (rows) => Number(rows[0]?.n) > 0,
        'the load holds the migrate lock',
      )
      const claim = await heldLockClaim(fixture.executor, fixture.database, fixture.journalTable)

      const noop = await migrate(fixture, empty, env.clickhouseUser, env.clickhousePassword).result
      expect(noop.exitCode, formatTestDiagnostic('no-op beside a held lock', noop)).toBe(0)
      // It wrote no claim of its own: the running load still holds the only one.
      expect(await heldLockClaim(fixture.executor, fixture.database, fixture.journalTable)).toBe(claim)

      const held = await holder.result
      expect(held.exitCode, formatTestDiagnostic('lock holder', held)).toBe(0)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)
})

function table(fixture: Fixture, name: string): string {
  return `${quoteIdent(fixture.database)}.${quoteIdent(name)}`
}

async function createFixture(label: string): Promise<Fixture> {
  const prefix = createPrefix(label)
  const root = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const fixture: Fixture = {
    root,
    database: `${prefix}db`,
    journalTable: createJournalTableName(label),
    user: `${prefix}user`,
    executor: createLiveExecutor(getLiveEnv()),
  }
  const { executor } = fixture
  await executor.command(`CREATE DATABASE ${quoteIdent(fixture.database)}`)
  await executor.command(`CREATE TABLE ${table(fixture, 'events')} (id UInt64) ENGINE = MergeTree ORDER BY id SETTINGS index_granularity = 1`)
  // A cluster journal is created ON CLUSTER with a replicated engine. The
  // test creates it first, as a plain table, so it does not depend on ON
  // CLUSTER DDL and runs the same on the local stack and on ObsessionDB.
  await executor.command(
    `CREATE TABLE ${table(fixture, fixture.journalTable)} (name String, applied_at DateTime64(3, 'UTC'), checksum String, ` +
      "chkit_version String, migration_completed Bool DEFAULT true, operations Array(Tuple(operation_index Int32, operation_key String, operation_type String, query_id String, status LowCardinality(String), started_at DateTime64(3, 'UTC'), finished_at Nullable(DateTime64(3, 'UTC')), last_error String)) DEFAULT [], " +
      'operation_fingerprints Array(String) DEFAULT []) ENGINE = ReplacingMergeTree(applied_at) ORDER BY (name) SETTINGS index_granularity = 1',
  )
  await waitForTable(executor, fixture.database, 'events')
  await waitForTable(executor, fixture.database, fixture.journalTable)
  // Everything on its own database, and nothing else: no REMOTE grant.
  await executor.command(`CREATE USER ${quoteIdent(fixture.user)} IDENTIFIED WITH sha256_password BY '${PASSWORD}'`)
  await executor.command(`GRANT SELECT, INSERT, CREATE TABLE, DROP TABLE, ALTER ON ${quoteIdent(fixture.database)}.* TO ${quoteIdent(fixture.user)}`)
  return fixture
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.command(`DROP USER IF EXISTS ${quoteIdent(fixture.user)}`)
  await fixture.executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
  await fixture.executor.close()
  await rm(fixture.root, { recursive: true, force: true })
}

/** A project directory with one migration per statement, against the fixture database. */
async function writeProject(fixture: Fixture, name: string, statements: string[]): Promise<{ dir: string; config: string }> {
  const env = getLiveEnv()
  const dir = join(fixture.root, name)
  const migrationsDir = join(dir, 'chkit/migrations')
  await mkdir(migrationsDir, { recursive: true })
  for (const [index, statement] of statements.entries()) {
    await writeFile(
      join(migrationsDir, `2099010100000${index}_${name}.sql`),
      ['-- operation: sql_statement key=statement:0 risk=safe', '-- before-retry: CREATE OR REPLACE TABLE events AS events', statement, ''].join('\n'),
      'utf8',
    )
  }
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
      `    username: process.env.CHKIT_E2E_USER,\n` +
      // The password reaches the CLI through its environment, not the file.
      `    password: process.env.CHKIT_E2E_PASSWORD,\n` +
      `    database: '${fixture.database}',\n` +
      `    cluster: '${CLUSTER}',\n` +
      `  },\n}\n`,
    'utf8',
  )
  return { dir, config }
}

function migrate(
  fixture: Fixture,
  project: { dir: string; config: string },
  user: string,
  password: string,
  extraEnv: Record<string, string> = {},
): { result: Promise<CliResult>; kill: () => void } {
  return startCli(project.dir, ['migrate', '--config', project.config, '--apply', '--json', '--setting', 'max_block_size=1,min_insert_block_size_rows=1,min_insert_block_size_bytes=0'], {
    CHKIT_JOURNAL_TABLE: fixture.journalTable,
    CHKIT_E2E_USER: user,
    CHKIT_E2E_PASSWORD: password,
    CI: '1',
    ...extraEnv,
  })
}

async function countEvents(fixture: Fixture): Promise<number> {
  const [row] = await fixture.executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table(fixture, 'events')}`)
  return Number(row?.n)
}
