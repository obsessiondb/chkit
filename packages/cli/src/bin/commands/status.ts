import { mkdir } from 'node:fs/promises'

import { getCommandContext } from '../config.js'
import { emitJson } from '../json-output.js'
import { findChecksumMismatches, listMigrations, readJournal } from '../migration-store.js'

export async function cmdStatus(args: string[]): Promise<void> {
  const { dirs, jsonMode } = await getCommandContext(args)
  const { migrationsDir, metaDir } = dirs

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await readJournal(metaDir)
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pending = files.filter((f) => !appliedNames.has(f))
  const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)

  const payload = {
    migrationsDir,
    total: files.length,
    applied: journal.applied.length,
    pending: pending.length,
    pendingMigrations: pending,
    checksumMismatchCount: checksumMismatches.length,
    checksumMismatches,
  }

  if (jsonMode) {
    emitJson('status', payload)
    return
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
