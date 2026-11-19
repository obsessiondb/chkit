import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as defaultSleep } from 'node:timers/promises'

import type { ClickHouseExecutor, ClickHouseSettings, QueryStatus } from '@chkit/clickhouse'

import { debug } from '../../runtime/debug.js'
import {
  type JournalStore,
  type MigrationRowState,
  type OperationState,
  resolveJournalTableName,
} from '../../runtime/journal-store.js'
import { rejectionRunsNothing } from '../../runtime/safety-markers.js'
import { CLI_VERSION } from '../../runtime/version.js'
import { inProgressChecksumMismatchError, MigrateError } from './errors.js'
import { assertCompletedStatement, hasStatementProgress } from './recovery.js'
import type { QueryTracker } from './query-intents.js'

const POLL_INTERVAL_MS = 5_000
// Every attempt, the first included, submits under a random query id of its
// own, recorded in the journal before the submit (#767), so every
// system.query_log entry of that id is the attempt's. The bound on them only
// lets query_log prune its partitions (event_date), and leaves replica clocks
// an hour of skew: an entry it misses reads as no outcome, which stops a
// re-run instead of retrying.
const QUERY_LOG_MARGIN_MS = 3_600_000
// A poll request can fail transiently (gateway 504/524, network blip) while the
// server-side async query keeps running. Tolerate a bounded number of these so a
// momentary timeout doesn't abort a long-running load; only give up after the budget.
// The same budget limits `unknown` polls after a failed submit (#657).
const MAX_TRANSIENT_POLL_ERRORS = 20
// The lastError of a 'started' record this release writes. The record is
// fenced (OperationState.attemptFenced): its query id names this attempt
// alone, and a retry by this release journals the attempt failed before its
// before-retry SQL runs, so a QueryFinish of the id is the statement's
// outcome (#767). Releases from #701 wrote the same text, under the
// statement's deterministic id for a first attempt, without the fence.
export const ATTEMPT_RECORD_MARKER = 'submitted under its own query id; a retry reads its outcome from system.query_log'
// The lastError of a 'started' record of an attempt that was never sent
// (#767). The record moves to ATTEMPT_RECORD_MARKER, and the server returns
// it, before the statement is submitted, so a re-run that finds an attempt
// still prepared, with nothing of its id on the server, runs it again.
export const PREPARED_RECORD_MARKER = 'prepared under its own query id; not submitted yet'
// query_log is flushed on a timer, every 7.5 s by default. A fenced started
// attempt that no replica runs and that has no query_log entry is checked
// again this many times, QUERY_LOG_FLUSH_RECHECK_INTERVAL_MS apart, before it
// counts as having no outcome, so an attempt that ended right before the
// check is found (#701).
const QUERY_LOG_FLUSH_RECHECKS = 5
// Polls in a row that find the query neither running nor in query_log before
// the run reads every replica once more, then stops without an outcome (#767).
const MAX_UNKNOWN_POLLS = 20
const QUERY_LOG_FLUSH_RECHECK_INTERVAL_MS = 2_000
// An async statement is journaled complete at its QueryFinish (#812). A
// mutation (ALTER ... UPDATE/DELETE, a lightweight DELETE) and a replicated
// ALTER, OPTIMIZE or TRUNCATE finish once queued unless the query waits for
// them on every replica, and ON CLUSTER DDL once queued when its wait is off
// (a timeout of 0) or a mode finishes despite a host that timed out or
// failed. These make the query wait for the work, and fail when it does not
// complete. They go after --setting values; a SETTINGS clause in the
// statement still wins. A SELECT or an INSERT queues no such work and is sent
// without them, so a profile that fixes one of them does not reject a load.
export const ASYNC_COMPLETION_SETTINGS: ClickHouseSettings = {
  mutations_sync: '2',
  alter_sync: '2',
  distributed_ddl_task_timeout: '-1',
  distributed_ddl_output_mode: 'throw',
}

export function asyncSubmitSettings(sql: string, settings: ClickHouseSettings | undefined): ClickHouseSettings | undefined {
  if (rejectionRunsNothing(sql)) return settings
  // A server before ClickHouse 24.4 rejects lightweight_deletes_sync as an
  // unknown setting (its lightweight DELETE always waits), so it is pinned
  // only over a --setting value, which that server would reject anyway.
  const deletes = settings?.lightweight_deletes_sync === undefined ? {} : { lightweight_deletes_sync: '2' }
  return { ...settings, ...ASYNC_COMPLETION_SETTINGS, ...deletes }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface AsyncApplyInput {
  db: ClickHouseExecutor
  journalStore: JournalStore
  sql: string
  migrationName: string
  migrationChecksum: string
  statementIndex: number
  operationType: string
  operationKey: string
  /** `statementFingerprint(sql)`, recorded with every write of this statement (#599). */
  fingerprint: string
  beforeRetry: string | null
  /** --setting values, sent with the submitted statement and its before-retry SQL. */
  settings?: ClickHouseSettings
  queryTracker?: QueryTracker
  /** The run holds no migrate lock because the target database did not exist (#767). */
  locklessBootstrap?: boolean
  log: (line: string) => void
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** The outcome a --retry edit's check read for this statement's record (#767). */
  known?: KnownOutcome
}

export type AsyncApplyResult =
  | { kind: 'completed'; operation: OperationState }
  | { kind: 'skipped'; operation: OperationState }

export async function applyAsyncStatement(input: AsyncApplyInput): Promise<AsyncApplyResult> {
  const {
    db,
    journalStore,
    sql,
    migrationName,
    migrationChecksum,
    statementIndex,
    operationType,
    operationKey,
    fingerprint,
    beforeRetry,
    settings,
    log,
    pollIntervalMs = POLL_INTERVAL_MS,
    sleep = defaultSleep,
    now = Date.now,
  } = input

  const initialMigrationState = acceptChangedChecksum(
    await journalStore.readMigrationState(migrationName),
    migrationName,
    migrationChecksum,
  )
  const priorOpState = initialMigrationState?.operations.find(
    (op) => op.operationIndex === statementIndex,
  )

  // 1. Already completed → skip entirely, when it is this statement that ran (#599)
  if (initialMigrationState !== null && priorOpState?.status === 'completed') {
    assertCompletedStatement(initialMigrationState, {
      migration: migrationName,
      index: statementIndex,
      fingerprint,
      cliVersion: CLI_VERSION,
    })
    log(
      `  ${operationType}: query_id=${priorOpState.queryId} already completed in prior run — skipping`,
    )
    return { kind: 'skipped', operation: priorOpState }
  }

  // 2. Currently in flight on the server → attach.
  const { nowMs: serverNowMs, database } = await readServerState(db)
  // The id of the attempt the journal tracks. Without a record, the id an
  // earlier release submitted a statement's first attempt under, so an
  // attempt of it whose record the journal lost is not run twice.
  const queryId = priorOpState?.queryId || makeDeterministicQueryId(database, resolveJournalTableName(), migrationName, statementIndex)
  debug(
    'migrate:async',
    `${migrationName}#${statementIndex} query_id=${queryId} type=${operationType}`,
  )
  const recorded =
    reusableOutcome(input.known, priorOpState, fingerprint) ??
    (await resolveRecordedAttempt({ db, journalStore, migrationName, op: priorOpState, fingerprint, sql, queryId, operationType, log, sleep }))
  if (recorded.kind === 'running') {
    if (recorded.afterTime === undefined || priorOpState === undefined) {
      throw runningElsewhereError({ operationType, statementIndex, migrationName, queryId, reason: recorded.reason })
    }
    log(
      `  ${operationType}: query_id=${queryId} already running on server — attaching to in-flight query`,
    )
    // The record already names the attempt, and stays as it is.
    return await pollUntilTerminal({
      rejectionRunsNothing: rejectionRunsNothing(sql),
      db,
      journalStore,
      migrationState: initialMigrationState,
      migrationName,
      migrationChecksum,
      statementIndex,
      operationType,
      operationKey,
      fingerprint,
      queryId,
      pollAfterTime: recorded.afterTime,
      log,
      pollIntervalMs,
      sleep,
      now,
      // No submit promise — query was started by a prior chkit run that's
      // now gone. We only observe its eventual completion.
      submitPromise: null,
      startedAt: priorOpState.startedAt,
    })
  }

  // 3. A started attempt that no replica runs any more finished on the server
  // when query_log has its QueryFinish (#672): its run ended before it
  // journaled the outcome. Record it, without compensating or resubmitting.
  if (recorded.kind === 'finished' && initialMigrationState !== null && priorOpState !== undefined) {
    const finishedOp = finishedRecordOf(priorOpState, now)
    await journalStore.writeMigrationState(upsertOperation(initialMigrationState, finishedOp, now))
    log(
      `  ${operationType}: previous attempt of query_id=${queryId} finished on the server — written=${formatRows(recorded.status.writtenRows)} (${formatBytes(recorded.status.writtenBytes)}) in ${Math.round((recorded.status.durationMs ?? 0) / 1000)}s, recording it as completed`,
    )
    return { kind: 'completed', operation: finishedOp }
  }

  // 4. An attempt of this statement's SQL without a server-recorded outcome
  // may have finished (#767), so running it again, even after before-retry
  // SQL, could load its rows twice or remove rows that landed. Stop, writing
  // nothing, so a later run still finds a late query_log entry.
  if (recorded.kind === 'unknown') {
    throw outcomeUnknownError({ operationType, statementIndex, migrationName, queryId, reason: recorded.reason })
  }
  // Two runs without the lock could both submit the statement, each under an
  // id of its own (#767). The run stops before it; the next one takes the lock.
  if (input.locklessBootstrap) {
    throw new MigrateError(
      'async_needs_lock',
      `Async migration step ${operationType} (statement ${statementIndex + 1} of ${migrationName}) was not submitted: this run holds no migrate lock, because the target database did not exist when it started, and two runs without the lock could both submit it. The statements before it are recorded. Run chkit migrate --apply again: the database exists now, so that run takes the migrate lock and submits the statement.`,
    )
  }

  // 5. Prior in-progress row exists but no replica runs the query → RETRY.
  // Run before-retry compensation, then resubmit forward under a new random
  // id. A started attempt that failed on the server is retried the same way,
  // reported with its error.
  // 6. No prior row → FIRST attempt. Skip compensation, submit forward.
  // (priorOpState.status === 'completed' was already returned above.)
  // Every attempt's id is random and its own, recorded before its submit
  // (#701, #767).
  const attemptQueryId = randomUUID()
  // An attempt that was never sent ran nothing: it is submitted again without
  // the before-retry SQL, which runs only after a rejection or an abandon.
  if (recorded.kind === 'unsent') {
    log(`  ${operationType}: previous attempt of query_id=${queryId} was never sent — submitting async (query_id=${attemptQueryId})`)
  } else if (priorOpState !== undefined) {
    const prior =
      recorded.kind === 'failed'
        ? { status: 'failed', lastError: recorded.error }
        : priorOpState
    const errorTail = prior.lastError ? `: ${firstLine(prior.lastError)}` : ''
    log(
      `  ${operationType}: previous attempt of query_id=${queryId} is no longer running (status=${prior.status}${errorTail}) — running before-retry then resubmitting as query_id=${attemptQueryId}`,
    )
    // The checked attempt is journaled failed before it is compensated. Its
    // QueryFinish can still reach query_log after this check (query_log is
    // flushed on a timer), and a run that stops between the compensation and
    // the next 'started' write must not take it for this statement's outcome
    // on its re-run (#672). Without compensation nothing is written until
    // the next 'started' write, which replaces the record.
    if (recorded.kind === 'failed' && initialMigrationState !== null && beforeRetry !== null) {
      await journalStore.writeMigrationState(
        upsertOperation(
          initialMigrationState,
          {
            ...priorOpState,
            status: 'failed',
            finishedAt: isoWithoutZone(new Date(now())),
            lastError: prior.lastError,
          },
          now,
        ),
      )
    }
    if (beforeRetry !== null) {
      log(`  ${operationType}: running before-retry SQL`)
      if (input.queryTracker) {
        await input.queryTracker.command({ migration: migrationName, statementIndex, forwardSQL: sql, beforeRetry }, 'compensation', beforeRetry, settings)
      } else await db.command(beforeRetry, settings)
    }
  } else {
    log(`  ${operationType}: submitting async (query_id=${attemptQueryId})`)
  }

  // The attempt's start on the server clock, which also stamps query_log,
  // read before the attempt is journaled and submitted.
  const startedAt = isoWithoutZone(new Date(serverNowMs))

  // Persist the "started" intent BEFORE submitting, so a crash between here
  // and the next event still leaves chkit able to detect "this op was tried."
  // These writes alone fence a record (#767). The attempt is prepared first,
  // and moves to "may have been sent" only once the server returned the
  // prepared record: a run that stops before that move, or whose read of it
  // lags, leaves an attempt a re-run can tell was never sent.
  const baseState = initialMigrationState ?? freshMigrationState(migrationName, migrationChecksum)
  const attemptRecord = (lastError: string): OperationState => ({
    operationIndex: statementIndex,
    operationKey,
    operationType,
    queryId: attemptQueryId,
    status: 'started',
    startedAt,
    finishedAt: null,
    lastError,
    fingerprint,
    attemptFenced: true,
  })
  const stored = { journalStore, migrationName, statementIndex, operationType, queryId: attemptQueryId, fingerprint, sleep }
  await journalStore.writeMigrationState(upsertOperation(baseState, attemptRecord(PREPARED_RECORD_MARKER), now))
  await assertAttemptStored({ ...stored, lastError: PREPARED_RECORD_MARKER })
  await journalStore.writeMigrationState(upsertOperation(baseState, attemptRecord(ATTEMPT_RECORD_MARKER), now))
  let stateAfterStart: MigrationRowState | null
  try {
    await assertAttemptStored({ ...stored, lastError: ATTEMPT_RECORD_MARKER })
    // Re-read so we have the row's actual stored applied_at (matters for
    // subsequent ReplacingMergeTree writes during polling).
    stateAfterStart = await journalStore.readMigrationState(migrationName)
    await input.queryTracker?.recordAsync({ migration: migrationName, statementIndex, forwardSQL: sql, beforeRetry }, attemptQueryId)
  } catch (error) {
    // Nothing was sent: put the record back to prepared, so a re-run runs
    // it again without an abandon (#767).
    try {
      await journalStore.writeMigrationState(upsertOperation(baseState, attemptRecord(PREPARED_RECORD_MARKER), now))
    } catch (revertError) {
      throw new Error(notRevertedMessage(error, revertError, migrationName), { cause: error })
    }
    throw error
  }
  const pollAfterTime = queryLogLowerBound(serverNowMs)
  // Aborted when the run stops without an outcome, so a request not sent yet
  // never starts after the run released the migrate lock (#767).
  const submitAbort = new AbortController()
  const submitPromise = db.submit(sql, attemptQueryId, asyncSubmitSettings(sql, settings), { signal: submitAbort.signal })

  return await pollUntilTerminal({
    rejectionRunsNothing: rejectionRunsNothing(sql),
    db,
    journalStore,
    migrationState: stateAfterStart,
    migrationName,
    migrationChecksum,
    statementIndex,
    operationType,
    operationKey,
    fingerprint,
    queryId: attemptQueryId,
    pollAfterTime,
    log,
    pollIntervalMs,
    sleep,
    now,
    submitPromise,
    abortSubmit: () => submitAbort.abort(),
    startedAt,
  })
}

interface PollUntilTerminalInput {
  db: ClickHouseExecutor
  journalStore: JournalStore
  migrationState: MigrationRowState | null
  migrationName: string
  migrationChecksum: string
  statementIndex: number
  operationType: string
  operationKey: string
  fingerprint: string
  queryId: string
  /** Only query_log entries of queries started at or after this time count. */
  pollAfterTime: string
  log: (line: string) => void
  pollIntervalMs: number
  sleep: (ms: number) => Promise<void>
  now: () => number
  submitPromise: Promise<unknown> | null
  /** Gives up on the submit request: the run stops without waiting for it. */
  abortSubmit?: () => void
  startedAt: string
  /** Whether an ExceptionBeforeStart of the statement shows it applied nothing (#767). */
  rejectionRunsNothing: boolean
}

async function pollUntilTerminal(input: PollUntilTerminalInput): Promise<AsyncApplyResult> {
  const {
    db,
    journalStore,
    migrationState,
    migrationName,
    migrationChecksum,
    statementIndex,
    operationType,
    operationKey,
    fingerprint,
    queryId,
    pollAfterTime,
    log,
    pollIntervalMs,
    sleep,
    now,
    submitPromise,
    startedAt,
  } = input

  let submitError: Error | null = null
  // Set when the run stops without an outcome: it does not wait for a submit
  // request that may never settle (#767).
  let submitAbandoned = false
  // Every stop without an outcome: the submit is aborted, so a request not
  // sent yet never starts, the run does not wait for one that may never
  // settle, and the fenced started record stays for the next run (#767).
  const abandonSubmit = () => {
    input.abortSubmit?.()
    submitAbandoned = true
  }
  const stopWithoutOutcome = (reason: string): MigrateError => {
    abandonSubmit()
    const submitTail = submitError ? `, and the submit request failed (${describeError(submitError)})` : ''
    return outcomeUnknownError({ operationType, statementIndex, migrationName, queryId, reason: `${reason}${submitTail}` })
  }
  // Capture the submit promise rejection so it doesn't surface as an
  // unhandled rejection. Polling is the source of truth for outcome.
  const submitPromiseGuarded =
    submitPromise === null
      ? null
      : submitPromise.catch((error: unknown) => {
          submitError = error instanceof Error ? error : new Error(String(error))
        })

  const pollStartedAt = now()
  let transientPollErrors = 0
  // Polls in a row that found the query neither running nor in query_log,
  // however polling started (#767).
  let unknownPolls = 0
  try {
    for (;;) {
      await sleep(pollIntervalMs)
      let status: QueryStatus
      try {
        status = await db.queryStatus(queryId, { afterTime: pollAfterTime, includeBeforeStart: true })
        transientPollErrors = 0
      } catch (pollError) {
        // The poll request itself failed (e.g. HTTP 524 gateway timeout). The async
        // query is very likely still running server-side, so don't abort the migration —
        // keep polling up to a bounded budget. A re-run re-attaches by the id the journal records.
        transientPollErrors += 1
        unknownPolls = 0
        const failedElapsed = Math.floor((now() - pollStartedAt) / 1000)
        if (transientPollErrors > MAX_TRANSIENT_POLL_ERRORS) {
          throw stopWithoutOutcome(`polling failed ${transientPollErrors}× in a row (${describeError(pollError)})`)
        }
        log(
          `  ${operationType}: poll request failed (${describeError(pollError)}) — load may still be running, retrying (elapsed ${failedElapsed}s)`,
        )
        continue
      }
      const elapsedSec = Math.floor((now() - pollStartedAt) / 1000)

      // A submit error (a gateway 524, a lost response) says nothing about
      // the outcome: the query may have run (#657, #767). Only the server's
      // record for the id decides it. After the budget, every replica is
      // read once more, through a query_log flush, before the run stops with
      // the attempt still recorded as started.
      unknownPolls = status.status === 'unknown' ? unknownPolls + 1 : 0
      if (unknownPolls >= MAX_UNKNOWN_POLLS) {
        try {
          status = await finalOutcomeCheck({ db, queryId, operationType, pollAfterTime, sleep })
        } catch (error) {
          // The request's own error, not the check's wrapped message.
          const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
          throw stopWithoutOutcome(`the final check of every replica failed (${describeError(cause)})`)
        }
        if (status.status === 'unknown') {
          throw stopWithoutOutcome(`polling found it neither running nor in system.query_log ${unknownPolls}× in a row`)
        }
        unknownPolls = 0
      }

      if (status.status === 'finished') {
        const finishedSec = Math.round((status.durationMs ?? 0) / 1000)
        const finishedOp: OperationState = {
          operationIndex: statementIndex,
          operationKey,
          operationType,
          queryId,
          status: 'completed',
          startedAt,
          finishedAt: isoWithoutZone(new Date(now())),
          lastError: '',
          fingerprint,
        }
        const baseState =
          migrationState ?? freshMigrationState(migrationName, migrationChecksum)
        // Once the outcome's journal write settled, written or rejected, a
        // proxy holding the submit's response does not keep the run, or its
        // migrate lock (#767).
        try {
          await journalStore.writeMigrationState(
            upsertOperation(baseState, finishedOp, now),
          )
        } finally {
          abandonSubmit()
        }
        log(
          `  ${operationType}: finished — written=${formatRows(status.writtenRows)} (${formatBytes(status.writtenBytes)}) in ${finishedSec}s`,
        )
        return { kind: 'completed', operation: finishedOp }
      }

      if (status.status === 'failed') {
        // Only a statement the server rejected before it started (#767) ran
        // nothing: one that failed while it ran can have applied some writes,
        // so its fenced started record stays for the operator to reconcile.
        if (status.beforeStart !== true || !input.rejectionRunsNothing) {
          // A proxy may hold the submit's response: the run stops as every
          // other stop without an outcome does, without waiting for it.
          abandonSubmit()
          throw failedWhileRunningError({ operationType, statementIndex, migrationName, queryId, error: status.error ?? '<unknown>', beforeStart: status.beforeStart === true })
        }
        const failedOp: OperationState = {
          operationIndex: statementIndex,
          operationKey,
          operationType,
          queryId,
          status: 'failed',
          startedAt,
          finishedAt: isoWithoutZone(new Date(now())),
          lastError: status.error ?? '<unknown>',
          fingerprint,
          // A rejection the server recorded for this id: a re-run may retry it.
          attemptFenced: true,
        }
        const baseState =
          migrationState ?? freshMigrationState(migrationName, migrationChecksum)
        try {
          await journalStore.writeMigrationState(
            upsertOperation(baseState, failedOp, now),
          )
        } finally {
          abandonSubmit()
        }
        throw new Error(
          `Async migration step ${operationType} failed (query_id ${queryId}): ${status.error ?? '<unknown>'}`,
        )
      }

      if (status.status === 'running') {
        log(progressLine(operationType, status, elapsedSec))
        continue
      }

      // status === 'unknown'
      log(
        `  ${operationType}: status unknown — still polling (elapsed ${elapsedSec}s)`,
      )
    }
  } finally {
    if (submitPromiseGuarded && !submitAbandoned) {
      await submitPromiseGuarded.catch(() => {})
    }
  }
}

// applyMigration re-keys an edited in-progress state before any statement
// runs; this is defense in depth. A state whose checksum still differs is
// accepted only when no statement is recorded as completed or started (#233),
// and the writes that follow carry the new checksum.
function acceptChangedChecksum(
  state: MigrationRowState | null,
  migrationName: string,
  migrationChecksum: string,
): MigrationRowState | null {
  if (state === null || state.migrationCompleted || state.checksum === migrationChecksum) return state
  if (hasStatementProgress(state)) {
    throw inProgressChecksumMismatchError({
      migration: migrationName,
      journalChecksum: state.checksum,
      fileChecksum: migrationChecksum,
      async: true,
    })
  }
  return { ...state, checksum: migrationChecksum }
}

// The retry path that follows a 'not running' answer runs before-retry SQL
// (e.g. a TRUNCATE) and resubmits, so the answer must cover every replica: the
// attempt runs on the replica that received it (#246). A replica that cannot be
// read fails the check instead of being skipped, and a failed check stops here,
// before anything is compensated or resubmitted. Without a started attempt
// only system.processes is read: the check needs no outcome, and a fresh server
// has no system.query_log until its first log flush. With one, the check also
// reads the attempt's outcome from system.query_log (#672), and fails like an
// unreadable replica when query_log cannot be read.
async function checkInFlight(
  db: ClickHouseExecutor,
  queryId: string,
  operationType: string,
  attemptLowerBound: string | undefined,
): Promise<QueryStatus> {
  try {
    return await db.queryStatus(
      queryId,
      attemptLowerBound === undefined
        ? { everyReplica: true, runningOnly: true }
        : { everyReplica: true, afterTime: attemptLowerBound, includeBeforeStart: true },
    )
  } catch (error) {
    if (attemptLowerBound !== undefined && QUERY_LOG_ACCESS_DENIED.test(describeError(error))) {
      throw new Error(
        `Async migration step ${operationType} (query_id ${queryId}): the ClickHouse user cannot read system.query_log, which tells whether the previous attempt finished (${describeError(error)}). Nothing was resubmitted and no before-retry SQL ran. Grant SELECT ON system.query_log to the user; until then a re-run of \`chkit migrate --apply\` stops here too.`,
        { cause: error },
      )
    }
    throw new Error(
      `Async migration step ${operationType} (query_id ${queryId}): could not check whether a previous attempt is still running (${describeError(error)}). Nothing was resubmitted and no before-retry SQL ran — re-run \`chkit migrate --apply\`.`,
      { cause: error },
    )
  }
}

// ClickHouse's ACCESS_DENIED (497) for system.query_log, as the native client
// and the ObsessionDB console relay it.
const QUERY_LOG_ACCESS_DENIED = /(ACCESS_DENIED|Code: 497|Not enough privileges)[\s\S]*query_log|query_log[\s\S]*(ACCESS_DENIED|Code: 497)/

/** What the server shows of the attempt a statement's record names (#767). */
export type RecordedAttempt =
  /** Running. afterTime is set when the record is fenced, so its id names that attempt alone. */
  | { kind: 'running'; afterTime: string | undefined; reason: string }
  | { kind: 'finished'; status: QueryStatus }
  /** The server's failure of the fenced id. */
  | { kind: 'failed'; error: string }
  /** An attempt of this statement without a server-recorded outcome. */
  | { kind: 'unknown'; reason: string }
  /** A prepared attempt a fresh journal read shows was never sent: it ran nothing. */
  | { kind: 'unsent' }
  /** No attempt to resolve: none, a rejection the server recorded, or an abandon. */
  | { kind: 'ended' }

const NO_ENTRY_REASON =
  'system.query_log has no entry for its query id (query logging is off for the user, query_log is flushed later than chkit waits, or the run stopped before it submitted the statement)'
const UNFENCED_REASON =
  "an earlier chkit release recorded it, or the journal could not store the record's fence (it has no operation_fingerprints column), so its query id may name earlier attempts too"
const UNVERIFIED_FAILURE_REASON =
  'the journal records it as failed, but not from a rejection the server recorded before it started (an earlier chkit release recorded it, it failed while it ran, or a run lost its submit response), so some of its writes may have been applied'
const WHILE_PROCESSING_REASON =
  'the server reports it failed while it ran (ExceptionWhileProcessing), and a statement that fails while it runs can leave some of its writes applied (parts of an INSERT ... SELECT, a DDL that ran on some hosts)'
const BEFORE_START_EFFECTS_REASON =
  "the server reports it was rejected before it started (ExceptionBeforeStart), but a statement other than a SELECT or an INSERT can apply effects before that (an ALTER's mutation keeps running in system.mutations, or applied to some partitions before one failed)"
const STALE_PREPARED_REASON =
  'the journal records it as prepared, not sent, but chkit cannot read every copy of the journal to rule out a newer record of it (one that may have been sent)'
const OTHER_SQL_REASON =
  "it ran other SQL than the statement now has (an edit, or a plugin's onBeforeApply rewrite)"
const NOT_RECORDED_RUNNING =
  'but its query id was not recorded by this chkit release for that attempt alone, so chkit cannot tell its outcome from system.query_log once it ends'
const FAILED_RUNNING =
  'but the journal records that attempt as failed, so chkit does not attach to it, and the next chkit migrate --apply runs the statement again (after its before-retry SQL, when it has one)'
// The lastError prefix of a record --abandon reset: the operator's decision
// to run the statement again (abandon.ts).
const ABANDONED_PREFIX = 'abandoned via chkit migrate --abandon (was '

/** An outcome resolveRecordedAttempt read earlier in this run (#767). */
export interface KnownOutcome {
  op: OperationState
  recorded: RecordedAttempt
}

/**
 * The outcome read earlier for `op`, when it stands for a new lookup (#767):
 * only one query_log settled (an unsent, failed or finished attempt, which
 * stays so under the lock), for this very record and the SQL the statement
 * still has. An attempt that ended without one is checked in system.processes
 * again right before the statement runs.
 */
export function reusableOutcome(known: KnownOutcome | undefined, op: OperationState | undefined, fingerprint: string): RecordedAttempt | undefined {
  if (known === undefined || op === undefined || known.recorded.kind === 'ended') return undefined
  const same =
    known.op.queryId === op.queryId &&
    known.op.status === op.status &&
    known.op.lastError === op.lastError &&
    known.op.fingerprint === fingerprint
  return same ? known.recorded : undefined
}

/**
 * Reads the outcome of the attempt `op` records, on every replica (#246).
 * Only a fenced record's id names its attempt alone, so only its query_log
 * entries count (#767): a QueryFinish completes it, a server failure lets it
 * be retried, and no entry, after the query_log flush rechecks (#701), is
 * unknown. A started record without the fence, or a failed one that no server
 * failure or abandon recorded, may have finished, so it is unknown once it no
 * longer runs. A failed attempt of other SQL (kept by --abandon and an edit)
 * did not run this statement.
 */
export async function resolveRecordedAttempt(input: {
  db: ClickHouseExecutor
  journalStore: JournalStore
  migrationName: string
  op: OperationState | undefined
  fingerprint: string
  /** The statement's SQL, when known: only it can show a rejection ran nothing (#767). */
  sql: string | undefined
  queryId: string
  operationType: string
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
}): Promise<RecordedAttempt> {
  const { db, op, fingerprint, queryId, operationType, sleep } = input
  // The record is read as it was recorded, whatever SQL the statement has
  // now (an edit, a plugin's onBeforeApply rewrite).
  const recorded = op !== undefined && op.queryId !== ''
  const otherSql = op !== undefined && op.fingerprint !== '' && op.fingerprint !== fingerprint
  // Only this release writes a prepared record, and only under an id of its
  // own, so its id names that attempt alone too.
  const prepared = recorded && op.status === 'started' && op.lastError === PREPARED_RECORD_MARKER
  const fenced = recorded && op.status === 'started' && op.attemptFenced === true && !prepared
  const afterTime = fenced || prepared ? queryLogLowerBound(journalTimeMs(op.startedAt)) : undefined
  let status = await checkInFlight(db, queryId, operationType, afterTime)
  if (afterTime !== undefined && status.status === 'unknown') {
    input.log(
      `  ${operationType}: previous attempt of query_id=${queryId} is not running and has no outcome in system.query_log yet — checking again while query_log is flushed`,
    )
    status = await recheckThroughFlush(db, queryId, operationType, afterTime, sleep)
  }
  if (status.status === 'running') {
    if (otherSql) {
      // The running attempt is the SQL its record names (#599): an attempt
      // of other SQL, kept by --abandon and an edit, must not finish as this one.
      throw new Error(
        `Async migration step ${operationType} (query_id ${queryId}): an earlier attempt with different SQL is still running on the server. ${stopRunningAdvice(queryId)}`,
      )
    }
    return { kind: 'running', afterTime, reason: op?.status === 'failed' ? FAILED_RUNNING : NOT_RECORDED_RUNNING }
  }
  if (op !== undefined && afterTime !== undefined) {
    if (status.status === 'finished') return otherSql ? { kind: 'unknown', reason: OTHER_SQL_REASON } : { kind: 'finished', status }
    if (status.status === 'failed') {
      if (status.beforeStart !== true) return { kind: 'unknown', reason: WHILE_PROCESSING_REASON }
      return input.sql !== undefined && rejectionRunsNothing(input.sql)
        ? { kind: 'failed', error: status.error ?? '<unknown>' }
        : { kind: 'unknown', reason: BEFORE_START_EFFECTS_REASON }
    }
    if (!prepared) return { kind: 'unknown', reason: NO_ENTRY_REASON }
    // A prepared attempt with nothing of its id on the server was never sent,
    // when no copy of the journal holds a newer record of it.
    return (await preparedIsCurrent(input.journalStore, input.migrationName, op))
      ? { kind: 'unsent' }
      : { kind: 'unknown', reason: STALE_PREPARED_REASON }
  }
  if (!recorded || op.status === 'completed') return { kind: 'ended' }
  if (op.status === 'started') return { kind: 'unknown', reason: UNFENCED_REASON }
  return isRecordedFailure(op) ? { kind: 'ended' } : { kind: 'unknown', reason: UNVERIFIED_FAILURE_REASON }
}

/**
 * Whether a journal read that covers every copy of the journal still holds
 * `op` as prepared (#767): a read of one replica behind a load balancer can
 * return a prepared row that another replica has superseded with a record of
 * an attempt that may have been sent. A read that fails counts as no.
 */
async function preparedIsCurrent(journalStore: JournalStore, migrationName: string, op: OperationState): Promise<boolean> {
  try {
    const read = await journalStore.readOperationOnEveryCopy(migrationName, op.operationIndex)
    if (!read.covered) return false
    const current = read.op
    return current?.status === 'started' && current.queryId === op.queryId && current.lastError === PREPARED_RECORD_MARKER
  } catch {
    return false
  }
}

/** Whether a failed record was a rejection the server recorded before the statement started, or an abandon (#767). */
function isRecordedFailure(op: OperationState): boolean {
  return op.attemptFenced === true || op.lastError.startsWith(ABANDONED_PREFIX)
}

/** The record of an attempt that finished on the server. */
export function finishedRecordOf(op: OperationState, now: () => number): OperationState {
  return { ...op, status: 'completed', finishedAt: isoWithoutZone(new Date(now())), lastError: '' }
}

// After the unknown-poll budget: every replica, then the query_log flush rechecks.
async function finalOutcomeCheck(input: {
  db: ClickHouseExecutor
  queryId: string
  operationType: string
  pollAfterTime: string
  sleep: (ms: number) => Promise<void>
}): Promise<QueryStatus> {
  const status = await checkInFlight(input.db, input.queryId, input.operationType, input.pollAfterTime)
  if (status.status !== 'unknown') return status
  return await recheckThroughFlush(input.db, input.queryId, input.operationType, input.pollAfterTime, input.sleep)
}

function failedWhileRunningError(input: {
  operationType: string
  statementIndex: number
  migrationName: string
  queryId: string
  error: string
  /** The server recorded it before the statement started, for one that can apply effects before that. */
  beforeStart: boolean
}): MigrateError {
  const what = input.beforeStart
    ? `was rejected before it started (ExceptionBeforeStart): ${input.error}. A statement other than a SELECT or an INSERT can apply effects before that (an ALTER's mutation keeps running in system.mutations, or applied to some partitions before one failed)`
    : `failed while it ran: ${input.error}. A statement that fails while it runs can leave some of its writes applied (parts of an INSERT ... SELECT, a DDL that ran on some hosts)`
  return new MigrateError(
    'async_outcome_unknown',
    `Async migration step ${input.operationType} (statement ${input.statementIndex + 1} of ${input.migrationName}, query_id ${input.queryId}) ${what}, so chkit does not run it, or its before-retry SQL, again. Check in ClickHouse what the statement applied. Then reconcile every statement of ${input.migrationName} that already ran, since an abandon runs the migration again from statement 1, run chkit migrate --apply --abandon ${input.migrationName}, and apply again.`,
  )
}

async function recheckThroughFlush(
  db: ClickHouseExecutor,
  queryId: string,
  operationType: string,
  afterTime: string,
  sleep: (ms: number) => Promise<void>,
): Promise<QueryStatus> {
  let status: QueryStatus = { status: 'unknown' }
  for (let recheck = 0; recheck < QUERY_LOG_FLUSH_RECHECKS && status.status === 'unknown'; recheck += 1) {
    await sleep(QUERY_LOG_FLUSH_RECHECK_INTERVAL_MS)
    status = await checkInFlight(db, queryId, operationType, afterTime)
  }
  return status
}

// How many times, and how far apart, a started record's read-back is tried
// before the attempt is not submitted: a read can land on a replica that has
// not got the write yet.
const STORED_ATTEMPT_READS = 5
const STORED_ATTEMPT_READ_INTERVAL_MS = 1_000

/**
 * Refuses to submit an attempt until the journal's server returns its
 * started record with its id, fingerprint and fence (#767): only the journal
 * knows the random id, and only the fence stops an earlier release from
 * resuming the record without recording it failed first.
 */
async function assertAttemptStored(input: {
  journalStore: JournalStore
  migrationName: string
  statementIndex: number
  operationType: string
  queryId: string
  fingerprint: string
  lastError: string
  sleep: (ms: number) => Promise<void>
}): Promise<void> {
  let stored: OperationState | undefined
  let readError: unknown
  for (let read = 0; read < STORED_ATTEMPT_READS; read += 1) {
    if (read > 0) await input.sleep(STORED_ATTEMPT_READ_INTERVAL_MS)
    try {
      stored = await input.journalStore.readStoredOperation(input.migrationName, input.statementIndex)
      readError = undefined
    } catch (error) {
      // A read that fails (a gateway error) is tried again like a lagging one.
      readError = error
      continue
    }
    if (
      stored?.status === 'started' &&
      stored.queryId === input.queryId &&
      stored.fingerprint === input.fingerprint &&
      stored.lastError === input.lastError &&
      stored.attemptFenced === true
    ) return
  }
  const prefix = `Async migration step ${input.operationType} (query_id ${input.queryId})`
  if (stored?.queryId === input.queryId && stored.attemptFenced !== true) {
    throw new MigrateError(
      'async_attempt_unfenced',
      `${prefix}: the journal stored the attempt without its fence, because it has no operation_fingerprints column, so it was not submitted and stays prepared. An earlier chkit release could resume an attempt stored that way and run its before-retry SQL without recording it, which loses rows. Add the column with a user that can alter the journal (ALTER TABLE <database>.${resolveJournalTableName()} ADD COLUMN IF NOT EXISTS operation_fingerprints Array(String) DEFAULT [] ON every replica, or any chkit migrate --apply by that user), then run chkit migrate --apply again: it submits the statement, and the statements that completed stay completed.`,
    )
  }
  const tail = readError === undefined ? '' : ` (${describeError(readError)})`
  throw new Error(
    `${prefix}: the journal did not return the attempt's record${tail}, so it was not submitted. Re-run \`chkit migrate --apply\`: an attempt that was never sent runs again.`,
    readError === undefined ? undefined : { cause: readError },
  )
}

/** A stop before the submit whose record could not go back to prepared (#767). */
function notRevertedMessage(error: unknown, revertError: unknown, migrationName: string): string {
  return `${describeError(error)}. The attempt was never sent, but chkit could not put its record back to prepared (${describeError(revertError)}), so the next chkit migrate --apply stops with async_outcome_unknown: run chkit migrate --apply --abandon ${migrationName} to run it again.`
}

/**
 * What to do about an attempt still running (#767): a killed statement can
 * still have applied effects, so the operator reconciles before applying.
 */
export function stopRunningAdvice(queryId: string): string {
  return `Wait for it to finish, or stop it with KILL QUERY WHERE query_id = '${queryId}'. A stopped statement can still have applied effects (an ALTER's mutation keeps running, see system.mutations), so check what it applied and reconcile before you run chkit migrate --apply again: until its outcome is known, migrate stops with async_outcome_unknown.`
}

function runningElsewhereError(input: {
  operationType: string
  statementIndex: number
  migrationName: string
  queryId: string
  reason: string
}): MigrateError {
  return new MigrateError(
    'async_outcome_unknown',
    `Async migration step ${input.operationType} (statement ${input.statementIndex + 1} of ${input.migrationName}, query_id ${input.queryId}) is still running on the server, ${input.reason}. Nothing was submitted and no before-retry SQL ran. ${stopRunningAdvice(input.queryId)}`,
  )
}

export function outcomeUnknownError(input: {
  operationType: string
  statementIndex: number
  migrationName: string
  queryId: string
  reason: string
}): MigrateError {
  return new MigrateError(
    'async_outcome_unknown',
    `Async migration step ${input.operationType} (statement ${input.statementIndex + 1} of ${input.migrationName}, query_id ${input.queryId}): the journal records an attempt of it and no replica runs it, but chkit cannot tell whether it finished: ${input.reason}. Nothing was submitted and no before-retry SQL ran. Check in ClickHouse whether the statement's rows reached its target. Then reconcile every statement of ${input.migrationName} that already ran, since an abandon runs the migration again from statement 1, run chkit migrate --apply --abandon ${input.migrationName}, and apply again.`,
  )
}

// The journal returns DateTime64 without a zone, all of it UTC.
function journalTimeMs(value: string): number {
  const iso = value.trim().replace(' ', 'T')
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
}

function queryLogLowerBound(startedMs: number): string {
  return new Date(startedMs - QUERY_LOG_MARGIN_MS).toISOString()
}

async function readServerState(db: ClickHouseExecutor): Promise<{ nowMs: number; database: string }> {
  const [row] = await db.query<{ now_ms: number | string; database: string }>(
    'SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms, currentDatabase() AS database',
  )
  const nowMs = Number(row?.now_ms)
  if (!Number.isFinite(nowMs) || typeof row?.database !== 'string' || row.database === '') {
    throw new Error('Could not read the ClickHouse server time and database for an async statement.')
  }
  return { nowMs, database: row.database }
}

export function upsertOperation(
  state: MigrationRowState,
  op: OperationState,
  now: () => number,
): MigrationRowState {
  const others = state.operations.filter(
    (existing) => existing.operationIndex !== op.operationIndex,
  )
  const operations = [...others, op].sort(
    (a, b) => a.operationIndex - b.operationIndex,
  )
  return {
    ...state,
    appliedAt: isoWithoutZone(new Date(now())),
    operations,
    // migrationCompleted stays false until applyMigration explicitly flips it
    migrationCompleted: state.migrationCompleted,
  }
}

export function freshMigrationState(
  migrationName: string,
  checksum: string,
): MigrationRowState {
  return {
    name: migrationName,
    appliedAt: '1970-01-01 00:00:00.000',
    checksum,
    chkitVersion: '',
    migrationCompleted: false,
    operations: [],
  }
}

/**
 * The id earlier releases submitted an async statement's first attempt
 * under. It names the database and journal table too, so runs of one
 * migration file against other databases, or by other projects in the same
 * database, never share it (#463). This release submits every attempt under a
 * random id recorded before its submit (#767), and only checks this one in
 * system.processes when the journal has no record of the statement.
 */
export function makeDeterministicQueryId(
  database: string,
  journalTable: string,
  migrationName: string,
  statementIndex: number,
): string {
  const hex = createHash('sha256')
    .update(`chkit:${database}:${journalTable}:${migrationName}:${statementIndex}`)
    .digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

function progressLine(
  operationLabel: string,
  status: QueryStatus,
  elapsedSec: number,
): string {
  const rows = formatRows(status.writtenRows)
  const bytes = formatBytes(status.writtenBytes)
  return `  ${operationLabel}: written=${rows} (${bytes}), elapsed ${elapsedSec}s`
}

function formatRows(value: number | undefined): string {
  if (value === undefined || value === 0) return '0 rows'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M rows`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K rows`
  return `${value} rows`
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || value === 0) return '0 B'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${value} B`
}

export function isoWithoutZone(date: Date): string {
  return date.toISOString().replace('Z', '')
}

function firstLine(value: string): string {
  return value.split('\n')[0] ?? value
}
