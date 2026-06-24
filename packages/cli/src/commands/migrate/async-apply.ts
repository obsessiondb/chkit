import { createHash } from 'node:crypto'

import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'

import { debug } from '../../runtime/debug.js'
import type {
  JournalStore,
  MigrationRowState,
  OperationState,
} from '../../runtime/journal-store.js'

const POLL_INTERVAL_MS = 5_000
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

  const initialMigrationState = await journalStore.readMigrationState(migrationName)
  if (
    initialMigrationState !== null &&
    !initialMigrationState.migrationCompleted &&
    initialMigrationState.checksum !== migrationChecksum
  ) {
    throw new Error(
      `Migration ${migrationName} has in-progress async journal state for checksum ${initialMigrationState.checksum}, but the current file checksum is ${migrationChecksum}. Restore the original migration file or clear the in-progress journal state before retrying.`,
    )
  }
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

  // 2. Currently in flight on the server → attach
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
      pollAfterTime: '1970-01-01 00:00:00',
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

  const submitAfterTime =
    priorOpState === undefined ? undefined : isoWithoutZone(new Date(now() - 60_000))
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
    pollAfterTime: submitAfterTime,
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
  pollAfterTime: string | undefined
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
        status = await db.queryStatus(
          queryId,
          pollAfterTime === undefined ? undefined : { afterTime: pollAfterTime },
        )
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
      // (e.g. SQL parse error) — surface that error. Otherwise it's a
      // transient gap (just-submitted or just-finished); loop.
      if (submitError) {
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
