import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TableScope } from '../../plugins.js'
import { emitJson } from '../../runtime/json-output.js'
import { resolveJournalTableName } from '../../runtime/journal-store.js'
import { extractMigrationMetadata } from '../../runtime/migration-metadata.js'
import type { MigrationJournalEntry } from '../../runtime/migration-store.js'
import type { DestructiveScan } from './destructive.js'

export type MigrateMode = 'plan' | 'execute'

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
}): void {
  const selector = input.scope.selector ?? ''
  if (input.jsonMode) {
    emitJson('migrate', {
      mode: input.mode,
      scope: input.scope,
      pending: [],
      applied: [],
      warning: `No tables matched selector "${selector}".`,
    })
  } else {
    console.log(`No tables matched selector "${selector}". No migrations selected.`)
  }
}

export function emitNoPending(input: {
  jsonMode: boolean
  mode: MigrateMode
  scope: TableScope
}): void {
  if (input.jsonMode) {
    emitJson('migrate', { mode: input.mode, scope: input.scope, pending: [], applied: [] })
  } else {
    console.log('No pending migrations.')
  }
}

export function emitPlanJson(input: {
  mode: MigrateMode
  scope: TableScope
  pending: string[]
  undeterminedScope: string[]
}): void {
  emitJson('migrate', {
    mode: input.mode,
    scope: input.scope,
    pending: input.pending,
    ...(input.undeterminedScope.length > 0
      ? { undeterminedMigrations: input.undeterminedScope }
      : {}),
  })
}

export async function renderPlanText(input: {
  migrationsDir: string
  scope: TableScope
  undeterminedScope: string[]
  pending: string[]
}): Promise<void> {
  const { migrationsDir, scope, undeterminedScope, pending } = input
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
    console.log(`- ${file}`)
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    const meta = extractMigrationMetadata(sql)
    if (meta.log) console.log(`    ${meta.log}`)
  }
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
}): void {
  emitJson('migrate', {
    mode: 'execute',
    scope: input.scope,
    applied: input.applied,
    ...(input.undeterminedScope.length > 0
      ? { undeterminedMigrations: input.undeterminedScope }
      : {}),
  })
}

export function renderApplySummary(): void {
  console.log(`\nMigrations recorded in ClickHouse ${resolveJournalTableName()} table.`)
}
