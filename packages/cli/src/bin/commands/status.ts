import { mkdir } from 'node:fs/promises'

import type { CommandDef, CommandRunContext } from '../../plugins.js'
import { emitJson } from '../json-output.js'
import { createJournalStore } from '../journal-store.js'
import { findChecksumMismatches, listMigrations } from '../migration-store.js'

export const statusCommand: CommandDef = {
  name: 'status',
  description: 'Show migration status and checksum mismatch information',
  flags: [],
  run: cmdStatus,
}

async function cmdStatus(runCtx: CommandRunContext): Promise<void> {
  const { flags, config, dirs, ctx } = runCtx
  const jsonMode = flags['--json'] === true
  const { migrationsDir } = dirs

  if (!ctx.hasExecutor) {
    throw new Error('clickhouse config is required for status (journal is stored in ClickHouse)')
  }
  const db = ctx.executor
  const database = config.clickhouse?.database
  const journalStore = createJournalStore(db)

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await journalStore.readJournal()
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pending = files.filter((f) => !appliedNames.has(f))
  const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)

  const databaseMissing = journalStore.databaseMissing
  const payload = {
    migrationsDir,
    total: files.length,
    applied: journal.applied.length,
    pending: pending.length,
    pendingMigrations: pending,
    checksumMismatchCount: checksumMismatches.length,
    checksumMismatches,
    ...(databaseMissing ? { databaseMissing: true, database } : {}),
  }

  if (jsonMode) {
    emitJson('status', payload)
    return
  }

  if (databaseMissing) {
    console.log(`\u26A0 Database "${database ?? ''}" does not exist on the target server.`)
    console.log('  It will be created when you run: chkit migrate --apply\n')
  }

  console.log(`Migrations directory: ${migrationsDir}`)
  console.log(`Total migrations:     ${files.length}`)
  console.log(`Applied:              ${journal.applied.length}`)
  console.log(`Pending:              ${pending.length}`)

  if (pending.length > 0) {
    console.log('\nPending migrations:')
    for (const item of pending) console.log(`- ${item}`)
  }
  if (checksumMismatches.length > 0) {
    console.log('\nChecksum mismatches on applied migrations:')
    for (const item of checksumMismatches) console.log(`- ${item.name}`)
  }
}
