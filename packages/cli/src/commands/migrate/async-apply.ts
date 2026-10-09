import { createHash } from 'node:crypto'
import { setTimeout as defaultSleep } from 'node:timers/promises'

import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'

import { debug } from '../../runtime/debug.js'
import type {
  JournalStore,
  MigrationRowState,
  OperationState,
} from '../../runtime/journal-store.js'
import { inProgressChecksumMismatchError } from './errors.js'
import { hasStatementProgress } from './recovery.js'

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
const MAX_TRANSIENT_POLL_ERRORS = 20

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
  beforeRetry: string | null
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
    beforeRetry,
    log,
    pollIntervalMs = POLL_INTERVAL_MS,
    sleep = defaultSleep,
    now = Date.now,
  } = input

  const queryId = makeDeterministicQueryId(migrationName, statementIndex)
  debug(
    'migrate:async',
    `${migrationName}#${statementIndex} query_id=${queryId} type=${operationType}`,
  )

  const initialMigrationState = acceptChangedChecksum(
    await journalStore.readMigrationState(migrationName),
    migrationName,
    migrationChecksum,
  )
  const priorOpState = initialMigrationState?.operations.find(
    (op) => op.operationIndex === statementIndex,
  )

  // 1. Already completed → skip entirely
  if (priorOpState?.status === 'completed') {
    log(
      `  ${operationType}: query_id=${queryId} already completed in prior run — skipping`,
    )
    return { kind: 'skipped', operation: priorOpState }
  }

  // 2. Currently in flight on the server → attach. The server clock is read
  // before the check, so the start derived from it and the attempt's elapsed
  // time never falls after the start that query_log records for the attempt.
  const serverNowMs = await readServerNowMs(db)
  const inFlight = await db.queryStatus(queryId)
  if (inFlight.status === 'running') {
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

  // 3. Prior in-progress row exists but query is not in system.processes →
  // RETRY. Run before-retry compensation, then resubmit forward.
  // 4. No prior row → FIRST attempt. Skip compensation, submit forward.
  // (priorOpState.status === 'completed' was already returned above.)
  if (priorOpState !== undefined) {
    const errorTail = priorOpState.lastError
      ? `: ${firstLine(priorOpState.lastError)}`
      : ''
    log(
      `  ${operationType}: previous attempt of query_id=${queryId} is no longer running (status=${priorOpState.status}${errorTail}) — running before-retry then resubmitting`,
    )
    if (beforeRetry !== null) {
      log(`  ${operationType}: running before-retry SQL`)
      await db.command(beforeRetry)
    }
  } else {
    log(`  ${operationType}: submitting async (query_id=${queryId})`)
  }

  const startedAt = isoWithoutZone(new Date(now()))

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
      },
      now,
    ),
  )

  // Re-read so we have the row's actual stored applied_at (matters for
  // subsequent ReplacingMergeTree writes during polling).
  const stateAfterStart = await journalStore.readMigrationState(migrationName)

  const pollAfterTime = await readSubmissionLowerBound(db)
  const submitPromise = db.submit(sql, queryId)

  return await pollUntilTerminal({
    db,
    journalStore,
    migrationState: stateAfterStart,
    migrationName,
    migrationChecksum,
    statementIndex,
    operationType,
    operationKey,
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
          throw new Error(
            `Async migration step ${operationType} (query_id ${queryId}): polling failed ${transientPollErrors}× (${describeError(pollError)}). The load may still be running server-side — re-run \`chkit migrate --apply\` to re-attach.`,
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
        log(progressLine(operationType, status, elapsedSec))
        continue
      }

      // status === 'unknown'
      // If submit has already rejected, the query never made it server-side
      // (e.g. SQL parse error) — record the attempt as failed and surface that
      // error. Otherwise it's a transient gap (just-submitted or just-finished); loop.
      if (submitError) {
        const failedOp: OperationState = {
          operationIndex: statementIndex,
          operationKey,
          operationType,
          queryId,
          status: 'failed',
          startedAt,
          finishedAt: isoWithoutZone(new Date(now())),
          lastError: describeError(submitError),
        }
        const baseState =
          migrationState ?? freshMigrationState(migrationName, migrationChecksum)
        await journalStore.writeMigrationState(upsertOperation(baseState, failedOp, now))
        throw submitError
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

// Read just before a submission, as an ISO UTC string for queryStatus.
async function readSubmissionLowerBound(db: ClickHouseExecutor): Promise<string> {
  return queryLogLowerBound(await readServerNowMs(db), 0)
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

async function readServerNowMs(db: ClickHouseExecutor): Promise<number> {
  const [row] = await db.query<{ now_ms: number | string }>(
    'SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms',
  )
  const serverNowMs = Number(row?.now_ms)
  if (!Number.isFinite(serverNowMs)) {
    throw new Error('Could not read the ClickHouse server time for an async statement.')
  }
  return serverNowMs
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

export function makeDeterministicQueryId(
  migrationName: string,
  statementIndex: number,
): string {
  const hex = createHash('sha256')
    .update(`chkit:${migrationName}:${statementIndex}`)
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
