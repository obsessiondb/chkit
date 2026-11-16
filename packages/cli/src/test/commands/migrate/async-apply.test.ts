import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor, ClickHouseSettings, QueryStatus, QueryStatusOptions } from '@chkit/clickhouse'

import {
  applyAsyncStatement,
  ATTEMPT_RECORD_MARKER,
  makeDeterministicQueryId,
  STARTED_RECORD_MARKER,
} from '../../../commands/migrate/async-apply.js'
import type {
  JournalStore,
  MigrationRowState,
  OperationState,
} from '../../../runtime/journal-store.js'

type StatusCall = { queryId: string; afterTime?: string; everyReplica?: boolean; runningOnly?: boolean }
type SubmitCall = { sql: string; queryId?: string; settings?: ClickHouseSettings }
type CommandCall = { sql: string; settings?: ClickHouseSettings }

interface FakeExecutor {
  db: ClickHouseExecutor
  /** A sleep that advances the fake's server clock, as time does the real one's. */
  sleep: (ms: number) => Promise<void>
  statusCalls: StatusCall[]
  submitCalls: SubmitCall[]
  commandCalls: CommandCall[]
  /** Server-time reads, status checks and submissions, in call order. */
  events: string[]
}

// The server clock differs from the client clock (FIXED_NOW) on purpose: the
// query_log bound must come from the server.
const SERVER_NOW_MS = 1_700_000_100_000
const SERVER_DATABASE = 'analytics'
// SERVER_NOW_MS minus the 2 s skew margin.
const SUBMISSION_BOUND = '2023-11-14T22:14:58.000Z'
// How long the attempt an attach finds has been running.
const RUNNING_ELAPSED_MS = 30_000
// SERVER_NOW_MS minus RUNNING_ELAPSED_MS and the 2 s skew margin.
const ATTACH_BOUND = '2023-11-14T22:14:28.000Z'
// A retry's id is its own (#701): its polls count every query_log entry from
// an hour before SERVER_NOW_MS, a bound that only lets query_log prune.
const RETRY_BOUND = '2023-11-14T21:15:00.000Z'
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function createFakeExecutor(
  // An Error is thrown by the queryStatus call it answers.
  statuses: Array<QueryStatus | Error>,
  // deferSubmit settles the submit only after the polls of a no-sleep test ran.
  // clock: the server clock, which a test can advance; SERVER_NOW_MS by default.
  options: { failSubmit?: () => Error; deferSubmit?: boolean; clock?: { ms: number } } = {},
): FakeExecutor {
  const statusCalls: StatusCall[] = []
  const submitCalls: SubmitCall[] = []
  const commandCalls: CommandCall[] = []
  const events: string[] = []
  const queue = [...statuses]
  const clock = options.clock ?? { ms: SERVER_NOW_MS }
  const sleep = async (ms: number) => {
    clock.ms += ms
  }
  const db = {
    async query(sql: string) {
      events.push(`query: ${sql}`)
      return [{ now_ms: String(clock.ms), database: SERVER_DATABASE }]
    },
    async submit(sql: string, queryId?: string, settings?: ClickHouseSettings) {
      events.push('submit')
      submitCalls.push({ sql, queryId, ...(settings ? { settings } : {}) })
      if (options.deferSubmit) await new Promise((resolve) => setTimeout(resolve, 10))
      if (options.failSubmit) throw options.failSubmit()
      return queryId ?? 'fallback-id'
    },
    async queryStatus(queryId: string, opts?: QueryStatusOptions) {
      events.push('status')
      statusCalls.push({
        queryId,
        afterTime: opts?.afterTime,
        everyReplica: opts?.everyReplica,
        ...(opts?.runningOnly ? { runningOnly: true } : {}),
      })
      const next = queue.shift()
      if (!next) {
        throw new Error('queryStatus called more times than fake has answers for')
      }
      if (next instanceof Error) throw next
      // A read of system.processes alone, as the server answers it, never
      // finds a query that ended.
      if (opts?.runningOnly && next.status !== 'running') return { status: 'unknown' }
      return next
    },
    async command(sql: string, settings?: ClickHouseSettings) {
      commandCalls.push({ sql, ...(settings ? { settings } : {}) })
    },
  } as unknown as ClickHouseExecutor
  return { db, sleep, statusCalls, submitCalls, commandCalls, events }
}

interface FakeStore {
  store: JournalStore
  writes: MigrationRowState[]
}

function createFakeJournalStore(initial: MigrationRowState | null = null): FakeStore {
  let current: MigrationRowState | null = initial
  const writes: MigrationRowState[] = []
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState() {
      return current
    },
    async writeMigrationState(state) {
      writes.push(state)
      current = state
    },
    async appendEntry() {
      // not used in these tests
    },
  }
  return { store, writes }
}

const SERVER_TIME_QUERY = 'query: SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms, currentDatabase() AS database'

const NO_SLEEP = (_ms: number) => Promise.resolve()
const FIXED_NOW = () => 1_700_000_000_000

const BASE_INPUT = {
  sql: 'INSERT INTO t SELECT 1',
  migrationName: 'm.sql',
  migrationChecksum: 'deadbeef',
  statementIndex: 0,
  operationType: 'load_table_data',
  operationKey: 'table:t',
  beforeRetry: null,
} as const

// The id a statement with no journal row gets on SERVER_DATABASE.
const QUERY_ID = makeDeterministicQueryId(
  SERVER_DATABASE,
  '_chkit_migrations',
  BASE_INPUT.migrationName,
  BASE_INPUT.statementIndex,
)

// The id a retry submitted under: a random one, never the statement's first id (#701).
function retryQueryId(submitCalls: Array<{ queryId?: string }>): string {
  const id = submitCalls[0]?.queryId ?? ''
  expect(id).toMatch(UUID_SHAPE)
  expect(id).not.toBe(QUERY_ID)
  return id
}

function freshStateWith(op: OperationState): MigrationRowState {
  return {
    name: BASE_INPUT.migrationName,
    appliedAt: '1970-01-01 00:00:00.000',
    checksum: BASE_INPUT.migrationChecksum,
    chkitVersion: '',
    migrationCompleted: false,
    operations: [op],
  }
}

describe('applyAsyncStatement', () => {
  test('produces a deterministic UUID-shaped query_id from (database, journal table, migration, statement_index)', () => {
    const a = makeDeterministicQueryId('staging', '_chkit_migrations', '20260526_load.sql', 0)
    expect(makeDeterministicQueryId('staging', '_chkit_migrations', '20260526_load.sql', 0)).toBe(a)
    // chkit-py builds the same id (test_migrate_async_apply.py).
    expect(a).toBe('ff8138de-dce9-96af-69dc-cd30f8f4a7bb')
    const others = [
      makeDeterministicQueryId('staging', '_chkit_migrations', '20260526_load.sql', 1),
      makeDeterministicQueryId('staging', '_chkit_migrations', '20260526_other.sql', 0),
      // #463: another database, or another project's journal in the same database.
      makeDeterministicQueryId('prod', '_chkit_migrations', '20260526_load.sql', 0),
      makeDeterministicQueryId('staging', '_chkit_migrations_b', '20260526_load.sql', 0),
    ]
    expect(new Set([a, ...others]).size).toBe(5)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('first attempt: writes started, submits, polls to completion', async () => {
    const queryId = QUERY_ID
    const { db, statusCalls, submitCalls, commandCalls, events } = createFakeExecutor([
      { status: 'unknown' }, // initial in-flight check
      { status: 'running', writtenRows: 50_000 },
      { status: 'finished', writtenRows: 100_000, durationMs: 8000 },
    ])
    const { store, writes } = createFakeJournalStore(null)
    const lines: string[] = []

    const result = await applyAsyncStatement({
      ...BASE_INPUT,
      db,
      journalStore: store,
      log: (line) => lines.push(line),
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0]?.queryId).toBe(queryId)
    expect(commandCalls).toEqual([]) // no before-retry on first attempt
    expect(statusCalls).toHaveLength(3)
    // The in-flight check looks for any running query with this id; the polls
    // after submitting only count queries started after the server-time bound.
    expect(statusCalls.map((call) => call.afterTime)).toEqual([
      undefined,
      SUBMISSION_BOUND,
      SUBMISSION_BOUND,
    ])
    // The server time is read before the in-flight check (an attach would
    // need it) and again right before the submission.
    expect(events).toEqual([SERVER_TIME_QUERY, 'status', SERVER_TIME_QUERY, 'submit', 'status', 'status'])
    // Two writes: started + completed.
    expect(writes).toHaveLength(2)
    expect(writes[0]?.operations[0]?.status).toBe('started')
    expect(writes[1]?.operations[0]?.status).toBe('completed')
    expect(lines.some((line) => line.includes('submitting async'))).toBe(true)
  })

  test('refuses to resume in-progress async state when the migration checksum changed', async () => {
    const queryId = QUERY_ID
    const { db, statusCalls, submitCalls, commandCalls } = createFakeExecutor([])
    const { store, writes } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId,
        status: 'started',
        startedAt: '2026-05-26 12:00:00.000',
        finishedAt: null,
        lastError: '',
      }),
    )

    const attempt = applyAsyncStatement({
      ...BASE_INPUT,
      migrationChecksum: 'changed-checksum',
      beforeRetry: 'TRUNCATE TABLE t',
      db,
      journalStore: store,
      log: () => {},
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })
    await expect(attempt).rejects.toThrow(/in-progress async journal state/)
    await expect(attempt).rejects.toThrow(/chkit migrate --apply --retry m\.sql/)
    await expect(attempt).rejects.toMatchObject({ code: 'in_progress_checksum_mismatch' })

    expect(statusCalls).toEqual([])
    expect(submitCalls).toEqual([])
    expect(commandCalls).toEqual([])
    expect(writes).toEqual([])
  })

  test('completed-skip: prior operation marked completed → no submit, no command', async () => {
    const queryId = QUERY_ID
    const { db, statusCalls, submitCalls, commandCalls } = createFakeExecutor([])
    const { store, writes } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId,
        status: 'completed',
        startedAt: '2026-05-26 12:00:00.000',
        finishedAt: '2026-05-26 12:01:00.000',
        lastError: '',
      }),
    )
    const lines: string[] = []

    const result = await applyAsyncStatement({
      ...BASE_INPUT,
      db,
      journalStore: store,
      log: (line) => lines.push(line),
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('skipped')
    expect(submitCalls).toEqual([])
    expect(statusCalls).toEqual([]) // didn't even consult system.processes
    expect(commandCalls).toEqual([])
    expect(writes).toEqual([]) // nothing changed
    expect(lines.some((line) => line.includes('already completed'))).toBe(true)
  })

  test('in-flight attach: query already running on server → poll without resubmit', async () => {
    const queryId = QUERY_ID
    const { db, statusCalls, submitCalls, commandCalls, events } = createFakeExecutor([
      { status: 'running', writtenRows: 50, elapsedMs: RUNNING_ELAPSED_MS }, // initial check sees it running
      { status: 'running', writtenRows: 75 },
      { status: 'finished', writtenRows: 100, durationMs: 5000 },
    ])
    const { store, writes } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId,
        status: 'started',
        startedAt: '2026-05-26 11:00:00.000',
        finishedAt: null,
        lastError: '',
      }),
    )
    const lines: string[] = []

    const result = await applyAsyncStatement({
      ...BASE_INPUT,
      beforeRetry: 'TRUNCATE TABLE t',
      db,
      journalStore: store,
      log: (line) => lines.push(line),
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    expect(submitCalls).toEqual([]) // never resubmitted
    expect(commandCalls).toEqual([]) // before-retry NOT run on attach
    // The polls only count queries that started with the attached attempt,
    // which had run for RUNNING_ELAPSED_MS when the in-flight check saw it.
    // A started record an older chkit wrote, with before-retry SQL, is
    // checked in system.processes only (#672).
    expect(statusCalls.map((call) => call.afterTime)).toEqual([undefined, ATTACH_BOUND, ATTACH_BOUND])
    expect(events).toEqual([SERVER_TIME_QUERY, 'status', 'status', 'status'])
    expect(lines.some((line) => line.includes('attaching'))).toBe(true)
    // The attach journals the attempt started (#672), then completed.
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'completed'])
  })

  // query_log is flushed on a timer. Right after the attached attempt ends, its
  // entry can still be missing while an earlier attempt with the same query id
  // (abandoned, or retried after an edit, #233) has its QueryFinish there.
  test('an attach ignores query_log entries of an earlier attempt', async () => {
    const queryId = QUERY_ID
    const attachedStartSec = Math.floor((SERVER_NOW_MS - RUNNING_ELAPSED_MS) / 1000)
    const earlierStartSec = attachedStartSec - 3_600
    const phases = ['running', 'running', 'flush gap', 'flush gap', 'flushed']
    const statusCalls: StatusCall[] = []
    const db = {
      async query() {
        return [{ now_ms: SERVER_NOW_MS, database: SERVER_DATABASE }]
      },
      async submit() {
        throw new Error('an attach never submits')
      },
      // system.processes while the attempt runs, then system.query_log:
      // query_start_time >= parseDateTimeBestEffort(afterTime), in whole seconds.
      async queryStatus(id: string, opts?: { afterTime?: string }): Promise<QueryStatus> {
        statusCalls.push({ queryId: id, afterTime: opts?.afterTime })
        const phase = phases.shift()
        if (phase === undefined) throw new Error('queryStatus called after the attempt was reported')
        if (phase === 'running') return { status: 'running', writtenRows: 1, elapsedMs: RUNNING_ELAPSED_MS }
        const afterSec = opts?.afterTime === undefined ? 0 : Math.floor(Date.parse(opts.afterTime) / 1000)
        if (phase === 'flushed' && attachedStartSec >= afterSec) {
          return { status: 'failed', error: 'Memory limit exceeded' }
        }
        return earlierStartSec >= afterSec
          ? { status: 'finished', writtenRows: 2, durationMs: 10 }
          : { status: 'unknown' }
      },
      async command() {},
    } as unknown as ClickHouseExecutor
    const { store, writes } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId,
        status: 'started',
        startedAt: '2023-11-14 22:14:30.000',
        finishedAt: null,
        lastError: '',
      }),
    )

    await expect(
      applyAsyncStatement({
        ...BASE_INPUT,
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      }),
    ).rejects.toThrow(/Memory limit exceeded/)

    expect(statusCalls.slice(1).map((call) => call.afterTime)).toEqual(Array(4).fill(ATTACH_BOUND))
    // Recorded as the attached attempt's failure, never as completed.
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'failed'])
  })

  test('an attach keeps the unbounded lookup when the running attempt reports no elapsed time', async () => {
    const { db, statusCalls } = createFakeExecutor([
      { status: 'running' },
      { status: 'finished', writtenRows: 1, durationMs: 100 },
    ])
    const { store } = createFakeJournalStore(null)

    const result = await applyAsyncStatement({
      ...BASE_INPUT,
      db,
      journalStore: store,
      log: () => {},
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    // Without its start, a bound could exclude the attempt's own entry.
    expect(statusCalls.map((call) => call.afterTime)).toEqual([undefined, '1970-01-01 00:00:00'])
  })

  // #463: an older chkit derived the id from the migration alone. A statement
  // it journaled keeps that id, so an upgrade mid-load still finds the attempt.
  test('a statement the journal tracks keeps its journaled query id', async () => {
    const legacyId = 'f2d1c4e0-1111-2222-3333-444455556666'
    const { db, statusCalls, submitCalls, commandCalls } = createFakeExecutor([
      { status: 'running', writtenRows: 5, elapsedMs: RUNNING_ELAPSED_MS },
      { status: 'finished', writtenRows: 12, durationMs: 12_000 },
    ])
    const { store, writes } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId: legacyId,
        status: 'started',
        startedAt: '2026-05-26 11:00:00.000',
        finishedAt: null,
        lastError: '',
      }),
    )

    const result = await applyAsyncStatement({
      ...BASE_INPUT,
      beforeRetry: 'TRUNCATE TABLE t',
      db,
      journalStore: store,
      log: () => {},
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    expect(statusCalls.map((call) => call.queryId)).toEqual([legacyId, legacyId])
    expect(submitCalls).toEqual([])
    expect(commandCalls).toEqual([])
    // The attach journals the attempt started (#672), under its journaled id.
    expect(writes.map((state) => state.operations[0]?.queryId)).toEqual([legacyId, legacyId])
  })

  test('retry: prior failed op + query no longer running → run before-retry, then resubmit', async () => {
    const queryId = QUERY_ID
    const { db, sleep, statusCalls, submitCalls, commandCalls, events } = createFakeExecutor([
      { status: 'unknown' }, // initial check: not running on server anymore
      { status: 'running', writtenRows: 25_000 },
      { status: 'finished', writtenRows: 100_000, durationMs: 3000 },
    ])
    const { store, writes } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId,
        status: 'failed',
        startedAt: '2026-05-26 10:00:00.000',
        finishedAt: '2026-05-26 10:05:00.000',
        lastError: 'Memory limit exceeded',
      }),
    )
    const lines: string[] = []

    const result = await applyAsyncStatement({
      ...BASE_INPUT,
      beforeRetry: 'TRUNCATE TABLE t SETTINGS max_table_size_to_drop = 0',
      db,
      journalStore: store,
      log: (line) => lines.push(line),
      sleep,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    expect(commandCalls).toEqual([
      { sql: 'TRUNCATE TABLE t SETTINGS max_table_size_to_drop = 0' },
    ])
    // The check reads the recorded attempt's id; the retry submits and polls
    // under an id of its own, so every query_log entry of it counts (#701).
    expect(statusCalls[0]?.queryId).toBe(queryId)
    expect(submitCalls).toHaveLength(1)
    const retryId = retryQueryId(submitCalls)
    expect(statusCalls).toHaveLength(3)
    expect(statusCalls.slice(1)).toMatchObject([
      { queryId: retryId, afterTime: RETRY_BOUND },
      { queryId: retryId, afterTime: RETRY_BOUND },
    ])
    // The retry submits right after the check, without waiting on the server clock.
    expect(events).toEqual([SERVER_TIME_QUERY, 'status', 'submit', 'status', 'status'])
    // #246: the check that decides on the retry reads every replica; a poll
    // skips a replica it cannot reach.
    expect(statusCalls.map((call) => call.everyReplica)).toEqual([true, undefined, undefined])
    expect(lines.some((line) => line.includes('running before-retry SQL'))).toBe(true)
    expect(lines.some((line) => line.includes('Memory limit exceeded'))).toBe(true)
    // started (overwrite prior failed) + completed
    expect(writes).toHaveLength(2)
    expect(writes[0]?.operations[0]).toMatchObject({
      status: 'started',
      queryId: retryId,
      lastError: ATTEMPT_RECORD_MARKER,
    })
    expect(writes[1]?.operations[0]).toMatchObject({ status: 'completed', queryId: retryId })
  })

  test('migrate --setting reaches the before-retry SQL and the resubmission (#321)', async () => {
    const queryId = QUERY_ID
    const { db, sleep, submitCalls, commandCalls } = createFakeExecutor([
      { status: 'unknown' },
      { status: 'finished', writtenRows: 1, durationMs: 10 },
    ])
    const { store } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId,
        status: 'failed',
        startedAt: '2026-05-26 10:00:00.000',
        finishedAt: '2026-05-26 10:05:00.000',
        lastError: 'boom',
      }),
    )
    const settings = { max_table_size_to_drop: '0' }

    await applyAsyncStatement({
      ...BASE_INPUT,
      beforeRetry: 'TRUNCATE TABLE t',
      settings,
      db,
      journalStore: store,
      log: () => {},
      sleep,
      now: FIXED_NOW,
    })

    expect(commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t', settings }])
    expect(submitCalls).toEqual([{ sql: BASE_INPUT.sql, queryId: retryQueryId(submitCalls), settings }])
  })

  test('retry without before-retry SQL: still resubmits forward', async () => {
    const queryId = QUERY_ID
    const { db, sleep, submitCalls, commandCalls } = createFakeExecutor([
      { status: 'unknown' },
      { status: 'finished', writtenRows: 1, durationMs: 100 },
    ])
    const { store } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId,
        status: 'failed',
        startedAt: '2026-05-26 10:00:00.000',
        finishedAt: '2026-05-26 10:05:00.000',
        lastError: 'NETWORK_ERROR',
      }),
    )

    await applyAsyncStatement({
      ...BASE_INPUT,
      beforeRetry: null,
      db,
      journalStore: store,
      log: () => {},
      sleep,
      now: FIXED_NOW,
    })

    expect(commandCalls).toEqual([]) // no before-retry SQL → no command
    expect(submitCalls).toHaveLength(1)
  })

  // #246: the attempt may still run on a replica the check could not read.
  // Running before-retry SQL (a TRUNCATE) or resubmitting then would race it.
  for (const prior of ['started', 'failed'] as const) {
    test(`an in-flight check that cannot read every replica neither compensates nor resubmits (prior op: ${prior})`, async () => {
      const queryId = QUERY_ID
      const { db, statusCalls, submitCalls, commandCalls } = createFakeExecutor([
        new Error('ALL_CONNECTION_TRIES_FAILED: clickhouse-1'),
      ])
      const priorState = freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId,
        status: prior,
        startedAt: '2026-05-26 10:00:00.000',
        finishedAt: prior === 'started' ? null : '2026-05-26 10:05:00.000',
        lastError: '',
      })
      const { store, writes } = createFakeJournalStore(priorState)

      const run = applyAsyncStatement({
        ...BASE_INPUT,
        beforeRetry: 'TRUNCATE TABLE t',
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      })

      await expect(run).rejects.toThrow(
        /could not check whether a previous attempt is still running \(ALL_CONNECTION_TRIES_FAILED: clickhouse-1\)\. Nothing was resubmitted and no before-retry SQL ran/,
      )
      // A started record an older chkit wrote, with before-retry SQL, is
      // checked in system.processes only (#672).
      expect(statusCalls).toEqual([{ queryId, afterTime: undefined, everyReplica: true, runningOnly: true }])
      expect(commandCalls).toEqual([])
      expect(submitCalls).toEqual([])
      expect(writes).toEqual([])
      expect(await store.readMigrationState(BASE_INPUT.migrationName)).toEqual(priorState)
    })
  }

  test('polling-failure: query transitions to failed → write failed state and throw', async () => {
    const { db } = createFakeExecutor([
      { status: 'unknown' },
      { status: 'running' },
      { status: 'failed', error: 'NETWORK_ERROR: broken pipe' },
    ])
    const { store, writes } = createFakeJournalStore(null)

    await expect(
      applyAsyncStatement({
        ...BASE_INPUT,
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      }),
    ).rejects.toThrow(/NETWORK_ERROR: broken pipe/)

    // started + failed
    expect(writes).toHaveLength(2)
    expect(writes[0]?.operations[0]?.status).toBe('started')
    expect(writes[1]?.operations[0]?.status).toBe('failed')
    expect(writes[1]?.operations[0]?.lastError).toContain('NETWORK_ERROR: broken pipe')
  })

  test('surfaces submit error when status remains unknown (SQL parse failure case)', async () => {
    const { db } = createFakeExecutor(
      [{ status: 'unknown' }, { status: 'unknown' }, { status: 'unknown' }],
      { failSubmit: () => new Error('Syntax error: failed at position 1') },
    )
    const { store, writes } = createFakeJournalStore(null)
    const lines: string[] = []

    await expect(
      applyAsyncStatement({
        ...BASE_INPUT,
        sql: 'NOT VALID SQL',
        db,
        journalStore: store,
        log: (line) => lines.push(line),
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      }),
    ).rejects.toThrow(/Syntax error/)

    // The query never started, so the attempt is recorded as failed (#233):
    // an edited file can then run again without --retry.
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'failed'])
    expect(writes[1]?.operations[0]?.lastError).toBe('Syntax error: failed at position 1')
    // The submit error is the command's error; no progress line repeats it (#561).
    expect(lines).toEqual([`  load_table_data: submitting async (query_id=${QUERY_ID})`])
  })

  // When polling gives up, the submit error is the only trace of e.g. a rejected
  // statement, so the error names it (#561).
  // A deferred submit is still pending when the budget runs out.
  for (const [submitFails, deferSubmit] of [
    [true, false],
    [true, true],
    [false, false],
  ] as const) {
    test(`polling that exhausts its budget names the submit error (submit fails: ${submitFails}, deferred: ${deferSubmit})`, async () => {
      const { db } = createFakeExecutor(
        [
          { status: 'unknown' }, // initial in-flight check
          ...Array.from({ length: 21 }, () => new Error('HTTP 502: bad gateway')),
        ],
        submitFails ? { failSubmit: () => new Error('Authentication failed'), deferSubmit } : {},
      )
      const { store, writes } = createFakeJournalStore(null)

      const submitTail = submitFails ? ' The submit request failed too (Authentication failed).' : ''
      await expect(
        applyAsyncStatement({
          ...BASE_INPUT,
          db,
          journalStore: store,
          log: () => {},
          sleep: NO_SLEEP,
          now: FIXED_NOW,
        }),
      ).rejects.toThrow(
        `Async migration step load_table_data (query_id ${QUERY_ID}): polling failed 21× (HTTP 502: bad gateway).${submitTail} The load may still be running server-side — re-run \`chkit migrate --apply\` to re-attach.`,
      )
      // The outcome is unknown, so the attempt stays started for a re-run to re-attach.
      expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started'])
    })
  }

  // A gateway can fail the submit request (e.g. HTTP 524) while the query keeps
  // running on the server. The poller decides the outcome, and the progress
  // lines are the poller's only (#561).
  test('a submit that fails while the query runs completes with the poller lines only', async () => {
    const { db, submitCalls } = createFakeExecutor(
      [
        { status: 'unknown' }, // initial in-flight check
        { status: 'running', writtenRows: 9, writtenBytes: 72 },
        { status: 'finished', writtenRows: 16, writtenBytes: 128, durationMs: 8000 },
      ],
      { failSubmit: () => new Error('HTTP 524: error code: 524') },
    )
    const { store, writes } = createFakeJournalStore(null)
    const lines: string[] = []

    const result = await applyAsyncStatement({
      ...BASE_INPUT,
      db,
      journalStore: store,
      log: (line) => lines.push(line),
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    expect(submitCalls).toHaveLength(1)
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'completed'])
    expect(lines).toEqual([
      `  load_table_data: submitting async (query_id=${QUERY_ID})`,
      '  load_table_data: written=9 rows (72 B), elapsed 0s',
      '  load_table_data: finished — written=16 rows (128 B) in 8s',
    ])
  })

  // After the 524, the query can end between two polls. A poll then finds it
  // neither running nor yet in query_log (flushed on a timer). The server ran
  // the query, so the submit error does not mean it failed (#657).
  test('a submit that fails after a poll found the query running waits for query_log', async () => {
    const { db } = createFakeExecutor(
      [
        { status: 'unknown' }, // initial in-flight check
        { status: 'running', writtenRows: 9, writtenBytes: 72 },
        { status: 'unknown' },
        { status: 'finished', writtenRows: 16, writtenBytes: 128, durationMs: 8000 },
      ],
      { failSubmit: () => new Error('error code: 524') },
    )
    const { store, writes } = createFakeJournalStore(null)
    const lines: string[] = []

    const result = await applyAsyncStatement({
      ...BASE_INPUT,
      db,
      journalStore: store,
      log: (line) => lines.push(line),
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'completed'])
    expect(lines).toEqual([
      `  load_table_data: submitting async (query_id=${QUERY_ID})`,
      '  load_table_data: written=9 rows (72 B), elapsed 0s',
      '  load_table_data: status unknown — still polling (elapsed 0s)',
      '  load_table_data: finished — written=16 rows (128 B) in 8s',
    ])
  })

  test('a submit that fails after a poll found the query running gives up after the poll budget', async () => {
    const { db } = createFakeExecutor(
      [
        { status: 'unknown' }, // initial in-flight check
        { status: 'running', writtenRows: 9, writtenBytes: 72 },
        ...Array.from({ length: 21 }, () => ({ status: 'unknown' as const })),
      ],
      { failSubmit: () => new Error('error code: 524') },
    )
    const { store, writes } = createFakeJournalStore(null)

    await expect(
      applyAsyncStatement({
        ...BASE_INPUT,
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      }),
    ).rejects.toThrow(
      `Async migration step load_table_data (query_id ${QUERY_ID}): the submit request failed (error code: 524) and polling found no outcome 21×. A re-run of \`chkit migrate --apply\` attaches to the query if it still runs and runs the statement again if not.`,
    )
    // The outcome is unknown, so the attempt stays started.
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started'])
  })

  // The query id is deterministic, so query_log still holds the earlier
  // attempt's QueryFinish after `migrate --abandon` (#233). A submission that
  // then fails before it starts (no query_log row) must not inherit it.
  for (const prior of ['none', 'abandoned'] as const) {
    test(`a new submission ignores query_log entries of an earlier attempt (prior op: ${prior})`, async () => {
      const queryId = QUERY_ID
      // The earlier attempt started one 5 s poll interval before this
      // submission: the youngest it can be once a previous run polled it to its end.
      const staleQueryStartSec = Math.floor((SERVER_NOW_MS - 5_000) / 1000)
      const statusCalls: StatusCall[] = []
      const clock = { ms: SERVER_NOW_MS }
      const db = {
        async query() {
          return [{ now_ms: clock.ms, database: SERVER_DATABASE }]
        },
        async submit() {
          throw new Error("Unknown table expression identifier 'default.src_typo'")
        },
        // Like system.query_log: query_start_time >= parseDateTimeBestEffort(afterTime), in whole seconds.
        async queryStatus(id: string, opts?: { afterTime?: string }): Promise<QueryStatus> {
          statusCalls.push({ queryId: id, afterTime: opts?.afterTime })
          if (id !== queryId) return { status: 'unknown' }
          const afterSec = opts?.afterTime === undefined ? 0 : Math.floor(Date.parse(opts.afterTime) / 1000)
          return staleQueryStartSec >= afterSec
            ? { status: 'finished', writtenRows: 2, durationMs: 10 }
            : { status: 'unknown' }
        },
        async command() {},
      } as unknown as ClickHouseExecutor
      const { store, writes } = createFakeJournalStore(
        prior === 'none'
          ? null
          : freshStateWith({
              operationIndex: 0,
              operationKey: BASE_INPUT.operationKey,
              operationType: BASE_INPUT.operationType,
              queryId,
              status: 'failed',
              startedAt: '2023-11-14 22:14:00.000',
              finishedAt: '2023-11-14 22:14:01.000',
              lastError: 'abandoned via chkit migrate --abandon (was completed)',
            }),
      )

      await expect(
        applyAsyncStatement({
          ...BASE_INPUT,
          db,
          journalStore: store,
          log: () => {},
          sleep: async (ms) => {
            clock.ms += ms
          },
          now: FIXED_NOW,
        }),
      ).rejects.toThrow(/src_typo/)

      // A first attempt's polls are bounded by its start; a retry polls an id of its own (#701).
      const poll =
        prior === 'none'
          ? { queryId, afterTime: SUBMISSION_BOUND }
          : { queryId: statusCalls[1]?.queryId ?? '', afterTime: RETRY_BOUND }
      expect(poll.queryId).toMatch(UUID_SHAPE)
      expect(statusCalls.slice(1).every((call) => call.queryId === poll.queryId && call.afterTime === poll.afterTime)).toBe(true)
      // Recorded as a failed attempt, never as completed.
      expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'failed'])
    })
  }

  test('accepts a changed checksum when no statement completed or started (#233)', async () => {
    const queryId = QUERY_ID
    const { db, sleep, submitCalls, commandCalls } = createFakeExecutor([
      { status: 'unknown' },
      { status: 'finished', writtenRows: 1, durationMs: 100 },
    ])
    const { store, writes } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0,
        operationKey: BASE_INPUT.operationKey,
        operationType: BASE_INPUT.operationType,
        queryId,
        status: 'failed',
        startedAt: '2026-05-26 10:00:00.000',
        finishedAt: '2026-05-26 10:05:00.000',
        lastError: 'Memory limit exceeded',
      }),
    )

    const result = await applyAsyncStatement({
      ...BASE_INPUT,
      migrationChecksum: 'changed-checksum',
      beforeRetry: 'TRUNCATE TABLE t',
      db,
      journalStore: store,
      log: () => {},
      sleep,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    // The failed attempt is still compensated before the edited statement runs.
    expect(commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    expect(submitCalls).toHaveLength(1)
    expect(writes.map((state) => state.checksum)).toEqual(['changed-checksum', 'changed-checksum'])
  })
})

// #556: chkit-py prints the same lines for the same statuses
// (test_migrate_async_apply.py has this table). toFixed rounds the double's
// exact value and takes the larger candidate on a tie; Math.round takes the
// one closer to +∞. Exact ties: 1.25, 1.125, 2.5, 0.5. Just below a decimal
// tie in binary: 1.15, 1.005, 2.675. Just above: 1.35.
const ROUNDING_CASES: Array<{
  rows: number
  bytes: number
  durationMs: number
  progress: string
  finished: string
}> = [
  { rows: 999, bytes: 1000, durationMs: 0, progress: '999 rows (1000 B)', finished: '999 rows (1000 B) in 0s' },
  { rows: 1000, bytes: 1024, durationMs: 499, progress: '1.0K rows (1.0 KiB)', finished: '1.0K rows (1.0 KiB) in 0s' },
  { rows: 1005, bytes: 1029, durationMs: 500, progress: '1.0K rows (1.0 KiB)', finished: '1.0K rows (1.0 KiB) in 1s' },
  { rows: 1050, bytes: 1075, durationMs: 1499, progress: '1.1K rows (1.0 KiB)', finished: '1.1K rows (1.0 KiB) in 1s' },
  { rows: 1150, bytes: 1177, durationMs: 1500, progress: '1.1K rows (1.1 KiB)', finished: '1.1K rows (1.1 KiB) in 2s' },
  { rows: 1250, bytes: 1280, durationMs: 2500, progress: '1.3K rows (1.3 KiB)', finished: '1.3K rows (1.3 KiB) in 3s' },
  { rows: 1350, bytes: 3584, durationMs: 3500, progress: '1.4K rows (3.5 KiB)', finished: '1.4K rows (3.5 KiB) in 4s' },
  { rows: 999_950, bytes: 1_048_575, durationMs: 123_456_500, progress: '1000.0K rows (1024.0 KiB)', finished: '1000.0K rows (1024.0 KiB) in 123457s' },
  { rows: 1_005_000, bytes: 1_310_720, durationMs: 4500, progress: '1.00M rows (1.3 MiB)', finished: '1.00M rows (1.3 MiB) in 5s' },
  { rows: 1_125_000, bytes: 1_079_194_419, durationMs: 5500, progress: '1.13M rows (1.01 GiB)', finished: '1.13M rows (1.01 GiB) in 6s' },
  { rows: 2_675_000, bytes: 1_207_959_552, durationMs: 6500, progress: '2.67M rows (1.13 GiB)', finished: '2.67M rows (1.13 GiB) in 7s' },
  { rows: 1, bytes: 1, durationMs: 1_000_000_500, progress: '1 rows (1 B)', finished: '1 rows (1 B) in 1000001s' },
  // UInt64 max: query_status reads it as the nearest double, and String()
  // prints the rounded seconds in shortest form.
  {
    rows: Number('18446744073709551615'),
    bytes: Number('18446744073709551615'),
    durationMs: Number('18446744073709551615'),
    progress: '18446744073709.55M rows (17179869184.00 GiB)',
    finished: '18446744073709.55M rows (17179869184.00 GiB) in 18446744073709550s',
  },
  // A tie only after the exact integer division; as a double it is just below.
  {
    rows: 1,
    bytes: 1,
    durationMs: 36_028_797_018_964_500,
    progress: '1 rows (1 B)',
    finished: '1 rows (1 B) in 36028797018964s',
  },
]

describe('applyAsyncStatement progress rounding', () => {
  test.each(ROUNDING_CASES)(
    'rows=$rows bytes=$bytes durationMs=$durationMs',
    async ({ rows, bytes, durationMs, progress, finished }) => {
      const { db } = createFakeExecutor([
        { status: 'unknown' },
        { status: 'running', writtenRows: rows, writtenBytes: bytes },
        { status: 'finished', writtenRows: rows, writtenBytes: bytes, durationMs },
      ])
      const { store } = createFakeJournalStore(null)
      const lines: string[] = []

      await applyAsyncStatement({
        ...BASE_INPUT,
        db,
        journalStore: store,
        log: (line) => lines.push(line),
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      })

      expect(lines.filter((line) => line.includes('written='))).toEqual([
        `  load_table_data: written=${progress}, elapsed 0s`,
        `  load_table_data: finished — written=${finished}`,
      ])
    },
  )
})

// The journal records which SQL each attempt ran (#599).
describe('applyAsyncStatement with recorded fingerprints', () => {
  const abandonedRunning = (fingerprint: string): MigrationRowState =>
    freshStateWith({
      operationIndex: 0,
      operationKey: BASE_INPUT.operationKey,
      operationType: BASE_INPUT.operationType,
      queryId: QUERY_ID,
      status: 'failed',
      startedAt: '2026-05-26 11:00:00.000',
      finishedAt: '2026-05-26 11:00:01.000',
      lastError: 'abandoned via chkit migrate --abandon (was started)',
      fingerprint,
    })

  test('refuses to attach to a running attempt of other SQL', async () => {
    const { db, submitCalls } = createFakeExecutor([{ status: 'running', elapsedMs: RUNNING_ELAPSED_MS }])
    const { store, writes } = createFakeJournalStore(abandonedRunning('v1:old'))

    await expect(
      applyAsyncStatement({
        ...BASE_INPUT,
        fingerprint: 'v1:new',
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      }),
    ).rejects.toThrow(
      `an earlier attempt with different SQL is still running on the server. Wait for it to finish or run KILL QUERY WHERE query_id = '${QUERY_ID}'`,
    )
    expect(submitCalls).toEqual([])
    expect(writes).toEqual([])
  })

  test('an attach records the fingerprint of the attempt it attached to', async () => {
    const { db } = createFakeExecutor([
      { status: 'running', elapsedMs: RUNNING_ELAPSED_MS },
      { status: 'finished', writtenRows: 1, durationMs: 1000 },
    ])
    const { store, writes } = createFakeJournalStore(abandonedRunning(''))

    await applyAsyncStatement({
      ...BASE_INPUT,
      fingerprint: 'v1:new',
      db,
      journalStore: store,
      log: () => {},
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(writes.at(-1)?.operations[0]).toMatchObject({ status: 'completed', fingerprint: '' })
  })

  test('refuses to skip a completed record of other SQL', async () => {
    const { db } = createFakeExecutor([])
    const { store } = createFakeJournalStore({
      ...abandonedRunning('v1:old'),
      operations: [{ ...abandonedRunning('v1:old').operations[0], status: 'completed', lastError: '' } as OperationState],
    })

    await expect(
      applyAsyncStatement({
        ...BASE_INPUT,
        fingerprint: 'v1:new',
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ code: 'statement_split_changed' })
  })
})

// #672: a run can leave a step started after its load finished on the server:
// the poll budget ran out after a failed submit, or the run was killed before
// it journaled the outcome. A re-run reads that attempt's outcome before it
// compensates and resubmits.
describe('applyAsyncStatement re-run of a started step', () => {
  const startedRecord = (overrides: Partial<OperationState> = {}): MigrationRowState =>
    freshStateWith({
      operationIndex: 0,
      operationKey: BASE_INPUT.operationKey,
      operationType: BASE_INPUT.operationType,
      queryId: QUERY_ID,
      status: 'started',
      startedAt: '2026-05-26 10:00:00.000',
      finishedAt: null,
      lastError: ATTEMPT_RECORD_MARKER,
      fingerprint: 'v1:load',
      ...overrides,
    })

  // A server clock that the run's sleeps advance, as the real one does.
  function clockedExecutor(statuses: Array<QueryStatus | Error>, options: { failSubmit?: () => Error } = {}) {
    const clock = { ms: SERVER_NOW_MS }
    const sleeps: number[] = []
    const fake = createFakeExecutor(statuses, { ...options, clock })
    const sleep = async (ms: number) => {
      sleeps.push(ms)
      clock.ms += ms
    }
    return { ...fake, clock, sleeps, sleep }
  }

  const input = {
    ...BASE_INPUT,
    fingerprint: 'v1:load',
    beforeRetry: 'TRUNCATE TABLE t',
    log: () => {},
    now: FIXED_NOW,
  }
  const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '')
  // The statement's first id is bounded by the record's start minus the skew margin.
  const RECORD_BOUND = '2026-05-26T09:59:58.000Z'
  // A started attempt without a query_log entry: the check, then 5 rechecks
  // while query_log is flushed (#701).
  const NO_ENTRY_CHECKS = Array.from({ length: 6 }, () => ({ status: 'unknown' as const }))

  test('a re-run after the poll budget ran out finds the finished attempt and neither compensates nor resubmits', async () => {
    const { store, writes } = createFakeJournalStore(null)
    // Run 1: the submit fails with a gateway timeout, a poll sees the load
    // running, then query_log has no outcome for 21 polls.
    const first = createFakeExecutor(
      [
        { status: 'unknown' },
        { status: 'running', writtenRows: 9, writtenBytes: 72 },
        ...Array.from({ length: 21 }, () => ({ status: 'unknown' as const })),
      ],
      { failSubmit: () => new Error('error code: 524') },
    )
    await expect(
      applyAsyncStatement({ ...input, db: first.db, journalStore: store, sleep: NO_SLEEP }),
    ).rejects.toThrow(/polling found no outcome 21×/)
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started'])
    // The attempt's start is recorded on the server clock, as this release's record.
    expect(writes[0]?.operations[0]).toMatchObject({ startedAt: iso(SERVER_NOW_MS), lastError: ATTEMPT_RECORD_MARKER })

    // Run 2: the load is no longer running and query_log has its QueryFinish.
    const second = createFakeExecutor([{ status: 'finished', writtenRows: 16, writtenBytes: 128, durationMs: 8000 }])
    const lines: string[] = []
    const result = await applyAsyncStatement({
      ...input,
      db: second.db,
      journalStore: store,
      sleep: NO_SLEEP,
      log: (line) => lines.push(line),
    })

    expect(result.kind).toBe('completed')
    expect(second.commandCalls).toEqual([])
    expect(second.submitCalls).toEqual([])
    // One read of every replica, bounded by the start run 1 recorded.
    expect(second.statusCalls).toEqual([{ queryId: QUERY_ID, afterTime: SUBMISSION_BOUND, everyReplica: true }])
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'completed'])
    expect(writes[1]?.operations[0]).toMatchObject({
      queryId: QUERY_ID,
      startedAt: iso(SERVER_NOW_MS),
      fingerprint: 'v1:load',
      lastError: '',
    })
    expect(lines).toEqual([
      `  load_table_data: previous attempt of query_id=${QUERY_ID} finished on the server — written=16 rows (128 B) in 8s, recording it as completed`,
    ])
  })

  test('a started attempt that failed on the server is journaled failed, then compensated and resubmitted', async () => {
    const fake = clockedExecutor([
      { status: 'failed', error: 'Code: 241. DB::Exception: Memory limit exceeded\nstack' },
      { status: 'finished', writtenRows: 16, durationMs: 8000 },
    ])
    const { store, writes } = createFakeJournalStore(startedRecord())
    const lines: string[] = []

    const result = await applyAsyncStatement({
      ...input,
      db: fake.db,
      journalStore: store,
      sleep: fake.sleep,
      log: (line) => lines.push(line),
    })

    expect(result.kind).toBe('completed')
    expect(fake.statusCalls[0]).toEqual({ queryId: QUERY_ID, afterTime: RECORD_BOUND, everyReplica: true })
    expect(fake.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    const retryId = retryQueryId(fake.submitCalls)
    expect(fake.submitCalls).toEqual([{ sql: input.sql, queryId: retryId }])
    expect(lines[0]).toBe(
      `  load_table_data: previous attempt of query_id=${QUERY_ID} is no longer running (status=failed: Code: 241. DB::Exception: Memory limit exceeded) — running before-retry then resubmitting as query_id=${retryId}`,
    )
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['failed', 'started', 'completed'])
    expect(writes[0]?.operations[0]?.lastError).toBe('Code: 241. DB::Exception: Memory limit exceeded\nstack')
  })

  test('a started attempt without a query_log entry is journaled failed, then compensated and resubmitted', async () => {
    const fake = clockedExecutor([...NO_ENTRY_CHECKS, { status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const { store, writes } = createFakeJournalStore(startedRecord())

    await applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep })

    // Checked once, then 5 times 2 s apart while query_log is flushed (#701).
    expect(fake.statusCalls.slice(0, 6)).toEqual(
      Array.from({ length: 6 }, () => ({ queryId: QUERY_ID, afterTime: RECORD_BOUND, everyReplica: true })),
    )
    expect(fake.sleeps.slice(0, 5)).toEqual([2_000, 2_000, 2_000, 2_000, 2_000])
    expect(fake.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    expect(fake.submitCalls).toHaveLength(1)
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['failed', 'started', 'completed'])
    expect(writes[0]?.operations[0]?.lastError).toBe('no longer running and no outcome in system.query_log; retried')
  })

  test('without before-retry SQL a started attempt without a query_log entry stays started until it is resubmitted', async () => {
    const fake = clockedExecutor([...NO_ENTRY_CHECKS, { status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const { store, writes } = createFakeJournalStore(startedRecord())

    await applyAsyncStatement({ ...input, beforeRetry: null, db: fake.db, journalStore: store, sleep: fake.sleep })

    // Nothing is compensated, so a re-run may still find its QueryFinish.
    expect(fake.submitCalls).toHaveLength(1)
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'completed'])
  })

  // The attempt's QueryFinish can reach query_log only after the check (it is
  // flushed on a timer). A run that stops after the compensation, before it
  // journals the new attempt, must leave a record whose QueryFinish a re-run
  // does not take for the outcome: the rows it loaded were truncated.
  test('a re-run after a compensation that stopped the run compensates and resubmits again', async () => {
    const { store, writes } = createFakeJournalStore(startedRecord())
    // Run 1: no outcome yet; the TRUNCATE ran, but its response was lost.
    const first = clockedExecutor(NO_ENTRY_CHECKS)
    const lostResponse = {
      ...first.db,
      command: async () => {
        throw new Error('socket hang up')
      },
    } as unknown as ClickHouseExecutor
    await expect(
      applyAsyncStatement({ ...input, db: lostResponse, journalStore: store, sleep: first.sleep }),
    ).rejects.toThrow('socket hang up')
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['failed'])
    expect(writes[0]?.operations[0]?.lastError).toBe('no longer running and no outcome in system.query_log; retried')

    // Run 2: the first attempt's QueryFinish is in query_log by now.
    const second = clockedExecutor([
      { status: 'finished', writtenRows: 16, durationMs: 8000 },
      { status: 'finished', writtenRows: 16, durationMs: 8000 },
    ])
    await applyAsyncStatement({ ...input, db: second.db, journalStore: store, sleep: second.sleep })

    expect(second.statusCalls[0]).toMatchObject({ everyReplica: true, runningOnly: true })
    expect(second.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    expect(second.submitCalls).toHaveLength(1)
  })

  // #701: every attempt submits under an id of its own, so a re-run never
  // takes an earlier attempt's QueryFinish for a later attempt's outcome,
  // however close together they started.
  test("a re-run never takes an earlier attempt's QueryFinish for the outcome of the retry that followed it", async () => {
    const { store, writes } = createFakeJournalStore(startedRecord({ startedAt: iso(SERVER_NOW_MS - 1_000) }))
    // Run 2, a second after run 1's attempt: no outcome yet; it compensates,
    // journals its own attempt, and stops before its submit leaves.
    const second = clockedExecutor(NO_ENTRY_CHECKS)
    const killedBeforeSubmit = {
      ...second.db,
      submit: () => {
        throw new Error('killed')
      },
    } as unknown as ClickHouseExecutor
    await expect(
      applyAsyncStatement({ ...input, db: killedBeforeSubmit, journalStore: store, sleep: second.sleep }),
    ).rejects.toThrow('killed')
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['failed', 'started'])
    const runTwoQueryId = writes[1]?.operations[0]?.queryId ?? ''
    expect(runTwoQueryId).toMatch(UUID_SHAPE)
    expect(writes[1]?.operations[0]).toMatchObject({ startedAt: iso(SERVER_NOW_MS), lastError: ATTEMPT_RECORD_MARKER })

    // Run 3: query_log now holds run 1's QueryFinish, and nothing of run 2's attempt.
    const third = clockedExecutor([...NO_ENTRY_CHECKS, { status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const answers = third.db.queryStatus.bind(third.db)
    const db = {
      ...third.db,
      async queryStatus(id: string, opts?: QueryStatusOptions): Promise<QueryStatus> {
        const answer = await answers(id, opts)
        return id === QUERY_ID ? { status: 'finished', writtenRows: 0, durationMs: 10 } : answer
      },
    } as unknown as ClickHouseExecutor
    const result = await applyAsyncStatement({ ...input, db, journalStore: store, sleep: third.sleep })

    // Every check reads run 2's id, from an hour before its recorded start.
    const runTwoBound = new Date(SERVER_NOW_MS - 3_600_000).toISOString()
    expect(third.statusCalls.slice(0, 6).every((call) => call.queryId === runTwoQueryId && call.afterTime === runTwoBound)).toBe(true)
    expect(third.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    expect(third.submitCalls).toHaveLength(1)
    expect([QUERY_ID, runTwoQueryId]).not.toContain(third.submitCalls[0]?.queryId)
    expect(result.operation.status).toBe('completed')
  })

  // Codex review of #701: two runs that read the same failed record. Run A
  // retries and records its attempt completed; run B, delayed after its
  // check, compensates (deleting A's rows), journals its own attempt and
  // stops before its submit. A re-run must not take A's QueryFinish for B's
  // attempt: each run's retry has an id no other run submits.
  test("a re-run never takes a concurrent run's finished retry for its own compensated attempt", async () => {
    const failed = startedRecord({ status: 'failed', finishedAt: '2026-05-26 10:05:00.000', lastError: 'boom' })
    // Run A.
    const runA = clockedExecutor([{ status: 'unknown' }, { status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const journalA = createFakeJournalStore(failed)
    await applyAsyncStatement({ ...input, db: runA.db, journalStore: journalA.store, sleep: runA.sleep })
    const runAQueryId = retryQueryId(runA.submitCalls)
    // Run B read the same failed record.
    const runB = clockedExecutor([{ status: 'unknown' }])
    const journalB = createFakeJournalStore(failed)
    const killedBeforeSubmit = {
      ...runB.db,
      submit: () => {
        throw new Error('killed')
      },
    } as unknown as ClickHouseExecutor
    await expect(
      applyAsyncStatement({ ...input, db: killedBeforeSubmit, journalStore: journalB.store, sleep: runB.sleep }),
    ).rejects.toThrow('killed')
    expect(runB.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    const runBRecord = journalB.writes.at(-1)?.operations[0]
    expect(runBRecord?.status).toBe('started')
    expect(runBRecord?.queryId).not.toBe(runAQueryId)

    // The re-run: query_log has run A's QueryFinish only.
    const rerun = clockedExecutor([...NO_ENTRY_CHECKS, { status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const answers = rerun.db.queryStatus.bind(rerun.db)
    const db = {
      ...rerun.db,
      async queryStatus(id: string, opts?: QueryStatusOptions): Promise<QueryStatus> {
        const answer = await answers(id, opts)
        return id === runAQueryId ? { status: 'finished', writtenRows: 16, durationMs: 8000 } : answer
      },
    } as unknown as ClickHouseExecutor
    await applyAsyncStatement({ ...input, db, journalStore: journalB.store, sleep: rerun.sleep })

    expect(rerun.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    expect(rerun.submitCalls).toHaveLength(1)
  })

  // A record of the release before #701 names an id that earlier attempts may
  // share, so it keeps that release's check: bounded by its recorded start,
  // and a missing entry is not waited for.
  test("a started record of the release before #701 keeps the bounded check without a wait, and the retry gets an id of its own", async () => {
    const fake = clockedExecutor([{ status: 'unknown' }, { status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const { store, writes } = createFakeJournalStore(startedRecord({ lastError: STARTED_RECORD_MARKER }))

    await applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep })

    expect(fake.statusCalls[0]).toEqual({ queryId: QUERY_ID, afterTime: RECORD_BOUND, everyReplica: true })
    expect(fake.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    const retryId = retryQueryId(fake.submitCalls)
    expect(fake.statusCalls[1]).toMatchObject({ queryId: retryId, afterTime: RETRY_BOUND })
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['failed', 'started', 'completed'])
    expect(writes[1]?.operations[0]?.lastError).toBe(ATTEMPT_RECORD_MARKER)
  })

  // A started attempt of this release that is running again by a recheck (its
  // submit reached the server late) is attached to, not resubmitted.
  test('a started attempt that a recheck finds running is attached to', async () => {
    const fake = clockedExecutor([
      { status: 'unknown' },
      { status: 'running', writtenRows: 5, elapsedMs: 1_000 },
      { status: 'finished', writtenRows: 16, durationMs: 8000 },
    ])
    const { store } = createFakeJournalStore(startedRecord())

    const result = await applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep })

    expect(result.kind).toBe('completed')
    expect(fake.commandCalls).toEqual([])
    expect(fake.submitCalls).toEqual([])
  })

  // An older release's started record has a client-clock start, and a retry
  // by that release may have run before-retry SQL without journaling the
  // attempt failed first, so its QueryFinish is not the statement's outcome.
  for (const beforeRetry of ['TRUNCATE TABLE t', null]) {
    test(`an older release's started record is checked in system.processes only (before-retry: ${beforeRetry ?? 'none'})`, async () => {
      const fake = clockedExecutor([
        { status: 'finished', writtenRows: 16, durationMs: 8000 },
        { status: 'finished', writtenRows: 16, durationMs: 8000 },
      ])
      const { store } = createFakeJournalStore(startedRecord({ lastError: '' }))

      await applyAsyncStatement({ ...input, beforeRetry, db: fake.db, journalStore: store, sleep: fake.sleep })

      expect(fake.statusCalls[0]).toMatchObject({ afterTime: undefined, everyReplica: true, runningOnly: true })
      expect(fake.commandCalls).toEqual(beforeRetry === null ? [] : [{ sql: beforeRetry }])
      expect(fake.submitCalls).toHaveLength(1)
    })
  }

  // Only a started attempt of this statement's SQL can have finished unseen:
  // a failed one has its outcome, a sync record never ran under this id, and
  // an attempt of other SQL that finished did not run this statement.
  const notRead: Array<[string, MigrationRowState]> = [
    ['a failed attempt', startedRecord({ status: 'failed', finishedAt: '2026-05-26 10:05:00.000', lastError: 'boom' })],
    ['a started record without a query id', startedRecord({ queryId: '' })],
    ['a started attempt of other SQL', startedRecord({ fingerprint: 'v1:other' })],
  ]
  for (const [label, state] of notRead) {
    test(`${label} is checked in system.processes only`, async () => {
      const fake = clockedExecutor([
        { status: 'finished', writtenRows: 16, durationMs: 8000 },
        { status: 'finished', writtenRows: 16, durationMs: 8000 },
      ])
      const { store } = createFakeJournalStore(state)

      await applyAsyncStatement({ ...input, beforeRetry: null, db: fake.db, journalStore: store, sleep: fake.sleep })

      expect(fake.statusCalls[0]).toMatchObject({ afterTime: undefined, everyReplica: true, runningOnly: true })
      expect(fake.submitCalls).toHaveLength(1)
    })
  }

  // An attach under a failed record (an attempt kept by --abandon, or one
  // that a retry journaled failed) records the attempt started, so a run that
  // stops while it polls leaves a record a re-run reads from query_log.
  test('an attach journals the attempt started, and a re-run after a killed attach records its QueryFinish', async () => {
    const { store, writes } = createFakeJournalStore(
      startedRecord({ status: 'failed', finishedAt: '2026-05-26 10:05:00.000', lastError: 'boom' }),
    )
    const first = createFakeExecutor([
      { status: 'running', writtenRows: 5, elapsedMs: RUNNING_ELAPSED_MS },
      ...Array.from({ length: 21 }, () => new Error('HTTP 502: bad gateway')),
    ])
    await expect(
      applyAsyncStatement({ ...input, beforeRetry: null, db: first.db, journalStore: store, sleep: NO_SLEEP }),
    ).rejects.toThrow(/polling failed 21×/)
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started'])
    expect(writes[0]?.operations[0]).toMatchObject({
      startedAt: iso(SERVER_NOW_MS - RUNNING_ELAPSED_MS),
      lastError: STARTED_RECORD_MARKER,
      fingerprint: 'v1:load',
    })

    const second = createFakeExecutor([{ status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const result = await applyAsyncStatement({
      ...input,
      beforeRetry: null,
      db: second.db,
      journalStore: store,
      sleep: NO_SLEEP,
    })

    expect(result.kind).toBe('completed')
    expect(second.statusCalls[0]?.afterTime).toBe(ATTACH_BOUND)
    expect(second.submitCalls).toEqual([])
  })

  // The elapsed time is observed after the server time the attach reads, so
  // a start derived from both can lie earlier than the attempt's own.
  test('an attach keeps the start a record of this release holds for the attempt', async () => {
    const { db } = createFakeExecutor([
      { status: 'running', writtenRows: 5, elapsedMs: RUNNING_ELAPSED_MS },
      { status: 'finished', writtenRows: 16, durationMs: 8000 },
    ])
    const { store, writes } = createFakeJournalStore(startedRecord({ startedAt: '2023-11-14 22:14:59.000' }))

    await applyAsyncStatement({ ...input, db, journalStore: store, sleep: NO_SLEEP })

    expect(writes[0]?.operations[0]).toMatchObject({ status: 'started', startedAt: '2023-11-14 22:14:59.000' })
  })

  test('a user that cannot read system.query_log is told which grant it lacks', async () => {
    const { db, submitCalls, commandCalls } = createFakeExecutor([
      new Error(
        "Code: 497. DB::Exception: default: Not enough privileges. To execute this query, it's necessary to have the grant SELECT(type, query_id) ON system.query_log. (ACCESS_DENIED)",
      ),
    ])
    const { store, writes } = createFakeJournalStore(startedRecord())

    const run = applyAsyncStatement({ ...input, db, journalStore: store, sleep: NO_SLEEP })

    await expect(run).rejects.toThrow(
      /the ClickHouse user cannot read system\.query_log, which tells whether the previous attempt finished \(Code: 497\..*\)\. Nothing was resubmitted and no before-retry SQL ran\. Grant SELECT ON system\.query_log to the user; until then a re-run of `chkit migrate --apply` stops here too\./,
    )
    expect(submitCalls).toEqual([])
    expect(commandCalls).toEqual([])
    expect(writes).toEqual([])
  })

  for (const [startedAt, label] of [
    ['2026-05-26T10:00:00.000Z', 'Z'],
    ['2026-05-26T12:00:00.000+02:00', '+02:00'],
  ] as const) {
    test(`a started record with a start time zoned ${label} is read with that zone`, async () => {
      const { db, statusCalls } = createFakeExecutor([{ status: 'finished', writtenRows: 16, durationMs: 8000 }])
      const { store } = createFakeJournalStore(startedRecord({ startedAt }))

      await applyAsyncStatement({ ...input, db, journalStore: store, sleep: NO_SLEEP })

      expect(statusCalls[0]?.afterTime).toBe('2026-05-26T09:59:58.000Z')
    })
  }

  // #701: query_log is flushed on a timer (7.5 s by default), so a re-run right
  // after the attempt ended can find it neither running nor in query_log.
  test('a re-run before query_log has the finished attempt waits for it instead of resubmitting', async () => {
    const { store, writes } = createFakeJournalStore(null)
    const first = createFakeExecutor([
      { status: 'running', writtenRows: 9, writtenBytes: 72 },
      ...Array.from({ length: 21 }, () => new Error('HTTP 502: bad gateway')),
    ])
    await expect(
      applyAsyncStatement({ ...input, db: first.db, journalStore: store, sleep: NO_SLEEP }),
    ).rejects.toThrow(/polling failed 21×/)

    // Run 2: the load ended; its QueryFinish reaches query_log on the third check.
    const second = clockedExecutor([
      { status: 'unknown' },
      { status: 'unknown' },
      { status: 'finished', writtenRows: 16, writtenBytes: 128, durationMs: 8000 },
    ])
    const result = await applyAsyncStatement({ ...input, db: second.db, journalStore: store, sleep: second.sleep })

    expect(result.kind).toBe('completed')
    expect(second.commandCalls).toEqual([])
    expect(second.submitCalls).toEqual([])
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'completed'])
  })

  // #701: a retried attempt that ran on a replica whose clock is 3 s behind
  // the one that gave its recorded start, more than the skew margin.
  test('a re-run finds the QueryFinish of a retried attempt that ran on a replica 3 s behind', async () => {
    const { store, writes } = createFakeJournalStore(
      startedRecord({ status: 'failed', finishedAt: '2026-05-26 10:05:00.000', lastError: 'boom' }),
    )
    // Run 1 retries and stops while it polls.
    const first = clockedExecutor([
      { status: 'unknown' },
      ...Array.from({ length: 21 }, () => new Error('HTTP 502: bad gateway')),
    ])
    await expect(
      applyAsyncStatement({ ...input, db: first.db, journalStore: store, sleep: first.sleep }),
    ).rejects.toThrow(/polling failed 21×/)
    const retried = writes.at(-1)?.operations[0]
    expect(retried?.status).toBe('started')
    const retriedQueryId = retried?.queryId ?? ''
    const entryStartMs = Date.parse(`${retried?.startedAt}Z`) - 3_000

    // Run 2: query_log has the attempt's QueryFinish, stamped 3 s behind.
    const submitCalls: string[] = []
    const clock = { ms: SERVER_NOW_MS + 60_000 }
    const db = {
      async query() {
        return [{ now_ms: String(clock.ms), database: SERVER_DATABASE }]
      },
      async queryStatus(id: string, opts?: QueryStatusOptions): Promise<QueryStatus> {
        // A resubmission's own load finishes at once.
        if (submitCalls.length > 0) return { status: 'finished', writtenRows: 16, durationMs: 1 }
        if (opts?.runningOnly || id !== retriedQueryId) return { status: 'unknown' }
        const afterSec = Math.floor(Date.parse(opts?.afterTime ?? '1970-01-01T00:00:00Z') / 1000)
        return Math.floor(entryStartMs / 1000) >= afterSec
          ? { status: 'finished', writtenRows: 16, durationMs: 8000 }
          : { status: 'unknown' }
      },
      async command() {},
      async submit(sql: string) {
        submitCalls.push(sql)
        return retriedQueryId
      },
    } as unknown as ClickHouseExecutor
    const result = await applyAsyncStatement({
      ...input,
      db,
      journalStore: store,
      sleep: async (ms) => {
        clock.ms += ms
      },
    })

    expect(submitCalls).toEqual([])
    expect(result.kind).toBe('completed')
    expect(writes.at(-1)?.operations[0]).toMatchObject({ status: 'completed', queryId: retriedQueryId })
  })

  // Codex review of #701: the statement's first id is shared with an attempt
  // whose record was lost. Its polls are bounded by the server time read
  // after the journal writes, which can take long, so that attempt's
  // QueryFinish is not taken for a rejected submission's.
  test("a first attempt's polls ignore an earlier attempt of its id that finished during the journal writes", async () => {
    const earlierStartSec = Math.floor((SERVER_NOW_MS - 1_000) / 1000)
    const clock = { ms: SERVER_NOW_MS }
    const db = {
      async query() {
        return [{ now_ms: String(clock.ms), database: SERVER_DATABASE }]
      },
      async queryStatus(_id: string, opts?: QueryStatusOptions): Promise<QueryStatus> {
        if (opts?.runningOnly) return { status: 'unknown' }
        const afterSec = Math.floor(Date.parse(opts?.afterTime ?? '') / 1000)
        return earlierStartSec >= afterSec ? { status: 'finished', writtenRows: 2, durationMs: 10 } : { status: 'unknown' }
      },
      async command() {},
      async submit() {
        throw new Error('Code: 216. QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING')
      },
    } as unknown as ClickHouseExecutor
    const { store, writes } = createFakeJournalStore(null)
    // Each journal write takes 6 s.
    const write = store.writeMigrationState.bind(store)
    store.writeMigrationState = async (state) => {
      clock.ms += 6_000
      await write(state)
    }

    await expect(
      applyAsyncStatement({ ...input, beforeRetry: null, db, journalStore: store, sleep: NO_SLEEP }),
    ).rejects.toThrow(/QUERY_WITH_SAME_ID/)
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'failed'])
  })
})
