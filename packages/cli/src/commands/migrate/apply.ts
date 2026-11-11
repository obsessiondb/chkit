import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertNoFireAndForgetAsyncInserts,
  parseExchangeTables,
  waitForDDLPropagation,
  waitForExchange,
  waitForInsertBarrier,
  type ClickHouseExecutor,
  type ClickHouseSettings,
  type QualifiedTable,
  type QueryStatus,
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
import { checksumSQL, type MigrationJournalEntry } from '../../runtime/migration-store.js'
import {
  extractExecutableStatements,
  extractMigrationOperationSummaries,
  findNonSelectBarriers,
  type MigrationOperationSummary,
} from '../../runtime/safety-markers.js'
import { CLI_VERSION } from '../../runtime/version.js'
import {
  applyAsyncStatement,
  freshMigrationState,
  isoWithoutZone,
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
  if (
    initialState !== null &&
    !initialState.migrationCompleted &&
    initialState.checksum !== migrationChecksum
  ) {
    await acceptEditedMigration({
      db,
      file,
      state: initialState,
      checksum: migrationChecksum,
      identities: statementIdentities(operationSummaries, fingerprints),
      retry,
      journalStore,
      log,
    })
  }

  for (let i = 0; i < statements.length; i++) {
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
          beforeRetry: operation.beforeRetry,
          settings,
          log,
        })
      } catch (error) {
        throw statementError({ file, index: i, total: statements.length, statement, error })
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
    if (priorAttempt !== undefined && operation?.beforeRetry) {
      try {
        await runBeforeRetry(db, operation.type, statement, operation.beforeRetry, {
          cluster: config.clickhouse?.cluster,
          settings,
          log,
          status: priorAttempt.status,
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
        await db.command(statement, settings)
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
  },
): Promise<void> {
  if (operationType === 'exchange_tables') {
    await waitForExchange(db, statement, { cluster: options.cluster })
  }
  options.log(`  ${operationType}: an earlier attempt ${options.status === 'failed' ? 'failed' : 'was interrupted'} — running before-retry SQL`)
  await db.command(beforeRetry, options.settings)
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
  retry: { previousChecksum: string; checksum: string } | undefined
  journalStore: JournalStore
  log: (line: string) => void
}): Promise<void> {
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
  await assertDroppedAttemptsStopped(input.db, file, state, rebased)
  await journalStore.writeMigrationState(rebased)
}

// An async retry runs under a random query id (#701), so the record a rebase
// drops is the only trace of an attempt that may still run (a submit that
// failed while the server ran it, an attempt kept by --abandon): the next run
// would not find it. Every replica is read, and an edit stops while one runs.
async function assertDroppedAttemptsStopped(
  db: ClickHouseExecutor,
  file: string,
  state: MigrationRowState,
  rebased: MigrationRowState,
): Promise<void> {
  const dropped = state.operations.filter(
    (op) => op.status !== 'completed' && op.queryId !== '' && !rebased.operations.includes(op),
  )
  for (const op of dropped) {
    let status: QueryStatus
    try {
      status = await db.queryStatus(op.queryId, { everyReplica: true, runningOnly: true })
    } catch (error) {
      throw new Error(
        `Cannot apply the edited ${file}: could not check whether the earlier attempt of statement ${op.operationIndex + 1} (query_id ${op.queryId}) is still running (${error instanceof Error ? error.message : String(error)}). Nothing ran — re-run chkit migrate --apply.`,
        { cause: error },
      )
    }
    if (status.status === 'running') {
      throw new MigrateError(
        'retry_mismatch',
        `Cannot apply the edited ${file}: the earlier attempt of statement ${op.operationIndex + 1} (query_id ${op.queryId}) is still running on the server, and the edit changed that statement's operation. Wait for it to finish or run KILL QUERY WHERE query_id = '${op.queryId}', then run chkit migrate --apply again.`,
      )
    }
  }
}
