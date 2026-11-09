import type { OperationState, OperationStatus } from '../../runtime/journal-store.js'

/**
 * `lastError` of a completed sync statement whose DDL propagation wait has not
 * passed yet (#513). A statement is recorded completed before its wait, so a
 * re-run never replays it; while this marker is set, a re-run waits for it
 * again before it runs the next statement. A write after the wait passes
 * clears it. --abandon replaces it, and --retry keeps it with the record.
 */
export const PROPAGATION_WAIT_PENDING = 'executed; waiting for the change to reach every replica'

/**
 * What the journal record of one statement says, decoded from its status,
 * query id and `lastError`. The record keeps its stored shape.
 */
export type StatementState =
  | { state: 'completed' }
  /** It ran; the next apply waits again for every replica before the next statement. */
  | { state: 'awaiting_replicas' }
  /** chkit stopped while this sync statement ran, so it may have run. */
  | { state: 'interrupted' }
  /** An async statement whose query may still run on the server. */
  | { state: 'running'; queryId: string }
  | { state: 'failed'; error: string }
  /** --abandon marked it failed; `was` is its status before. */
  | { state: 'abandoned'; was: OperationStatus }

const OPERATION_STATUSES: readonly OperationStatus[] = ['completed', 'failed', 'started']

export function statementState(op: OperationState): StatementState {
  switch (op.status) {
    case 'completed':
      return op.lastError === PROPAGATION_WAIT_PENDING ? { state: 'awaiting_replicas' } : { state: 'completed' }
    case 'started':
      return op.queryId === '' ? { state: 'interrupted' } : { state: 'running', queryId: op.queryId }
    default: {
      const was = OPERATION_STATUSES.find((status) => op.lastError === abandonedError(status))
      return was === undefined ? { state: 'failed', error: op.lastError } : { state: 'abandoned', was }
    }
  }
}

/** The `lastError` that --abandon records for a statement whose status was `previous`. */
export function abandonedError(previous: OperationStatus): string {
  return `abandoned via chkit migrate --abandon (was ${previous})`
}
