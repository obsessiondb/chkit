import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TableScope } from '../../plugins.js'
import { emitJson } from '../../runtime/json-output.js'
import { resolveJournalTableName } from '../../runtime/journal-store.js'
import { extractMigrationMetadata } from '../../runtime/migration-metadata.js'
import type { MigrationJournalEntry } from '../../runtime/migration-store.js'
import { statusBeforeAbandon, type AbandonReport } from './abandon.js'
import { previewStatement } from './apply.js'
import type { DestructiveScan } from './destructive.js'
import { EMPTY_MIGRATIONS_SUMMARY } from './errors.js'
import type { RetryResolution } from './retry.js'

export type MigrateMode = 'plan' | 'execute'

// A regenerated migration plans the statements that completed again.
const REPEATED_STATEMENTS_HINT =
  'The new migration may repeat statements that completed; remove those that cannot run twice, such as a REMOVE DEFAULT or REMOVE MATERIALIZED, before you apply it.'

interface ChecksumMismatch {
  name: string
  expected: string
  actual: string
}

export function emitChecksumMismatchJson(input: {
  mode: MigrateMode
  scope: TableScope
  checksumMismatches: ChecksumMismatch[]
}): void {
  emitJson('migrate', {
    mode: input.mode,
    scope: input.scope,
    error: 'Checksum mismatch detected on applied migrations',
    checksumMismatches: input.checksumMismatches,
  })
}

export function emitNoScopeMatch(input: {
  jsonMode: boolean
  mode: MigrateMode
  scope: TableScope
  retry: RetryResolution | undefined
}): void {
  const selector = input.scope.selector ?? ''
  if (input.jsonMode) {
    emitJson('migrate', {
      mode: input.mode,
      scope: input.scope,
      pending: [],
      applied: [],
      warning: `No tables matched selector "${selector}".`,
      ...(input.retry ? { retry: input.retry } : {}),
    })
    return
  }
  console.log(`No tables matched selector "${selector}". No migrations selected.`)
  renderRetryNotice(input.retry)
}

export function emitNoPending(input: {
  jsonMode: boolean
  mode: MigrateMode
  scope: TableScope
  retry: RetryResolution | undefined
}): void {
  if (input.jsonMode) {
    emitJson('migrate', {
      mode: input.mode,
      scope: input.scope,
      pending: [],
      applied: [],
      ...(input.retry ? { retry: input.retry } : {}),
    })
    return
  }
  console.log('No pending migrations.')
  renderRetryNotice(input.retry)
}

export function emitPlanJson(input: {
  mode: MigrateMode
  scope: TableScope
  pending: string[]
  undeterminedScope: string[]
  emptyMigrations: string[]
  retry: RetryResolution | undefined
}): void {
  emitJson('migrate', {
    mode: input.mode,
    scope: input.scope,
    pending: input.pending,
    ...(input.undeterminedScope.length > 0
      ? { undeterminedMigrations: input.undeterminedScope }
      : {}),
    ...(input.emptyMigrations.length > 0 ? { emptyMigrations: input.emptyMigrations } : {}),
    ...(input.retry ? { retry: input.retry } : {}),
  })
}

export async function renderPlanText(input: {
  migrationsDir: string
  scope: TableScope
  undeterminedScope: string[]
  pending: string[]
  emptyMigrations: string[]
  retry: RetryResolution | undefined
}): Promise<void> {
  const { migrationsDir, scope, undeterminedScope, pending, emptyMigrations, retry } = input
  const empty = new Set(emptyMigrations)
  if (scope.enabled) {
    console.log(`Table scope: ${scope.selector ?? ''} (${scope.matchCount} matched)`)
    for (const table of scope.matchedTables) console.log(`- ${table}`)
  }
  if (undeterminedScope.length > 0) {
    console.log(
      `⚠ ${undeterminedScope.length} pending migration(s) have no table markers; ` +
        "including them because their target tables can't be determined under --table:",
    )
    for (const file of undeterminedScope) console.log(`  - ${file}`)
  }
  console.log(`Pending migrations: ${pending.length}`)
  for (const file of pending) {
    console.log(empty.has(file) ? `- ${file}  (no executable statements)` : `- ${file}`)
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    const meta = extractMigrationMetadata(sql)
    if (meta.log) console.log(`    ${meta.log}`)
  }
  if (emptyMigrations.length > 0) {
    console.log(
      `⚠ ${emptyMigrations.length} pending migration(s) contain no executable statements. ` +
        'chkit migrate --apply refuses to run until each has SQL or is deleted.',
    )
  }
  renderRetryNotice(retry)
}

export function renderPlanOnlyNotice(): void {
  console.log('\nPlan only. Re-run with --apply to apply and journal these migrations.')
}

export function emitDestructiveBlockedJson(input: {
  scope: TableScope
  error: string
  destructive: DestructiveScan
}): void {
  emitJson('migrate', {
    mode: 'execute',
    scope: input.scope,
    error: input.error,
    destructiveMigrations: input.destructive.migrations,
    destructiveOperations: input.destructive.operations,
  })
}

export async function renderMigrationLog(migrationsDir: string, file: string): Promise<void> {
  const sql = await readFile(join(migrationsDir, file), 'utf8')
  const meta = extractMigrationMetadata(sql)
  if (meta.log) console.log(`  ${meta.log}`)
}

export function renderApplied(file: string): void {
  console.log(`Applied: ${file}`)
}

export function emitApplySummaryJson(input: {
  scope: TableScope
  applied: MigrationJournalEntry[]
  undeterminedScope: string[]
  retry: RetryResolution | undefined
}): void {
  emitJson('migrate', {
    mode: 'execute',
    scope: input.scope,
    applied: input.applied,
    ...(input.undeterminedScope.length > 0
      ? { undeterminedMigrations: input.undeterminedScope }
      : {}),
    ...(input.retry ? { retry: input.retry } : {}),
  })
}

export function renderApplySummary(): void {
  console.log(`\nMigrations recorded in ClickHouse ${resolveJournalTableName()} table.`)
}

export function emitEmptyMigrationsBlockedJson(input: {
  mode: MigrateMode
  scope: TableScope
  emptyMigrations: string[]
}): void {
  emitJson('migrate', {
    mode: input.mode,
    scope: input.scope,
    error: EMPTY_MIGRATIONS_SUMMARY,
    emptyMigrations: input.emptyMigrations,
  })
}

export function emitAbandonJson(input: {
  mode: MigrateMode
  scope: TableScope
  abandon: AbandonReport
}): void {
  emitJson('migrate', { mode: input.mode, scope: input.scope, abandon: input.abandon })
}

/**
 * The --abandon report: what stays applied in ClickHouse, what failed or was
 * interrupted, and how to continue. `performed` is false for the preview. A
 * statement an earlier --abandon marked failed is reported by the status it
 * had before, so a statement that completed still shows as applied.
 */
export function renderAbandonText(
  report: AbandonReport,
  input: { performed: boolean; fileExists: boolean; snapshotFile: string },
): void {
  const { migration } = report
  console.log(
    input.performed
      ? `Abandoned in-progress migration ${migration}: every recorded statement is now marked failed.`
      : `Abandoning in-progress migration ${migration} marks every recorded statement failed. Nothing has changed yet.`,
  )
  const completed = report.operations.filter((op) => statusBeforeAbandon(op) === 'completed')
  if (completed.length === 0) {
    console.log('No statement had completed.')
  } else {
    console.log(`${completed.length} completed statement(s) remain applied in ClickHouse:`)
    for (const op of completed) {
      console.log(`  ${op.operationIndex + 1}. ${op.operationType} ${op.operationKey}`)
    }
  }
  for (const op of report.operations) {
    const statement = op.operationIndex + 1
    const status = statusBeforeAbandon(op)
    if (status === 'failed') {
      const reason = op.lastError.split('\n')[0]?.trim() ?? ''
      console.log(
        reason === ''
          ? `Statement ${statement} failed.`
          : `Statement ${statement} failed: ${previewStatement(reason, 200)}`,
      )
    }
    if (status === 'started') {
      console.log(
        `Statement ${statement} was interrupted${op.queryId === '' ? '' : ` (query_id ${op.queryId})`}.`,
      )
      if (op.queryId !== '') {
        console.log(
          `  ⚠ If that query is still running on the server, wait for it to finish or run KILL QUERY WHERE query_id = '${op.queryId}' before you apply ${migration} again.`,
        )
      }
    }
  }
  console.log('')
  if (!input.fileExists) {
    console.log(
      `${migration} is no longer in the migrations directory, so no apply runs it again. If you still need its changes, restore the file, or regenerate them: restore ${input.snapshotFile} from git to its state before ${migration} was generated and run chkit generate. ${REPEATED_STATEMENTS_HINT}`,
    )
    return
  }
  console.log(
    `Next: edit ${migration} if needed and run chkit migrate --apply. It runs again from statement 1, including the statements that completed, so they must be safe to run twice (for example CREATE ... IF NOT EXISTS), or remove them from the file. A column's MODIFY COLUMN ... REMOVE DEFAULT or REMOVE MATERIALIZED is not safe: it fails once the column has no such expression.`,
  )
  // chkit runs -- before-retry: only on the async path, and only for a record
  // whose operation type and key still match (rebaseInProgressState).
  console.log(
    'A data load adds its rows again unless it is marked mode=async with a -- before-retry: line that undoes it. That line runs only for an async statement that keeps its position, operation type and key.',
  )
  console.log(
    `Or regenerate it: delete ${migration}, restore ${input.snapshotFile} from git to its state before ${migration} was generated, and run chkit generate. ${REPEATED_STATEMENTS_HINT}`,
  )
}

export function renderAbandonPlanOnlyNotice(): void {
  console.log('\nPlan only. Re-run with --apply to abandon the in-progress state.')
}

function renderRetryNotice(retry: RetryResolution | undefined): void {
  if (!retry) return
  for (const line of formatRetryNotice(retry)) console.log(line)
}

function formatRetryNotice(retry: RetryResolution): string[] {
  const { migration } = retry
  if (retry.action === 'none') {
    const reasons = {
      already_applied: 'already applied; --retry has no effect.',
      not_in_scope: 'outside the --table scope; --retry has no effect.',
      empty_migration: 'no executable statements; --retry has no effect.',
      not_in_progress: 'no in-progress journal state; it applies normally.',
      checksum_unchanged: 'unchanged since it failed; it resumes without --retry.',
    } as const
    return [`Retry ${migration}: ${reasons[retry.reason]}`]
  }
  const progress =
    retry.resumeAtStatement === null
      ? `All ${retry.totalStatements} statements already completed; the migration will be recorded as applied.`
      : `${retry.completedStatements} completed statement(s) will be skipped; resuming at statement ${retry.resumeAtStatement} of ${retry.totalStatements}.`
  const lines = [`Retry ${migration}: the file changed after a failed apply. ${progress}`]
  if (retry.unmarkedCompletedStatements > 0) {
    lines.push(
      `⚠ ${retry.unmarkedCompletedStatements} completed statement(s) have no "-- operation:" marker and were matched by position only. ` +
        'Do not add, remove, or reorder statements above the first statement that did not complete.',
    )
  }
  return lines
}
