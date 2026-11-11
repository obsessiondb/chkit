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

// #463: one migrations folder applied to two databases on one server. Each
// run's async load must run its own query: a run never attaches to, or takes
// the result of, the other database's query of the same statement.

const TIMEOUT_MS = 240_000
const ROWS = 16
// About 8 s at 0.5 s per row, so the other run starts while it still runs.
// It fails on row FAIL_AT in a database whose fail_marker has a row.
const FAIL_AT = 12

interface Fixture {
  dir: string
  configs: { staging: string; prod: string }
  databases: { staging: string; prod: string }
  journalTable: string
  migration: string
  executor: ClickHouseExecutor
}

type Target = 'staging' | 'prod'

describe('async migrate statements across databases (#463)', () => {
  test("a run never takes the other database's failure, and the failed run retries its own load", async () => {
    const fixture = await createFixture('qid_failure')
    const { executor, databases } = fixture
    try {
      await executor.command(`INSERT INTO ${quoteIdent(databases.staging)}.fail_marker VALUES (1)`)
      const staging = migrate(fixture, 'staging')
      await waitForRunningLoad(fixture, 'staging')
      const prod = await migrate(fixture, 'prod').result
      const failed = await staging.result

      expect(prod.exitCode, formatTestDiagnostic('prod', prod)).toBe(0)
      expect(prod.stderr).not.toContain('attaching to in-flight query')
      expect(await countEvents(fixture, 'prod')).toBe(ROWS)
      expect(failed.exitCode, formatTestDiagnostic('staging', failed)).toBe(1)
      expect(failed.stdout).toContain('failure in this database')
      await waitForStatuses(fixture, 'staging', 'failed')

      // The retry finds its own failed attempt: it runs the before-retry SQL
      // and loads once.
      await executor.command(`TRUNCATE TABLE ${quoteIdent(databases.staging)}.fail_marker`)
      const retried = await migrate(fixture, 'staging').result
      expect(retried.exitCode, formatTestDiagnostic('staging retry', retried)).toBe(0)
      expect(retried.stderr).toContain('load_table_data: running before-retry SQL')
      expect(await countEvents(fixture, 'staging')).toBe(ROWS)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)

  test('a re-run attaches to the load its killed run left running', async () => {
    const fixture = await createFixture('qid_resume')
    try {
      const killed = migrate(fixture, 'staging')
      await waitForRunningLoad(fixture, 'staging')
      killed.kill()
      expect((await killed.result).exitCode).not.toBe(0)

      // The killed run still holds the migrate lock (#716).
      const claim = await heldLockClaim(fixture.executor, fixture.databases.staging, fixture.journalTable)
      const resumed = await migrate(fixture, 'staging', ['--break-lock', claim]).result
      expect(resumed.exitCode, formatTestDiagnostic('staging re-run', resumed)).toBe(0)
      expect(resumed.stderr).toContain('attaching to in-flight query')
      expect(resumed.stderr).not.toContain('running before-retry SQL')
      expect(await countEvents(fixture, 'staging')).toBe(ROWS)
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
  const databases = { staging: `${prefix}staging`, prod: `${prefix}prod` }
  // One file name for both databases, unique to this run.
  const migration = `20990101000000_${prefix}load.sql`
  await writeFile(
    join(migrationsDir, migration),
    [
      '-- operation: load_table_data key=table:events risk=caution mode=async',
      '-- before-retry: TRUNCATE TABLE events',
      `INSERT INTO events SELECT number + throwIf(number = ${FAIL_AT} AND (SELECT count() FROM fail_marker) > 0, 'failure in this database') FROM numbers(${ROWS}) WHERE sleepEachRow(0.5) = 0 SETTINGS max_block_size = 1;`,
      '',
    ].join('\n'),
    'utf8',
  )
  const configFor = async (target: Target) => {
    const path = join(dir, `${target}.config.ts`)
    await writeFile(
      path,
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
        `    database: '${databases[target]}',\n` +
        `  },\n}\n`,
      'utf8',
    )
    return path
  }
  const fixture: Fixture = {
    dir,
    configs: { staging: await configFor('staging'), prod: await configFor('prod') },
    databases,
    journalTable: createJournalTableName(label),
    migration,
    executor: createLiveExecutor(env),
  }
  for (const database of Object.values(databases)) {
    const db = quoteIdent(database)
    await fixture.executor.command(`CREATE DATABASE ${db}`)
    await fixture.executor.command(`CREATE TABLE ${db}.events (id UInt64) ENGINE = MergeTree ORDER BY id`)
    await fixture.executor.command(`CREATE TABLE ${db}.fail_marker (x UInt8) ENGINE = MergeTree ORDER BY x`)
    await waitForTable(fixture.executor, database, 'events')
    await waitForTable(fixture.executor, database, 'fail_marker')
  }
  return fixture
}

async function dropFixture(fixture: Fixture): Promise<void> {
  for (const database of Object.values(fixture.databases)) {
    await fixture.executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
  }
  await fixture.executor.close()
  await rm(fixture.dir, { recursive: true, force: true })
}

function migrate(
  fixture: Fixture,
  target: Target,
  extraArgs: string[] = [],
): { result: Promise<CliResult>; kill: () => void } {
  return startCli(
    fixture.dir,
    ['migrate', '--config', fixture.configs[target], '--execute', '--json', ...extraArgs],
    { CHKIT_JOURNAL_TABLE: fixture.journalTable, CHKIT_E2E_PASSWORD: getLiveEnv().clickhousePassword, CI: '1' },
  )
}

async function waitForStatuses(
  fixture: Fixture,
  target: Target,
  statuses: string,
): Promise<{ statuses: string; queryId: string }> {
  const db = quoteIdent(fixture.databases[target])
  const [row] = await waitForRows<{ statuses: string; queryId: string }>(
    fixture.executor,
    `SELECT arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses, ` +
      `operations[1].query_id AS queryId ` +
      `FROM ${db}.${quoteIdent(fixture.journalTable)} FINAL ` +
      `WHERE name = '${fixture.migration}' SETTINGS select_sequential_consistency = 1`,
    (rows) => rows[0]?.statuses === statuses,
    `journal of ${target} reads ${statuses}`,
  )
  return { statuses: row?.statuses ?? '', queryId: row?.queryId ?? '' }
}

// The journal says 'started' just before the load is submitted.
async function waitForRunningLoad(fixture: Fixture, target: Target): Promise<void> {
  const { queryId } = await waitForStatuses(fixture, target, 'started')
  const status = await pollUntil(
    () => fixture.executor.queryStatus(queryId, { everyReplica: true }),
    (found) => found.status === 'running',
    { intervalMs: 100, timeoutMs: 10_000 },
  )
  expect(status.status).toBe('running')
}

async function countEvents(fixture: Fixture, target: Target): Promise<number> {
  const db = quoteIdent(fixture.databases[target])
  return pollUntil(
    async () => {
      const [row] = await fixture.executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${db}.events`)
      return Number(row?.n)
    },
    (rows) => rows === ROWS,
    { timeoutMs: 10_000 },
  )
}
