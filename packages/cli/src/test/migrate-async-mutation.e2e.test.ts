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
  pollUntil,
  quoteIdent,
  runOnEveryReplica,
  startCli,
  waitForRows,
  waitForTable,
} from './e2e-testkit.js'

// #812: an async statement is journaled complete at its QueryFinish. Without
// mutations_sync an ALTER ... UPDATE finishes once its mutation is queued (a
// lightweight DELETE likewise without lightweight_deletes_sync), so the next
// statement read the table before the mutation ran, and a mutation that
// failed was journaled complete.

const TIMEOUT_MS = 180_000

interface Fixture {
  dir: string
  config: string
  database: string
  journalTable: string
  migration: string
  executor: ClickHouseExecutor
}

describe('async mutations', () => {
  test.each([
    { name: 'an ALTER UPDATE', label: 'mutwait', statement: 'ALTER TABLE t UPDATE v = v + 1 WHERE 1', args: [], sum: 10 },
    {
      name: 'a lightweight DELETE run with lightweight_deletes_sync = 0',
      label: 'lwdwait',
      statement: 'DELETE FROM t WHERE k = 4',
      args: ['--setting', 'lightweight_deletes_sync=0'],
      sum: 4,
    },
  ])(
    'the next statement runs only once the mutation of $name is done',
    async ({ label, statement, args, sum }) => {
      const fixture = await createFixture(label, statement)
      const db = quoteIdent(fixture.database)
      // SYSTEM STOP MERGES acts on one replica, and any replica may run the
      // mutation, so merges stop on every replica.
      let mergesStopped = false
      let run: ReturnType<typeof migrate> | undefined
      try {
        // The mutation stays queued until merges start again.
        mergesStopped = true
        await runOnEveryReplica(fixture.executor, getLiveEnv(), `SYSTEM STOP MERGES ${db}.t`)
        run = migrate(fixture, args)
        const queryId = await waitForStartedQueryId(fixture)
        await pollUntil(
          () => fixture.executor.queryStatus(queryId, { everyReplica: true }),
          (found) => found.status === 'running',
          { intervalMs: 100, timeoutMs: 30_000 },
        )
        await waitForRows(
          fixture.executor,
          `SELECT 1 FROM system.mutations WHERE database = '${fixture.database}' AND table = 't' AND NOT is_done`,
          (rows) => rows.length === 1,
          'the mutation is queued',
        )
        // Polls run every 5 s: across two of them, the statement stays started.
        expect(await statusesDuring(fixture, 11_000)).toEqual(['started'])
        await runOnEveryReplica(fixture.executor, getLiveEnv(), `SYSTEM START MERGES ${db}.t`)
        mergesStopped = false

        const result = await run.result
        expect(result.exitCode, formatTestDiagnostic('migrate', result)).toBe(0)
        const seen = await fixture.executor.query<{ s: number | string }>(`SELECT s FROM ${db}.seen`)
        expect(seen.map((row) => Number(row.s))).toEqual([sum])
      } finally {
        try {
          if (mergesStopped) await runOnEveryReplica(fixture.executor, getLiveEnv(), `SYSTEM START MERGES ${db}.t`)
        } finally {
          // A run the test left mid-way would go on against the dropped database.
          try {
            if (run) {
              run.kill()
              await run.result
            }
          } finally {
            await dropFixture(fixture)
          }
        }
      }
    },
    TIMEOUT_MS,
  )

  test(
    'a failed mutation is not journaled complete',
    async () => {
      const fixture = await createFixture('mutfail', "ALTER TABLE t UPDATE v = v + throwIf(k = 4, 'mutation failure') WHERE 1")
      try {
        const result = await migrate(fixture).result
        expect(result.exitCode, formatTestDiagnostic('migrate', result)).toBe(1)
        expect(JSON.parse(result.stdout).error.code).toBe('async_outcome_unknown')
        const db = quoteIdent(fixture.database)
        expect(await fixture.executor.query(`SELECT s FROM ${db}.seen`)).toEqual([])
      } finally {
        await dropFixture(fixture)
      }
    },
    TIMEOUT_MS,
  )
})

async function createFixture(label: string, statement: string): Promise<Fixture> {
  const env = getLiveEnv()
  const prefix = createPrefix(label)
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const migrationsDir = join(dir, 'chkit/migrations')
  await mkdir(migrationsDir, { recursive: true })
  const database = `${prefix}db`
  const migration = `20990101000000_${prefix}update.sql`
  await writeFile(
    join(migrationsDir, migration),
    [
      '-- operation: alter_table_update key=table:t risk=caution mode=async',
      `${statement};`,
      '',
      '-- operation: load_table_data key=table:seen risk=caution',
      'INSERT INTO seen SELECT sum(v) FROM t;',
      '',
    ].join('\n'),
    'utf8',
  )
  const config = join(dir, 'chkit.config.ts')
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
      `    password: process.env.CHKIT_E2E_PASSWORD,\n` +
      `    database: '${database}',\n` +
      `  },\n}\n`,
    'utf8',
  )
  const executor = createLiveExecutor(env)
  const db = quoteIdent(database)
  await executor.command(`CREATE DATABASE ${db}`)
  await executor.command(`CREATE TABLE ${db}.t (k UInt32, v UInt32) ENGINE = MergeTree ORDER BY k`)
  await executor.command(`CREATE TABLE ${db}.seen (s UInt64) ENGINE = MergeTree ORDER BY s`)
  await waitForTable(executor, database, 't')
  await waitForTable(executor, database, 'seen')
  await executor.command(`INSERT INTO ${db}.t SELECT number, 1 FROM numbers(5)`)
  return { dir, config, database, journalTable: createJournalTableName(label), migration, executor }
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.command(`KILL MUTATION WHERE database = '${fixture.database}'`).catch(() => {})
  await fixture.executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
  await fixture.executor.close()
  await rm(fixture.dir, { recursive: true, force: true })
}

function migrate(fixture: Fixture, args: string[] = []): { result: Promise<CliResult>; kill: () => void } {
  return startCli(
    fixture.dir,
    ['migrate', '--config', fixture.config, '--execute', '--json', ...args],
    { CHKIT_JOURNAL_TABLE: fixture.journalTable, CHKIT_E2E_PASSWORD: getLiveEnv().clickhousePassword, CI: '1' },
  )
}

function journalSQL(fixture: Fixture): string {
  return (
    `SELECT operations[1].status AS status, operations[1].query_id AS queryId ` +
    `FROM ${quoteIdent(fixture.database)}.${quoteIdent(fixture.journalTable)} FINAL ` +
    `WHERE name = '${fixture.migration}' SETTINGS select_sequential_consistency = 1`
  )
}

// The query id of the async attempt, once the journal records it as started.
async function waitForStartedQueryId(fixture: Fixture): Promise<string> {
  const [row] = await waitForRows<{ status: string; queryId: string }>(
    fixture.executor,
    journalSQL(fixture),
    (rows) => rows[0]?.status === 'started' && rows[0]?.queryId !== '',
    'the journal records the attempt as started',
  )
  return row?.queryId ?? ''
}

// Every status the journal records for the statement over durationMs: the
// check that it does not complete needs a span of time, not a state to wait for.
async function statusesDuring(fixture: Fixture, durationMs: number): Promise<string[]> {
  const seen = new Set<string>()
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    const [row] = await fixture.executor.query<{ status: string }>(journalSQL(fixture))
    seen.add(row?.status ?? 'missing')
    await Bun.sleep(250)
  }
  return [...seen]
}
