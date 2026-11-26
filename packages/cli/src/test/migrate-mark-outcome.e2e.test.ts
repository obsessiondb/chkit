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
  pollUntil,
  quoteIdent,
  startCli,
  waitForRows,
  waitForTable,
} from './e2e-testkit.js'

// After async_outcome_unknown, --mark-applied / --mark-not-applied record the
// outcome of the stopped statement only: the statements the journal records
// as completed do not run again, as they do after --abandon.

const TIMEOUT_MS = 180_000
const ROWS = 8
// The load fails on this row while the database's fail_marker has a row.
const FAIL_AT = 3

interface Fixture {
  dir: string
  config: string
  database: string
  journalTable: string
  migration: string
  executor: ClickHouseExecutor
}

describe('migrate --mark-applied / --mark-not-applied', () => {
  test('--mark-not-applied runs the stopped load again after its before-retry SQL, and not the statement before it', async () => {
    const fixture = await createFixture('mark_not_applied')
    try {
      await stopOnUnknownOutcome(fixture)

      await fixture.executor.command(`TRUNCATE TABLE ${table(fixture, 'fail_marker')}`)
      const marked = await migrate(fixture, ['--mark-not-applied', fixture.migration]).result
      expect(marked.exitCode, formatTestDiagnostic('mark', marked)).toBe(0)
      expect(JSON.parse(marked.stdout).mark).toMatchObject({ outcome: 'not-applied', operation: { operationIndex: 1 } })

      const resumed = await migrate(fixture).result
      expect(resumed.exitCode, formatTestDiagnostic('resume', resumed)).toBe(0)
      expect(resumed.stderr).toContain('load_table_data: running before-retry SQL')
      expect(await count(fixture, 'events', ROWS)).toBe(ROWS)
      expect(await count(fixture, 'audit', 1)).toBe(1)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)

  test('--mark-applied records the stopped load as completed, and the next apply runs nothing again', async () => {
    const fixture = await createFixture('mark_applied')
    try {
      await stopOnUnknownOutcome(fixture)
      const partial = await count(fixture, 'events')

      const marked = await migrate(fixture, ['--mark-applied', fixture.migration]).result
      expect(marked.exitCode, formatTestDiagnostic('mark', marked)).toBe(0)

      const resumed = await migrate(fixture).result
      expect(resumed.exitCode, formatTestDiagnostic('resume', resumed)).toBe(0)
      expect(resumed.stderr).not.toContain('submitting async')
      expect(await count(fixture, 'events')).toBe(partial)
      expect(await count(fixture, 'audit', 1)).toBe(1)
      expect(await journalStatuses(fixture)).toBe('completed,completed')
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)

  test('refuses while the stopped attempt still runs on the server, and changes nothing', async () => {
    const fixture = await createFixture('mark_running')
    try {
      // No failure: the killed run's load keeps running.
      await fixture.executor.command(`TRUNCATE TABLE ${table(fixture, 'fail_marker')}`)
      const killed = migrate(fixture)
      const queryId = await waitForRunningLoad(fixture)
      killed.kill()
      expect((await killed.result).exitCode).not.toBe(0)

      const claim = await heldLockClaim(fixture.executor, fixture.database, fixture.journalTable)
      const marked = await migrate(fixture, ['--mark-applied', fixture.migration, '--break-lock', claim]).result
      expect(marked.exitCode, formatTestDiagnostic('mark', marked)).toBe(1)
      expect(JSON.parse(marked.stdout).error).toMatchObject({ code: 'async_outcome_unknown' })
      expect(marked.stdout).toContain('is still running on the server')
      expect(await journalStatuses(fixture)).toBe('completed,started')
      await fixture.executor.command(`KILL QUERY WHERE query_id = '${queryId}' SYNC`)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)
})

// The first run completes the audit insert, then its load fails while it runs.
async function stopOnUnknownOutcome(fixture: Fixture): Promise<void> {
  const failed = await migrate(fixture).result
  expect(failed.exitCode, formatTestDiagnostic('first run', failed)).toBe(1)
  expect(JSON.parse(failed.stdout).error).toMatchObject({ code: 'async_outcome_unknown' })
  expect(await journalStatuses(fixture)).toBe('completed,started')
}

async function createFixture(label: string): Promise<Fixture> {
  const env = getLiveEnv()
  const prefix = createPrefix(label)
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const migrationsDir = join(dir, 'chkit/migrations')
  await mkdir(migrationsDir, { recursive: true })
  const database = `${prefix}db`
  const migration = `20990101000000_${prefix}load.sql`
  await writeFile(
    join(migrationsDir, migration),
    [
      // Not safe to run twice: an abandon would insert it again.
      '-- operation: load_table_data key=table:audit risk=caution mode=sync',
      'INSERT INTO audit VALUES (1);',
      '-- operation: load_table_data key=table:events risk=caution mode=async',
      '-- before-retry: TRUNCATE TABLE events',
      `INSERT INTO events SELECT number + throwIf(number = ${FAIL_AT} AND (SELECT count() FROM fail_marker) > 0, 'failure in this database') FROM numbers(${ROWS}) WHERE sleepEachRow(1) = 0 SETTINGS max_block_size = 1;`,
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
  const db = quoteIdent(database)
  await fixture.executor.command(`CREATE DATABASE ${db}`)
  for (const name of ['events', 'audit', 'fail_marker']) {
    await fixture.executor.command(`CREATE TABLE ${db}.${name} (x UInt64) ENGINE = MergeTree ORDER BY x`)
    await waitForTable(fixture.executor, database, name)
  }
  await fixture.executor.command(`INSERT INTO ${db}.fail_marker VALUES (1)`)
  return fixture
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
  await fixture.executor.close()
  await rm(fixture.dir, { recursive: true, force: true })
}

function table(fixture: Fixture, name: string): string {
  return `${quoteIdent(fixture.database)}.${quoteIdent(name)}`
}

function migrate(fixture: Fixture, extraArgs: string[] = []): { result: Promise<CliResult>; kill: () => void } {
  return startCli(
    fixture.dir,
    ['migrate', '--config', fixture.config, '--execute', '--json', ...extraArgs],
    { CHKIT_JOURNAL_TABLE: fixture.journalTable, CHKIT_E2E_PASSWORD: getLiveEnv().clickhousePassword, CI: '1' },
  )
}

async function journalStatuses(fixture: Fixture): Promise<string> {
  const [row] = await fixture.executor.query<{ statuses: string }>(
    `SELECT arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses ` +
      `FROM ${table(fixture, fixture.journalTable)} FINAL ` +
      `WHERE name = '${fixture.migration}' SETTINGS select_sequential_consistency = 1`,
  )
  return row?.statuses ?? ''
}

// The journal says 'started' just before the load is submitted.
async function waitForRunningLoad(fixture: Fixture): Promise<string> {
  const [row] = await waitForRows<{ statuses: string; queryId: string }>(
    fixture.executor,
    `SELECT arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses, operations[2].query_id AS queryId ` +
      `FROM ${table(fixture, fixture.journalTable)} FINAL ` +
      `WHERE name = '${fixture.migration}' SETTINGS select_sequential_consistency = 1`,
    (rows) => rows[0]?.statuses === 'completed,started',
    'journal records the load as started',
  )
  const queryId = row?.queryId ?? ''
  const status = await pollUntil(
    () => fixture.executor.queryStatus(queryId, { everyReplica: true }),
    (found) => found.status === 'running',
    { intervalMs: 100, timeoutMs: 10_000 },
  )
  expect(status.status).toBe('running')
  return queryId
}

async function count(fixture: Fixture, name: string, expected?: number): Promise<number> {
  const read = async () => {
    const [row] = await fixture.executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table(fixture, name)}`)
    return Number(row?.n)
  }
  if (expected === undefined) return read()
  return pollUntil(read, (rows) => rows === expected, { timeoutMs: 10_000 })
}
