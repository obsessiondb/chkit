import { createHash } from 'node:crypto'
import { setTimeout as defaultSleep } from 'node:timers/promises'

import type { ClickHouseExecutor, ClickHouseSettings, QueryStatus } from '@chkit/clickhouse'

import { debug } from '../../runtime/debug.js'
import {
  type JournalStore,
  type MigrationRowState,
  type OperationState,
  resolveJournalTableName,
} from '../../runtime/journal-store.js'
import { CLI_VERSION } from '../../runtime/version.js'
import { inProgressChecksumMismatchError } from './errors.js'
import { assertCompletedStatement, hasStatementProgress } from './recovery.js'

const POLL_INTERVAL_MS = 5_000
// The query id is deterministic, so system.query_log can still hold entries of
// an earlier attempt of the same statement (one that was abandoned, or retried
// after an edit). A new submission only trusts entries of queries that started
// after it, and an attach only those of queries that started no earlier than
// the attempt it attaches to: query_log is flushed on a timer, so right after
// that attempt ends the newest flushed entry can still be an earlier
// attempt's. The bound comes from the server clock, which also stamps
// query_log, minus a margin for clock skew between replicas. queryStatus
// compares whole seconds, so the margin stays more than a second below
// POLL_INTERVAL_MS: an earlier attempt that a previous run polled to its end
// started at least one poll interval ago and always falls before the bound.
const QUERY_LOG_SKEW_MARGIN_MS = 2_000
// queryStatus's own default: every query_log entry for the id counts.
const UNBOUNDED_POLL_AFTER_TIME = '1970-01-01 00:00:00'
// A poll request can fail transiently (gateway 504/524, network blip) while the
// server-side async query keeps running. Tolerate a bounded number of these so a
// momentary timeout doesn't abort a long-running load; only give up after the budget.
// The same budget limits `unknown` polls after a failed submit (#657).
const MAX_TRANSIENT_POLL_ERRORS = 20
// The lastError of a started attempt that no replica runs and that has no
// outcome in system.query_log, journaled before it is retried (#672).
const NO_OUTCOME_ERROR = 'no longer running and no outcome in system.query_log; retried'

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
  log: (line: string) => void
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
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

  // 2. Currently in flight on the server → attach. The server clock is read
  // before the check, so the start derived from it and the attempt's elapsed
  // time never falls after the start that query_log records for the attempt.
  const { nowMs: serverNowMs, database } = await readServerState(db)
  // A statement the journal already tracks keeps the id it was submitted
  // with, which an older chkit derived from the migration alone (#463): a
  // new id would miss that attempt while it still runs.
  const queryId =
    priorOpState?.queryId ||
    makeDeterministicQueryId(database, resolveJournalTableName(), migrationName, statementIndex)
  debug(
    'migrate:async',
    `${migrationName}#${statementIndex} query_id=${queryId} type=${operationType}`,
  )
  const attemptLowerBound = startedAttemptLowerBound(priorOpState, fingerprint)
  const inFlight = await checkInFlight(db, queryId, operationType, attemptLowerBound)
  // Only the outcome read of a started attempt can tell that it ended.
  const attemptOutcome = attemptLowerBound === undefined ? 'unknown' : inFlight.status
  if (inFlight.status === 'running') {
    // The running attempt is the SQL its record names (#599): an attempt of
    // other SQL, kept by --abandon and an edit, must not finish as this one.
    const attemptFingerprint = priorOpState?.fingerprint ?? ''
    if (attemptFingerprint !== '' && attemptFingerprint !== fingerprint) {
      throw new Error(
        `Async migration step ${operationType} (query_id ${queryId}): an earlier attempt with different SQL is still running on the server. Wait for it to finish or run KILL QUERY WHERE query_id = '${queryId}', then re-run chkit migrate --apply.`,
      )
    }
    log(
      `  ${operationType}: query_id=${queryId} already running on server — attaching to in-flight query`,
    )
    return await pollUntilTerminal({
      db,
      journalStore,
      migrationState: initialMigrationState,
      migrationName,
      migrationChecksum,
      statementIndex,
      operationType,
      operationKey,
      // What is known about the attempt that runs: a record without a
      // fingerprint stays without one.
      fingerprint: attemptFingerprint,
      queryId,
      pollAfterTime: attachLowerBound(serverNowMs, inFlight.elapsedMs),
      log,
      pollIntervalMs,
      sleep,
      now,
      // No submit promise — query was started by a prior chkit run that's
      // now gone. We only observe its eventual completion.
      submitPromise: null,
      startedAt: priorOpState?.startedAt ?? isoWithoutZone(new Date(now())),
    })
  }

  // 3. A started attempt that no replica runs any more finished on the server
  // when query_log has its QueryFinish (#672): its run ended before it
  // journaled the outcome. Record it, without compensating or resubmitting.
  if (attemptOutcome === 'finished' && initialMigrationState !== null && priorOpState !== undefined) {
    const finishedOp: OperationState = {
      ...priorOpState,
      queryId,
      status: 'completed',
      finishedAt: isoWithoutZone(new Date(now())),
      lastError: '',
    }
    await journalStore.writeMigrationState(upsertOperation(initialMigrationState, finishedOp, now))
    log(
      `  ${operationType}: previous attempt of query_id=${queryId} finished on the server — written=${formatRows(inFlight.writtenRows)} (${formatBytes(inFlight.writtenBytes)}) in ${Math.round((inFlight.durationMs ?? 0) / 1000)}s, recording it as completed`,
    )
    return { kind: 'completed', operation: finishedOp }
  }

  // 4. Prior in-progress row exists but no replica runs the query → RETRY.
  // Run before-retry compensation, then resubmit forward. A started attempt
  // that failed on the server is retried the same way, reported with its error.
  // 5. No prior row → FIRST attempt. Skip compensation, submit forward.
  // (priorOpState.status === 'completed' was already returned above.)
  if (priorOpState !== undefined) {
    const prior =
      attemptOutcome === 'failed'
        ? { status: 'failed', lastError: inFlight.error ?? '<unknown>' }
        : priorOpState
    const errorTail = prior.lastError ? `: ${firstLine(prior.lastError)}` : ''
    log(
      `  ${operationType}: previous attempt of query_id=${queryId} is no longer running (status=${prior.status}${errorTail}) — running before-retry then resubmitting`,
    )
    // The checked attempt is journaled failed before anything is compensated.
    // Its QueryFinish can still reach query_log after this check (query_log
    // is flushed on a timer), and a run that stops between the compensation
    // and the next 'started' write must not take it for this statement's
    // outcome on its re-run (#672).
    if (attemptLowerBound !== undefined && initialMigrationState !== null) {
      await journalStore.writeMigrationState(
        upsertOperation(
          initialMigrationState,
          {
            ...priorOpState,
            queryId,
            status: 'failed',
            finishedAt: isoWithoutZone(new Date(now())),
            lastError: attemptOutcome === 'failed' ? prior.lastError : NO_OUTCOME_ERROR,
          },
          now,
        ),
      )
    }
    if (beforeRetry !== null) {
      log(`  ${operationType}: running before-retry SQL`)
      await db.command(beforeRetry, settings)
    }
  } else {
    log(`  ${operationType}: submitting async (query_id=${queryId})`)
  }

  // The attempt's start on the server clock, which also stamps query_log, read
  // before the attempt is journaled and submitted. This run's polls and a
  // re-run's outcome check (#672) bound the attempt's query_log entry by it.
  const { nowMs: submissionNowMs } = await readServerState(db)
  const startedAt = isoWithoutZone(new Date(submissionNowMs))

  // Persist the "started" intent BEFORE submitting, so a crash between here
  // and the next event still leaves chkit able to detect "this op was tried."
  await journalStore.writeMigrationState(
    upsertOperation(
      initialMigrationState ?? freshMigrationState(migrationName, migrationChecksum),
      {
        operationIndex: statementIndex,
        operationKey,
        operationType,
        queryId,
        status: 'started',
        startedAt,
        finishedAt: null,
        lastError: '',
        fingerprint,
      },
      now,
    ),
  )

  // Re-read so we have the row's actual stored applied_at (matters for
  // subsequent ReplacingMergeTree writes during polling).
  const stateAfterStart = await journalStore.readMigrationState(migrationName)

  const pollAfterTime = queryLogLowerBound(submissionNowMs, 0)
  const submitPromise = db.submit(sql, queryId, settings)

  return await pollUntilTerminal({
    db,
    journalStore,
    migrationState: stateAfterStart,
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
  startedAt: string
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
  // Once a poll found the query running, the server has it, so a failed
  // submit request (a gateway 524, a timeout) says nothing about its outcome (#657).
  let seenRunning = false
  let unknownPollsAfterSubmitError = 0
  try {
    for (;;) {
      await sleep(pollIntervalMs)
      let status: QueryStatus
      try {
        status = await db.queryStatus(queryId, { afterTime: pollAfterTime })
        transientPollErrors = 0
      } catch (pollError) {
        // The poll request itself failed (e.g. HTTP 524 gateway timeout). The async
        // query is very likely still running server-side, so don't abort the migration —
        // keep polling up to a bounded budget. A re-run re-attaches via the deterministic id.
        transientPollErrors += 1
        const failedElapsed = Math.floor((now() - pollStartedAt) / 1000)
        if (transientPollErrors > MAX_TRANSIENT_POLL_ERRORS) {
          // A submit error is the only trace of e.g. a rejected statement (#561).
          // The finally block waits for the submit anyway; wait here so its error
          // makes it into the message.
          if (submitPromiseGuarded) await submitPromiseGuarded
          const submitTail = submitError
            ? ` The submit request failed too (${describeError(submitError)}).`
            : ''
          throw new Error(
            `Async migration step ${operationType} (query_id ${queryId}): polling failed ${transientPollErrors}× (${describeError(pollError)}).${submitTail} The load may still be running server-side — re-run \`chkit migrate --apply\` to re-attach.`,
          )
        }
        log(
          `  ${operationType}: poll request failed (${describeError(pollError)}) — load may still be running, retrying (elapsed ${failedElapsed}s)`,
        )
        continue
      }
      const elapsedSec = Math.floor((now() - pollStartedAt) / 1000)

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
        await journalStore.writeMigrationState(
          upsertOperation(baseState, finishedOp, now),
        )
        log(
          `  ${operationType}: finished — written=${formatRows(status.writtenRows)} (${formatBytes(status.writtenBytes)}) in ${finishedSec}s`,
        )
        return { kind: 'completed', operation: finishedOp }
      }

      if (status.status === 'failed') {
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
        }
        const baseState =
          migrationState ?? freshMigrationState(migrationName, migrationChecksum)
        await journalStore.writeMigrationState(
          upsertOperation(baseState, failedOp, now),
        )
        throw new Error(
          `Async migration step ${operationType} failed (query_id ${queryId}): ${status.error ?? '<unknown>'}`,
        )
      }

      if (status.status === 'running') {
        seenRunning = true
        unknownPollsAfterSubmitError = 0
        log(progressLine(operationType, status, elapsedSec))
        continue
      }

      // status === 'unknown'
      // If submit has already rejected and no poll found the query running, it
      // never made it server-side (e.g. SQL parse error) — record the attempt as
      // failed and surface that error. Known gap: a load that ends before the
      // first poll, with a transport error on its submit, also lands here (#657).
      // Otherwise it's a transient gap (just-submitted, or just-finished before
      // query_log has it); loop.
      if (submitError && !seenRunning) {
        const failedOp: OperationState = {
          operationIndex: statementIndex,
          operationKey,
          operationType,
          queryId,
          status: 'failed',
          startedAt,
          finishedAt: isoWithoutZone(new Date(now())),
          lastError: describeError(submitError),
          fingerprint,
        }
        const baseState =
          migrationState ?? freshMigrationState(migrationName, migrationChecksum)
        await journalStore.writeMigrationState(upsertOperation(baseState, failedOp, now))
        throw submitError
      }
      if (submitError) {
        unknownPollsAfterSubmitError += 1
        if (unknownPollsAfterSubmitError > MAX_TRANSIENT_POLL_ERRORS) {
          throw new Error(
            `Async migration step ${operationType} (query_id ${queryId}): the submit request failed (${describeError(submitError)}) and polling found no outcome ${unknownPollsAfterSubmitError}×. A re-run of \`chkit migrate --apply\` attaches to the query if it still runs and runs the statement again if not.`,
          )
        }
      }
      log(
        `  ${operationType}: status unknown — still polling (elapsed ${elapsedSec}s)`,
      )
    }
  } finally {
    if (submitPromiseGuarded) {
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
        : { everyReplica: true, afterTime: attemptLowerBound },
    )
  } catch (error) {
    throw new Error(
      `Async migration step ${operationType} (query_id ${queryId}): could not check whether a previous attempt is still running (${describeError(error)}). Nothing was resubmitted and no before-retry SQL ran — re-run \`chkit migrate --apply\`.`,
      { cause: error },
    )
  }
}

// Only a started attempt of this statement's SQL can have finished without
// its run journaling the outcome: a failed attempt has its outcome, a record
// without a query id never ran under one, and a finished attempt of other SQL
// (kept by --abandon and an edit) did not run this statement. Its query_log
// entry is bounded by the start the attempt recorded, on the server clock, so
// an earlier attempt's entry does not count.
function startedAttemptLowerBound(op: OperationState | undefined, fingerprint: string): string | undefined {
  if (op?.status !== 'started' || op.queryId === '') return undefined
  if (op.fingerprint !== '' && op.fingerprint !== fingerprint) return undefined
  // The journal returns DateTime64 without a zone, all of it UTC.
  const iso = op.startedAt.trim().replace(' ', 'T')
  return queryLogLowerBound(Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`), 0)
}

// The attached attempt had run for elapsedMs when the in-flight check, which
// followed the serverNowMs reading, saw it. Without an elapsed time its start
// is unknown, and only the unbounded lookup still finds its entry.
function attachLowerBound(serverNowMs: number, elapsedMs: number | undefined): string {
  return elapsedMs === undefined ? UNBOUNDED_POLL_AFTER_TIME : queryLogLowerBound(serverNowMs, elapsedMs)
}

function queryLogLowerBound(serverNowMs: number, startedMsAgo: number): string {
  return new Date(serverNowMs - startedMsAgo - QUERY_LOG_SKEW_MARGIN_MS).toISOString()
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
 * The id of an async statement's query. It names the database and journal
 * table too, so runs of one migration file against other databases, or by
 * other projects in the same database, never share it (#463), while a re-run
 * against the same target gets the same id and attaches to its attempt.
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
