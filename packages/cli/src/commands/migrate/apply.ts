import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as defaultSleep } from 'node:timers/promises'

import {
  assertNoFireAndForgetAsyncInserts,
  parseExchangeTables,
  waitForDDLPropagation,
  waitForExchange,
  waitForInsertBarrier,
  type ClickHouseExecutor,
  type ClickHouseSettings,
  type QualifiedTable,
} from '@chkit/clickhouse'
import { extractLegacyExecutableStatements, statementFingerprint, type ResolvedChxConfig } from '@chkit/core'

import type { ParsedFlags, PluginRuntime, TableScope } from '../../plugins.js'
import { debug } from '../../runtime/debug.js'
import type {
  createJournalStore,
  MigrationRowState,
  OperationState,
  OperationStatus,
} from '../../runtime/journal-store.js'
import { resolveJournalTableName } from '../../runtime/journal-store.js'
import { checksumSQL, type MigrationJournalEntry } from '../../runtime/migration-store.js'
import {
  extractExecutableStatements,
  extractMigrationOperationSummaries,
  findNonSelectBarriers,
  type MigrationOperationSummary,
} from '../../runtime/safety-markers.js'
import { CLI_VERSION } from '../../runtime/version.js'
import type { QueryContext, QueryTracker } from './query-intents.js'
import {
  applyAsyncStatement,
  finishedRecordOf,
  freshMigrationState,
  isoWithoutZone,
  type KnownOutcome,
  outcomeUnknownError,
  resolveRecordedAttempt,
  reusableOutcome,
  stopRunningAdvice,
  upsertOperation,
} from './async-apply.js'
import {
  inProgressChecksumMismatchError,
  MigrateError,
  nonSelectBarrierError,
  recordedStatementsChangedError,
  statementSplitChangedError,
  type PendingNonSelectBarrier,
} from './errors.js'
import {
  assertCompletedStatement,
  hasStatementProgress,
  rebaseInProgressState,
  recordedStatementMismatches,
  retryMismatchError,
  splitChangedStatements,
  statementIdentities,
  statementIdentity,
  verifyRetryEdit,
  type StatementIdentity,
} from './recovery.js'

type JournalStore = ReturnType<typeof createJournalStore>

function operationIsCompleted(state: MigrationRowState | null, index: number): boolean {
  return (
    state?.operations.some((op) => op.operationIndex === index && op.status === 'completed') ?? false
  )
}

/**
 * `lastError` of a completed sync statement whose DDL propagation wait has not
 * passed yet (#513). A statement is recorded completed before its wait, so a
 * re-run never replays it; while this marker is set, a re-run waits for it
 * again before it runs the next statement. A write after the wait passes
 * clears it. --abandon replaces it, and --retry keeps it with the record.
 */
export const PROPAGATION_WAIT_PENDING = 'executed; waiting for the change to reach every replica'

function propagationWaitPending(state: MigrationRowState, index: number): boolean {
  return state.operations.some(
    (op) => op.operationIndex === index && op.status === 'completed' && op.lastError === PROPAGATION_WAIT_PENDING,
  )
}

/**
 * A barrier changes no object, so it has no wait: migrate refuses a barrier
 * statement that is not a SELECT before anything runs (#634).
 */
function hasPropagationWait(operation: MigrationOperationSummary | undefined): operation is MigrationOperationSummary {
  return operation !== undefined && operation.mode !== 'barrier'
}

/**
 * Waits until a sync statement's DDL reaches every replica, then clears its
 * pending marker. A resumed run calls it with the same inputs as the first.
 */
async function completePropagation(input: {
  db: ClickHouseExecutor
  journalStore: JournalStore
  file: string
  fallbackState: MigrationRowState
  index: number
  identity: RecordedIdentity
  operation: MigrationOperationSummary | undefined
  statement: string
  cluster: string | undefined
}): Promise<void> {
  const { db, journalStore, file, index, identity, operation, statement, cluster } = input
  if (hasPropagationWait(operation)) {
    await waitForDDLPropagation(db, operation.type, operation.key, { cluster, statement })
  }
  const state = (await journalStore.readMigrationState(file)) ?? input.fallbackState
  await journalStore.writeMigrationState(
    upsertOperation(state, syncOperationState(index, identity, 'completed'), Date.now),
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One-line, length-capped preview of a SQL statement for error messages. */
export function previewStatement(sql: string, max = 120): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** A migration's statements marked `mode=barrier` that are not a SELECT (#634). */
export function nonSelectBarriers(
  migration: string,
  statements: readonly string[],
  operations: readonly MigrationOperationSummary[],
): PendingNonSelectBarrier[] {
  return findNonSelectBarriers(statements, operations).map((barrier) => ({
    migration,
    statement: barrier.index + 1,
    total: statements.length,
    operation: barrier.summary,
    preview: previewStatement(barrier.statement),
  }))
}

/**
 * Wrap a statement-execution failure with the context a user needs to locate
 * it (#10): the migration file, the failed statement's position, and a SQL
 * preview — on top of the cleaned ClickHouse message. Without this, a rejected
 * migration surfaces only the raw CH exception with no file or statement.
 */
export function statementError(input: {
  file: string
  index: number
  total: number
  statement: string
  error: unknown
}): Error {
  const wrapped = new Error(
    `Migration ${input.file} failed at statement ${input.index + 1} of ${input.total}:\n` +
      `  ${previewStatement(input.statement)}\n` +
      errorMessage(input.error),
  )
  if (input.error instanceof Error && input.error.stack) wrapped.stack = input.error.stack
  return wrapped
}

/** What the journal records about a statement besides its progress. */
interface RecordedIdentity {
  type: string
  key: string
  fingerprint: string
}

// A sync or barrier run of a statement whose record names an async attempt
// (a mode-only edit with --retry) resolves that attempt first, as an async
// re-run does (#767): a QueryFinish records the statement completed, a
// server failure is journaled failed before any before-retry SQL runs, and
// an attempt that may have finished stops the run before anything is written
// or run. A running attempt keeps its record: its query id is the only way to
// find it later.
const ASYNC_STOP_CODES: ReadonlySet<string> = new Set(['async_outcome_unknown', 'async_attempt_unfenced', 'async_needs_lock'])

function unfencedJournalError(file: string): MigrateError {
  return new MigrateError(
    'async_attempt_unfenced',
    `Cannot apply ${file}: it has async statements, and the journal ${resolveJournalTableName()} has no operation_fingerprints column, which records each async attempt's fence (#767). Nothing ran. Add the column with a user that can alter the journal: run chkit migrate --apply as that user, or ALTER TABLE <database>.${resolveJournalTableName()} ADD COLUMN IF NOT EXISTS operation_fingerprints Array(String) DEFAULT [] (ON CLUSTER in cluster mode), then apply again.`,
  )
}

async function resolveAsyncAttemptBeforeSync(input: {
  db: ClickHouseExecutor
  journalStore: JournalStore
  file: string
  state: MigrationRowState
  op: OperationState
  fingerprint: string
  /** The statement this run runs at that position. */
  sql: string
  operationType: string
  log: (line: string) => void
  /** The outcome the edit's check read for this attempt, if it did (#767). */
  known?: KnownOutcome
}): Promise<'completed' | 'run' | 'unsent'> {
  const { op, file, known } = input
  if (op.status === 'completed' || op.queryId === '') return 'run'
  const recorded =
    reusableOutcome(known, op, input.fingerprint) ??
    (await resolveRecordedAttempt({
        db: input.db, journalStore: input.journalStore, migrationName: file, op, fingerprint: input.fingerprint, sql: input.sql, queryId: op.queryId,
        operationType: input.operationType, log: input.log, sleep: defaultSleep,
      }))
  switch (recorded.kind) {
    case 'running':
      throw attemptStillRunningError(file, op)
    case 'unknown':
      throw outcomeUnknownError({ operationType: input.operationType, statementIndex: op.operationIndex, migrationName: file, queryId: op.queryId, reason: recorded.reason })
    case 'finished':
      await input.journalStore.writeMigrationState(upsertOperation(input.state, finishedRecordOf(op, Date.now), Date.now))
      input.log(`  ${input.operationType}: earlier async attempt of query_id=${op.queryId} finished on the server, recording it as completed`)
      return 'completed'
    case 'failed':
      await input.journalStore.writeMigrationState(
        upsertOperation(input.state, { ...op, status: 'failed', finishedAt: isoWithoutZone(new Date()), lastError: recorded.error }, Date.now),
      )
      return 'run'
    case 'unsent':
      return 'unsent'
    case 'ended':
      return 'run'
  }
}

function syncOperationState(
  index: number,
  identity: RecordedIdentity,
  status: OperationStatus,
  lastError = '',
): OperationState {
  const timestamp = isoWithoutZone(new Date())
  return {
    operationIndex: index,
    operationKey: identity.key,
    operationType: identity.type,
    queryId: '',
    status,
    startedAt: timestamp,
    finishedAt: status === 'started' ? null : timestamp,
    lastError,
    fingerprint: identity.fingerprint,
  }
}

export async function applyMigration(input: {
  db: ClickHouseExecutor
  journalStore: JournalStore
  pluginRuntime: PluginRuntime
  config: ResolvedChxConfig
  tableScope: TableScope
  flags: ParsedFlags
  migrationsDir: string
  file: string
  /** --setting values, sent with every statement of the migration (sync, async, barrier, before-retry). */
  settings?: ClickHouseSettings
  queryTracker?: QueryTracker
  /** Set when the run holds no migrate lock because the target database did not exist (#767). */
  locklessBootstrap?: boolean
  /** Aborted by Ctrl-C: no statement starts after it. */
  signal?: AbortSignal
  /** Set when --retry verified an edit of this in-progress migration before the run (#233). */
  retry?: { previousChecksum: string; checksum: string }
  /** Progress lines; the command sends them to stderr in --json mode. */
  log?: (line: string) => void
}): Promise<MigrationJournalEntry> {
  const { db, journalStore, pluginRuntime, config, tableScope, flags, migrationsDir, file, settings, retry } = input
  const log = input.log ?? ((line: string) => console.log(line))

  debug('migrate', `applying ${file}`)
  const sql = await readFile(join(migrationsDir, file), 'utf8')
  const parsedStatements = extractExecutableStatements(sql)
  const operationSummaries = extractMigrationOperationSummaries(sql)
  debug('migrate', `${file}: ${parsedStatements.length} statements, ${operationSummaries.length} operations`)

  const statements = await pluginRuntime.runOnBeforeApply({
    command: 'migrate',
    config,
    tableScope,
    flags,
    migration: file,
    sql,
    statements: parsedStatements,
  })

  // migrate refused a file's non-SELECT barrier before the run; a plugin may
  // have rewritten the statements since (#634).
  const barriers = nonSelectBarriers(file, statements, operationSummaries)
  if (barriers.length > 0) throw nonSelectBarrierError(barriers)

  const migrationChecksum = checksumSQL(sql)
  // What the journal records for each statement run, and checks against (#599).
  const fingerprints = statements.map(statementFingerprint)
  const sqlByFingerprint = new Map(statements.map((statement, index) => [fingerprints[index] ?? '', statement]))

  // Resume support (#6): if a prior run left per-statement journal state for
  // this migration, statements already marked completed are skipped instead of
  // replayed — so a partial failure no longer bricks the migration on re-run
  // with "column already exists". Resuming across a file edit needs care (#233).
  const initialState = await journalStore.readMigrationState(file)
  // Releases before #562 did not know `//` and `#` comments, so the statement
  // positions they recorded do not hold where their split and this one differ.
  // A state this release recorded is split as now.
  if (
    initialState !== null &&
    !initialState.migrationCompleted &&
    initialState.chkitVersion !== CLI_VERSION
  ) {
    const changed = splitChangedStatements(initialState.operations, {
      legacy: extractLegacyExecutableStatements(sql),
      current: parsedStatements,
      positionsKept:
        statements.length === parsedStatements.length &&
        statements.every((statement, index) => statement === parsedStatements[index]),
    })
    if (changed.length > 0) {
      throw statementSplitChangedError({
        migration: file,
        statements: changed,
        recordedBy: initialState.chkitVersion,
        cliVersion: CLI_VERSION,
      })
    }
  }
  // A statement a plugin's onBeforeApply dropped is never visited below, so
  // its recorded async attempt is read, against the identity it was recorded
  // with, before anything runs and before the recorded statements are
  // checked: one still running or without an outcome stops the run with the
  // journal as it was, instead of the migration being recorded as applied, or
  // the record being refused unread (#767).
  if (initialState !== null && !initialState.migrationCompleted && initialState.checksum === migrationChecksum) {
    const omitted = initialState.operations.filter((op) => op.operationIndex >= statements.length)
    if (omitted.length > 0) {
      await assertRecordedAttemptsResolved(db, journalStore, file, { ...initialState, operations: omitted }, initialState, sqlByFingerprint, log)
    }
  }

  // The file is unchanged, so the statements this run gets should be those the
  // journal recorded. They are not when the split or a plugin's onBeforeApply
  // changed since: then positions do not hold (#599). An edited file is
  // checked by --retry below.
  if (
    initialState !== null &&
    !initialState.migrationCompleted &&
    initialState.checksum === migrationChecksum
  ) {
    const changed = recordedStatementMismatches(initialState.operations, fingerprints)
    if (changed.length > 0) {
      throw recordedStatementsChangedError({
        migration: file,
        statements: changed,
        recordedBy: initialState.chkitVersion,
        cliVersion: CLI_VERSION,
      })
    }
  }
  // The outcomes the edit's check read for the attempts it keeps, so the sync
  // path does not look them up, through the query_log rechecks, again.
  let editResolved = new Map<number, KnownOutcome>()
  if (
    initialState !== null &&
    !initialState.migrationCompleted &&
    initialState.checksum !== migrationChecksum
  ) {
    editResolved = await acceptEditedMigration({
      db,
      file,
      state: initialState,
      checksum: migrationChecksum,
      identities: statementIdentities(operationSummaries, fingerprints),
      sqlByFingerprint,
      retry,
      journalStore,
      log,
    })
  }

  // An async attempt is submitted only once the journal stored its fence
  // (#767), so a journal that cannot store one stops the migration before any
  // of its statements runs: nothing needs reconciling.
  if (operationSummaries.some((operation) => operation?.mode === 'async') && !(await journalStore.storesAttemptFences())) {
    throw unfencedJournalError(file)
  }

  for (let i = 0; i < statements.length; i++) {
    input.signal?.throwIfAborted()
    const statement = statements[i] as string
    const operation = operationSummaries[i]
    if (operation?.mode === 'async') {
      try {
        await applyAsyncStatement({
          db,
          journalStore,
          sql: statement,
          migrationName: file,
          migrationChecksum,
          statementIndex: i,
          operationType: operation.type,
          operationKey: operation.key,
          fingerprint: fingerprints[i] ?? '',
          known: editResolved.get(i),
          beforeRetry: operation.beforeRetry,
          settings,
          queryTracker: input.queryTracker,
          locklessBootstrap: input.locklessBootstrap,
          signal: input.signal,
          log,
        })
      } catch (error) {
        if (error === input.signal?.reason) throw error
        const wrapped = statementError({ file, index: i, total: statements.length, statement, error })
        // A stop of an async statement keeps its code for --json (#767).
        if (error instanceof MigrateError && ASYNC_STOP_CODES.has(error.code)) {
          throw new MigrateError(error.code, wrapped.message)
        }
        throw wrapped
      }
      // Async ops are DML (loads, backfills) — no DDL propagation to wait on.
      continue
    }
    // Sync DDL path with per-statement journaling + resume. Re-read state each
    // iteration so async ops written above (or in a prior run) are preserved.
    const stateBefore = await journalStore.readMigrationState(file)
    const identity: RecordedIdentity = { ...statementIdentity(operationSummaries, i), fingerprint: fingerprints[i] ?? '' }
    if (stateBefore !== null && operationIsCompleted(stateBefore, i)) {
      assertCompletedStatement(stateBefore, { migration: file, index: i, fingerprint: identity.fingerprint, cliVersion: CLI_VERSION })
      if (propagationWaitPending(stateBefore, i)) {
        // The run that completed it stopped before its propagation wait
        // passed (#513): wait again before the next statement runs.
        debug('migrate', `${file}#${i}: already completed in a prior run — waiting for DDL propagation again`)
        await completePropagation({
          db,
          journalStore,
          file,
          fallbackState: stateBefore,
          index: i,
          identity,
          operation,
          statement,
          cluster: config.clickhouse?.cluster,
        })
      } else {
        debug('migrate', `${file}#${i}: already completed in a prior run — skipping`)
      }
      continue
    }
    const priorAttempt = stateBefore?.operations.find((op) => op.operationIndex === i)
    let resolved: 'completed' | 'run' | 'unsent' = 'run'
    if (priorAttempt !== undefined && stateBefore !== null) {
      resolved = await resolveAsyncAttemptBeforeSync({ db, journalStore, file, state: stateBefore, op: priorAttempt, fingerprint: identity.fingerprint, sql: statement, operationType: identity.type, log, known: editResolved.get(i) })
      if (resolved === 'completed') continue
    }
    // An async attempt that was never sent ran nothing: no before-retry SQL.
    if (priorAttempt !== undefined && operation?.beforeRetry && resolved !== 'unsent') {
      try {
        await runBeforeRetry(db, operation.type, statement, operation.beforeRetry, {
          cluster: config.clickhouse?.cluster,
          settings,
          log,
          status: priorAttempt.status,
          queryTracker: input.queryTracker,
          queryContext: { migration: file, statementIndex: i, forwardSQL: statement, beforeRetry: operation.beforeRetry },
        })
      } catch (error) {
        throw statementError({ file, index: i, total: statements.length, statement, error })
      }
    }
    const swapped = operation ? swappedTables(operation.type, operation.key, statement) : undefined
    if (swapped) {
      try {
        await assertNoFireAndForgetAsyncInserts(db, swapped, { cluster: config.clickhouse?.cluster, log })
      } catch (error) {
        throw statementError({ file, index: i, total: statements.length, statement, error })
      }
    }
    const baseState = stateBefore ?? freshMigrationState(file, migrationChecksum)
    await journalStore.writeMigrationState(
      upsertOperation(baseState, syncOperationState(i, identity, 'started'), Date.now),
    )
    try {
      if (operation?.mode === 'barrier') {
        await waitForInsertBarrier(db, statement, { cluster: config.clickhouse?.cluster, settings, log })
      } else {
        if (input.queryTracker) {
          await input.queryTracker.command({ migration: file, statementIndex: i, forwardSQL: statement, beforeRetry: operation?.beforeRetry ?? null }, 'forward', statement, settings)
        } else await db.command(statement, settings)
      }
    } catch (error) {
      const stateOnError = (await journalStore.readMigrationState(file)) ?? baseState
      await journalStore.writeMigrationState(
        upsertOperation(
          stateOnError,
          syncOperationState(i, identity, 'failed', errorMessage(error)),
          Date.now,
        ),
      )
      throw statementError({ file, index: i, total: statements.length, statement, error })
    }
    // Mark completed as soon as the statement has executed — BEFORE waiting for
    // DDL propagation. The statement already ran, so if the propagation wait
    // later times out and throws, a re-run must skip this statement rather than
    // replay it into an "already exists" error (the brick this fix prevents).
    // Until its wait passes, the record carries PROPAGATION_WAIT_PENDING, so a
    // re-run waits for it again before the next statement (#513).
    const waits = hasPropagationWait(operation)
    const stateAfter = (await journalStore.readMigrationState(file)) ?? baseState
    await journalStore.writeMigrationState(
      upsertOperation(
        stateAfter,
        syncOperationState(i, identity, 'completed', waits ? PROPAGATION_WAIT_PENDING : ''),
        Date.now,
      ),
    )
    if (waits) {
      await completePropagation({
        db,
        journalStore,
        file,
        fallbackState: stateAfter,
        index: i,
        identity,
        operation,
        statement,
        cluster: config.clickhouse?.cluster,
      })
    }
  }

  const entry: MigrationJournalEntry = {
    name: file,
    appliedAt: new Date().toISOString().replace('Z', ''),
    checksum: migrationChecksum,
  }
  await journalStore.appendEntry(entry)

  await pluginRuntime.runOnAfterApply({
    command: 'migrate',
    config,
    tableScope,
    flags,
    migration: file,
    statements,
    appliedAt: entry.appliedAt,
  })

  return entry
}

const CUTOVER_START_KEY = /^table:([^.]+)\.(.+):cutover:start$/

/**
 * The tables a statement is about to swap, whose fire-and-forget async inserts
 * would be dropped: both tables of an EXCHANGE TABLES, and the table of a
 * cutover at its first step, so that the cutover stops before its copy.
 */
function swappedTables(operationType: string, operationKey: string, statement: string): QualifiedTable[] | undefined {
  if (operationType === 'exchange_tables') return parseExchangeTables(statement)
  if (operationType !== 'cutover_validate') return undefined
  const match = CUTOVER_START_KEY.exec(operationKey)
  if (!match?.[1] || !match[2]) return undefined
  return [{ database: match[1], name: match[2] }]
}

/**
 * Runs a statement's `-- before-retry:` SQL before chkit attempts it again
 * after an earlier attempt failed or was interrupted. Before an EXCHANGE
 * TABLES the replicas first have to agree on both tables: a swap that ran but
 * whose acknowledgement was lost may not have reached the replica the guard
 * reads yet, and exchanging again would swap the tables back.
 */
async function runBeforeRetry(
  db: ClickHouseExecutor,
  operationType: string,
  statement: string,
  beforeRetry: string,
  options: {
    cluster: string | undefined
    settings: ClickHouseSettings | undefined
    log: (line: string) => void
    status: OperationStatus
    queryTracker?: QueryTracker
    queryContext?: QueryContext
  },
): Promise<void> {
  if (operationType === 'exchange_tables') {
    await waitForExchange(db, statement, { cluster: options.cluster })
  }
  options.log(`  ${operationType}: an earlier attempt ${options.status === 'failed' ? 'failed' : 'was interrupted'} — running before-retry SQL`)
  if (options.queryTracker && options.queryContext) {
    await options.queryTracker.command(options.queryContext, 'compensation', beforeRetry, options.settings)
  } else await db.command(beforeRetry, options.settings)
}

// An in-progress migration whose file changed resumes when this run's --retry
// verified the edit, or when no statement is recorded as completed or started
// (the first statement failed, or --abandon marked every statement failed):
// the file then runs again from statement 1. The state is re-keyed to the new
// checksum before anything runs, so a later failure resumes without --retry.
async function acceptEditedMigration(input: {
  db: ClickHouseExecutor
  file: string
  state: MigrationRowState
  checksum: string
  identities: StatementIdentity[]
  sqlByFingerprint: ReadonlyMap<string, string>
  retry: { previousChecksum: string; checksum: string } | undefined
  journalStore: JournalStore
  log: (line: string) => void
}): Promise<Map<number, KnownOutcome>> {
  const { file, state, checksum, identities, retry, journalStore } = input
  const retryVerified =
    retry !== undefined && retry.previousChecksum === state.checksum && retry.checksum === checksum
  if (retryVerified) {
    // --retry checked the file's statements; apply indexes the statements the
    // plugins returned, so check those too.
    const check = verifyRetryEdit(state.operations, identities)
    if (!check.ok) throw retryMismatchError(file, check)
    debug('migrate', `${file}: --retry accepted checksum ${state.checksum} → ${checksum}`)
  } else if (hasStatementProgress(state)) {
    throw inProgressChecksumMismatchError({
      migration: file,
      journalChecksum: state.checksum,
      fileChecksum: checksum,
      async: false,
    })
  } else {
    input.log(
      `${file} changed since its last failed attempt; no statement is recorded as completed, so it runs again from statement 1.`,
    )
  }
  const rebased = rebaseInProgressState(state, { checksum, identities, appliedAt: isoWithoutZone(new Date()) })
  const resolved = await assertRecordedAttemptsResolved(input.db, journalStore, file, state, rebased, input.sqlByFingerprint, input.log)
  await journalStore.writeMigrationState(rebased)
  return resolved
}


// Every async attempt the journal records, the ones the re-key would drop
// included, must have an outcome the edit can act on before it is accepted,
// read against the identity it was recorded with (#767). An attempt still
// running, one whose outcome is unknown, and one that finished but whose
// record the edit drops (its statement would run again) stop the run here,
// with the journal as it was and nothing run. A dropped record is otherwise
// the only trace of an attempt under a random id (#701).
async function assertRecordedAttemptsResolved(
  db: ClickHouseExecutor,
  journalStore: JournalStore,
  file: string,
  state: MigrationRowState,
  rebased: MigrationRowState,
  /** The statements this run has, by fingerprint: a record's own SQL, when it is one of them. */
  sqlByFingerprint: ReadonlyMap<string, string>,
  log: (line: string) => void,
): Promise<Map<number, KnownOutcome>> {
  const resolved = new Map<number, KnownOutcome>()
  for (const op of state.operations) {
    if (op.status === 'completed' || op.queryId === '') continue
    const sql = op.fingerprint === '' ? undefined : sqlByFingerprint.get(op.fingerprint)
    const recorded = await resolveRecordedAttempt({ db, journalStore, migrationName: file, op, fingerprint: op.fingerprint, sql, queryId: op.queryId, operationType: op.operationType, log, sleep: defaultSleep })
    if (recorded.kind === 'running') throw attemptStillRunningError(file, op)
    const dropped = !rebased.operations.includes(op)
    const reason =
      recorded.kind === 'unknown'
        ? recorded.reason
        : recorded.kind === 'finished' && dropped
          ? 'it finished on the server, but the edit drops its record, so the edited statement would run again'
          : undefined
    if (reason !== undefined) {
      throw outcomeUnknownError({ operationType: op.operationType, statementIndex: op.operationIndex, migrationName: file, queryId: op.queryId, reason })
    }
    if (!dropped) resolved.set(op.operationIndex, { op, recorded })
  }
  return resolved
}

function attemptStillRunningError(file: string, op: OperationState): MigrateError {
  return new MigrateError(
    'retry_mismatch',
    `Cannot apply ${file}: the earlier attempt of statement ${op.operationIndex + 1} (query_id ${op.queryId}) is still running on the server, and continuing would discard its query id. ${stopRunningAdvice(op.queryId)}`,
  )
}

