import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ChxPluginCommand } from '../plugins.js'
import { resolveDirs } from '../runtime/config.js'
import { debug } from '../runtime/debug.js'
import { emitJson } from '../runtime/json-output.js'
import { createJournalStore } from '../runtime/journal-store.js'
import { checksumSQL, findChecksumMismatches, listMigrations } from '../runtime/migration-store.js'
import { previewStatement } from './migrate/apply.js'
import { describeInProgress, type InProgressMigration } from './migrate/recovery.js'

export const statusCommand: ChxPluginCommand = {
  name: 'status',
  description: 'Show migration status and checksum mismatch information',
  flags: [],
  async run(context): Promise<undefined | number> {
    const { flags, config, pluginContext } = context
    const jsonMode = flags['--json'] === true
    const { migrationsDir } = resolveDirs(config)

    if (!pluginContext.hasExecutor) {
      throw new Error('clickhouse config is required for status (journal is stored in ClickHouse)')
    }
    const db = pluginContext.executor
    const database = config.clickhouse?.database
    const journalStore = createJournalStore(db, config.clickhouse?.cluster)

    await mkdir(migrationsDir, { recursive: true })
    const files = await listMigrations(migrationsDir)
    const journal = await journalStore.readJournal()
    const appliedNames = new Set(journal.applied.map((entry) => entry.name))
    // Scope "Applied" to migrations that exist in this project's migrations dir
    // (#31). The journal table can be shared across tenants/services on
    // ObsessionDB, so journal.applied.length counts other projects' rows too and
    // can exceed this project's total. The intersection is always <= total.
    const applied = files.filter((f) => appliedNames.has(f))
    const pending = files.filter((f) => !appliedNames.has(f))
    const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)
    // A migration that failed part-way stays pending; scoped to this project's files like Applied.
    const inProgressMigrations = await Promise.all(
      (await journalStore.readInProgress())
        .filter((state) => pending.includes(state.name))
        .map(async (state) =>
          describeInProgress(state, checksumSQL(await readFile(join(migrationsDir, state.name), 'utf8'))),
        ),
    )

    debug('status', `files=${files.length}, applied=${applied.length}, pending=${pending.length}, inProgress=${inProgressMigrations.length}, checksumMismatches=${checksumMismatches.length}`)

    const databaseMissing = journalStore.databaseMissing
    const payload = {
      migrationsDir,
      total: files.length,
      applied: applied.length,
      pending: pending.length,
      pendingMigrations: pending,
      inProgressMigrations,
      checksumMismatchCount: checksumMismatches.length,
      checksumMismatches,
      ...(databaseMissing ? { databaseMissing: true, database } : {}),
    }

    if (jsonMode) {
      emitJson('status', payload)
      return 0
    }

    if (databaseMissing) {
      console.log(`⚠ Database "${database ?? ''}" does not exist on the target server.`)
      console.log('  It will be created when you run: chkit migrate --apply\n')
    }

    console.log(`Migrations directory: ${migrationsDir}`)
    console.log(`Total migrations:     ${files.length}`)
    console.log(`Applied:              ${applied.length}`)
    console.log(`Pending:              ${pending.length}`)

    if (pending.length > 0) {
      console.log('\nPending migrations:')
      for (const item of pending) console.log(`- ${item}`)
    }
    if (inProgressMigrations.length > 0) {
      console.log('\nIn progress (failed part-way, still pending):')
      for (const migration of inProgressMigrations) {
        for (const line of formatInProgress(migration)) console.log(line)
      }
    }
    if (checksumMismatches.length > 0) {
      console.log('\nChecksum mismatches on applied migrations:')
      for (const item of checksumMismatches) console.log(`- ${item.name}`)
    }
    return 0
  },
}

function formatInProgress(migration: InProgressMigration): string[] {
  const { name, completedStatements } = migration
  const lines = [`- ${name}: ${completedStatements} statement${completedStatements === 1 ? '' : 's'} completed`]
  for (const entry of migration.statements) {
    const statement = `Statement ${entry.statement}`
    switch (entry.state) {
      case 'failed': {
        const reason = entry.error.split('\n')[0]?.trim() ?? ''
        lines.push(reason === '' ? `  ${statement} failed.` : `  ${statement} failed: ${previewStatement(reason, 200)}`)
        break
      }
      case 'interrupted':
        lines.push(`  ${statement} was interrupted while it ran.`)
        break
      case 'running':
        lines.push(`  ${statement} may still be running on the server (query_id ${entry.queryId}).`)
        break
      case 'awaiting_replicas':
        lines.push(`  ${statement} ran; it has not reached every replica yet.`)
        break
      case 'abandoned':
        lines.push(`  ${statement} was abandoned (it had ${entry.was}).`)
        break
    }
  }
  if (migration.fileChanged) lines.push('  The file changed since its last failed attempt.')
  lines.push(`  Next: ${migration.nextSteps.join(', then ')}`)
  return lines
}
