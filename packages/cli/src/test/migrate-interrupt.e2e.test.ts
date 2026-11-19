import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { ATTEMPT_RECORD_MARKER, PREPARED_RECORD_MARKER } from '../commands/migrate/async-apply.js'
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

// Ctrl-C on migrate, as chkit-py handles it: a first SIGINT starts no new
// statement, stops polling an async statement, puts an attempt not sent yet
// back to prepared, and releases the migrate lock; a second one exits at once
// and leaves the lock claim in place.

const TIMEOUT_MS = 180_000
const ROWS = 16
const SRC = resolve(import.meta.dir, '..')
const CLICKHOUSE_TESTKIT = resolve(import.meta.dir, '../../../clickhouse/src/e2e-testkit.ts')

/** An async load of about 4 s, at 0.25 s per row. */
const ASYNC_LOAD = [
  '-- operation: load_table_data key=table:events risk=caution mode=async',
  `INSERT INTO events SELECT number FROM numbers(${ROWS}) WHERE sleepEachRow(0.25) = 0 SETTINGS max_block_size = 1;`,
]
/** A sync statement of about 3 s. */
const SYNC_LOAD = [
  '-- operation: load_table_data key=table:events risk=caution',
  `INSERT INTO events SELECT number + 1000 FROM numbers(12) WHERE sleepEachRow(0.25) = 0 SETTINGS max_block_size = 1;`,
]

interface Fixture {
  dir: string
  config: string
  database: string
  journalTable: string
  migration: string
  executor: ClickHouseExecutor
}

describe('migrate on SIGINT', () => {
  test('a SIGINT while an async load runs stops polling and releases the lock; a re-run records the load once', async () => {
    const fixture = await createFixture('sigint_poll', ASYNC_LOAD)
    try {
      const run = migrate(fixture)
      const { queryId } = await waitForOperations(fixture, (ops) => ops[0]?.marker === ATTEMPT_RECORD_MARKER)
      await pollUntil(
        () => fixture.executor.queryStatus(queryId, { everyReplica: true, runningOnly: true }),
        (found) => found.status === 'running',
        { intervalMs: 100, timeoutMs: 10_000 },
      )
      const sentAt = Date.now()
      run.kill('SIGINT')
      const result = await run.result

      expect(result.exitCode, formatTestDiagnostic('interrupted run', result)).toBe(130)
      // It does not wait for the load (about 4 s) or for its next poll (5 s).
      expect(Date.now() - sentAt).toBeLessThan(3_000)
      expect(result.stderr).toContain('migrate: interrupted (SIGINT). No new statement was started. The migrate lock is released.')
      expect(result.stderr).toContain(`query_id ${queryId}) was submitted, and the run was interrupted (SIGINT) before its outcome`)
      expect(await heldClaims(fixture)).toEqual([])
      // The record still names the attempt as one that may have been sent.
      expect(await readOperations(fixture)).toEqual([{ status: 'started', marker: ATTEMPT_RECORD_MARKER, queryId }])

      // No --break-lock: the lock is free. The re-run attaches to the load,
      // or reads its outcome, and does not load the rows again.
      const rerun = await migrate(fixture).result
      expect(rerun.exitCode, formatTestDiagnostic('re-run', rerun)).toBe(0)
      expect(rerun.stderr).not.toContain('resubmitting')
      expect((await readOperations(fixture)).map((op) => op.status)).toEqual(['completed'])
      expect(await countEvents(fixture)).toBe(ROWS)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)

  test('a SIGINT during a sync statement lets it finish, starts no next statement, and releases the lock', async () => {
    const fixture = await createFixture('sigint_sync', [...SYNC_LOAD, ...ASYNC_LOAD])
    try {
      const run = migrate(fixture)
      await waitForOperations(fixture, (ops) => ops[0]?.status === 'started')
      run.kill('SIGINT')
      const result = await run.result

      expect(result.exitCode, formatTestDiagnostic('interrupted run', result)).toBe(130)
      expect(result.stderr).toContain('migrate: interrupted (SIGINT). No new statement was started. The migrate lock is released.')
      expect(await heldClaims(fixture)).toEqual([])
      // The sync statement completed; the async one was never attempted.
      expect((await readOperations(fixture)).map((op) => op.status)).toEqual(['completed'])
      expect(await countEvents(fixture)).toBe(12)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)

  test('a second SIGINT exits at once and leaves the lock claim in place', async () => {
    const fixture = await createFixture('sigint_twice', SYNC_LOAD)
    try {
      const run = migrate(fixture)
      await waitForOperations(fixture, (ops) => ops[0]?.status === 'started')
      run.kill('SIGINT')
      await new Promise((resolve) => setTimeout(resolve, 200))
      const sentAt = Date.now()
      run.kill('SIGINT')
      const result = await run.result

      expect(result.exitCode, formatTestDiagnostic('interrupted run', result)).toBe(130)
      expect(Date.now() - sentAt).toBeLessThan(1_500)
      const claims = await heldClaims(fixture)
      expect(claims).toHaveLength(1)
      expect(result.stderr).toContain(`migrate: SIGINT again, exiting at once. The migrate lock claim ${claims[0]} stays in place`)
      expect(result.stderr).not.toContain('The migrate lock is released')
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)

  // The window between the attempt's record and its submit is too short to
  // hit through the CLI: the child holds the run there, with a real SIGINT
  // handler, journal and server.
  test('a SIGINT before the submit puts the attempt back to prepared and sends nothing', async () => {
    const fixture = await createFixture('sigint_prepared', ASYNC_LOAD)
    try {
      const script = join(fixture.dir, 'held-before-submit.ts')
      await writeFile(script, heldBeforeSubmitScript(fixture), 'utf8')
      const child = Bun.spawn(['bun', script], {
        cwd: fixture.dir,
        env: { ...process.env, CHKIT_JOURNAL_TABLE: fixture.journalTable, CLICKHOUSE_DB: fixture.database, CLICKHOUSE_URL: getLiveEnv().clickhouseUrl, CLICKHOUSE_PASSWORD: getLiveEnv().clickhousePassword, CLICKHOUSE_USER: getLiveEnv().clickhouseUser },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      })
      const reader = child.stdout.getReader()
      let stdout = ''
      while (!stdout.includes('ready')) {
        const chunk = await reader.read()
        if (chunk.done) break
        stdout += new TextDecoder().decode(chunk.value)
      }
      expect(stdout).toContain('ready')
      child.kill('SIGINT')
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

      expect(exitCode, stderr).toBe(130)
      expect(stderr).toContain('migrate: interrupted (SIGINT). No new statement was started.')
      const [op] = await readOperations(fixture)
      expect(op?.marker).toBe(PREPARED_RECORD_MARKER)
      // Sent nothing: no replica runs or logged the attempt.
      await fixture.executor.command('SYSTEM FLUSH LOGS')
      const status = await fixture.executor.queryStatus(op?.queryId ?? '', { everyReplica: true })
      expect(status.status).toBe('unknown')
      expect(await countEvents(fixture)).toBe(0)
    } finally {
      await dropFixture(fixture)
    }
  }, TIMEOUT_MS)
})

function heldBeforeSubmitScript(fixture: Fixture): string {
  return `
    import { setTimeout as sleep } from 'node:timers/promises'
    import { applyAsyncStatement, ATTEMPT_RECORD_MARKER } from ${JSON.stringify(join(SRC, 'commands/migrate/async-apply.ts'))}
    import { withInterrupt } from ${JSON.stringify(join(SRC, 'commands/migrate/interrupt.ts'))}
    import { createJournalStore } from ${JSON.stringify(join(SRC, 'runtime/journal-store.ts'))}
    import { createLiveExecutor, getLiveEnv } from ${JSON.stringify(CLICKHOUSE_TESTKIT)}

    const db = createLiveExecutor(getLiveEnv())
    const store = createJournalStore(db)
    // Holds the run once the attempt is recorded as one that may be sent.
    const journalStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property !== 'writeMigrationState') return Reflect.get(target, property, receiver)
        return async (state) => {
          await target.writeMigrationState(state)
          if (state.operations.some((op) => op.lastError === ATTEMPT_RECORD_MARKER)) {
            console.log('ready')
            await sleep(1_000)
          }
        }
      },
    })
    const controller = new AbortController()
    await withInterrupt(controller, {}, () => applyAsyncStatement({
      db,
      journalStore,
      sql: ${JSON.stringify(ASYNC_LOAD[1]?.replace(/;$/, ''))},
      migrationName: ${JSON.stringify(fixture.migration)},
      migrationChecksum: 'c1',
      statementIndex: 0,
      operationType: 'load_table_data',
      operationKey: 'table:events',
      fingerprint: '',
      beforeRetry: null,
      signal: controller.signal,
      log: (line) => console.error(line),
    }))
    process.exit(0)
  `
}

async function createFixture(label: string, statements: string[]): Promise<Fixture> {
  const env = getLiveEnv()
  const prefix = createPrefix(label)
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const migrationsDir = join(dir, 'chkit/migrations')
  await mkdir(migrationsDir, { recursive: true })
  const database = `${prefix}db`
  const migration = `20990101000000_${prefix}load.sql`
  await writeFile(join(migrationsDir, migration), [...statements, ''].join('\n'), 'utf8')
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

function migrate(fixture: Fixture): { result: Promise<CliResult>; kill: (signal?: NodeJS.Signals) => void } {
  return startCli(fixture.dir, ['migrate', '--config', fixture.config, '--execute', '--json'], {
    CHKIT_JOURNAL_TABLE: fixture.journalTable,
    CHKIT_E2E_PASSWORD: getLiveEnv().clickhousePassword,
    CI: '1',
  })
}

interface Operation {
  status: string
  marker: string
  queryId: string
}

async function readOperations(fixture: Fixture): Promise<Operation[]> {
  const [row] = await fixture.executor.query<{ ops: string }>(
    `SELECT toJSONString(arrayMap(o -> (o.status, o.last_error, o.query_id), operations)) AS ops ` +
      `FROM ${quoteIdent(fixture.database)}.${quoteIdent(fixture.journalTable)} FINAL ` +
      `WHERE name = '${fixture.migration}' SETTINGS select_sequential_consistency = 1`,
  )
  const ops = row ? (JSON.parse(row.ops) as [string, string, string][]) : []
  return ops.map(([status, marker, queryId]) => ({ status, marker, queryId }))
}

async function waitForOperations(fixture: Fixture, ready: (ops: Operation[]) => boolean): Promise<Operation> {
  const ops = await pollUntil(() => readOperations(fixture), ready, { intervalMs: 100, timeoutMs: 60_000 })
  if (!ready(ops)) throw new Error(`journal never showed the expected operations: ${JSON.stringify(ops)}`)
  return ops[0] as Operation
}

/** Claims of the migrate lock not released. */
async function heldClaims(fixture: Fixture): Promise<string[]> {
  const rows = await fixture.executor.query<{ claim: string }>(
    `SELECT substring(name, ${'__chkit_migrate_lock__/'.length + 1}) AS claim FROM ${quoteIdent(fixture.database)}.${quoteIdent(fixture.journalTable)} ` +
      "WHERE startsWith(name, '__chkit_migrate_lock__/') GROUP BY name " +
      "HAVING max(applied_at) < toDateTime64('2299-01-01 00:00:00', 3, 'UTC') SETTINGS select_sequential_consistency = 1",
  )
  return rows.map((row) => row.claim)
}

async function countEvents(fixture: Fixture): Promise<number> {
  const [row] = await fixture.executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${quoteIdent(fixture.database)}.events`)
  return Number(row?.n)
}
