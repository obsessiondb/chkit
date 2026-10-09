import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { JournalStore } from '../../runtime/journal-store.js'
import { checksumSQL } from '../../runtime/migration-store.js'
import {
  extractExecutableStatements,
  extractMigrationOperationSummaries,
} from '../../runtime/safety-markers.js'
import { retryMismatchError, statementIdentities, verifyRetryEdit } from './recovery.js'

export interface RetryResume {
  action: 'resume'
  migration: string
  previousChecksum: string
  checksum: string
  totalStatements: number
  completedStatements: number
  /** 1-based number of the first statement that runs; null when every statement already completed. */
  resumeAtStatement: number | null
  /** Completed statements without an `-- operation:` marker, matched by position only. */
  unmarkedCompletedStatements: number
}

export type RetryNoopReason =
  | 'already_applied'
  | 'not_in_scope'
  | 'empty_migration'
  | 'not_in_progress'
  | 'checksum_unchanged'

export interface RetryNoop {
  action: 'none'
  migration: string
  reason: RetryNoopReason
}

export type RetryResolution = RetryResume | RetryNoop

/**
 * Decide what --retry <migration> does in this run, before anything is
 * applied. A target that is not an edited in-progress migration is a no-op,
 * so the same command can run against every environment; an edit that moved
 * or changed a statement that already ran throws `retry_mismatch`.
 */
export async function resolveRetry(
  input: {
    migration: string
    migrationsDir: string
    pending: readonly string[]
    /** Pending files without executable statements, which apply refuses. */
    emptyMigrations: readonly string[]
    appliedNames: ReadonlySet<string>
  },
  deps: { journalStore: JournalStore },
): Promise<RetryResolution> {
  const { migration } = input
  if (input.appliedNames.has(migration)) return { action: 'none', migration, reason: 'already_applied' }
  if (!input.pending.includes(migration)) return { action: 'none', migration, reason: 'not_in_scope' }
  if (input.emptyMigrations.includes(migration)) return { action: 'none', migration, reason: 'empty_migration' }
  const state = await deps.journalStore.readMigrationState(migration)
  if (state === null) return { action: 'none', migration, reason: 'not_in_progress' }
  if (state.migrationCompleted) return { action: 'none', migration, reason: 'already_applied' }
  const sql = await readFile(join(input.migrationsDir, migration), 'utf8')
  const checksum = checksumSQL(sql)
  if (state.checksum === checksum) return { action: 'none', migration, reason: 'checksum_unchanged' }
  // The file's statements before onBeforeApply; apply checks again against the
  // statements the plugins return.
  const identities = statementIdentities(
    extractMigrationOperationSummaries(sql),
    extractExecutableStatements(sql).length,
  )
  const check = verifyRetryEdit(state.operations, identities)
  if (!check.ok) throw retryMismatchError(migration, check)
  return {
    action: 'resume',
    migration,
    previousChecksum: state.checksum,
    checksum,
    totalStatements: identities.length,
    completedStatements: check.completed,
    resumeAtStatement: check.resumeIndex === null ? null : check.resumeIndex + 1,
    unmarkedCompletedStatements: check.unmarkedCompleted,
  }
}
