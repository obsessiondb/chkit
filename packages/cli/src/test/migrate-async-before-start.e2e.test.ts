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
  startCli,
  waitForTable,
} from './e2e-testkit.js'

// #767 (Opus review): ExceptionBeforeStart shows nothing ran only for a
// SELECT or an INSERT. A killed ALTER ... UPDATE with mutations_sync logs it
// while its mutation still completes, and a mutation that fails on one
// partition logs it after it changed the others. Neither may be compensated
// and run again: the run, and the next one, stop with async_outcome_unknown.

const TIMEOUT_MS = 180_000

interface Fixture {
  dir: string
  config: string
  database: string
  journalTable: string
  executor: ClickHouseExecutor
}

describe('async ALTER rejected before it started (#767)', () => {
  test(
    'a killed ALTER UPDATE whose mutation completed is not run again',
    async () => {
      const fixture = await createFixture('bskill', 'ORDER BY k', 'v = v + 100 + sleepEachRow(0.5) * 0')
      try {
        const db = quoteIdent(fixture.database)
        const first = migrate(fixture)
        const running = await pollUntil(
          () => fixture.executor.query<{ query_id: string }>(
            `SELECT query_id FROM system.processes WHERE current_database = '${fixture.database}' AND query LIKE 'ALTER TABLE t UPDATE%'`,
          ),
          (rows) => rows.length > 0,
          { timeoutMs: 60_000, intervalMs: 200 },
        )
        await fixture.executor.command(`KILL QUERY WHERE query_id = '${running[0]?.query_id}' SYNC`)
        await first.result
        const completed = await waitForValues(fixture, [100, 101, 102, 103, 104])

        const again = await migrate(fixture).result
        expect(again.exitCode, formatTestDiagnostic('re-run', again)).toBe(1)
        expect(JSON.parse(again.stdout).error.code).toBe('async_outcome_unknown')
        expect(completed).toEqual([100, 101, 102, 103, 104])
        // Never applied twice.
        expect(await values(fixture)).toEqual([100, 101, 102, 103, 104])
        expect(await fixture.executor.query(`SELECT 1 FROM ${db}.t WHERE v >= 200`)).toEqual([])
      } finally {
        await dropFixture(fixture)
      }
    },
    TIMEOUT_MS,
  )

  test(
    'an ALTER UPDATE that failed on one partition is not run again',
    async () => {
      const fixture = await createFixture('bspart', 'PARTITION BY k ORDER BY k', 'v = v + 100 + throwIf(k = 4)')
      try {
        const first = await migrate(fixture).result
        expect(first.exitCode, formatTestDiagnostic('first run', first)).toBe(1)
        expect(JSON.parse(first.stdout).error.code).toBe('async_outcome_unknown')
        const again = await migrate(fixture).result
        expect(again.exitCode, formatTestDiagnostic('re-run', again)).toBe(1)
        expect(JSON.parse(again.stdout).error.code).toBe('async_outcome_unknown')
        // The partitions the mutation changed before it failed are never
        // changed again.
        const after = await values(fixture)
        expect(after.filter((v) => v >= 200)).toEqual([])
      } finally {
        await dropFixture(fixture)
      }
    },
    TIMEOUT_MS,
  )
})

async function createFixture(label: string, layout: string, assignment: string): Promise<Fixture> {
  const env = getLiveEnv()
  const prefix = createPrefix(label)
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const migrationsDir = join(dir, 'chkit/migrations')
  await mkdir(migrationsDir, { recursive: true })
  const database = `${prefix}db`
  await writeFile(
    join(migrationsDir, `20990101000000_${prefix}update.sql`),
    [
      '-- operation: alter_table_update key=table:t risk=caution mode=async',
      '-- before-retry: SELECT 1',
      `ALTER TABLE t UPDATE ${assignment} WHERE 1 SETTINGS mutations_sync = 1, allow_nondeterministic_mutations = 1;`,
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
  await executor.command(`CREATE TABLE ${db}.t (k UInt32, v UInt32) ENGINE = MergeTree ${layout}`)
  await waitForTable(executor, database, 't')
  await executor.command(`INSERT INTO ${db}.t SELECT number, number FROM numbers(5)`)
  return { dir, config, database, journalTable: createJournalTableName(label), executor }
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.command(`KILL MUTATION WHERE database = '${fixture.database}'`).catch(() => {})
  await fixture.executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
  await fixture.executor.close()
  await rm(fixture.dir, { recursive: true, force: true })
}

function migrate(fixture: Fixture): { result: Promise<CliResult>; kill: () => void } {
  return startCli(
    fixture.dir,
    ['migrate', '--config', fixture.config, '--execute', '--json'],
    { CHKIT_JOURNAL_TABLE: fixture.journalTable, CHKIT_E2E_PASSWORD: getLiveEnv().clickhousePassword, CI: '1' },
  )
}

async function values(fixture: Fixture): Promise<number[]> {
  const rows = await fixture.executor.query<{ v: number | string }>(`SELECT v FROM ${quoteIdent(fixture.database)}.t ORDER BY k`)
  return rows.map((row) => Number(row.v))
}

async function waitForValues(fixture: Fixture, expected: number[]): Promise<number[]> {
  return await pollUntil(() => values(fixture), (rows) => JSON.stringify(rows) === JSON.stringify(expected), {
    timeoutMs: 60_000,
    intervalMs: 500,
  })
}
