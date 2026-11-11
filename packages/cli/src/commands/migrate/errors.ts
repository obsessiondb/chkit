/** Stable `--json` error codes of migrate failures; `bin/chkit.ts` copies them into the error envelope. */
export type MigrateErrorCode =
  | 'invalid_usage'
  | 'migration_not_found'
  | 'migration_not_in_progress'
  | 'migration_already_applied'
  | 'retry_mismatch'
  | 'in_progress_checksum_mismatch'
  | 'statement_split_changed'
  | 'barrier_not_select'
  | 'migrate_locked'
  | 'migrate_lock_lost'
  | 'migrate_lock_unverifiable'
  | 'journal_changed'

/** A migrate failure with a stable code for `--json` consumers. */
export class MigrateError extends Error {
  readonly code: MigrateErrorCode

  constructor(code: MigrateErrorCode, message: string) {
    super(message)
    this.name = 'MigrateError'
    this.code = code
  }
}

export const EMPTY_MIGRATIONS_SUMMARY =
  'Pending migrations contain no executable statements. Add SQL statements to each file or delete it.'

/**
 * An in-progress migration whose file changed after some of its statements
 * completed or started. Without --retry, chkit cannot tell whether the
 * statements that ran still match the file.
 */
export function inProgressChecksumMismatchError(input: {
  migration: string
  journalChecksum: string
  fileChecksum: string
  async: boolean
}): MigrateError {
  const { migration } = input
  const stateLabel = input.async ? 'in-progress async journal state' : 'in-progress journal state'
  return new MigrateError(
    'in_progress_checksum_mismatch',
    `Migration ${migration} has ${stateLabel} for checksum ${input.journalChecksum}, but the current file checksum is ${input.fileChecksum}: the file changed after some of its statements had run.\n` +
      `  Resume with the edited file (completed statements are skipped): chkit migrate --apply --retry ${migration}\n` +
      `  Or discard the partial run, so the next apply starts the file over: chkit migrate --apply --abandon ${migration}\n` +
      '  Or restore the original file content and re-run chkit migrate --apply.',
  )
}

/**
 * An in-progress migration that another chkit release recorded, whose
 * statements completed or started where the split before #562 and this split
 * differ. Resuming by position could skip a statement that never ran or run
 * one again.
 */
export function statementSplitChangedError(input: {
  migration: string
  /** 1-based statement numbers. */
  statements: readonly number[]
  /** The release that recorded the state; empty when it did not record one. */
  recordedBy: string
  cliVersion: string
}): MigrateError {
  const { migration, statements } = input
  const recorder = input.recordedBy === '' ? 'an earlier chkit release' : `chkit ${input.recordedBy}`
  const label = statements.length === 1 ? 'statement' : 'statements'
  return new MigrateError(
    'statement_split_changed',
    `Cannot resume ${migration}: ${recorder} recorded its partial run, and this chkit (${input.cliVersion}) splits the file into different statements. ` +
      'It reads `//`, `# ` and `#!` comments as ClickHouse does, so a `;`, quote or `/*` inside one no longer ends or opens anything (#562). ' +
      `The journal recorded ${label} ${statements.join(', ')} as completed or started, which ${statements.length === 1 ? 'is' : 'are'} not the same in this split.\n` +
      `  Finish the partial run with the chkit release that recorded it, then upgrade.\n` +
      `  Or discard the partial run, so the next apply starts the file over (statements that ran stay applied and run again): chkit migrate --apply --abandon ${migration}`,
  )
}

/**
 * An in-progress migration whose file is unchanged, but whose statements as
 * this run gets them differ from those the journal recorded as completed or
 * running (#599): the release that recorded the state split the file
 * differently, or a plugin's onBeforeApply now returns other statements.
 */
export function recordedStatementsChangedError(input: {
  migration: string
  /** 1-based statement numbers. */
  statements: readonly number[]
  /** The release that recorded the state; empty when it did not record one. */
  recordedBy: string
  cliVersion: string
}): MigrateError {
  const { migration, statements } = input
  const recorder = input.recordedBy === '' ? 'an earlier chkit release' : `chkit ${input.recordedBy}`
  const label = statements.length === 1 ? 'statement' : 'statements'
  return new MigrateError(
    'statement_split_changed',
    `Cannot resume ${migration}: the journal recorded ${label} ${statements.join(', ')} as completed or started, but this run gets different SQL from the file at ${statements.length === 1 ? 'that position' : 'those positions'}. ` +
      `${recorder} recorded the partial run and this chkit is ${input.cliVersion}; a change in how chkit splits the file, or in what a plugin's onBeforeApply returns, moves statements. ` +
      'Resuming by position could skip a statement that never ran or run one again.\n' +
      `  Finish the partial run with the chkit release and plugins that recorded it, then upgrade.\n` +
      `  Or discard the partial run, so the next apply starts the file over (statements that ran stay applied and run again): chkit migrate --apply --abandon ${migration}`,
  )
}

/** A pending migration's statement marked `mode=barrier` that is not a SELECT. */
export interface PendingNonSelectBarrier {
  migration: string
  /** 1-based position among the migration's executable statements. */
  statement: number
  total: number
  /** The `-- operation:` marker text after the prefix. */
  operation: string
  /** One-line, length-capped preview of the statement. */
  preview: string
}

/**
 * Refusal of pending migrations that mark a statement other than a SELECT
 * `mode=barrier` (#634): the barrier read would run it, maybe more than once,
 * and nothing would wait for its change to reach every replica.
 */
export function nonSelectBarrierError(barriers: readonly PendingNonSelectBarrier[]): MigrateError {
  const lines = barriers.map(
    (barrier) =>
      `  - ${barrier.migration}, statement ${barrier.statement} of ${barrier.total} (-- operation: ${barrier.operation}):\n` +
      `      ${barrier.preview}`,
  )
  return new MigrateError(
    'barrier_not_select',
    'Cannot apply: a statement marked mode=barrier is not a SELECT:\n' +
      `${lines.join('\n')}\n` +
      'chkit runs a barrier statement as a read of the running INSERTs, once and then every second, and waits for no change it makes to reach every replica.\n' +
      'Make each statement a SELECT (or WITH ... SELECT) that returns a query_id column, or remove mode=barrier from its -- operation: marker, then re-run chkit migrate --apply. No statement of these migrations ran.',
  )
}

/** Text-mode refusal of pending files without executable statements. */
export function emptyMigrationsError(files: readonly string[]): Error {
  return new Error(
    'Cannot apply: these pending migrations contain no executable statements (only comments or whitespace):\n' +
      `${files.map((file) => `  - ${file}`).join('\n')}\n` +
      'An empty migration would be recorded as applied, and SQL added to it later would fail the checksum check.\n' +
      'Add SQL statements to each file or delete it, then re-run chkit migrate --apply.',
  )
}

/**
 * The journal changed between the plan this run showed and the moment it
 * took the migrate lock, in a way the plan does not cover (#716).
 */
export function journalChangedError(detail: string): MigrateError {
  return new MigrateError(
    'journal_changed',
    `Another migrate run changed the journal while this run was planning: ${detail}. Nothing was applied; run migrate again to see the current plan.`,
  )
}
