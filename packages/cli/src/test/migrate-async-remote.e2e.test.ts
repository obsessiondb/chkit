import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { createRemoteExecutor } from '../../../plugin-obsessiondb/src/query/remote-executor.js'
import {
  type AsyncApplyInput,
  applyAsyncStatement,
  ATTEMPT_RECORD_MARKER,
  makeDeterministicQueryId,
} from '../commands/migrate/async-apply.js'
import type { JournalStore, MigrationRowState } from '../runtime/journal-store.js'
import {
  createLiveExecutor,
  createPrefix,
  getLiveEnv,
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

type LiveEnv = ReturnType<typeof getLiveEnv>

interface WorkbenchInput {
  query: string
  settings?: Record<string, string | number>
  queryId?: string
}

interface WorkbenchResult {
  data: string[][]
  meta: Array<{ name: string; type: string }>
  rows: number
}

interface WorkbenchOptions {
  /** Fail system.query_log reads until a statement is submitted, as on a
   *  fresh server, which creates the table on its first log flush. */
  queryLogAfterSubmit?: boolean
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

  // The in-flight check runs before the first submission, when a fresh server
  // can still lack system.query_log (OBS-176).
  test('a first submission completes on a server that has not created system.query_log yet', async () => {
    const run = startRun('remote_fresh', { queryLogAfterSubmit: true })
    const journal = createMemoryJournal(null)
    const statement = run.statement({
      migrationName: `20990101000000_${run.prefix}fresh.sql`,
      journalStore: journal.store,
      sql: `INSERT INTO ${run.table} SELECT number FROM numbers(3)`,
    })
    try {
      await run.createTable()
      expect((await applyAsyncStatement(statement)).kind).toBe('completed')
      expect(journal.statuses()).toEqual(['started', 'completed'])
      expect(await run.countRows(3)).toBe(3)
    } finally {
      await run.cleanup()
    }
  }, TIMEOUT_MS)

  // A run that lost its connection leaves the statement 'started' while its
  // query runs on, and a re-run attaches to it. An earlier attempt finished
  // before under the id earlier releases gave a first attempt. The attached
  // attempt's id is its own, recorded fenced before its submit (#767), so its
  // polls read that id only and the earlier QueryFinish never counts.
  test('an attach polls only the id its fenced record names', async () => {
    const run = startRun('remote_attach')
    const migrationName = `20990101000000_${run.prefix}attach.sql`
    const earlierId = makeDeterministicQueryId(getLiveEnv().clickhouseDatabase, '_chkit_migrations', migrationName, 0)
    const attachedId = randomUUID()
    try {
      await run.createTable()
      await run.remote.submit(`INSERT INTO ${run.table} SELECT number FROM numbers(2)`, earlierId)
      const earlier = await pollUntil(
        () => run.remote.queryStatus(earlierId),
        (status) => status.status === 'finished',
        { timeoutMs: 60_000 },
      )
      expect(earlier.status).toBe('finished')
      const attachedStartMs = await readServerNowMs(run.live)
      // Fails after about 6 s: one row per block, 0.5 s per row.
      const attached = run.remote
        .submit(
          `INSERT INTO ${run.table} SELECT number + throwIf(number = 12, 'attached attempt failed') + sleepEachRow(0.5) FROM numbers(20) SETTINGS max_block_size = 1`,
          attachedId,
        )
        .then(
          () => 'finished',
          (error: unknown) => String(error),
        )
      const running = await pollUntil(
        () => run.remote.queryStatus(attachedId),
        (status) => status.status === 'running',
        { intervalMs: 100 },
      )
      expect(running.status).toBe('running')

      const calls: Array<{ queryId: string; afterTime?: string }> = []
      const db: ClickHouseExecutor = {
        ...run.remote,
        queryStatus: (id, options) => {
          calls.push({ queryId: id, afterTime: options?.afterTime })
          return run.remote.queryStatus(id, options)
        },
      }
      const startedAt = new Date(attachedStartMs).toISOString().replace('Z', '')
      const journal = createMemoryJournal(startedState(migrationName, attachedId, run.operationKey, { startedAt, fenced: true }))
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
      // The attach writes nothing until the outcome.
      expect(journal.statuses()).toEqual(['failed'])
      expect(await attached).toContain('attached attempt failed')

      // Every check and poll reads the attached attempt's id, from an hour
      // before its recorded start, which only lets query_log prune.
      expect(calls.length).toBeGreaterThan(1)
      expect(calls.every((call) => call.queryId === attachedId)).toBe(true)
      expect(new Set(calls.map((call) => call.afterTime))).toEqual(new Set([new Date(attachedStartMs - 3_600_000).toISOString()]))
    } finally {
      await run.cleanup()
    }
  }, TIMEOUT_MS)

  // #767: a record an earlier release wrote names an id that earlier attempts
  // may share, so chkit cannot tell the running attempt's outcome from
  // query_log once it ends. The run stops instead of attaching.
  test('a running attempt under a record an earlier release wrote stops the run', async () => {
    const run = startRun('remote_legacy')
    const migrationName = `20990101000000_${run.prefix}legacy.sql`
    const legacyId = makeDeterministicQueryId(getLiveEnv().clickhouseDatabase, '_chkit_migrations', migrationName, 0)
    try {
      await run.createTable()
      // About 5 s: one row per block, 0.5 s per row.
      const legacy = run.remote.submit(`INSERT INTO ${run.table} SELECT number + sleepEachRow(0.5) FROM numbers(10) SETTINGS max_block_size = 1`, legacyId)
      const running = await pollUntil(
        () => run.remote.queryStatus(legacyId),
        (status) => status.status === 'running',
        { intervalMs: 100 },
      )
      expect(running.status).toBe('running')
      const journal = createMemoryJournal(startedState(migrationName, legacyId, run.operationKey))

      await expect(
        applyAsyncStatement(run.statement({ migrationName, journalStore: journal.store, sql: 'SELECT 1' })),
      ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: expect.stringContaining(`query_id ${legacyId}) is still running on the server`) })
      expect(journal.statuses()).toEqual([])
      await legacy
    } finally {
      await run.cleanup()
    }
  }, TIMEOUT_MS)
})

function startRun(label: string, workbenchOptions: WorkbenchOptions = {}) {
  const env = getLiveEnv()
  const workbench = startWorkbench(env, workbenchOptions)
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
function startWorkbench(env: LiveEnv, options: WorkbenchOptions): { url: string; stop: () => void } {
  const authorization = `Basic ${btoa(`${env.clickhouseUser}:${env.clickhousePassword}`)}`
  let submitted = false
  const server = Bun.serve({
    port: 0,
    // A submitted query holds its request open until it ends.
    idleTimeout: 60,
    async fetch(request) {
      const { json: input } = (await request.json()) as { json: WorkbenchInput }
      if (input.queryId) submitted = true
      if (options.queryLogAfterSubmit && !submitted && input.query.includes('system.query_log')) {
        const error = "Code: 60. DB::Exception: Unknown table expression identifier 'system.query_log'. (UNKNOWN_TABLE)"
        return Response.json({ json: { data: [], meta: [], rows: 0, error } })
      }
      const url = new URL(env.clickhouseUrl)
      url.searchParams.set('default_format', 'JSONCompactStrings')
      // Like the real API: the query runs under the top-level queryId, and a
      // query_id setting is ignored.
      for (const [key, value] of Object.entries(input.settings ?? {})) {
        if (key !== 'query_id') url.searchParams.set(key, String(value))
      }
      if (input.queryId) url.searchParams.set('query_id', input.queryId)
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

// What a run that lost its connection while the statement ran leaves behind:
// by default, a record an earlier release wrote.
function startedState(
  migrationName: string,
  queryId: string,
  operationKey: string,
  attempt: { startedAt?: string; fenced?: boolean } = {},
): MigrationRowState {
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
        startedAt: attempt.startedAt ?? '2026-10-02 00:00:00.000',
        finishedAt: null,
        lastError: attempt.fenced ? ATTEMPT_RECORD_MARKER : '',
        fingerprint: '',
        ...(attempt.fenced ? { attemptFenced: true } : {}),
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
