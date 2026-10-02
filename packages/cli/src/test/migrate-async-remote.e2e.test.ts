import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { createRemoteExecutor } from '../../../plugin-obsessiondb/src/query/remote-executor.js'
import {
  type AsyncApplyInput,
  applyAsyncStatement,
  makeDeterministicQueryId,
} from '../commands/migrate/async-apply.js'
import type { JournalStore, MigrationRowState } from '../runtime/journal-store.js'
import {
  createLiveExecutor,
  createPrefix,
  getRequiredEnv,
  pollUntil,
  quoteIdent,
  waitForTable,
} from './e2e-testkit.js'

// With the ObsessionDB plugin, migrate runs async statements through the
// plugin's remote executor. A stand-in for the workbench API runs each query on
// the live ClickHouse and returns every cell as a string, as the API does, so
// the query_log bounds of #233 meet a real server through that executor.

const TIMEOUT_MS = 240_000
const POLL_INTERVAL_MS = 250
const MIGRATION_CHECKSUM = 'c1'

type LiveEnv = ReturnType<typeof getRequiredEnv>

interface WorkbenchInput {
  query: string
  settings?: Record<string, string | number>
}

interface WorkbenchResult {
  data: string[][]
  meta: Array<{ name: string; type: string }>
  rows: number
}

describe('async migrate statements through the ObsessionDB remote executor (live)', () => {
  test('a submission completes, and a re-run skips it', async () => {
    const run = startRun('remote_submit')
    const journal = createMemoryJournal(null)
    const statement = run.statement({
      migrationName: `20990101000000_${run.prefix}load.sql`,
      journalStore: journal.store,
      // About 1.5 s, so the first polls see the query running.
      sql: `INSERT INTO ${run.table} SELECT number FROM numbers(30) WHERE sleepEachRow(0.05) = 0 SETTINGS max_block_size = 1`,
    })
    try {
      await run.createTable()
      expect((await applyAsyncStatement(statement)).kind).toBe('completed')
      expect(journal.statuses()).toEqual(['started', 'completed'])
      expect((await applyAsyncStatement(statement)).kind).toBe('skipped')
      expect(await run.countRows(30)).toBe(30)
    } finally {
      await run.cleanup()
    }
  }, TIMEOUT_MS)

  // A run that lost its connection leaves the statement 'started' while its
  // query runs on, and a re-run attaches to it. An earlier attempt with the
  // same query id (one that was abandoned) finished before. query_log is
  // flushed on a timer, so right after the attached attempt fails, the earlier
  // attempt's QueryFinish can be the newest entry for the id.
  test('an attach counts only query_log entries of the attempt it attaches to', async () => {
    const run = startRun('remote_attach')
    const migrationName = `20990101000000_${run.prefix}attach.sql`
    const queryId = makeDeterministicQueryId(migrationName, 0)
    try {
      await run.createTable()
      await run.remote.submit(`INSERT INTO ${run.table} SELECT number FROM numbers(2)`, queryId)
      const earlierAttemptEndedMs = await readServerNowMs(run.live)
      const earlier = await pollUntil(
        () => run.remote.queryStatus(queryId),
        (status) => status.status === 'finished',
        { timeoutMs: 60_000 },
      )
      expect(earlier.status).toBe('finished')
      // Start the attached attempt well past the bound's 2 s margin.
      await sleep(4_000)
      // Fails after about 6 s: one row per block, 0.5 s per row.
      const attached = run.remote
        .submit(
          `INSERT INTO ${run.table} SELECT number + throwIf(number = 12, 'attached attempt failed') + sleepEachRow(0.5) FROM numbers(20) SETTINGS max_block_size = 1`,
          queryId,
        )
        .then(
          () => 'finished',
          (error: unknown) => String(error),
        )
      const running = await pollUntil(
        () => run.remote.queryStatus(queryId),
        (status) => status.status === 'running',
        { intervalMs: 100 },
      )
      expect(running.status).toBe('running')

      const afterTimes: Array<string | undefined> = []
      const db: ClickHouseExecutor = {
        ...run.remote,
        queryStatus: (id, options) => {
          afterTimes.push(options?.afterTime)
          return run.remote.queryStatus(id, options)
        },
      }
      const journal = createMemoryJournal(startedState(migrationName, queryId, run.operationKey))
      const lines: string[] = []
      const statement = {
        ...run.statement({
          migrationName,
          journalStore: journal.store,
          // Never submitted: chkit attaches to the running attempt.
          sql: 'SELECT 1',
        }),
        db,
        log: (line: string) => lines.push(line),
      }

      await expect(applyAsyncStatement(statement)).rejects.toThrow(/attached attempt failed/)
      expect(lines.some((line) => line.includes('attaching to in-flight query'))).toBe(true)
      expect(journal.statuses()).toEqual(['failed'])
      expect(await attached).toContain('attached attempt failed')

      // The in-flight check looks for any running query with the id. Every
      // poll after it counts only queries that started after the earlier
      // attempt had ended.
      const [inFlightCheck, ...polls] = afterTimes
      expect(inFlightCheck).toBeUndefined()
      expect(polls.length).toBeGreaterThan(0)
      expect(new Set(polls).size).toBe(1)
      expect(Date.parse(polls[0] ?? '')).toBeGreaterThan(earlierAttemptEndedMs)
    } finally {
      await run.cleanup()
    }
  }, TIMEOUT_MS)
})

function startRun(label: string) {
  const env = getRequiredEnv()
  const workbench = startWorkbench(env)
  const live = createLiveExecutor(env)
  const remote = createRemoteExecutor({
    credentials: { access_token: 'test', base_url: workbench.url },
    serviceSlug: 'test',
  })
  const prefix = createPrefix(label)
  const tableName = `${prefix}dst`
  const table = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(tableName)}`
  const operationKey = `table:${env.clickhouseDatabase}.${tableName}`
  return {
    prefix,
    table,
    operationKey,
    live,
    remote,
    statement(input: { migrationName: string; journalStore: JournalStore; sql: string }): AsyncApplyInput {
      return {
        ...input,
        db: remote,
        migrationChecksum: MIGRATION_CHECKSUM,
        statementIndex: 0,
        operationType: 'load_table_data',
        operationKey,
        beforeRetry: null,
        log: () => {},
        pollIntervalMs: POLL_INTERVAL_MS,
      }
    },
    async createTable() {
      await live.command(`CREATE TABLE ${table} (n UInt64) ENGINE = MergeTree ORDER BY n`)
      await waitForTable(live, env.clickhouseDatabase, tableName)
    },
    async countRows(expected: number): Promise<number> {
      const read = async () => {
        const [row] = await live.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`)
        return Number(row?.n)
      }
      return pollUntil(read, (rows) => rows >= expected)
    },
    async cleanup() {
      await live.command(`DROP TABLE IF EXISTS ${table}`)
      await live.close()
      workbench.stop()
    },
  }
}

// Stands in for the ObsessionDB workbench API: runs each query on the live
// ClickHouse and returns every cell as a string, as the API does.
function startWorkbench(env: LiveEnv): { url: string; stop: () => void } {
  const authorization = `Basic ${btoa(`${env.clickhouseUser}:${env.clickhousePassword}`)}`
  const server = Bun.serve({
    port: 0,
    // A submitted query holds its request open until it ends.
    idleTimeout: 60,
    async fetch(request) {
      const { json: input } = (await request.json()) as { json: WorkbenchInput }
      const url = new URL(env.clickhouseUrl)
      url.searchParams.set('default_format', 'JSONCompactStrings')
      for (const [key, value] of Object.entries(input.settings ?? {})) {
        url.searchParams.set(key, String(value))
      }
      const response = await fetch(url, {
        method: 'POST',
        body: input.query,
        headers: { Authorization: authorization },
      })
      const body = await response.text()
      if (!response.ok) {
        return Response.json({ json: { data: [], meta: [], rows: 0, error: body.trim() } })
      }
      const result: WorkbenchResult =
        body.trim() === '' ? { data: [], meta: [], rows: 0 } : JSON.parse(body)
      return Response.json({ json: { data: result.data, meta: result.meta, rows: result.rows } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

function createMemoryJournal(initial: MigrationRowState | null) {
  let state = initial
  const writes: MigrationRowState[] = []
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState() {
      return state
    },
    async writeMigrationState(next) {
      writes.push(next)
      state = next
    },
    async appendEntry() {},
  }
  return { store, statuses: () => writes.map((write) => write.operations[0]?.status) }
}

// What a run that lost its connection while the statement ran leaves behind.
function startedState(migrationName: string, queryId: string, operationKey: string): MigrationRowState {
  return {
    name: migrationName,
    appliedAt: '1970-01-01 00:00:00.000',
    checksum: MIGRATION_CHECKSUM,
    chkitVersion: '',
    migrationCompleted: false,
    operations: [
      {
        operationIndex: 0,
        operationKey,
        operationType: 'load_table_data',
        queryId,
        status: 'started',
        startedAt: '2026-10-02 00:00:00.000',
        finishedAt: null,
        lastError: '',
      },
    ],
  }
}

async function readServerNowMs(db: ClickHouseExecutor): Promise<number> {
  const [row] = await db.query<{ now_ms: string }>(
    'SELECT toString(toUnixTimestamp64Milli(now64(3))) AS now_ms',
  )
  return Number(row?.now_ms)
}
