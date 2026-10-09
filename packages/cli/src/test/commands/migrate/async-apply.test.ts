import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'

import {
  applyAsyncStatement,
  makeDeterministicQueryId,
} from '../../../commands/migrate/async-apply.js'
import type {
  JournalStore,
  MigrationRowState,
  OperationState,
} from '../../../runtime/journal-store.js'

type StatusCall = { queryId: string; afterTime?: string }
type SubmitCall = { sql: string; queryId?: string }
type CommandCall = { sql: string }

interface FakeExecutor {
  db: ClickHouseExecutor
  statusCalls: StatusCall[]
  submitCalls: SubmitCall[]
  commandCalls: CommandCall[]
  /** Server-time reads, status checks and submissions, in call order. */
  events: string[]
}

// The server clock differs from the client clock (FIXED_NOW) on purpose: the
// query_log bound must come from the server.
const SERVER_NOW_MS = 1_700_000_100_000
// SERVER_NOW_MS minus the 2 s skew margin.
const SUBMISSION_BOUND = '2023-11-14T22:14:58.000Z'
// How long the attempt an attach finds has been running.
const RUNNING_ELAPSED_MS = 30_000
// SERVER_NOW_MS minus RUNNING_ELAPSED_MS and the 2 s skew margin.
const ATTACH_BOUND = '2023-11-14T22:14:28.000Z'

function createFakeExecutor(
  statuses: QueryStatus[],
  options: { failSubmit?: () => Error } = {},
): FakeExecutor {
  const statusCalls: StatusCall[] = []
  const submitCalls: SubmitCall[] = []
  const commandCalls: CommandCall[] = []
  const events: string[] = []
  const queue = [...statuses]
  const db = {
    async query(sql: string) {
      events.push(`query: ${sql}`)
      return [{ now_ms: String(SERVER_NOW_MS) }]
    },
    async submit(sql: string, queryId?: string) {
      events.push('submit')
      submitCalls.push({ sql, queryId })
      if (options.failSubmit) throw options.failSubmit()
      return queryId ?? 'fallback-id'
    },
    async queryStatus(queryId: string, opts?: { afterTime?: string }) {
      events.push('status')
      statusCalls.push({ queryId, afterTime: opts?.afterTime })
      const next = queue.shift()
      if (!next) {
        throw new Error('queryStatus called more times than fake has answers for')
      }
      return next
    },
    async command(sql: string) {
      commandCalls.push({ sql })
    },
  } as unknown as ClickHouseExecutor
  return { db, statusCalls, submitCalls, commandCalls, events }
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

const SERVER_TIME_QUERY = 'query: SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms'

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
  test('produces a deterministic UUID-shaped query_id from (migration, statement_index)', () => {
    const a = makeDeterministicQueryId('20260526_load.sql', 0)
    const b = makeDeterministicQueryId('20260526_load.sql', 0)
    const c = makeDeterministicQueryId('20260526_load.sql', 1)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('first attempt: writes started, submits, polls to completion', async () => {
    const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
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
    const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
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
    const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
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
    const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
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
    expect(statusCalls.map((call) => call.afterTime)).toEqual([undefined, ATTACH_BOUND, ATTACH_BOUND])
    expect(events).toEqual([SERVER_TIME_QUERY, 'status', 'status', 'status'])
    expect(lines.some((line) => line.includes('attaching'))).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.operations[0]?.status).toBe('completed')
  })

  // query_log is flushed on a timer. Right after the attached attempt ends, its
  // entry can still be missing while an earlier attempt with the same query id
  // (abandoned, or retried after an edit, #233) has its QueryFinish there.
  test('an attach ignores query_log entries of an earlier attempt', async () => {
    const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
    const attachedStartSec = Math.floor((SERVER_NOW_MS - RUNNING_ELAPSED_MS) / 1000)
    const earlierStartSec = attachedStartSec - 3_600
    const phases = ['running', 'running', 'flush gap', 'flush gap', 'flushed']
    const statusCalls: StatusCall[] = []
    const db = {
      async query() {
        return [{ now_ms: SERVER_NOW_MS }]
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
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['failed'])
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

  test('retry: prior failed op + query no longer running → run before-retry, then resubmit', async () => {
    const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
    const { db, statusCalls, submitCalls, commandCalls, events } = createFakeExecutor([
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
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    expect(commandCalls).toEqual([
      { sql: 'TRUNCATE TABLE t SETTINGS max_table_size_to_drop = 0' },
    ])
    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0]?.queryId).toBe(queryId)
    expect(statusCalls).toHaveLength(3)
    expect(statusCalls[1]?.afterTime).toBe(SUBMISSION_BOUND)
    expect(statusCalls[2]?.afterTime).toBe(SUBMISSION_BOUND)
    expect(events).toEqual([SERVER_TIME_QUERY, 'status', SERVER_TIME_QUERY, 'submit', 'status', 'status'])
    expect(lines.some((line) => line.includes('running before-retry SQL'))).toBe(true)
    expect(lines.some((line) => line.includes('Memory limit exceeded'))).toBe(true)
    // started (overwrite prior failed) + completed
    expect(writes).toHaveLength(2)
    expect(writes[0]?.operations[0]?.status).toBe('started')
    expect(writes[1]?.operations[0]?.status).toBe('completed')
  })

  test('retry without before-retry SQL: still resubmits forward', async () => {
    const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
    const { db, submitCalls, commandCalls } = createFakeExecutor([
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
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(commandCalls).toEqual([]) // no before-retry SQL → no command
    expect(submitCalls).toHaveLength(1)
  })

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

    await expect(
      applyAsyncStatement({
        ...BASE_INPUT,
        sql: 'NOT VALID SQL',
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      }),
    ).rejects.toThrow(/Syntax error/)

    // The query never started, so the attempt is recorded as failed (#233):
    // an edited file can then run again without --retry.
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'failed'])
    expect(writes[1]?.operations[0]?.lastError).toBe('Syntax error: failed at position 1')
  })
  // The query id is deterministic, so query_log still holds the earlier
  // attempt's QueryFinish after `migrate --abandon` (#233). A submission that
  // then fails before it starts (no query_log row) must not inherit it.
  for (const prior of ['none', 'abandoned'] as const) {
    test(`a new submission ignores query_log entries of an earlier attempt (prior op: ${prior})`, async () => {
      const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
      // The earlier attempt started one 5 s poll interval before this
      // submission: the youngest it can be once a previous run polled it to its end.
      const staleQueryStartSec = Math.floor((SERVER_NOW_MS - 5_000) / 1000)
      const statusCalls: StatusCall[] = []
      const db = {
        async query() {
          return [{ now_ms: SERVER_NOW_MS }]
        },
        async submit() {
          throw new Error("Unknown table expression identifier 'default.src_typo'")
        },
        // Like system.query_log: query_start_time >= parseDateTimeBestEffort(afterTime), in whole seconds.
        async queryStatus(id: string, opts?: { afterTime?: string }): Promise<QueryStatus> {
          statusCalls.push({ queryId: id, afterTime: opts?.afterTime })
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
          sleep: NO_SLEEP,
          now: FIXED_NOW,
        }),
      ).rejects.toThrow(/src_typo/)

      expect(statusCalls.slice(1).every((call) => call.afterTime === SUBMISSION_BOUND)).toBe(true)
      // Recorded as a failed attempt, never as completed.
      expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'failed'])
    })
  }

  test('accepts a changed checksum when no statement completed or started (#233)', async () => {
    const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
    const { db, submitCalls, commandCalls } = createFakeExecutor([
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
      sleep: NO_SLEEP,
      now: FIXED_NOW,
    })

    expect(result.kind).toBe('completed')
    // The failed attempt is still compensated before the edited statement runs.
    expect(commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    expect(submitCalls).toHaveLength(1)
    expect(writes.map((state) => state.checksum)).toEqual(['changed-checksum', 'changed-checksum'])
  })
})
