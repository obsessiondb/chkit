import type { ParsedFlags } from '../../plugins.js'
import type {
  MigrationRowState,
  OperationState,
  OperationStatus,
} from '../../runtime/journal-store.js'
import type { MigrationOperationSummary } from '../../runtime/safety-markers.js'
import { MigrateError } from './errors.js'

export interface RecoveryTargets {
  /** `--retry <migration>` as a file name. */
  retryTarget: string | undefined
  /** `--abandon <migration>` as a file name. */
  abandonTarget: string | undefined
}

export interface StatementIdentity {
  type: string
  key: string
  /** False for a statement without an `-- operation:` marker, matched by position only. */
  marked: boolean
}

export interface OperationMismatch {
  /** 1-based statement number. */
  statement: number
  /** `completed`, or `started` for an async statement that may still be running. */
  status: OperationStatus
  queryId: string
  recorded: { type: string; key: string }
  /** null when the edited file has no statement at that position. */
  current: { type: string; key: string } | null
}

/**
 * A marker that a completed statement shares with other statements, which the
 * edited file carries on fewer statements than the journal recorded.
 */
export interface SharedMarkerMismatch {
  type: string
  key: string
  /** The statements the journal recorded with this marker (1-based), in file order. */
  recorded: Array<{ statement: number; status: OperationStatus }>
  /** How many statements of the edited file carry the marker. */
  currentCount: number
}

export type RetryEditCheck =
  | {
      ok: true
      completed: number
      unmarkedCompleted: number
      /** 0-based index of the first statement that did not complete; null when all did. */
      resumeIndex: number | null
    }
  | { ok: false; mismatches: OperationMismatch[]; sharedMarkers: SharedMarkerMismatch[] }

/** Flags that mean nothing next to --abandon, which only changes the journal. */
const ABANDON_CONFLICTING_FLAGS = ['--retry', '--table', '--allow-destructive'] as const

/** Read --retry and --abandon; usage errors surface before any connection is made. */
export function resolveRecoveryTargets(flags: ParsedFlags): RecoveryTargets {
  const retryRaw = flags['--retry']
  const abandonRaw = flags['--abandon']
  const retryTarget = typeof retryRaw === 'string' ? normalizeMigrationName(retryRaw, '--retry') : undefined
  const abandonTarget =
    typeof abandonRaw === 'string' ? normalizeMigrationName(abandonRaw, '--abandon') : undefined
  if (abandonTarget !== undefined) {
    const conflicts = ABANDON_CONFLICTING_FLAGS.filter(
      (name) => flags[name] !== undefined && flags[name] !== false,
    )
    if (conflicts.length > 0) {
      throw new MigrateError(
        'invalid_usage',
        `--abandon cannot be combined with ${conflicts.join(', ')}. It only resets the journal state of one migration and applies nothing.`,
      )
    }
  }
  return { retryTarget, abandonTarget }
}

/** `name`, `name.sql` or a path to the file → `name.sql`. */
export function normalizeMigrationName(raw: string, flag: '--retry' | '--abandon'): string {
  const base = raw.trim().split(/[\\/]/).pop()?.trim() ?? ''
  if (base === '' || base === '.sql') {
    throw new MigrateError(
      'invalid_usage',
      `${flag} requires a migration file name, for example ${flag} 20260101000000_add_users.sql.`,
    )
  }
  return base.endsWith('.sql') ? base : `${base}.sql`
}

/** The (type, key) the journal records for statement `index`; apply and --retry share it. */
export function statementIdentity(
  operations: readonly MigrationOperationSummary[],
  index: number,
): StatementIdentity {
  const operation = operations[index]
  return operation === undefined
    ? { type: 'sql_statement', key: `statement:${index}`, marked: false }
    : { type: operation.type, key: operation.key, marked: true }
}

export function statementIdentities(
  operations: readonly MigrationOperationSummary[],
  statementCount: number,
): StatementIdentity[] {
  return Array.from({ length: statementCount }, (_, index) => statementIdentity(operations, index))
}

/**
 * Whether --retry may resume an in-progress migration with an edited file.
 * apply skips completed statements and re-attaches a running async statement
 * by position, so each of them must keep its position and operation marker.
 * The journal records only type and key per statement, not its SQL.
 */
export function verifyRetryEdit(
  operations: readonly OperationState[],
  identities: readonly StatementIdentity[],
): RetryEditCheck {
  const bound = operations
    .filter(isBoundToPosition)
    .sort((a, b) => a.operationIndex - b.operationIndex)
  const mismatches: OperationMismatch[] = []
  let completed = 0
  let unmarkedCompleted = 0
  for (const op of bound) {
    const current = identities[op.operationIndex]
    if (current === undefined || !sameIdentity(current, op)) {
      mismatches.push({
        statement: op.operationIndex + 1,
        status: op.status,
        queryId: op.queryId,
        recorded: markerOf(op),
        current: current === undefined ? null : { type: current.type, key: current.key },
      })
      continue
    }
    if (op.status !== 'completed') continue
    completed += 1
    if (!current.marked) unmarkedCompleted += 1
  }
  const sharedMarkers = findSharedMarkerMismatches(operations, identities, mismatches)
  if (mismatches.length > 0 || sharedMarkers.length > 0) return { ok: false, mismatches, sharedMarkers }
  const done = new Set(
    operations.filter((op) => op.status === 'completed').map((op) => op.operationIndex),
  )
  const resumeIndex = identities.findIndex((_, index) => !done.has(index))
  return { ok: true, completed, unmarkedCompleted, resumeIndex: resumeIndex === -1 ? null : resumeIndex }
}

export function retryMismatchError(
  migration: string,
  check: { mismatches: readonly OperationMismatch[]; sharedMarkers: readonly SharedMarkerMismatch[] },
): MigrateError {
  const { mismatches, sharedMarkers } = check
  const lines = mismatches.map((mismatch) => {
    const { statement, recorded, current } = mismatch
    const label =
      mismatch.status === 'completed'
        ? `completed as ${recorded.type} ${recorded.key}`
        : `started as ${recorded.type} ${recorded.key} (async query_id ${mismatch.queryId})`
    const found =
      current === null
        ? `the edited file has no statement ${statement}`
        : `the edited file has ${current.type} ${current.key} there`
    return `  statement ${statement}: ${label}, but ${found}`
  })
  const sharedLines = sharedMarkers.map((shared) => {
    const statements = joinWithAnd(shared.recorded.map(({ statement, status }) => `${statement} (${status})`))
    const count = `${shared.currentCount} statement${shared.currentCount === 1 ? '' : 's'}`
    return `  statements ${statements} share ${shared.type} ${shared.key}, but the edited file has ${count} with that marker`
  })
  const sharedHint =
    sharedMarkers.length === 0
      ? ''
      : "\nStatements that share a marker, such as a column's REMOVE DEFAULT and the MODIFY COLUMN after it, are told apart only by position, so chkit cannot tell which one the edit removed. Keep each of them and edit only the one that failed."
  const running = mismatches.filter((mismatch) => mismatch.status === 'started')
  const runningHint = running.map(
    (mismatch) =>
      `\nStatement ${mismatch.statement} may still be running on the server. Wait for it to finish or run KILL QUERY WHERE query_id = '${mismatch.queryId}' before you abandon the partial run.`,
  )
  return new MigrateError(
    'retry_mismatch',
    `Cannot retry ${migration}: statements that completed or may still be running no longer match the edited file.\n` +
      `${[...lines, ...sharedLines].join('\n')}\n` +
      'chkit skips completed statements and re-attaches running async statements by position, so they must keep their position and operation marker.' +
      sharedHint +
      runningHint.join('') +
      `\nRestore them, or discard the partial run so the next apply starts the file over: chkit migrate --apply --abandon ${migration}`,
  )
}

/**
 * Re-key an in-progress state to an edited file. Completed statements stay
 * recorded (--retry verified them). A failed or started statement stays only
 * if the same operation still sits at its index, so a retry keeps its
 * `-- before-retry:` compensation and query id; any other record is dropped.
 */
export function rebaseInProgressState(
  state: MigrationRowState,
  input: { checksum: string; identities: readonly StatementIdentity[]; appliedAt: string },
): MigrationRowState {
  const operations = state.operations.filter((op) => {
    if (op.status === 'completed') return true
    const current = input.identities[op.operationIndex]
    return current !== undefined && sameIdentity(current, op)
  })
  return { ...state, checksum: input.checksum, appliedAt: input.appliedAt, operations }
}

/** Whether any statement of an in-progress state completed or may have run. */
export function hasStatementProgress(state: MigrationRowState): boolean {
  return state.operations.some((op) => op.status === 'completed' || op.status === 'started')
}

/**
 * Statements can share a marker: a column's generated `REMOVE DEFAULT` or
 * `REMOVE MATERIALIZED` carries the type and key of the MODIFY COLUMN after
 * it. When a completed statement holds such a marker and the edited file
 * carries it on fewer statements than the journal recorded, the position
 * check cannot tell which one the edit removed: deleting the completed REMOVE
 * slides the MODIFY into its slot, where apply would skip it as completed.
 * A marker that a positional mismatch already reports is left out.
 */
function findSharedMarkerMismatches(
  operations: readonly OperationState[],
  identities: readonly StatementIdentity[],
  mismatches: readonly OperationMismatch[],
): SharedMarkerMismatch[] {
  const markers = operations
    .filter(isBoundToPosition)
    .map(markerOf)
    .filter((marker, index, all) => all.findIndex((other) => sameMarker(other, marker)) === index)
    .filter((marker) => !mismatches.some((mismatch) => sameMarker(mismatch.recorded, marker)))
  return markers.flatMap((marker) => {
    const recorded = operations
      .filter((op) => sameMarker(markerOf(op), marker))
      .sort((a, b) => a.operationIndex - b.operationIndex)
      .map((op) => ({ statement: op.operationIndex + 1, status: op.status }))
    const currentCount = identities.filter((identity) => sameMarker(identity, marker)).length
    return currentCount < recorded.length ? [{ ...marker, recorded, currentCount }] : []
  })
}

// A completed statement, or an async statement whose query may still be running.
function isBoundToPosition(op: OperationState): boolean {
  return op.status === 'completed' || (op.status === 'started' && op.queryId !== '')
}

function sameIdentity(identity: StatementIdentity, op: OperationState): boolean {
  return sameMarker(identity, markerOf(op))
}

function markerOf(op: OperationState): { type: string; key: string } {
  return { type: op.operationType, key: op.operationKey }
}

function sameMarker(a: { type: string; key: string }, b: { type: string; key: string }): boolean {
  return a.type === b.type && a.key === b.key
}

/** `['1', '2', '3']` → `1, 2 and 3`. */
function joinWithAnd(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
