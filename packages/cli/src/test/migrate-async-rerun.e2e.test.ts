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

// #672: a run can leave an async step started although its load finished on
// the server. A re-run reads the attempt's outcome from system.query_log
// instead of submitting the load again.

const TIMEOUT_MS = 180_000
const ROWS = 16

interface Fixture {
  dir: string
  config: string
  database: string
  journalTable: string
  migration: string
  executor: ClickHouseExecutor
}

describe('async migrate re-run of a started step (#672)', () => {
  test('a re-run records the load its killed run left running, once it finished, and does not load it again', async () => {
    const fixture = await createFixture('rerun_finished')
    try {
      const killed = migrate(fixture)
      const queryId = await waitForStartedQueryId(fixture)
      await pollUntil(
        () => fixture.executor.queryStatus(queryId, { everyReplica: true }),
        (found) => found.status === 'running',
        { intervalMs: 100, timeoutMs: 10_000 },
      )
      killed.kill()
      expect((await killed.result).exitCode).not.toBe(0)
      // The load goes on without the run and ends; query_log has its QueryFinish.
      const finished = await pollUntil(
        () => fixture.executor.queryStatus(queryId, { everyReplica: true }),
        (found) => found.status === 'finished',
        { intervalMs: 500, timeoutMs: 60_000 },
      )
      expect(finished.status).toBe('finished')
      expect(await journalStatuses(fixture)).toBe('started')

      // The killed run still holds the migrate lock (#716).
      const claim = await heldLockClaim(fixture.executor, fixture.database, fixture.journalTable)
      const rerun = await migrate(fixture, ['--break-lock', claim]).result
      expect(rerun.exitCode, formatTestDiagnostic('re-run', rerun)).toBe(0)
      expect(rerun.stderr).toContain(`previous attempt of query_id=${queryId} finished on the server`)
      expect(rerun.stderr).not.toContain('resubmitting')
      expect(await journalStatuses(fixture)).toBe('completed')
      expect(await countEvents(fixture)).toBe(ROWS)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)

  // #701: query_log is flushed on a timer (7.5 s by default), so right after
  // the load ends it is neither running nor in query_log. The re-run checks
  // again while query_log is flushed instead of loading the rows again.
  test('a re-run right after the load its killed run left ended waits for its query_log entry', async () => {
    const fixture = await createFixture('rerun_flush')
    try {
      const killed = migrate(fixture)
      const queryId = await waitForStartedQueryId(fixture)
      await pollUntil(
        () => fixture.executor.queryStatus(queryId, { everyReplica: true, runningOnly: true }),
        (found) => found.status === 'running',
        { intervalMs: 100, timeoutMs: 10_000 },
      )
      killed.kill()
      expect((await killed.result).exitCode).not.toBe(0)
      // The load ends; re-run as soon as no replica runs it.
      await pollUntil(
        () => fixture.executor.queryStatus(queryId, { everyReplica: true, runningOnly: true }),
        (found) => found.status !== 'running',
        { intervalMs: 100, timeoutMs: 60_000 },
      )

      const claim = await heldLockClaim(fixture.executor, fixture.database, fixture.journalTable)
      const rerun = await migrate(fixture, ['--break-lock', claim]).result
      expect(rerun.exitCode, formatTestDiagnostic('re-run', rerun)).toBe(0)
      expect(rerun.stderr).toContain(`previous attempt of query_id=${queryId} finished on the server`)
      expect(rerun.stderr).not.toContain('resubmitting')
      expect(await journalStatuses(fixture)).toBe('completed')
      expect(await countEvents(fixture)).toBe(ROWS)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)
})

async function createFixture(label: string): Promise<Fixture> {
  const env = getLiveEnv()
  const prefix = createPrefix(label)
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const migrationsDir = join(dir, 'chkit/migrations')
  await mkdir(migrationsDir, { recursive: true })
  const database = `${prefix}db`
  const migration = `20990101000000_${prefix}load.sql`
  // About 4 s at 0.25 s per row. No before-retry SQL, so a resubmission
  // would load the rows a second time.
  await writeFile(
    join(migrationsDir, migration),
    [
      '-- operation: load_table_data key=table:events risk=caution mode=async',
      `INSERT INTO events SELECT number FROM numbers(${ROWS}) WHERE sleepEachRow(0.25) = 0 SETTINGS max_block_size = 1;`,
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
  await fixture.executor.command(`CREATE DATABASE ${quoteIdent(database)}`)
  await fixture.executor.command(`CREATE TABLE ${quoteIdent(database)}.events (id UInt64) ENGINE = MergeTree ORDER BY id`)
  await waitForTable(fixture.executor, database, 'events')
  return fixture
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
  await fixture.executor.close()
  await rm(fixture.dir, { recursive: true, force: true })
}

function migrate(fixture: Fixture, extraArgs: string[] = []): { result: Promise<CliResult>; kill: () => void } {
  return startCli(fixture.dir, ['migrate', '--config', fixture.config, '--execute', '--json', ...extraArgs], {
    CHKIT_JOURNAL_TABLE: fixture.journalTable,
    CHKIT_E2E_PASSWORD: getLiveEnv().clickhousePassword,
    CI: '1',
  })
}

function journalQuery(fixture: Fixture): string {
  return (
    `SELECT arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses, ` +
    `operations[1].query_id AS queryId ` +
    `FROM ${quoteIdent(fixture.database)}.${quoteIdent(fixture.journalTable)} FINAL ` +
    `WHERE name = '${fixture.migration}' SETTINGS select_sequential_consistency = 1`
  )
}

async function waitForStartedQueryId(fixture: Fixture): Promise<string> {
  const [row] = await waitForRows<{ statuses: string; queryId: string }>(
    fixture.executor,
    journalQuery(fixture),
    (rows) => rows[0]?.statuses === 'started',
    'journal reads started',
  )
  return row?.queryId ?? ''
}

async function journalStatuses(fixture: Fixture): Promise<string> {
  const [row] = await fixture.executor.query<{ statuses: string }>(journalQuery(fixture))
  return row?.statuses ?? ''
}

async function countEvents(fixture: Fixture): Promise<number> {
  const db = quoteIdent(fixture.database)
  const [row] = await fixture.executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${db}.events`)
  return Number(row?.n)
}
