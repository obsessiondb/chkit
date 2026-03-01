import { mkdir } from 'node:fs/promises'

import type { CommandDef, CommandRunContext } from '../../plugins.js'
import { withClickHouseExecutor } from '../clickhouse-resource.js'
import { emitJson } from '../json-output.js'
import { createJournalStore } from '../journal-store.js'
import { findChecksumMismatches, listMigrations } from '../migration-store.js'

export const statusCommand: CommandDef = {
  name: 'status',
  description: 'Show migration status and checksum mismatch information',
  flags: [],
  run: cmdStatus,
}

async function cmdStatus(ctx: CommandRunContext): Promise<void> {
  const { flags, config, dirs } = ctx
  const jsonMode = flags['--json'] === true
  const { migrationsDir } = dirs

  if (!config.clickhouse) {
    throw new Error('clickhouse config is required for status (journal is stored in ClickHouse)')
  }

  await withClickHouseExecutor(config.clickhouse, async (db) => {
    const journalStore = createJournalStore(db)

    await mkdir(migrationsDir, { recursive: true })
    const files = await listMigrations(migrationsDir)
    const journal = await journalStore.readJournal()
    const appliedNames = new Set(journal.applied.map((entry) => entry.name))
    const pending = files.filter((f) => !appliedNames.has(f))
    const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)

    const payload = {
      migrationsDir,
      total: files.length,
      applied: appliedNames.size,
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
    console.log(`Applied:              ${appliedNames.size}`)
    console.log(`Pending:              ${pending.length}`)

    if (pending.length > 0) {
      console.log('\nPending migrations:')
      for (const item of pending) console.log(`- ${item}`)
    }
    if (checksumMismatches.length > 0) {
      console.log('\nChecksum mismatches on applied migrations:')
      for (const item of checksumMismatches) console.log(`- ${item.name}`)
    }
  })
}
