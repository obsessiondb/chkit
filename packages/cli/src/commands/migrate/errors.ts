/** Stable `--json` error codes of migrate failures; `bin/chkit.ts` copies them into the error envelope. */
export type MigrateErrorCode =
  | 'invalid_usage'
  | 'migration_not_found'
  | 'migration_not_in_progress'
  | 'migration_already_applied'
  | 'retry_mismatch'
  | 'in_progress_checksum_mismatch'
  | 'statement_split_changed'

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

/** Text-mode refusal of pending files without executable statements. */
export function emptyMigrationsError(files: readonly string[]): Error {
  return new Error(
    'Cannot apply: these pending migrations contain no executable statements (only comments or whitespace):\n' +
      `${files.map((file) => `  - ${file}`).join('\n')}\n` +
      'An empty migration would be recorded as applied, and SQL added to it later would fail the checksum check.\n' +
      'Add SQL statements to each file or delete it, then re-run chkit migrate --apply.',
  )
}
