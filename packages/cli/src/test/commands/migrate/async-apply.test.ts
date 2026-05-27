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
}

function createFakeExecutor(
  statuses: QueryStatus[],
  options: { failSubmit?: () => Error } = {},
): FakeExecutor {
  const statusCalls: StatusCall[] = []
  const submitCalls: SubmitCall[] = []
  const commandCalls: CommandCall[] = []
  const queue = [...statuses]
  const db = {
    async submit(sql: string, queryId?: string) {
      submitCalls.push({ sql, queryId })
      if (options.failSubmit) throw options.failSubmit()
      return queryId ?? 'fallback-id'
    },
    async queryStatus(queryId: string, opts?: { afterTime?: string }) {
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
  return { db, statusCalls, submitCalls, commandCalls }
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
    const { db, statusCalls, submitCalls, commandCalls } = createFakeExecutor([
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
    // Two writes: started + completed.
    expect(writes).toHaveLength(2)
    expect(writes[0]?.operations[0]?.status).toBe('started')
    expect(writes[1]?.operations[0]?.status).toBe('completed')
    expect(lines.some((line) => line.includes('submitting async'))).toBe(true)
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
    const { db, statusCalls, submitCalls, commandCalls } = createFakeExecutor([
      { status: 'running', writtenRows: 50 }, // initial check sees it running
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
    expect(statusCalls).toHaveLength(3)
    expect(lines.some((line) => line.includes('attaching'))).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.operations[0]?.status).toBe('completed')
  })

  test('retry: prior failed op + query no longer running → run before-retry, then resubmit', async () => {
    const queryId = makeDeterministicQueryId(BASE_INPUT.migrationName, BASE_INPUT.statementIndex)
    const { db, statusCalls, submitCalls, commandCalls } = createFakeExecutor([
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
    const { store } = createFakeJournalStore(null)

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
  })
})
