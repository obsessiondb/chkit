/** Stable `--json` error codes of migrate failures; `bin/chkit.ts` copies them into the error envelope. */
export type MigrateErrorCode =
  | 'invalid_usage'
  | 'migration_not_found'
  | 'migration_not_in_progress'
  | 'migration_already_applied'
  | 'retry_mismatch'
  | 'in_progress_checksum_mismatch'

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

/** Text-mode refusal of pending files without executable statements. */
export function emptyMigrationsError(files: readonly string[]): Error {
  return new Error(
    'Cannot apply: these pending migrations contain no executable statements (only comments or whitespace):\n' +
      `${files.map((file) => `  - ${file}`).join('\n')}\n` +
      'An empty migration would be recorded as applied, and SQL added to it later would fail the checksum check.\n' +
      'Add SQL statements to each file or delete it, then re-run chkit migrate --apply.',
  )
}
