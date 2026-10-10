import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { waitForDDLPropagation, type ClickHouseExecutor } from '@chkit/clickhouse'
import type { ResolvedChxConfig } from '@chkit/core'

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
} from '../../runtime/safety-markers.js'
import {
  applyAsyncStatement,
  freshMigrationState,
  isoWithoutZone,
  upsertOperation,
} from './async-apply.js'
import { inProgressChecksumMismatchError } from './errors.js'
import {
  hasStatementProgress,
  rebaseInProgressState,
  retryMismatchError,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One-line, length-capped preview of a SQL statement for error messages. */
export function previewStatement(sql: string, max = 120): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
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

function syncOperationState(
  index: number,
  operationType: string,
  operationKey: string,
  status: OperationStatus,
  lastError = '',
): OperationState {
  const timestamp = isoWithoutZone(new Date())
  return {
    operationIndex: index,
    operationKey,
    operationType,
    queryId: '',
    status,
    startedAt: timestamp,
    finishedAt: status === 'started' ? null : timestamp,
    lastError,
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
  /** Set when --retry verified an edit of this in-progress migration before the run (#233). */
  retry?: { previousChecksum: string; checksum: string }
  /** Progress lines; the command sends them to stderr in --json mode. */
  log?: (line: string) => void
}): Promise<MigrationJournalEntry> {
  const { db, journalStore, pluginRuntime, config, tableScope, flags, migrationsDir, file, retry } = input
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

  const migrationChecksum = checksumSQL(sql)

  // Resume support (#6): if a prior run left per-statement journal state for
  // this migration, statements already marked completed are skipped instead of
  // replayed — so a partial failure no longer bricks the migration on re-run
  // with "column already exists". Resuming across a file edit needs care (#233).
  const initialState = await journalStore.readMigrationState(file)
  if (
    initialState !== null &&
    !initialState.migrationCompleted &&
    initialState.checksum !== migrationChecksum
  ) {
    await acceptEditedMigration({
      file,
      state: initialState,
      checksum: migrationChecksum,
      identities: statementIdentities(operationSummaries, statements.length),
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
          beforeRetry: operation.beforeRetry,
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
    if (operationIsCompleted(stateBefore, i)) {
      debug('migrate', `${file}#${i}: already completed in a prior run — skipping`)
      continue
    }
    const { type: opType, key: opKey } = statementIdentity(operationSummaries, i)
    const baseState = stateBefore ?? freshMigrationState(file, migrationChecksum)
    await journalStore.writeMigrationState(
      upsertOperation(baseState, syncOperationState(i, opType, opKey, 'started'), Date.now),
    )
    try {
      await db.command(statement)
    } catch (error) {
      const stateOnError = (await journalStore.readMigrationState(file)) ?? baseState
      await journalStore.writeMigrationState(
        upsertOperation(
          stateOnError,
          syncOperationState(i, opType, opKey, 'failed', errorMessage(error)),
          Date.now,
        ),
      )
      throw statementError({ file, index: i, total: statements.length, statement, error })
    }
    // Mark completed as soon as the statement has executed — BEFORE waiting for
    // DDL propagation. The statement already ran, so if the propagation wait
    // later times out and throws, a re-run must skip this statement rather than
    // replay it into an "already exists" error (the brick this fix prevents).
    const stateAfter = (await journalStore.readMigrationState(file)) ?? baseState
    await journalStore.writeMigrationState(
      upsertOperation(stateAfter, syncOperationState(i, opType, opKey, 'completed'), Date.now),
    )
    if (operation) {
      await waitForDDLPropagation(db, operation.type, operation.key, { cluster: config.clickhouse?.cluster })
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

// An in-progress migration whose file changed resumes when this run's --retry
// verified the edit, or when no statement is recorded as completed or started
// (the first statement failed, or --abandon marked every statement failed):
// the file then runs again from statement 1. The state is re-keyed to the new
// checksum before anything runs, so a later failure resumes without --retry.
async function acceptEditedMigration(input: {
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
  await journalStore.writeMigrationState(
    rebaseInProgressState(state, { checksum, identities, appliedAt: isoWithoutZone(new Date()) }),
  )
}
