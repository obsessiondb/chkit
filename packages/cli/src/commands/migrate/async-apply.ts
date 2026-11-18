import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as defaultSleep } from 'node:timers/promises'

import type { ClickHouseExecutor, ClickHouseSettings, QueryStatus } from '@chkit/clickhouse'

import { debug } from '../../runtime/debug.js'
import {
  ATTEMPT_BOUND_MARKER,
  type JournalStore,
  type MigrationRowState,
  type OperationState,
  resolveJournalTableName,
} from '../../runtime/journal-store.js'
import { CLI_VERSION } from '../../runtime/version.js'
import { inProgressChecksumMismatchError, MigrateError } from './errors.js'
import { assertCompletedStatement, hasStatementProgress } from './recovery.js'
import type { QueryTracker } from './query-intents.js'

const POLL_INTERVAL_MS = 5_000
// Every retry submits under a random query id of its own (#701), so the
// system.query_log entries of a retried attempt's id are that attempt's only
// (see RETRY_QUERY_LOG_MARGIN_MS). The first attempt
// of a statement uses the statement's deterministic id, which an earlier
// attempt can share only when the journal lost its record (a dropped journal,
// a database the journal could not be written to yet). Its entries, and those
// of an id an older release reused for every attempt, count only from the
// attempt's start on the server clock, which also stamps query_log, minus a
// margin for clock skew between replicas. queryStatus compares whole seconds,
// so the margin stays more than a second below POLL_INTERVAL_MS.
const QUERY_LOG_SKEW_MARGIN_MS = 2_000
// A retry's id is its own, so the bound on its query_log entries only lets
// query_log prune its partitions (event_date), and leaves replica clocks an
// hour of skew.
const RETRY_QUERY_LOG_MARGIN_MS = 3_600_000
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
// The lastError of a 'started' record this release writes is
// ATTEMPT_BOUND_MARKER followed by the attempt's query_log bound (#767): the
// time from which its polls count query_log entries of its id. A re-run reads
// the attempt's outcome with that same bound, so it never takes a QueryFinish
// its polls ignored. A retry by this release journals the attempt failed
// before its before-retry SQL runs, so a QueryFinish of the id from the bound
// on is the statement's outcome. The journal stores such a record's
// fingerprint fenced, so releases from #599 to #767 refuse to resume it
// rather than compensate it without a record (FENCED_FINGERPRINT_PREFIX); a
// record whose fence was not stored (a journal without the fingerprint
// column) is not trusted.
export { ATTEMPT_BOUND_MARKER }
// The lastError of the 'started' record a statement's first attempt writes
// before it reads its query_log bound, which is taken after that write and
// recorded by a second one before the submit (#767). Such a record was never
// submitted, so it is only checked in system.processes.
export const PENDING_ATTEMPT_MARKER = 'not submitted yet; its system.query_log bound is not recorded'
// The lastError of a 'started' record the releases from #701 to #767 wrote.
// Their re-runs bounded the query_log entries of the statement's first id by
// the recorded start, which lies before the bound the attempt's polls used,
// so only a record of a retry's id, which names that attempt alone, is read
// from query_log; one of the first id is checked in system.processes only.
export const ATTEMPT_RECORD_MARKER = 'submitted under its own query id; a retry reads its outcome from system.query_log'
// The lastError of a 'started' record that the releases from #672 to #767
// wrote, for an id an older release may have reused across attempts. Its
// recorded start is not the bound the attempt's polls used, so it is checked
// in system.processes only, like a started record without a marker, which a
// release before #672 wrote.
export const STARTED_RECORD_MARKER = 'submitted; a retry reads its outcome from system.query_log'
// A query_log bound as this release records it (an ISO time, or
// UNBOUNDED_POLL_AFTER_TIME).
const RECORDED_BOUND_SHAPE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/
// query_log is flushed on a timer, every 7.5 s by default. A started attempt
// of this release that no replica runs and that has no query_log entry is
// checked again this many times, QUERY_LOG_FLUSH_RECHECK_INTERVAL_MS apart, before it is
// retried, so an attempt that ended right before the check is found (#701).
const QUERY_LOG_FLUSH_RECHECKS = 5
const QUERY_LOG_FLUSH_RECHECK_INTERVAL_MS = 2_000

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
  const baseQueryId = makeDeterministicQueryId(database, resolveJournalTableName(), migrationName, statementIndex)
  // The id of the attempt the journal tracks, which an older chkit may have
  // derived from the migration alone (#463): a new id would miss that
  // attempt while it still runs.
  const queryId = priorOpState?.queryId || baseQueryId
  debug(
    'migrate:async',
    `${migrationName}#${statementIndex} query_id=${queryId} type=${operationType}`,
  )
  const attemptCheck = startedAttemptCheck(priorOpState, fingerprint, baseQueryId)
  let inFlight = await checkInFlight(db, queryId, operationType, attemptCheck?.afterTime)
  if (attemptCheck?.awaitsFlush && inFlight.status === 'unknown') {
    log(
      `  ${operationType}: previous attempt of query_id=${queryId} is not running and has no outcome in system.query_log yet — checking again while query_log is flushed`,
    )
    for (let recheck = 0; recheck < QUERY_LOG_FLUSH_RECHECKS && inFlight.status === 'unknown'; recheck += 1) {
      await sleep(QUERY_LOG_FLUSH_RECHECK_INTERVAL_MS)
      inFlight = await checkInFlight(db, queryId, operationType, attemptCheck.afterTime)
    }
  }
  // Only the outcome read of a started attempt can tell that it ended.
  const attemptOutcome = attemptCheck === undefined ? 'unknown' : inFlight.status
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
    // The attached attempt is journaled started, also under a failed record:
    // a run that stops while it polls leaves a record whose QueryFinish a
    // re-run finds (#672). Its start is the server's, from its elapsed time.
    // A record this release wrote for the attempt keeps its start: the
    // elapsed time is observed after serverNowMs was read, so the start
    // derived from both can lie earlier than the attempt's by that delay.
    // The record names the query_log bound its polls use, which a re-run then
    // uses too (#767). A record of this release keeps its attempt's bound. A
    // retry's id, which a #701 record names, is that attempt's alone. Any
    // other id an older release may have reused for earlier attempts, and
    // only the attached attempt's start bounds it.
    const priorBound = priorOpState?.status === 'started' ? recordedQueryLogBound(priorOpState) : undefined
    const attachedBound =
      priorBound ??
      (priorOpState?.status === 'started' && priorOpState.lastError === ATTEMPT_RECORD_MARKER && queryId !== baseQueryId
        ? retryQueryLogLowerBound(journalTimeMs(priorOpState.startedAt))
        : attachLowerBound(serverNowMs, inFlight.elapsedMs))
    const attachedStartedAt =
      priorOpState?.status === 'started' && isStartedRecordMarker(priorOpState)
        ? priorOpState.startedAt
        : inFlight.elapsedMs === undefined
          ? (priorOpState?.startedAt ?? isoWithoutZone(new Date(serverNowMs)))
          : isoWithoutZone(new Date(serverNowMs - inFlight.elapsedMs))
    await journalStore.writeMigrationState(
      upsertOperation(
        initialMigrationState ?? freshMigrationState(migrationName, migrationChecksum),
        {
          operationIndex: statementIndex,
          operationKey,
          operationType,
          queryId,
          status: 'started',
          startedAt: attachedStartedAt,
          finishedAt: null,
          lastError: attemptRecordError(attachedBound),
          fingerprint: attemptFingerprint,
        },
        now,
      ),
    )
    return await pollUntilTerminal({
      db,
      journalStore,
      migrationState: await journalStore.readMigrationState(migrationName),
      migrationName,
      migrationChecksum,
      statementIndex,
      operationType,
      operationKey,
      // What is known about the attempt that runs: a record without a
      // fingerprint stays without one.
      fingerprint: attemptFingerprint,
      queryId,
      pollAfterTime: attachedBound,
      log,
      pollIntervalMs,
      sleep,
      now,
      // No submit promise — query was started by a prior chkit run that's
      // now gone. We only observe its eventual completion.
      submitPromise: null,
      startedAt: attachedStartedAt,
    })
  }

  // 3. A started attempt that no replica runs any more finished on the server
  // when query_log has its QueryFinish (#672): its run ended before it
  // journaled the outcome. Record it, without compensating or resubmitting.
  if (attemptOutcome === 'finished' && initialMigrationState !== null && priorOpState !== undefined) {
    const finishedOp: OperationState = {
      ...priorOpState,
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
  // Run before-retry compensation, then resubmit forward under a new random
  // id, which no other attempt or run ever submits (#701). A
  // started attempt that failed on the server is retried the same way,
  // reported with its error.
  // 5. No prior row → FIRST attempt. Skip compensation, submit forward.
  // (priorOpState.status === 'completed' was already returned above.)
  // A started record of an older release, or one whose bound cannot be
  // trusted, may have finished without a QueryFinish this release can tell
  // from an earlier attempt's (#767). Without before-retry SQL to undo it,
  // running the statement again could load its rows twice: stop instead.
  const ambiguous = attemptCheck === undefined && isAmbiguousStartedRecord(priorOpState, fingerprint)
  if (ambiguous && beforeRetry === null) {
    throw new MigrateError(
      'async_outcome_unknown',
      `Async migration step ${operationType} (query_id ${queryId}): the journal records it as started and it is no longer running, but chkit cannot tell from system.query_log whether it finished: an earlier chkit release recorded it, or the journal has no operation_fingerprints column. The statement has no -- before-retry: SQL to undo a partial run, so it was not submitted again and nothing ran. ` +
        `If an earlier release recorded it, finish ${migrationName} with that release, then upgrade. Or check the query's outcome yourself (SELECT type, event_time FROM system.query_log WHERE query_id = '${queryId}'), reconcile the target table, and discard the partial run with chkit migrate --apply --abandon ${migrationName}; the next apply then runs the migration from statement 1.`,
    )
  }
  const attemptQueryId = priorOpState === undefined ? baseQueryId : randomUUID()
  if (priorOpState !== undefined) {
    const prior =
      attemptOutcome === 'failed'
        ? { status: 'failed', lastError: inFlight.error ?? '<unknown>' }
        : priorOpState
    const errorTail = prior.lastError ? `: ${firstLine(prior.lastError)}` : ''
    log(
      `  ${operationType}: previous attempt of query_id=${queryId} is no longer running (status=${prior.status}${errorTail}) — running before-retry then resubmitting as query_id=${attemptQueryId}`,
    )
    // The checked attempt is journaled failed before it is compensated. Its
    // QueryFinish can still reach query_log after this check (query_log is
    // flushed on a timer), and a run that stops between the compensation and
    // the next 'started' write must not take it for this statement's outcome
    // on its re-run (#672), nor may an older release that reads the record
    // as its own (#767). Without compensation nothing is written until the
    // next 'started' write, which replaces the record.
    if ((attemptCheck !== undefined || ambiguous) && initialMigrationState !== null && beforeRetry !== null) {
      await journalStore.writeMigrationState(
        upsertOperation(
          initialMigrationState,
          {
            ...priorOpState,
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
      if (input.queryTracker) {
        await input.queryTracker.command({ migration: migrationName, statementIndex, forwardSQL: sql, beforeRetry }, 'compensation', beforeRetry, settings)
      } else await db.command(beforeRetry, settings)
    }
  } else {
    log(`  ${operationType}: submitting async (query_id=${queryId})`)
  }

  // The attempt's start on the server clock, which also stamps query_log,
  // read before the attempt is journaled and submitted.
  const startedAt = isoWithoutZone(new Date(serverNowMs))
  const startedState = (lastError: string): MigrationRowState =>
    upsertOperation(
      initialMigrationState ?? freshMigrationState(migrationName, migrationChecksum),
      {
        operationIndex: statementIndex,
        operationKey,
        operationType,
        queryId: attemptQueryId,
        status: 'started',
        startedAt,
        finishedAt: null,
        lastError,
        fingerprint,
      },
      now,
    )

  // Persist the "started" intent BEFORE submitting, so a crash between here
  // and the next event still leaves chkit able to detect "this op was tried."
  // A retry's id is this attempt's alone, so every entry of it counts (#701).
  // The statement's first id counts only queries that started after the
  // server time read after a first journal write: the recorded start can lie
  // before an earlier attempt's entry by as long as the writes took. That
  // read can land on a replica whose clock is behind the one that gave the
  // recorded start, so the bound never lies before it. The record names the
  // bound before the submit, so a re-run reads the outcome with the bound
  // these polls use (#767); a run that stops between the two writes leaves a
  // record that was never submitted and is checked in system.processes only.
  let pollAfterTime: string
  if (attemptQueryId === baseQueryId) {
    await journalStore.writeMigrationState(startedState(PENDING_ATTEMPT_MARKER))
    pollAfterTime = queryLogLowerBound(Math.max(serverNowMs, (await readServerState(db)).nowMs), 0)
  } else {
    pollAfterTime = retryQueryLogLowerBound(serverNowMs)
  }
  await journalStore.writeMigrationState(startedState(attemptRecordError(pollAfterTime)))

  // Re-read so we have the row's actual stored applied_at (matters for
  // subsequent ReplacingMergeTree writes during polling).
  const stateAfterStart = await journalStore.readMigrationState(migrationName)
  await input.queryTracker?.recordAsync({ migration: migrationName, statementIndex, forwardSQL: sql, beforeRetry }, attemptQueryId)
  const submitPromise = db.submit(sql, attemptQueryId, settings)

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
    queryId: attemptQueryId,
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
        // keep polling up to a bounded budget. A re-run re-attaches by the id the journal records.
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

interface StartedAttemptCheck {
  /** Only query_log entries of queries started at or after this time count. */
  afterTime: string
  /** Whether a missing query_log entry is waited for, as query_log is flushed (#701). */
  awaitsFlush: boolean
}

// Only a started attempt of this statement's SQL can have finished without
// its run journaling the outcome: a failed attempt has its outcome, a record
// without a query id never ran under one, and a finished attempt of other SQL
// (kept by --abandon and an edit) did not run this statement. Its outcome is
// read with the query_log bound its record names, the one its polls used
// (#767). A record of the releases from #701 to #767 names no bound; only
// one of a retry's id is read, as every entry of that id is the attempt's
// (RETRY_QUERY_LOG_MARGIN_MS). Any other record is checked in
// system.processes only.
function startedAttemptCheck(
  op: OperationState | undefined,
  fingerprint: string,
  baseQueryId: string,
): StartedAttemptCheck | undefined {
  if (op?.status !== 'started' || op.queryId === '') return undefined
  if (op.fingerprint !== '' && op.fingerprint !== fingerprint) return undefined
  const bound = recordedQueryLogBound(op)
  if (bound !== undefined) return { afterTime: bound, awaitsFlush: true }
  if (op.lastError === ATTEMPT_RECORD_MARKER && op.queryId !== baseQueryId) {
    return { afterTime: retryQueryLogLowerBound(journalTimeMs(op.startedAt)), awaitsFlush: true }
  }
  return undefined
}

/** The lastError of a started record that names its query_log bound (#767). */
export function attemptRecordError(bound: string): string {
  return `${ATTEMPT_BOUND_MARKER}${bound}`
}

/**
 * The query_log bound a started record names, or undefined when it names none
 * or its fence was not stored, so an older release may have compensated the
 * attempt without a record (#767).
 */
function recordedQueryLogBound(op: OperationState): string | undefined {
  if (op.attemptFenced !== true || !op.lastError.startsWith(ATTEMPT_BOUND_MARKER)) return undefined
  const bound = op.lastError.slice(ATTEMPT_BOUND_MARKER.length)
  return RECORDED_BOUND_SHAPE.test(bound) ? bound : undefined
}

function isStartedRecordMarker(op: OperationState): boolean {
  return (
    op.lastError === ATTEMPT_RECORD_MARKER ||
    op.lastError === STARTED_RECORD_MARKER ||
    recordedQueryLogBound(op) !== undefined
  )
}

/**
 * Whether a started record of this statement's SQL that this release does not
 * read from query_log may still have finished on the server (#767): a record
 * of an older release that read it from query_log (#672, #701), or one that
 * names a bound this release cannot trust. A record without a marker, from a
 * release before #672, or one not submitted yet, keeps the retry without a
 * stop.
 */
function isAmbiguousStartedRecord(op: OperationState | undefined, fingerprint: string): boolean {
  if (op?.status !== 'started' || op.queryId === '') return false
  if (op.fingerprint !== '' && op.fingerprint !== fingerprint) return false
  return (
    op.lastError === ATTEMPT_RECORD_MARKER ||
    op.lastError === STARTED_RECORD_MARKER ||
    op.lastError.startsWith(ATTEMPT_BOUND_MARKER)
  )
}

// The journal returns DateTime64 without a zone, all of it UTC.
function journalTimeMs(value: string): number {
  const iso = value.trim().replace(' ', 'T')
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
}

// The attached attempt had run for elapsedMs when the in-flight check, which
// followed the serverNowMs reading, saw it. Without an elapsed time its start
// is unknown, and only the unbounded lookup still finds its entry.
function attachLowerBound(serverNowMs: number, elapsedMs: number | undefined): string {
  return elapsedMs === undefined ? UNBOUNDED_POLL_AFTER_TIME : queryLogLowerBound(serverNowMs, elapsedMs)
}

function retryQueryLogLowerBound(startedMs: number): string {
  return new Date(startedMs - RETRY_QUERY_LOG_MARGIN_MS).toISOString()
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
 * The id of an async statement's first attempt. It names the database and
 * journal table too, so runs of one migration file against other databases,
 * or by other projects in the same database, never share it (#463). A re-run
 * attaches to an attempt by the id its record names; a retry submits under a
 * random id (#701).
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
