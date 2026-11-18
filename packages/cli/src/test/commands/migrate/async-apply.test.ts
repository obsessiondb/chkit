import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor, ClickHouseSettings, QueryStatus, QueryStatusOptions } from '@chkit/clickhouse'

import {
  applyAsyncStatement,
  ATTEMPT_RECORD_MARKER,
  makeDeterministicQueryId,
  PREPARED_RECORD_MARKER,
} from '../../../commands/migrate/async-apply.js'
import { abandonMigrationState } from '../../../commands/migrate/abandon.js'
import {
  createJournalStore,
  type JournalStore,
  type MigrationRowState,
  operationAsStored,
  type OperationState,
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
// How long the attempt an attach finds has been running.
const RUNNING_ELAPSED_MS = 30_000
// Every attempt's id is its own (#701, #767): its polls count every query_log
// entry from an hour before SERVER_NOW_MS, a bound that only lets query_log prune.
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

// fingerprints: false is a journal without the operation_fingerprints
// column, which stores no fence (#767).
// everyCopy: false is a journal read that cannot cover every copy of the
// journal (#767).
function createFakeJournalStore(initial: MigrationRowState | null = null, options: { fingerprints?: boolean; everyCopy?: boolean } = {}): FakeStore {
  let current: MigrationRowState | null = initial
  const writes: MigrationRowState[] = []
  const fingerprints = options.fingerprints ?? true
  const everyCopy = options.everyCopy ?? true
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState() {
      return current
    },
    async readStoredOperation(_name, index) {
      return current?.operations.find((op) => op.operationIndex === index)
    },
    async readOperationOnEveryCopy(name, index) {
      return everyCopy ? { covered: true as const, op: await this.readStoredOperation(name, index) } : { covered: false as const }
    },
    async writeMigrationState(state) {
      writes.push(state)
      // As the journal returns it; BASE_INPUT records no fingerprint.
      current = { ...state, operations: state.operations.map((op) => (op.fingerprint === undefined ? op : operationAsStored(op, fingerprints))) }
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

// The id an earlier release gave a statement's first attempt on SERVER_DATABASE.
const QUERY_ID = makeDeterministicQueryId(
  SERVER_DATABASE,
  '_chkit_migrations',
  BASE_INPUT.migrationName,
  BASE_INPUT.statementIndex,
)

// The id an attempt submitted under: a random one, never the statement's
// earlier first id (#701, #767).
function submittedQueryId(submitCalls: Array<{ queryId?: string }>): string {
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
    // A first attempt gets a random id of its own too (#767).
    const queryId = submittedQueryId(submitCalls)
    expect(commandCalls).toEqual([]) // no before-retry on first attempt
    expect(statusCalls).toHaveLength(3)
    // The in-flight check looks for a running query under the id an earlier
    // release would have used; the polls read the attempt's own id.
    expect(statusCalls).toMatchObject([
      { queryId: QUERY_ID, afterTime: undefined },
      { queryId, afterTime: RETRY_BOUND },
      { queryId, afterTime: RETRY_BOUND },
    ])
    expect(events).toEqual([SERVER_TIME_QUERY, 'status', 'submit', 'status', 'status'])
    // Three writes: prepared, started + completed. Both started records name
    // the id and are fenced before the submit; the completed one is not
    // (#767). The submit follows the move to "may have been sent".
    expect(writes).toHaveLength(3)
    expect(writes[0]?.operations[0]).toMatchObject({ status: 'started', queryId, lastError: PREPARED_RECORD_MARKER, attemptFenced: true })
    expect(writes[1]?.operations[0]).toMatchObject({ status: 'started', queryId, lastError: ATTEMPT_RECORD_MARKER, attemptFenced: true })
    expect(writes[2]?.operations[0]?.status).toBe('completed')
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

  // #767: only a fenced record's id names the running attempt alone. Any
  // other id an earlier release may have reused, so polls could take an
  // earlier attempt's QueryFinish for this one's outcome. The run stops
  // instead of attaching, and writes nothing.
  // #463: an older chkit derived the id from the migration alone; a
  // statement it journaled is still checked under that id.
  const LEGACY_ID = 'f2d1c4e0-1111-2222-3333-444455556666'
  const NOT_RECORDED = 'but its query id was not recorded by this chkit release for that attempt alone, so chkit cannot tell its outcome from system.query_log once it ends'
  const RECORDED_FAILED = 'but the journal records that attempt as failed, so chkit does not attach to it, and the next chkit migrate --apply runs the statement again (after its before-retry SQL, when it has one)'
  const runningPriors: Array<[string, MigrationRowState | null, string, string]> = [
    ['no journal record', null, QUERY_ID, NOT_RECORDED],
    ['an earlier release\'s started record', freshStateWith({
      operationIndex: 0, operationKey: BASE_INPUT.operationKey, operationType: BASE_INPUT.operationType,
      queryId: LEGACY_ID, status: 'started', startedAt: '2026-05-26 11:00:00.000', finishedAt: null, lastError: '', fingerprint: '',
    }), LEGACY_ID, NOT_RECORDED],
    ['a failed record', freshStateWith({
      operationIndex: 0, operationKey: BASE_INPUT.operationKey, operationType: BASE_INPUT.operationType,
      queryId: LEGACY_ID, status: 'failed', startedAt: '2026-05-26 11:00:00.000', finishedAt: '2026-05-26 11:00:01.000', lastError: 'boom', fingerprint: '',
    }), LEGACY_ID, RECORDED_FAILED],
  ]
  for (const [label, prior, checkedId, reason] of runningPriors) {
    test(`a running query under ${label} stops the run instead of attaching (#767)`, async () => {
      const { db, statusCalls, submitCalls, commandCalls } = createFakeExecutor([
        { status: 'running', writtenRows: 50, elapsedMs: RUNNING_ELAPSED_MS },
      ])
      const { store, writes } = createFakeJournalStore(prior)

      const run = applyAsyncStatement({
        ...BASE_INPUT,
        beforeRetry: 'TRUNCATE TABLE t',
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      })

      await expect(run).rejects.toMatchObject({
        code: 'async_outcome_unknown',
        message: `Async migration step load_table_data (statement 1 of m.sql, query_id ${checkedId}) is still running on the server, ${reason}. Nothing was submitted and no before-retry SQL ran. Wait for it to finish, or stop it with KILL QUERY WHERE query_id = '${checkedId}'. A stopped statement can still have applied effects (an ALTER's mutation keeps running, see system.mutations), so check what it applied and reconcile before you run chkit migrate --apply again: until its outcome is known, migrate stops with async_outcome_unknown.`,
      })
      expect(statusCalls).toEqual([{ queryId: checkedId, afterTime: undefined, everyReplica: true, runningOnly: true }])
      expect(submitCalls).toEqual([])
      expect(commandCalls).toEqual([])
      expect(writes).toEqual([])
    })
  }

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
        // A failure the server recorded for the id (#767).
        attemptFenced: true,
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
    const retryId = submittedQueryId(submitCalls)
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
    // prepared, started (overwrite prior failed) + completed
    expect(writes).toHaveLength(3)
    expect(writes[1]?.operations[0]).toMatchObject({
      status: 'started',
      queryId: retryId,
      lastError: ATTEMPT_RECORD_MARKER,
      attemptFenced: true,
    })
    expect(writes[2]?.operations[0]).toMatchObject({ status: 'completed', queryId: retryId })
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
        // A failure the server recorded for the id (#767).
        attemptFenced: true,
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
    expect(submitCalls).toEqual([{ sql: BASE_INPUT.sql, queryId: submittedQueryId(submitCalls), settings }])
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
        // A failure the server recorded for the id (#767).
        attemptFenced: true,
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

  // #767 (round 3): a statement that fails while it runs can leave some of
  // its writes applied, so the failure is recorded without the fence and the
  // run stops with async_outcome_unknown: no re-run compensates or runs it
  // again before the operator reconciles and abandons.
  test('polling-failure: a query that fails while it runs keeps its fenced record and stops the run', async () => {
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
    ).rejects.toMatchObject({
      code: 'async_outcome_unknown',
      message: expect.stringContaining('failed while it ran: NETWORK_ERROR: broken pipe. A statement that fails while it runs can leave some of its writes applied'),
    })

    // #767 (round 4): nothing is written, so the fenced started record keeps
    // the attempt's identity.
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started'])
    expect(await store.readStoredOperation(BASE_INPUT.migrationName, 0)).toMatchObject({ lastError: ATTEMPT_RECORD_MARKER, attemptFenced: true })
  })

  // The server logs a statement it rejects before it starts as
  // ExceptionBeforeStart under the attempt's id: its recorded failure (#767).
  test('a statement the server rejects before it starts is recorded failed from query_log (SQL parse failure case)', async () => {
    const { db } = createFakeExecutor(
      [{ status: 'unknown' }, { status: 'unknown' }, { status: 'failed', error: 'Syntax error: failed at position 1', beforeStart: true }],
      { failSubmit: () => new Error('Syntax error: failed at position 1') },
    )
    const { store, writes } = createFakeJournalStore(null)
    const lines: string[] = []

    await expect(
      applyAsyncStatement({
        ...BASE_INPUT,
        // An INSERT the server cannot parse: an INSERT applies nothing
        // before its pipeline starts (#767).
        sql: 'INSERT INTO t SELECT FROM',
        db,
        journalStore: store,
        log: (line) => lines.push(line),
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      }),
    ).rejects.toThrow(/Syntax error/)
    const queryId = writes[0]?.operations[0]?.queryId ?? ''
    expect(queryId).toMatch(UUID_SHAPE)

    // The server recorded the failure, so the attempt is recorded failed
    // (#233): an edited file can then run again without --retry.
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started', 'failed'])
    expect(writes[2]?.operations[0]).toMatchObject({ lastError: 'Syntax error: failed at position 1', attemptFenced: true })
    // The submit error is the command's error; no progress line repeats it (#561).
    expect(lines).toEqual([
      `  load_table_data: submitting async (query_id=${queryId})`,
      '  load_table_data: status unknown — still polling (elapsed 0s)',
    ])
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
      const { db, submitCalls } = createFakeExecutor(
        [
          { status: 'unknown' }, // initial in-flight check
          ...Array.from({ length: 21 }, () => new Error('HTTP 502: bad gateway')),
        ],
        submitFails ? { failSubmit: () => new Error('Authentication failed'), deferSubmit } : {},
      )
      const { store, writes } = createFakeJournalStore(null)

      // A deferred submit has not settled when the run stops, and the run
      // does not wait for it (#767, round 4).
      const submitTail = submitFails && !deferSubmit ? ', and the submit request failed (Authentication failed)' : ''
      const error = await applyAsyncStatement({
        ...BASE_INPUT,
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      }).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(error).toMatchObject({ code: 'async_outcome_unknown' })
      expect((error as Error).message).toContain(
        `(statement 1 of m.sql, query_id ${submittedQueryId(submitCalls)}): the journal records an attempt of it and no replica runs it, but chkit cannot tell whether it finished: polling failed 21× in a row (HTTP 502: bad gateway)${submitTail}. Nothing was submitted`,
      )
      // The outcome is unknown, so the attempt stays started for a re-run to re-attach.
      expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started'])
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
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started', 'completed'])
    expect(lines).toEqual([
      `  load_table_data: submitting async (query_id=${submittedQueryId(submitCalls)})`,
      '  load_table_data: written=9 rows (72 B), elapsed 0s',
      '  load_table_data: finished — written=16 rows (128 B) in 8s',
    ])
  })

  // After the 524, the query can end between two polls. A poll then finds it
  // neither running nor yet in query_log (flushed on a timer). The server ran
  // the query, so the submit error does not mean it failed (#657).
  test('a submit that fails after a poll found the query running waits for query_log', async () => {
    const { db, submitCalls } = createFakeExecutor(
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
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started', 'completed'])
    expect(lines).toEqual([
      `  load_table_data: submitting async (query_id=${submittedQueryId(submitCalls)})`,
      '  load_table_data: written=9 rows (72 B), elapsed 0s',
      '  load_table_data: status unknown — still polling (elapsed 0s)',
      '  load_table_data: finished — written=16 rows (128 B) in 8s',
    ])
  })

  // #767 (round 2): a lost submit response is no evidence of failure. The
  // poller keeps the fenced started record, reads every replica once more
  // through a query_log flush, then stops with async_outcome_unknown.
  for (const [label, failSubmit] of [
    ['a submit that fails after a poll found the query running', () => new Error('error code: 524')],
    ['an acknowledged submit', undefined],
  ] as const) {
    test(`${label} stops with async_outcome_unknown after the unknown-poll budget`, async () => {
      const { db, statusCalls, submitCalls, commandCalls } = createFakeExecutor(
        [
          { status: 'unknown' }, // initial in-flight check
          { status: 'running', writtenRows: 9, writtenBytes: 72 },
          ...Array.from({ length: 21 }, () => ({ status: 'unknown' as const })),
          // The final check of every replica, then 5 rechecks while query_log is flushed.
          ...Array.from({ length: 6 }, () => ({ status: 'unknown' as const })),
        ],
        failSubmit ? { failSubmit } : {},
      )
      const { store, writes } = createFakeJournalStore(null)

      const run = applyAsyncStatement({
        ...BASE_INPUT,
        db,
        journalStore: store,
        log: () => {},
        sleep: NO_SLEEP,
        now: FIXED_NOW,
      })

      const tail = failSubmit ? ', and the submit request failed (error code: 524)' : ''
      await expect(run).rejects.toMatchObject({
        code: 'async_outcome_unknown',
        message: expect.stringContaining(`chkit cannot tell whether it finished: polling found it neither running nor in system.query_log 20× in a row${tail}. Nothing was submitted`),
      })
      expect(submitCalls).toHaveLength(1)
      expect(statusCalls.slice(-6).every((call) => call.everyReplica === true && call.queryId === submitCalls[0]?.queryId)).toBe(true)
      expect(commandCalls).toEqual([])
      // The outcome is unknown, so the attempt stays started, fenced.
      expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started'])
    })
  }

  // #767 (round 3): a submit request that never settles (a proxy holding the
  // socket open) does not keep the run, and its migrate lock, waiting after
  // the final check: the run aborts the request and stops.
  test('a submit that never settles is aborted, and the run stops with async_outcome_unknown', async () => {
    const fake = createFakeExecutor([
      { status: 'unknown' },
      ...Array.from({ length: 20 + 6 }, () => ({ status: 'unknown' as const })),
    ])
    let signal: AbortSignal | undefined
    const db = {
      ...fake.db,
      submit: (_sql: string, _queryId?: string, _settings?: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal
        return new Promise(() => {})
      },
    } as unknown as ClickHouseExecutor
    const { store, writes } = createFakeJournalStore(null)

    await expect(
      applyAsyncStatement({ ...BASE_INPUT, db, journalStore: store, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: expect.stringContaining('20× in a row') })
    expect(signal?.aborted).toBe(true)
    // The check before the submit, 20 polls, then the final check and 5 rechecks.
    expect(fake.statusCalls).toHaveLength(1 + 20 + 6)
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started'])
  })

  // #767 (round 4): every other budget exit stops the same way, without
  // waiting for a submit that never settles: 21 failed polls, and a final
  // check of every replica that fails.
  for (const [label, statuses, calls] of [
    [
      'polling failed 21× in a row (HTTP 502: bad gateway)',
      [{ status: 'unknown' as const }, ...Array.from({ length: 21 }, () => new Error('HTTP 502: bad gateway'))],
      1 + 21,
    ],
    [
      'the final check of every replica failed (HTTP 502: bad gateway)',
      [
        { status: 'unknown' as const },
        ...Array.from({ length: 20 }, () => ({ status: 'unknown' as const })),
        new Error('HTTP 502: bad gateway'),
      ],
      1 + 20 + 1,
    ],
  ] as const) {
    test(`a submit that never settles is aborted when ${label}`, async () => {
      const fake = createFakeExecutor([...statuses])
      let signal: AbortSignal | undefined
      const db = {
        ...fake.db,
        submit: (_sql: string, _queryId?: string, _settings?: unknown, options?: { signal?: AbortSignal }) => {
          signal = options?.signal
          return new Promise(() => {})
        },
      } as unknown as ClickHouseExecutor
      const { store, writes } = createFakeJournalStore(null)

      await expect(
        applyAsyncStatement({ ...BASE_INPUT, db, journalStore: store, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW }),
      ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: expect.stringContaining(label) })
      expect(signal?.aborted).toBe(true)
      expect(fake.statusCalls).toHaveLength(calls)
      expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started'])
    })
  }

  // #767 (round 5): a statement that fails while it runs stops the run at
  // once too, without waiting for a submit a proxy holds open.
  test('a failure while it runs aborts a submit that never settles and stops with async_outcome_unknown', async () => {
    const fake = createFakeExecutor([
      { status: 'unknown' },
      { status: 'failed', error: 'Code: 395. throwIf', beforeStart: false },
    ])
    let signal: AbortSignal | undefined
    const db = {
      ...fake.db,
      submit: (_sql: string, _queryId?: string, _settings?: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal
        return new Promise(() => {})
      },
    } as unknown as ClickHouseExecutor
    const { store, writes } = createFakeJournalStore(null)

    await expect(
      applyAsyncStatement({ ...BASE_INPUT, db, journalStore: store, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: expect.stringContaining('failed while it ran') })
    expect(signal?.aborted).toBe(true)
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started'])
  })

  // #767 (round 6): a settled outcome is journaled, then the run ends without
  // waiting for a submit a proxy holds open.
  for (const [label, status] of [
    ['QueryFinish', { status: 'finished' as const, writtenRows: 1, durationMs: 10 }],
    ['ExceptionBeforeStart', { status: 'failed' as const, error: 'Code: 60. UNKNOWN_TABLE', beforeStart: true }],
  ] as const) {
    test(`a ${label} journals the outcome and aborts a submit that never settles`, async () => {
      const fake = createFakeExecutor([{ status: 'unknown' }, status])
      let signal: AbortSignal | undefined
      const db = {
        ...fake.db,
        submit: (_sql: string, _queryId?: string, _settings?: unknown, options?: { signal?: AbortSignal }) => {
          signal = options?.signal
          return new Promise(() => {})
        },
      } as unknown as ClickHouseExecutor
      const { store, writes } = createFakeJournalStore(null)

      const run = applyAsyncStatement({ ...BASE_INPUT, db, journalStore: store, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW })
      if (label === 'QueryFinish') expect((await run).kind).toBe('completed')
      else await expect(run).rejects.toThrow('UNKNOWN_TABLE')
      expect(signal?.aborted).toBe(true)
      expect(writes.at(-1)?.operations[0]?.status).toBe(label === 'QueryFinish' ? 'completed' : 'failed')
    })
  }

  // #767 (round 7): a terminal journal write that is rejected detaches the
  // submit too, and the run stops with the journal's error.
  for (const [label, status] of [
    ['QueryFinish', { status: 'finished' as const, writtenRows: 1, durationMs: 10 }],
    ['ExceptionBeforeStart', { status: 'failed' as const, error: 'Code: 60. UNKNOWN_TABLE', beforeStart: true }],
  ] as const) {
    test(`a rejected journal write after a ${label} aborts a submit that never settles`, async () => {
      const fake = createFakeExecutor([{ status: 'unknown' }, status])
      let signal: AbortSignal | undefined
      const db = {
        ...fake.db,
        submit: (_sql: string, _queryId?: string, _settings?: unknown, options?: { signal?: AbortSignal }) => {
          signal = options?.signal
          return new Promise(() => {})
        },
      } as unknown as ClickHouseExecutor
      const { store } = createFakeJournalStore(null)
      const write = store.writeMigrationState.bind(store)
      store.writeMigrationState = async (state) => {
        if (state.operations[0]?.status !== 'started') throw new Error('journal write rejected')
        await write(state)
      }

      await expect(
        applyAsyncStatement({ ...BASE_INPUT, db, journalStore: store, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW }),
      ).rejects.toThrow('journal write rejected')
      expect(signal?.aborted).toBe(true)
    })
  }

  // #767 (Opus review): during polling too, an ExceptionBeforeStart of a
  // statement other than a SELECT or an INSERT is no proof that it applied
  // nothing: the fenced started record stays, and the run stops.
  test('an ALTER rejected before it started while polling keeps its fenced record and stops', async () => {
    const fake = createFakeExecutor([
      { status: 'unknown' },
      { status: 'failed', error: 'Code: 341. DB::Exception: Value passed to throwIf', beforeStart: true },
    ])
    const { store, writes } = createFakeJournalStore(null)

    await expect(
      applyAsyncStatement({ ...BASE_INPUT, sql: 'ALTER TABLE t UPDATE v = throwIf(k = 4) WHERE 1', db: fake.db, journalStore: store, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: expect.stringContaining('system.mutations') })
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started'])
    expect(fake.commandCalls).toEqual([])
  })

  // #767 (Opus review): a failure after the attempt was journaled as one
  // that may have been sent, but before its submit, puts the record back to
  // prepared, so the next run resolves it without an abandon.
  test('a failed query tracking write before the submit puts the attempt back to prepared', async () => {
    const fake = createFakeExecutor([{ status: 'unknown' }])
    const { store, writes } = createFakeJournalStore(null)
    const queryTracker = {
      async recordAsync() {
        throw new Error('tracking write failed')
      },
    } as unknown as NonNullable<Parameters<typeof applyAsyncStatement>[0]['queryTracker']>

    await expect(
      applyAsyncStatement({ ...BASE_INPUT, db: fake.db, journalStore: store, queryTracker, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW }),
    ).rejects.toThrow('tracking write failed')
    expect(fake.submitCalls).toEqual([])
    expect(writes.map((state) => state.operations[0]?.lastError)).toEqual([PREPARED_RECORD_MARKER, ATTEMPT_RECORD_MARKER, PREPARED_RECORD_MARKER])
  })

  // #767 (round 3): only unknown polls in a row count; a failed poll request
  // starts the count again.
  test('a failed poll request resets the unknown-poll count', async () => {
    const fake = createFakeExecutor([
      { status: 'unknown' },
      ...Array.from({ length: 19 }, () => ({ status: 'unknown' as const })),
      new Error('HTTP 502: bad gateway'),
      ...Array.from({ length: 19 }, () => ({ status: 'unknown' as const })),
      { status: 'finished', writtenRows: 1, durationMs: 10 },
    ])
    const { store } = createFakeJournalStore(null)

    const result = await applyAsyncStatement({ ...BASE_INPUT, db: fake.db, journalStore: store, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW })

    expect(result.kind).toBe('completed')
    expect(fake.statusCalls.every((call) => call.everyReplica !== true || call === fake.statusCalls[0])).toBe(true)
  })

  // #767 (round 3): a run that holds no migrate lock (the target database did
  // not exist when it started) never submits an async statement: two such
  // runs could both submit it under ids of their own.
  test('a run without the migrate lock stops before an async statement with async_needs_lock', async () => {
    const fake = createFakeExecutor([{ status: 'unknown' }])
    const { store, writes } = createFakeJournalStore(null)

    await expect(
      applyAsyncStatement({ ...BASE_INPUT, locklessBootstrap: true, db: fake.db, journalStore: store, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'async_needs_lock', message: expect.stringContaining('Run chkit migrate --apply again') })
    expect(fake.submitCalls).toEqual([])
    expect(writes).toEqual([])
  })

  // #767 (round 2): an attached attempt that disappears from system.processes
  // without a query_log entry stops the run too, instead of polling forever.
  test('an attach that polls unknown past the budget stops with async_outcome_unknown', async () => {
    const ownId = '0b7f9a52-3c1d-4e8f-9a6b-2d4c8e1f7a30'
    const { db, submitCalls } = createFakeExecutor([
      { status: 'running', writtenRows: 1 },
      ...Array.from({ length: 21 + 6 }, () => ({ status: 'unknown' as const })),
    ])
    const { store, writes } = createFakeJournalStore(
      freshStateWith({
        operationIndex: 0, operationKey: BASE_INPUT.operationKey, operationType: BASE_INPUT.operationType,
        queryId: ownId, status: 'started', startedAt: '2026-05-26 10:00:00.000', finishedAt: null,
        lastError: ATTEMPT_RECORD_MARKER, fingerprint: 'v1:load', attemptFenced: true,
      }),
    )

    await expect(
      applyAsyncStatement({ ...BASE_INPUT, fingerprint: 'v1:load', db, journalStore: store, log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown' })
    expect(submitCalls).toEqual([])
    expect(writes).toEqual([])
  })

  // query_log still holds an earlier attempt's QueryFinish under the id an
  // earlier release gave a statement's first attempt, also after `migrate
  // --abandon` (#233). A submission that then fails before it starts (no
  // query_log row) must not inherit it: its id is its own (#767).
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
          // The rejected submission's ExceptionBeforeStart (#767).
          if (id !== queryId) return opts?.runningOnly ? { status: 'unknown' } : { status: 'failed', error: "Unknown table expression identifier 'default.src_typo'", beforeStart: true }
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

      // Every attempt polls an id of its own (#701, #767).
      const poll = { queryId: statusCalls[1]?.queryId ?? '', afterTime: RETRY_BOUND }
      expect(poll.queryId).toMatch(UUID_SHAPE)
      expect(poll.queryId).not.toBe(queryId)
      expect(statusCalls.slice(1).every((call) => call.queryId === poll.queryId && call.afterTime === poll.afterTime)).toBe(true)
      // Recorded as a failed attempt, never as completed.
      expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started', 'failed'])
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
        // A failure the server recorded for the id (#767).
        attemptFenced: true,
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
    expect(writes.map((state) => state.checksum)).toEqual(['changed-checksum', 'changed-checksum', 'changed-checksum'])
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
      `an earlier attempt with different SQL is still running on the server. Wait for it to finish, or stop it with KILL QUERY WHERE query_id = '${QUERY_ID}'. A stopped statement can still have applied effects`,
    )
    expect(submitCalls).toEqual([])
    expect(writes).toEqual([])
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
// compensates and resubmits, when the record is fenced (#767).
describe('applyAsyncStatement re-run of a started step', () => {
  // The random id this release recorded for an attempt before its submit.
  const OWN_ID = '0b7f9a52-3c1d-4e8f-9a6b-2d4c8e1f7a30'
  const startedRecord = (overrides: Partial<OperationState> = {}): MigrationRowState =>
    freshStateWith({
      operationIndex: 0,
      operationKey: BASE_INPUT.operationKey,
      operationType: BASE_INPUT.operationType,
      queryId: OWN_ID,
      status: 'started',
      startedAt: '2026-05-26 10:00:00.000',
      finishedAt: null,
      lastError: ATTEMPT_RECORD_MARKER,
      fingerprint: 'v1:load',
      attemptFenced: true,
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
  // The record's start minus the hour that only lets query_log prune.
  const RECORD_BOUND = '2026-05-26T09:00:00.000Z'
  // A started attempt without a query_log entry: the check, then 5 rechecks
  // while query_log is flushed (#701).
  const NO_ENTRY_CHECKS = Array.from({ length: 6 }, () => ({ status: 'unknown' as const }))
  const killedBeforeSubmit = (db: ClickHouseExecutor) =>
    ({
      ...db,
      submit: () => {
        throw new Error('killed')
      },
    }) as unknown as ClickHouseExecutor
  const outcomeUnknown = (queryId: string, reason: string) =>
    `Async migration step load_table_data (statement 1 of m.sql, query_id ${queryId}): the journal records an attempt of it and no replica runs it, but chkit cannot tell whether it finished: ${reason}. Nothing was submitted and no before-retry SQL ran. Check in ClickHouse whether the statement's rows reached its target. Then reconcile every statement of m.sql that already ran, since an abandon runs the migration again from statement 1, run chkit migrate --apply --abandon m.sql, and apply again.`
  const NO_ENTRY_REASON =
    'system.query_log has no entry for its query id (query logging is off for the user, query_log is flushed later than chkit waits, or the run stopped before it submitted the statement)'
  const UNVERIFIED_REASON =
    'the journal records it as failed, but not from a rejection the server recorded before it started (an earlier chkit release recorded it, it failed while it ran, or a run lost its submit response), so some of its writes may have been applied'
  const WHILE_PROCESSING_REASON =
    'the server reports it failed while it ran (ExceptionWhileProcessing), and a statement that fails while it runs can leave some of its writes applied (parts of an INSERT ... SELECT, a DDL that ran on some hosts)'
  const UNFENCED_REASON =
    "an earlier chkit release recorded it, or the journal could not store the record's fence (it has no operation_fingerprints column), so its query id may name earlier attempts too"

  test('a re-run after the poll budget ran out finds the finished attempt and neither compensates nor resubmits', async () => {
    const { store, writes } = createFakeJournalStore(null)
    // Run 1: the submit fails with a gateway timeout, a poll sees the load
    // running, then query_log has no outcome for 21 polls.
    const first = createFakeExecutor(
      [
        { status: 'unknown' },
        { status: 'running', writtenRows: 9, writtenBytes: 72 },
        ...Array.from({ length: 21 + 6 }, () => ({ status: 'unknown' as const })),
      ],
      { failSubmit: () => new Error('error code: 524') },
    )
    await expect(
      applyAsyncStatement({ ...input, db: first.db, journalStore: store, sleep: NO_SLEEP }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown' })
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started'])
    const queryId = submittedQueryId(first.submitCalls)
    // The attempt's start is recorded on the server clock, fenced, under the submitted id.
    expect(writes[1]?.operations[0]).toMatchObject({ queryId, startedAt: iso(SERVER_NOW_MS), lastError: ATTEMPT_RECORD_MARKER, attemptFenced: true })

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
    // One read of every replica, of the recorded id only.
    expect(second.statusCalls).toEqual([{ queryId, afterTime: RETRY_BOUND, everyReplica: true }])
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started', 'completed'])
    expect(writes[2]?.operations[0]).toMatchObject({
      queryId,
      startedAt: iso(SERVER_NOW_MS),
      fingerprint: 'v1:load',
      lastError: '',
    })
    expect(lines).toEqual([
      `  load_table_data: previous attempt of query_id=${queryId} finished on the server — written=16 rows (128 B) in 8s, recording it as completed`,
    ])
  })

  test('a started attempt the server rejected before it started is journaled failed, then compensated and resubmitted', async () => {
    const fake = clockedExecutor([
      { status: 'failed', error: 'Code: 60. DB::Exception: Unknown table\nstack', beforeStart: true },
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
    expect(fake.statusCalls[0]).toEqual({ queryId: OWN_ID, afterTime: RECORD_BOUND, everyReplica: true })
    expect(fake.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    const retryId = submittedQueryId(fake.submitCalls)
    expect(retryId).not.toBe(OWN_ID)
    expect(fake.submitCalls).toEqual([{ sql: input.sql, queryId: retryId }])
    expect(lines[0]).toBe(
      `  load_table_data: previous attempt of query_id=${OWN_ID} is no longer running (status=failed: Code: 60. DB::Exception: Unknown table) — running before-retry then resubmitting as query_id=${retryId}`,
    )
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['failed', 'started', 'started', 'completed'])
    expect(writes[0]?.operations[0]).toMatchObject({ lastError: 'Code: 60. DB::Exception: Unknown table\nstack', attemptFenced: true })
  })

  // #767 (Opus review): an ExceptionBeforeStart shows nothing ran only for
  // a SELECT or an INSERT. A killed ALTER ... UPDATE logs one while its
  // mutation still completes, so its re-run stops instead of compensating.
  test('a started ALTER the server rejected before it started stops the re-run with async_outcome_unknown', async () => {
    const fake = clockedExecutor([
      { status: 'failed', error: 'Code: 394. DB::Exception: Query was cancelled', beforeStart: true },
    ])
    const { store, writes } = createFakeJournalStore(startedRecord())

    await expect(
      applyAsyncStatement({ ...input, sql: 'ALTER TABLE t UPDATE v = v + 100 WHERE 1', db: fake.db, journalStore: store, sleep: fake.sleep }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: expect.stringContaining('rejected before it started (ExceptionBeforeStart)') })
    expect(fake.commandCalls).toEqual([])
    expect(fake.submitCalls).toEqual([])
    expect(writes).toEqual([])
  })

  // #767 (round 3): a failure while it ran (ExceptionWhileProcessing) can
  // leave rows applied, so it stops the re-run like a missing outcome.
  test('a started attempt that failed while it ran stops with async_outcome_unknown', async () => {
    const fake = clockedExecutor([{ status: 'failed', error: 'Code: 241. DB::Exception: Memory limit exceeded' }])
    const { store, writes } = createFakeJournalStore(startedRecord())

    await expect(
      applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: outcomeUnknown(OWN_ID, WHILE_PROCESSING_REASON) })
    expect(fake.commandCalls).toEqual([])
    expect(fake.submitCalls).toEqual([])
    expect(writes).toEqual([])
  })

  // #767 (Codex review of #770, 770b): an attempt with no evidence may have
  // finished (query logging off, a late flush) or never been submitted. Its
  // record stays as it is, and nothing is compensated or submitted, with or
  // without before-retry SQL.
  for (const beforeRetry of ['TRUNCATE TABLE t', null]) {
    test(`a fenced started attempt without a query_log entry stops with async_outcome_unknown (before-retry: ${beforeRetry ?? 'none'})`, async () => {
      const fake = clockedExecutor(NO_ENTRY_CHECKS)
      const { store, writes } = createFakeJournalStore(startedRecord())

      const run = applyAsyncStatement({ ...input, beforeRetry, db: fake.db, journalStore: store, sleep: fake.sleep })

      await expect(run).rejects.toMatchObject({ code: 'async_outcome_unknown', message: outcomeUnknown(OWN_ID, NO_ENTRY_REASON) })
      // Checked once, then 5 times 2 s apart while query_log is flushed (#701).
      expect(fake.statusCalls).toEqual(
        Array.from({ length: 6 }, () => ({ queryId: OWN_ID, afterTime: RECORD_BOUND, everyReplica: true })),
      )
      expect(fake.sleeps).toEqual([2_000, 2_000, 2_000, 2_000, 2_000])
      expect(fake.commandCalls).toEqual([])
      expect(fake.submitCalls).toEqual([])
      expect(writes).toEqual([])
    })
  }

  // The stop leaves a way out: abandon, then apply, which compensates and
  // submits once.
  test('after async_outcome_unknown, an abandon lets the next apply compensate and submit once', async () => {
    const { store } = createFakeJournalStore(startedRecord())
    await expect(
      applyAsyncStatement({ ...input, db: clockedExecutor(NO_ENTRY_CHECKS).db, journalStore: store, sleep: NO_SLEEP }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown' })
    const stopped = await store.readMigrationState(BASE_INPUT.migrationName)
    expect(stopped).not.toBeNull()
    await abandonMigrationState(stopped as MigrationRowState, { journalStore: store, now: FIXED_NOW })

    const next = clockedExecutor([{ status: 'unknown' }, { status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const result = await applyAsyncStatement({ ...input, db: next.db, journalStore: store, sleep: next.sleep })

    expect(result.kind).toBe('completed')
    expect(next.statusCalls[0]).toEqual({ queryId: OWN_ID, afterTime: undefined, everyReplica: true, runningOnly: true })
    expect(next.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    expect(next.submitCalls).toHaveLength(1)
  })

  // The attempt's QueryFinish can reach query_log only after the check (it is
  // flushed on a timer). A run that stops after the compensation, before it
  // journals the new attempt, must leave a record whose QueryFinish a re-run
  // does not take for the outcome: the rows it loaded were truncated.
  test('a re-run after a compensation that stopped the run compensates and resubmits again', async () => {
    const { store, writes } = createFakeJournalStore(startedRecord())
    // Run 1: the attempt failed; the TRUNCATE ran, but its response was lost.
    const first = clockedExecutor([{ status: 'failed', error: 'boom', beforeStart: true }])
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

    // Run 2: query_log would now answer for the id, but a failed record is
    // checked in system.processes only.
    const second = clockedExecutor([
      { status: 'finished', writtenRows: 16, durationMs: 8000 },
      { status: 'finished', writtenRows: 16, durationMs: 8000 },
    ])
    await applyAsyncStatement({ ...input, db: second.db, journalStore: store, sleep: second.sleep })

    expect(second.statusCalls[0]).toMatchObject({ everyReplica: true, runningOnly: true })
    expect(second.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    expect(second.submitCalls).toHaveLength(1)
  })

  // #701, #767: every attempt submits under an id of its own, so a re-run
  // never takes an earlier attempt's QueryFinish for a later attempt's
  // outcome. A run killed between its journal write and its submit leaves
  // an attempt without evidence, which stops the re-run.
  test("a re-run never takes an earlier attempt's QueryFinish for an attempt killed before its submit", async () => {
    const { store, writes } = createFakeJournalStore(null)
    const first = clockedExecutor([{ status: 'unknown' }])
    await expect(
      applyAsyncStatement({ ...input, db: killedBeforeSubmit(first.db), journalStore: store, sleep: first.sleep }),
    ).rejects.toThrow('killed')
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started'])
    const recordedId = writes[0]?.operations[0]?.queryId ?? ''
    expect(recordedId).toMatch(UUID_SHAPE)
    expect(recordedId).not.toBe(QUERY_ID)

    // query_log holds an earlier attempt's QueryFinish under the statement's
    // earlier first id, and nothing of the recorded id.
    const rerun = clockedExecutor(NO_ENTRY_CHECKS)
    const answers = rerun.db.queryStatus.bind(rerun.db)
    const db = {
      ...rerun.db,
      async queryStatus(id: string, opts?: QueryStatusOptions): Promise<QueryStatus> {
        const answer = await answers(id, opts)
        return id === QUERY_ID ? { status: 'finished', writtenRows: 0, durationMs: 10 } : answer
      },
    } as unknown as ClickHouseExecutor
    await expect(
      applyAsyncStatement({ ...input, db, journalStore: store, sleep: rerun.sleep }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: outcomeUnknown(recordedId, NO_ENTRY_REASON) })

    expect(rerun.statusCalls.every((call) => call.queryId === recordedId)).toBe(true)
    expect(rerun.commandCalls).toEqual([])
    expect(rerun.submitCalls).toEqual([])
    expect(writes).toHaveLength(2)
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
    const runAQueryId = submittedQueryId(runA.submitCalls)
    // Run B read the same failed record.
    const runB = clockedExecutor([{ status: 'unknown' }])
    const journalB = createFakeJournalStore(failed)
    await expect(
      applyAsyncStatement({ ...input, db: killedBeforeSubmit(runB.db), journalStore: journalB.store, sleep: runB.sleep }),
    ).rejects.toThrow('killed')
    expect(runB.commandCalls).toEqual([{ sql: 'TRUNCATE TABLE t' }])
    const runBRecord = journalB.writes.at(-1)?.operations[0]
    expect(runBRecord?.status).toBe('started')
    expect(runBRecord?.queryId).not.toBe(runAQueryId)

    // The re-run: query_log has run A's QueryFinish only.
    const rerun = clockedExecutor(NO_ENTRY_CHECKS)
    const answers = rerun.db.queryStatus.bind(rerun.db)
    const db = {
      ...rerun.db,
      async queryStatus(id: string, opts?: QueryStatusOptions): Promise<QueryStatus> {
        const answer = await answers(id, opts)
        return id === runAQueryId ? { status: 'finished', writtenRows: 16, durationMs: 8000 } : answer
      },
    } as unknown as ClickHouseExecutor
    await expect(
      applyAsyncStatement({ ...input, db, journalStore: journalB.store, sleep: rerun.sleep }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown' })

    expect(rerun.commandCalls).toEqual([])
    expect(rerun.submitCalls).toEqual([])
  })

  // #767: a started record without the fence names an id that earlier
  // attempts may share (a first attempt's deterministic id, or an id an older
  // release reused for every attempt), or one an older release may have
  // compensated without recording it (a #701 retry id, then a TRUNCATE by a
  // release that did not know the marker). Its QueryFinish is never taken for
  // the outcome, and before-retry SQL cannot tell whether the rows landed
  // either, so the run stops before it writes or runs anything.
  const legacyRecords: Array<[string, MigrationRowState, { fingerprints?: boolean }]> = [
    ['a record without a marker (before #672)', startedRecord({ queryId: QUERY_ID, lastError: '', fingerprint: '', attemptFenced: undefined }), {}],
    ['a #672 record', startedRecord({ queryId: QUERY_ID, lastError: 'submitted; a retry reads its outcome from system.query_log', attemptFenced: undefined }), {}],
    ["a #701 record of a first attempt's deterministic id", startedRecord({ queryId: QUERY_ID, attemptFenced: undefined }), {}],
    ["a #701 record of a retry's random id", startedRecord({ attemptFenced: undefined }), {}],
    ['a record of this release in a journal without the fingerprint column', startedRecord({ fingerprint: '' }), { fingerprints: false }],
  ]
  for (const [label, record, journal] of legacyRecords) {
    for (const beforeRetry of ['TRUNCATE TABLE t', null]) {
      test(`${label} is checked in system.processes only and stops with async_outcome_unknown (before-retry: ${beforeRetry ?? 'none'})`, async () => {
        // query_log would answer QueryFinish for any id.
        const fake = clockedExecutor([{ status: 'finished', writtenRows: 16, durationMs: 8000 }])
        const { store, writes } = createFakeJournalStore(null, journal)
        await store.writeMigrationState(record)
        writes.length = 0
        const queryId = record.operations[0]?.queryId ?? ''

        await expect(
          applyAsyncStatement({ ...input, beforeRetry, db: fake.db, journalStore: store, sleep: fake.sleep }),
        ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: outcomeUnknown(queryId, UNFENCED_REASON) })

        expect(fake.statusCalls).toEqual([{ queryId, afterTime: undefined, everyReplica: true, runningOnly: true }])
        expect(fake.commandCalls).toEqual([])
        expect(fake.submitCalls).toEqual([])
        expect(writes).toEqual([])
      })
    }
  }

  // #767 (round 2): a failed record that no server failure or abandon
  // recorded (a #721-era "no outcome" retry record, or a lost submit response
  // an earlier release journaled failed) may have finished. It is checked in
  // system.processes only and stops the run before anything is written or run.
  for (const lastError of ['no longer running and no outcome in system.query_log; retried', 'error code: 524']) {
    test(`an unverified failed record (${lastError}) stops with async_outcome_unknown`, async () => {
      const fake = clockedExecutor([{ status: 'finished', writtenRows: 16, durationMs: 8000 }])
      const { store, writes } = createFakeJournalStore(startedRecord({ status: 'failed', finishedAt: '2026-05-26 10:05:00.000', lastError, attemptFenced: undefined }))

      await expect(
        applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep }),
      ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: outcomeUnknown(OWN_ID, UNVERIFIED_REASON) })
      expect(fake.statusCalls).toEqual([{ queryId: OWN_ID, afterTime: undefined, everyReplica: true, runningOnly: true }])
      expect(fake.commandCalls).toEqual([])
      expect(fake.submitCalls).toEqual([])
      expect(writes).toEqual([])
    })
  }

  // #767 (round 2, all three reviews): the submit's response is lost after
  // the INSERT committed, and the first polls run before query_log has its
  // QueryFinish. The attempt is never journaled failed, so nothing is
  // compensated or submitted again: the polls find the QueryFinish.
  test('a lost submit response is no failure: the polls find the committed attempt', async () => {
    const fake = clockedExecutor(
      [
        { status: 'unknown' }, // in-flight check before the submit
        { status: 'unknown' },
        { status: 'unknown' },
        { status: 'finished', writtenRows: 16, durationMs: 8000 },
      ],
      { failSubmit: () => new Error('HTTP 524 after commit') },
    )
    const { store, writes } = createFakeJournalStore(null)

    const result = await applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep })

    expect(result.kind).toBe('completed')
    expect(fake.submitCalls).toHaveLength(1)
    expect(fake.commandCalls).toEqual([])
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started', 'completed'])
  })

  // #767 (round 2): only a fenced record stops an earlier release from
  // resuming it, so a journal that cannot store the fence (no
  // operation_fingerprints column, ALTER denied) gets no submit.
  test('an attempt the journal stores without its fence is not submitted', async () => {
    const fake = clockedExecutor([{ status: 'unknown' }])
    const { store } = createFakeJournalStore(null, { fingerprints: false })

    await expect(
      applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep }),
    ).rejects.toMatchObject({
      code: 'async_attempt_unfenced',
      message: expect.stringContaining('ADD COLUMN IF NOT EXISTS operation_fingerprints Array(String)'),
    })
    expect(fake.submitCalls).toEqual([])
  })

  // #767 (round 3): a read-back that lags keeps the attempt prepared, never
  // sent, so the next run runs it again without an abandon.
  test('an attempt whose read-back lags stays prepared, and the next run submits it once', async () => {
    const first = clockedExecutor([{ status: 'unknown' }])
    const { store, writes } = createFakeJournalStore(null)
    const read = store.readStoredOperation.bind(store)
    store.readStoredOperation = async () => undefined
    await expect(
      applyAsyncStatement({ ...input, db: first.db, journalStore: store, sleep: first.sleep }),
    ).rejects.toThrow(/an attempt that was never sent runs again/)
    expect(first.submitCalls).toEqual([])
    expect(writes.map((state) => state.operations[0]?.lastError)).toEqual([PREPARED_RECORD_MARKER])
    const preparedId = writes[0]?.operations[0]?.queryId

    store.readStoredOperation = read
    const second = clockedExecutor([...NO_ENTRY_CHECKS, { status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const result = await applyAsyncStatement({ ...input, db: second.db, journalStore: store, sleep: second.sleep })

    expect(result.kind).toBe('completed')
    // The prepared id is looked up on every replica first: nothing of it.
    expect(second.statusCalls.slice(0, 6).every((call) => call.queryId === preparedId && call.everyReplica === true)).toBe(true)
    expect(second.submitCalls).toHaveLength(1)
    expect(second.submitCalls[0]?.queryId).not.toBe(preparedId)
    // #767 (round 4): an attempt that was never sent wrote nothing, so its
    // re-run runs no before-retry SQL.
    expect(second.commandCalls).toEqual([])
  })

  // #767 (round 4): a prepared record is read from one replica. Only a read
  // that covers every copy of the journal rules out a newer record of the
  // attempt (one that was sent); without it the run stops and keeps the row.
  const preparedRecord = () => startedRecord({ lastError: PREPARED_RECORD_MARKER })
  const STALE_PREPARED_REASON =
    'the journal records it as prepared, not sent, but chkit cannot read every copy of the journal to rule out a newer record of it (one that may have been sent)'

  test('a prepared attempt whose journal copies cannot all be read stops with async_outcome_unknown', async () => {
    const { store, writes } = createFakeJournalStore(preparedRecord(), { everyCopy: false })
    const fake = clockedExecutor([...NO_ENTRY_CHECKS])

    await expect(
      applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: outcomeUnknown(OWN_ID, STALE_PREPARED_REASON) })
    expect(fake.submitCalls).toEqual([])
    expect(fake.commandCalls).toEqual([])
    expect(writes).toEqual([])
  })

  test('a prepared attempt that a fresh read finds sent stops with async_outcome_unknown', async () => {
    const { store, writes } = createFakeJournalStore(preparedRecord())
    // The fresh read of every copy returns the newer, sent record.
    store.readStoredOperation = async () => startedRecord().operations[0]
    const fake = clockedExecutor([...NO_ENTRY_CHECKS])

    await expect(
      applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep }),
    ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: outcomeUnknown(OWN_ID, STALE_PREPARED_REASON) })
    expect(fake.submitCalls).toEqual([])
    expect(fake.commandCalls).toEqual([])
    expect(writes).toEqual([])
  })

  // A read that fails goes through the remaining reads (#767, round 3).
  test('a read-back that fails is tried again', async () => {
    const fake = clockedExecutor([{ status: 'unknown' }, { status: 'finished', writtenRows: 1, durationMs: 10 }])
    const { store } = createFakeJournalStore(null)
    const read = store.readStoredOperation.bind(store)
    let failures = 2
    store.readStoredOperation = async (name, index) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('HTTP 502: bad gateway')
      }
      return await read(name, index)
    }

    const result = await applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep })

    expect(result.kind).toBe('completed')
    expect(fake.submitCalls).toHaveLength(1)
  })

  // When the move to "may have been sent" does not read back, the attempt
  // goes back to prepared before the run stops: it was never sent.
  test('an attempt whose second read-back fails goes back to prepared and is not submitted', async () => {
    const fake = clockedExecutor([{ status: 'unknown' }])
    const { store, writes } = createFakeJournalStore(null)
    const read = store.readStoredOperation.bind(store)
    store.readStoredOperation = async (name, index) => {
      const op = await read(name, index)
      return op?.lastError === ATTEMPT_RECORD_MARKER ? undefined : op
    }

    await expect(
      applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep }),
    ).rejects.toThrow(/was not submitted/)
    expect(fake.submitCalls).toEqual([])
    expect(writes.map((state) => state.operations[0]?.lastError)).toEqual([PREPARED_RECORD_MARKER, ATTEMPT_RECORD_MARKER, PREPARED_RECORD_MARKER])
  })

  // The process's own last write is not the server's record (#767, round 2).
  test('an attempt only this process remembers writing is not submitted', async () => {
    const fake = clockedExecutor([{ status: 'unknown' }])
    const { store } = createFakeJournalStore(null)
    store.readStoredOperation = async () => undefined

    await expect(
      applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: fake.sleep }),
    ).rejects.toThrow(/the journal did not return the attempt's record, so it was not submitted/)
    expect(fake.submitCalls).toEqual([])
    // Read back 5 times, a second apart.
    expect(fake.sleeps).toEqual([1_000, 1_000, 1_000, 1_000])
  })

  // A fenced attempt that a recheck finds running (its submit reached the
  // server late) is attached to, not resubmitted.
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

  // Only a started attempt of this statement's SQL can have finished unseen:
  // a failed one has its outcome, a sync record never ran under this id, and
  // an attempt of other SQL that finished did not run this statement.
  const notRead: Array<[string, MigrationRowState]> = [
    ['a failed attempt', startedRecord({ status: 'failed', finishedAt: '2026-05-26 10:05:00.000', lastError: 'boom' })],
    ['a started record without a query id', startedRecord({ queryId: '' })],
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

  // #767 (770b): an attach writes nothing before the outcome, so a run killed
  // while it polls leaves the fenced record as it was, and a re-run reads the
  // same id with the same bound.
  test('an attach leaves the fenced record as it is, and a re-run after a killed attach records its QueryFinish', async () => {
    const { store, writes } = createFakeJournalStore(startedRecord())
    const first = createFakeExecutor([
      { status: 'running', writtenRows: 5 },
      ...Array.from({ length: 21 }, () => new Error('HTTP 502: bad gateway')),
    ])
    await expect(
      applyAsyncStatement({ ...input, beforeRetry: null, db: first.db, journalStore: store, sleep: NO_SLEEP }),
    ).rejects.toThrow(/polling failed 21×/)
    expect(writes).toEqual([])
    expect(first.statusCalls.slice(1).every((call) => call.queryId === OWN_ID && call.afterTime === RECORD_BOUND)).toBe(true)

    const second = createFakeExecutor([{ status: 'finished', writtenRows: 16, durationMs: 8000 }])
    const result = await applyAsyncStatement({
      ...input,
      beforeRetry: null,
      db: second.db,
      journalStore: store,
      sleep: NO_SLEEP,
    })

    expect(result.kind).toBe('completed')
    expect(second.statusCalls).toEqual([{ queryId: OWN_ID, afterTime: RECORD_BOUND, everyReplica: true }])
    expect(second.submitCalls).toEqual([])
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

      expect(statusCalls[0]?.afterTime).toBe(RECORD_BOUND)
    })
  }

  // #701: query_log is flushed on a timer (7.5 s by default), so a re-run right
  // after the attempt ended can find it neither running nor in query_log.
  test('a re-run before query_log has the finished attempt waits for it instead of resubmitting', async () => {
    const { store, writes } = createFakeJournalStore(null)
    const first = createFakeExecutor([
      { status: 'unknown' },
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
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started', 'completed'])
  })

  // #701: a retried attempt that ran on a replica whose clock is 3 s behind
  // the one that gave its recorded start.
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

  // #767 (Codex review of #770, 770d): an earlier attempt finished under the
  // statement's deterministic first id, and the journal writes before this
  // submission were slow. The submission is rejected; its polls read its
  // own id only, so the earlier QueryFinish is never taken for its outcome.
  test("a first attempt's polls ignore an earlier attempt of the deterministic id however long the journal writes take", async () => {
    const clock = { ms: SERVER_NOW_MS }
    const polled: string[] = []
    const db = {
      async query() {
        return [{ now_ms: String(clock.ms), database: SERVER_DATABASE }]
      },
      async queryStatus(id: string, opts?: QueryStatusOptions): Promise<QueryStatus> {
        if (opts?.runningOnly) return { status: 'unknown' }
        polled.push(id)
        // The rejected submission's ExceptionBeforeStart under its own id.
        return id === QUERY_ID ? { status: 'finished', writtenRows: 2, durationMs: 10 } : { status: 'failed', error: 'Code: 60. UNKNOWN_TABLE', beforeStart: true }
      },
      async command() {},
      async submit() {
        throw new Error('Code: 60. UNKNOWN_TABLE')
      },
    } as unknown as ClickHouseExecutor
    const { store, writes } = createFakeJournalStore(null)
    // Each journal write and read takes 6 s.
    const write = store.writeMigrationState.bind(store)
    store.writeMigrationState = async (state) => {
      clock.ms += 6_000
      await write(state)
    }
    const read = store.readMigrationState.bind(store)
    store.readMigrationState = async (name) => {
      clock.ms += 6_000
      return await read(name)
    }

    await expect(
      applyAsyncStatement({ ...input, beforeRetry: null, db, journalStore: store, sleep: NO_SLEEP }),
    ).rejects.toThrow(/UNKNOWN_TABLE/)
    expect(writes.map((state) => state.operations[0]?.status)).toEqual(['started', 'started', 'failed'])
    expect(polled.length > 0).toBe(true)
    expect(polled).not.toContain(QUERY_ID)
  })

  // The random id is known only to the journal, so it is never submitted
  // when the journal does not return the started record (#767).
  test('an attempt the journal does not return after its started write is not submitted', async () => {
    const fake = createFakeExecutor([{ status: 'unknown' }])
    const { store } = createFakeJournalStore(null)
    store.writeMigrationState = async () => {}

    await expect(
      applyAsyncStatement({ ...input, db: fake.db, journalStore: store, sleep: NO_SLEEP }),
    ).rejects.toThrow(/the journal did not return the attempt's record, so it was not submitted/)
    expect(fake.submitCalls).toEqual([])
  })
})

// #767 (round 7): through the real journal store, a fan-out that answers one
// server twice, or that a server added since cannot answer, never lets a
// prepared attempt run again: the run stops with nothing submitted.
describe('applyAsyncStatement recovery through the journal store', () => {
  const UUID_A = '2dea4dea-c7d6-439c-b8ef-5eaa1d275f14'
  const operations = JSON.stringify([{ operation_index: 0, operation_key: BASE_INPUT.operationKey, operation_type: BASE_INPUT.operationType, query_id: 'prepared-id', status: 'started', started_at: '2026-05-26 10:00:00.000', finished_at: null, last_error: PREPARED_RECORD_MARKER }])
  const copy = { replica: UUID_A, members: JSON.stringify([UUID_A]), present: '1', applied_at: '2026-05-26 10:00:00.000', operations, operation_fingerprints: '[]' }

  for (const [label, everyCopy] of [
    ['one server answering twice', () => [copy, copy]],
    ['a server added since that cannot be reached', () => {
      throw new Error('Code: 279. ALL_CONNECTION_TRIES_FAILED')
    }],
  ] as const) {
    test(`${label}: nothing is submitted`, async () => {
      const submits: string[] = []
      const db = {
        async command() {},
        async query<T>(sql: string): Promise<T[]> {
          if (sql.includes('SELECT engine FROM system.tables')) return [{ engine: 'ReplacingMergeTree' }] as T[]
          if (sql.includes('now_ms')) return [{ now_ms: String(SERVER_NOW_MS), database: SERVER_DATABASE }] as T[]
          if (sql.includes('currentDatabase() AS database')) return [{ database: SERVER_DATABASE }] as T[]
          if (sql.includes('view(')) return (everyCopy as () => T[])()
          if (sql.includes('FINAL WHERE')) {
            return [{ name: BASE_INPUT.migrationName, applied_at: '2026-05-26 10:00:00.000', checksum: BASE_INPUT.migrationChecksum, chkit_version: '', migration_completed: 'false', operations }] as T[]
          }
          return []
        },
        async queryStatus() { return { status: 'unknown' } },
        async submit(sql: string) { submits.push(sql); return 'x' },
      } as unknown as ClickHouseExecutor

      await expect(
        applyAsyncStatement({ ...BASE_INPUT, db, journalStore: createJournalStore(db), log: () => {}, sleep: NO_SLEEP, now: FIXED_NOW }),
      ).rejects.toMatchObject({ code: 'async_outcome_unknown', message: expect.stringContaining('query_id prepared-id') })
      expect(submits).toEqual([])
    })
  }
})
