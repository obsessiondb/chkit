import type { ParsedFlags } from '../../plugins.js'
import type {
  MigrationRowState,
  OperationState,
  OperationStatus,
} from '../../runtime/journal-store.js'
import type { MigrationOperationSummary } from '../../runtime/safety-markers.js'
import { MigrateError, recordedStatementsChangedError } from './errors.js'

export interface RecoveryTargets {
  /** `--retry <migration>` as a file name. */
  retryTarget: string | undefined
  /** `--abandon <migration>` as a file name. */
  abandonTarget: string | undefined
  /** `--mark-applied <migration>` or `--mark-not-applied <migration>`. */
  markTarget: { migration: string; outcome: 'applied' | 'not-applied' } | undefined
}

export interface StatementMarker {
  type: string
  key: string
  /** False for a statement without an `-- operation:` marker, matched by position only. */
  marked: boolean
}

export interface StatementIdentity extends StatementMarker {
  /**
   * The `statementFingerprint` of the statement; undefined when its SQL
   * cannot be checked yet, because a plugin's onBeforeApply may still rewrite it.
   */
  fingerprint: string | undefined
  /**
   * The marker releases before #831 gave the statement, when it differs: they
   * paired the n-th marker of the file with the n-th statement, and the
   * journal names the marker they gave each statement they ran.
   */
  legacy?: StatementMarker
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
  /** The marker matches, but the statement's SQL is not the one that ran (#599). */
  sqlChanged: boolean
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
      /** The unmarked ones the journal recorded without a fingerprint: matched by position only. */
      positionOnlyCompleted: number
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
  return { retryTarget, abandonTarget, markTarget: resolveMarkTarget(flags) }
}

/** Flags that mean nothing next to --mark-applied or --mark-not-applied, which only change the journal. */
const MARK_CONFLICTING_FLAGS = ['--retry', '--abandon', '--table', '--allow-destructive', '--cancel-lock-queries'] as const

function resolveMarkTarget(flags: ParsedFlags): RecoveryTargets['markTarget'] {
  const applied = flags['--mark-applied']
  const notApplied = flags['--mark-not-applied']
  if (typeof applied === 'string' && typeof notApplied === 'string') {
    throw new MigrateError('invalid_usage', '--mark-applied and --mark-not-applied cannot be combined: each records one outcome of the stopped statement.')
  }
  const flag = typeof applied === 'string' ? '--mark-applied' : typeof notApplied === 'string' ? '--mark-not-applied' : undefined
  if (flag === undefined) return undefined
  const migration = normalizeMigrationName(String(flags[flag]), flag)
  const conflicts = MARK_CONFLICTING_FLAGS.filter((name) => flags[name] !== undefined && flags[name] !== false)
  if (conflicts.length > 0) {
    throw new MigrateError(
      'invalid_usage',
      `${flag} cannot be combined with ${conflicts.join(', ')}. It only records the outcome of one statement in the journal and applies nothing.`,
    )
  }
  return { migration, outcome: flag === '--mark-applied' ? 'applied' : 'not-applied' }
}

/** `name`, `name.sql` or a path to the file → `name.sql`. */
export function normalizeMigrationName(raw: string, flag: '--retry' | '--abandon' | '--mark-applied' | '--mark-not-applied'): string {
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
  operations: ReadonlyArray<MigrationOperationSummary | undefined>,
  index: number,
): StatementMarker {
  const operation = operations[index]
  return operation === undefined
    ? { type: 'sql_statement', key: `statement:${index}`, marked: false }
    : { type: operation.type, key: operation.key, marked: true }
}

/**
 * One identity per statement; `fingerprints` has one entry per statement.
 * `operations` has the marker of each statement (`extractStatementOperations`),
 * `legacyOperations` the file's markers in order, as releases before #831
 * paired them (`extractMigrationOperationSummaries`).
 */
export function statementIdentities(
  operations: ReadonlyArray<MigrationOperationSummary | undefined>,
  fingerprints: ReadonlyArray<string | undefined>,
  legacyOperations: readonly MigrationOperationSummary[],
): StatementIdentity[] {
  return fingerprints.map((fingerprint, index) => {
    const identity = statementIdentity(operations, index)
    const legacy = statementIdentity(legacyOperations, index)
    return sameMarker(identity, legacy) ? { ...identity, fingerprint } : { ...identity, fingerprint, legacy }
  })
}

/**
 * Whether --retry may resume an in-progress migration with an edited file.
 * apply skips completed statements and re-attaches a running async statement
 * by position, so each of them must keep its position, operation marker and,
 * where the journal recorded its fingerprint, its SQL (#599). A record from
 * an older release has no fingerprint and is matched by position and marker.
 *
 * The records of a release before #831 name the markers it paired by order.
 * When the statements' own markers do not match them, every record is checked
 * against that pairing instead, as a whole, so a marker that several statements
 * share keeps its count (#831).
 */
export function verifyRetryEdit(
  operations: readonly OperationState[],
  identities: readonly StatementIdentity[],
): RetryEditCheck {
  const own = checkRetryEdit(operations, identities)
  if (own.ok || !identities.some((identity) => identity.legacy !== undefined)) return own
  const legacy = checkRetryEdit(
    operations,
    identities.map((identity) => (identity.legacy ? { ...identity.legacy, fingerprint: identity.fingerprint } : identity)),
  )
  return legacy.ok ? legacy : own
}

function checkRetryEdit(
  operations: readonly OperationState[],
  identities: readonly StatementIdentity[],
): RetryEditCheck {
  const bound = operations
    .filter(isBoundToPosition)
    .sort((a, b) => a.operationIndex - b.operationIndex)
  const mismatches: OperationMismatch[] = []
  let completed = 0
  let unmarkedCompleted = 0
  let positionOnlyCompleted = 0
  for (const op of bound) {
    const current = identities[op.operationIndex]
    if (current === undefined || !sameMarker(current, markerOf(op)) || !sameSql(current, op)) {
      mismatches.push({
        statement: op.operationIndex + 1,
        status: op.status,
        queryId: op.queryId,
        recorded: markerOf(op),
        current: current === undefined ? null : { type: current.type, key: current.key },
        sqlChanged: current !== undefined && sameMarker(current, markerOf(op)),
      })
      continue
    }
    if (op.status !== 'completed') continue
    completed += 1
    if (current.marked) continue
    unmarkedCompleted += 1
    // A recorded fingerprint is checked here, or by apply once plugins have
    // rewritten the statements.
    if (op.fingerprint === '') positionOnlyCompleted += 1
  }
  const sharedMarkers = findSharedMarkerMismatches(operations, identities, mismatches)
  if (mismatches.length > 0 || sharedMarkers.length > 0) return { ok: false, mismatches, sharedMarkers }
  const done = new Set(
    operations.filter((op) => op.status === 'completed').map((op) => op.operationIndex),
  )
  const resumeIndex = identities.findIndex((_, index) => !done.has(index))
  return {
    ok: true,
    completed,
    unmarkedCompleted,
    positionOnlyCompleted,
    resumeIndex: resumeIndex === -1 ? null : resumeIndex,
  }
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
        : mismatch.sqlChanged
          ? 'the edited file has different SQL there'
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
      'chkit skips completed statements and re-attaches running async statements by position, so they must keep their position, operation marker and SQL (comments and whitespace may change).' +
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
 * A record under the marker a release before #831 gave the statement stays
 * too when it is an attempt of this statement: an async attempt --retry
 * matched, or one the journal recorded with the statement's SQL. Another
 * statement's record never passes on its compensation (#831).
 */
export function rebaseInProgressState(
  state: MigrationRowState,
  input: { checksum: string; identities: readonly StatementIdentity[]; appliedAt: string },
): MigrationRowState {
  const operations = state.operations.filter((op) => {
    if (op.status === 'completed') return true
    const current = input.identities[op.operationIndex]
    if (current === undefined) return false
    if (sameMarker(current, markerOf(op))) return true
    if (current.legacy === undefined || !sameMarker(current.legacy, markerOf(op))) return false
    return isBoundToPosition(op) || (op.fingerprint !== '' && op.fingerprint === current.fingerprint)
  })
  return { ...state, checksum: input.checksum, appliedAt: input.appliedAt, operations }
}

/**
 * The statements (1-based) of an in-progress state that completed or started
 * at a position where the split before #562 and the current split of the file
 * give different statements. A state recorded with the old split would resume
 * at the wrong statements there: skip one that never ran, or run one again.
 *
 * The journal indexes the statements onBeforeApply returns. They keep the
 * positions of the split only when the plugins returned them unchanged; when
 * a plugin added, removed, moved or rewrote any, the positions cannot be
 * matched, so every recorded statement counts as changed once the two splits
 * differ. A statement recorded with its fingerprint is checked by
 * `recordedStatementMismatches` instead (#599).
 */
export function splitChangedStatements(
  operations: readonly OperationState[],
  splits: { legacy: readonly string[]; current: readonly string[]; positionsKept: boolean },
): number[] {
  const { legacy, current, positionsKept } = splits
  const same = legacy.length === current.length && legacy.every((statement, index) => statement === current[index])
  if (same) return []
  return operations
    .filter((op) => (op.status === 'completed' || op.status === 'started') && op.fingerprint === '')
    .filter((op) => !positionsKept || legacy[op.operationIndex] !== current[op.operationIndex])
    .map((op) => op.operationIndex + 1)
    .sort((a, b) => a - b)
}

/**
 * The statements (1-based) that an in-progress state records as completed,
 * or as a running async statement, with a fingerprint that the statement at
 * that position no longer has (#599). `fingerprints` holds one per statement
 * this run would execute. apply would skip or re-attach those statements by
 * position, though they are not the statements that ran.
 */
export function recordedStatementMismatches(
  operations: readonly OperationState[],
  fingerprints: readonly string[],
): number[] {
  return operations
    .filter((op) => isBoundToPosition(op) && op.fingerprint !== '')
    .filter((op) => fingerprints[op.operationIndex] !== op.fingerprint)
    .map((op) => op.operationIndex + 1)
    .sort((a, b) => a - b)
}

/**
 * Throws when the journal records statement `index` as completed with a
 * fingerprint the statement this run would skip does not have (#599). Every
 * skip checks the record it reads, not only the state the run started with:
 * a later read can return a version the first check never saw.
 */
export function assertCompletedStatement(
  state: MigrationRowState,
  input: { migration: string; index: number; fingerprint: string; cliVersion: string },
): void {
  const recorded = state.operations.find(
    (op) => op.operationIndex === input.index && op.status === 'completed',
  )
  if (recorded === undefined || recorded.fingerprint === '' || recorded.fingerprint === input.fingerprint) return
  throw recordedStatementsChangedError({
    migration: input.migration,
    statements: [input.index + 1],
    recordedBy: state.chkitVersion,
    cliVersion: input.cliVersion,
  })
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

// A record without a fingerprint, or a statement that cannot be checked yet,
// is matched by position and marker only.
function sameSql(identity: StatementIdentity, op: OperationState): boolean {
  return op.fingerprint === '' || identity.fingerprint === undefined || identity.fingerprint === op.fingerprint
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
