import { setTimeout as defaultSleep } from 'node:timers/promises'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import type { JournalStore, MigrationRowState, OperationState } from '../../runtime/journal-store.js'
import { abandonedError, readAbandonableState, type ReportedOperation } from './abandon.js'
import { finishedRecordOf, isoWithoutZone, resolveRecordedAttempt, stopRunningAdvice } from './async-apply.js'
import { MigrateError, journalChangedError } from './errors.js'

/** What the operator says about the attempt chkit could not resolve (#824). */
export type MarkedOutcome = 'applied' | 'not-applied'

export interface MarkTarget {
  migration: string
  outcome: MarkedOutcome
}

export interface MarkReport {
  migration: string
  outcome: MarkedOutcome
  /** The stopped statement's record before the mark. */
  operation: ReportedOperation
}

interface MarkDeps {
  db: ClickHouseExecutor
  journalStore: JournalStore
  log: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * The async statement of `migration` whose attempt has no known outcome
 * (async_outcome_unknown), read on every replica as an apply reads it. Refuses
 * while the attempt runs on any replica, when chkit can tell its outcome
 * itself, and when more than one statement has no known outcome.
 */
export async function readStoppedStatement(
  input: { migration: string; appliedNames: ReadonlySet<string>; flag: string },
  deps: MarkDeps,
): Promise<{ state: MigrationRowState; op: OperationState }> {
  const { migration, flag } = input
  const state = await readAbandonableState({ migration, appliedNames: input.appliedNames }, deps, flag)
  const unknown: OperationState[] = []
  for (const op of state.operations) {
    if (op.status === 'completed' || op.queryId === '') continue
    const recorded = await resolveRecordedAttempt({
      db: deps.db,
      journalStore: deps.journalStore,
      migrationName: migration,
      op,
      fingerprint: op.fingerprint,
      sql: undefined,
      queryId: op.queryId,
      operationType: op.operationType,
      log: deps.log,
      sleep: deps.sleep ?? defaultSleep,
    })
    if (recorded.kind === 'running') {
      throw new MigrateError(
        'async_outcome_unknown',
        `Cannot ${flag} ${migration}: statement ${op.operationIndex + 1} (query_id ${op.queryId}) is still running on the server, so its outcome is not known yet. Nothing was changed. ${stopRunningAdvice(op.queryId)}`,
      )
    }
    if (recorded.kind === 'unknown') unknown.push(op)
  }
  const [op, ...more] = unknown
  if (op === undefined) {
    throw new MigrateError(
      'migration_outcome_known',
      `Cannot ${flag} ${migration}: no statement of it stopped with async_outcome_unknown, so chkit resolves its state itself. Nothing was changed; run chkit migrate --apply.`,
    )
  }
  if (more.length > 0) {
    throw new MigrateError(
      'migration_outcome_known',
      `Cannot ${flag} ${migration}: statements ${unknown.map((item) => item.operationIndex + 1).join(', ')} have no known outcome, and ${flag} acts on one. Nothing was changed; reconcile them and run chkit migrate --apply --abandon ${migration}.`,
    )
  }
  return { state, op }
}

export function markReport(target: MarkTarget, op: OperationState): MarkReport {
  const { fingerprint: _fingerprint, attemptFenced: _attemptFenced, ...operation } = op
  return { migration: target.migration, outcome: target.outcome, operation }
}

/**
 * Records the operator's outcome for the stopped statement only. Applied: it
 * is completed, and the next apply continues after it. Not applied: it is
 * failed as an abandon records it, so the next apply runs its before-retry SQL
 * and submits it again. The other statements keep their records.
 */
export async function markStoppedStatement(
  state: MigrationRowState,
  op: OperationState,
  outcome: MarkedOutcome,
  deps: { journalStore: JournalStore; now?: () => number },
): Promise<void> {
  const nowMs = deps.now ?? Date.now
  const now = isoWithoutZone(new Date(nowMs()))
  const marked: OperationState =
    outcome === 'applied'
      ? finishedRecordOf(op, nowMs)
      : { ...op, status: 'failed', finishedAt: now, lastError: abandonedError(op.status) }
  await deps.journalStore.writeMigrationState({
    ...state,
    appliedAt: now,
    migrationCompleted: false,
    operations: state.operations.map((item) => (item.operationIndex === op.operationIndex ? marked : item)),
  })
}

/** Re-reads and re-resolves the stopped statement under the lock, then marks it. */
export async function markUnderLock(
  target: MarkTarget,
  shown: { state: MigrationRowState; op: OperationState },
  input: { appliedNames: ReadonlySet<string>; flag: string },
  deps: MarkDeps,
): Promise<void> {
  const current = await readStoppedStatement({ migration: target.migration, appliedNames: input.appliedNames, flag: input.flag }, deps)
  if (current.state.appliedAt !== shown.state.appliedAt || current.op.queryId !== shown.op.queryId) {
    throw journalChangedError(`the journal state of ${target.migration} is no longer the one shown`)
  }
  await markStoppedStatement(current.state, current.op, target.outcome, deps)
}

export function renderMarkText(report: MarkReport, performed: boolean): void {
  const { migration, operation } = report
  const statement = `statement ${operation.operationIndex + 1} of ${migration} (${operation.operationType}, query_id ${operation.queryId})`
  const next =
    report.outcome === 'applied'
      ? 'the next chkit migrate --apply records it as completed and continues after it'
      : 'the next chkit migrate --apply runs its before-retry SQL, when it has one, and submits it again'
  console.log(
    performed
      ? `Marked ${statement} as ${report.outcome}: ${next}. The statements recorded as completed do not run again.`
      : `Marking ${statement} as ${report.outcome} means ${next}. The statements recorded as completed do not run again. Nothing has changed yet.`,
  )
  if (!performed) console.log(`\nPlan only. Re-run with --apply to mark it ${report.outcome}.`)
}
