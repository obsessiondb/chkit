import type {
  JournalStore,
  MigrationRowState,
  OperationState,
  OperationStatus,
} from '../../runtime/journal-store.js'
import { isoWithoutZone } from './async-apply.js'
import { MigrateError } from './errors.js'

/** What --abandon reports, before and after it resets the journal state. */
export interface AbandonReport {
  migration: string
  /** Checksum recorded for the failed attempt. */
  checksum: string
  /** Statements that completed, including those an earlier --abandon marked failed. */
  completedStatements: number
  /** The recorded per-statement progress, sorted by statement index. */
  operations: OperationState[]
}

const OPERATION_STATUSES: readonly OperationStatus[] = ['completed', 'failed', 'started']

/** Read the in-progress state --abandon <migration> resets; throws when there is none. */
export async function readAbandonableState(
  input: { migration: string; appliedNames: ReadonlySet<string> },
  deps: { journalStore: JournalStore },
): Promise<MigrationRowState> {
  const { migration } = input
  if (input.appliedNames.has(migration)) throw alreadyAppliedError(migration)
  const state = await deps.journalStore.readMigrationState(migration)
  if (state === null) {
    throw new MigrateError(
      'migration_not_in_progress',
      `Cannot abandon ${migration}: the journal has no in-progress state for it.`,
    )
  }
  if (state.migrationCompleted) throw alreadyAppliedError(migration)
  return state
}

/**
 * Supersede an in-progress state with a version in which every recorded
 * statement failed. The next apply runs the file from statement 1: sync
 * statements run again, and async statements keep their query ids, so they
 * take the retry path (`-- before-retry:` compensation, then a resubmit).
 * Like every journal write this is an INSERT of a newer row version, so it
 * needs no DELETE privilege and leaves no mutation behind.
 */
export async function abandonMigrationState(
  state: MigrationRowState,
  deps: { journalStore: JournalStore; now?: () => number },
): Promise<void> {
  const now = isoWithoutZone(new Date((deps.now ?? Date.now)()))
  await deps.journalStore.writeMigrationState(abandonedState(state, now))
}

export function abandonReport(state: MigrationRowState): AbandonReport {
  const operations = [...state.operations].sort((a, b) => a.operationIndex - b.operationIndex)
  return {
    migration: state.name,
    checksum: state.checksum,
    completedStatements: operations.filter((op) => statusBeforeAbandon(op) === 'completed').length,
    operations,
  }
}

/**
 * The status a statement had before --abandon marked it failed, or its
 * recorded status when no abandon touched it. A statement that completed
 * before an abandon stays applied in ClickHouse.
 */
export function statusBeforeAbandon(op: OperationState): OperationStatus {
  return abandonedFrom(op) ?? op.status
}

// A statement an earlier --abandon already marked failed keeps that record,
// so abandoning again does not lose which statements had completed.
function abandonedState(state: MigrationRowState, now: string): MigrationRowState {
  return {
    ...state,
    appliedAt: now,
    migrationCompleted: false,
    operations: state.operations.map((op) =>
      abandonedFrom(op) !== undefined
        ? op
        : {
            ...op,
            status: 'failed',
            finishedAt: op.finishedAt ?? now,
            lastError: abandonedError(op.status),
          },
    ),
  }
}

/** The status before an earlier --abandon, or undefined when no abandon marked this statement. */
function abandonedFrom(op: OperationState): OperationStatus | undefined {
  if (op.status !== 'failed') return undefined
  return OPERATION_STATUSES.find((status) => op.lastError === abandonedError(status))
}

function abandonedError(previous: OperationStatus): string {
  return `abandoned via chkit migrate --abandon (was ${previous})`
}

function alreadyAppliedError(migration: string): MigrateError {
  return new MigrateError(
    'migration_already_applied',
    `Cannot abandon ${migration}: it is already applied. --abandon only resets a migration that failed part-way; to undo an applied migration, write a new migration.`,
  )
}
