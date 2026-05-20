import { mkdir } from 'node:fs/promises'
import process from 'node:process'

import { defineFlags, typedFlags, type CommandDef, type CommandRunContext } from '../../plugins.js'
import { GLOBAL_FLAGS } from '../../runtime/global-flags.js'
import { emitJson } from '../../runtime/json-output.js'
import { createJournalStore } from '../../runtime/journal-store.js'
import {
  findChecksumMismatches,
  listMigrations,
  readSnapshot,
  type MigrationJournalEntry,
} from '../../runtime/migration-store.js'
import {
  resolveTableScope,
  tableKeysFromDefinitions,
} from '../../runtime/table-scope.js'
import { debug } from '../../runtime/debug.js'

import { applyMigration } from './apply.js'
import { scanDestructive } from './destructive.js'
import {
  confirmApply,
  confirmDestructiveExecution,
  isBackgroundOrCI,
  printDestructiveOperationDetails,
} from './prompts.js'
import { filterPendingByScope } from './scope.js'

const MIGRATE_FLAGS = defineFlags([
  { name: '--apply', type: 'boolean', description: 'Apply pending migrations on ClickHouse (no prompt)' },
  { name: '--execute', type: 'boolean', description: 'Alias for --apply' },
  { name: '--allow-destructive', type: 'boolean', description: 'Allow destructive migrations tagged with risk=danger' },
] as const)

export const migrateCommand: CommandDef = {
  name: 'migrate',
  description: 'Review or execute pending migrations',
  flags: MIGRATE_FLAGS,
  run: cmdMigrate,
}

async function cmdMigrate(runCtx: CommandRunContext): Promise<void> {
  const { flags, config, configPath, dirs, pluginRuntime, ctx } = runCtx
  const f = typedFlags(flags, [...GLOBAL_FLAGS, ...MIGRATE_FLAGS] as const)
  const executeRequested = f['--apply'] === true || f['--execute'] === true
  const allowDestructive = f['--allow-destructive'] === true
  const tableSelector = f['--table']
  const jsonMode = f['--json'] === true

  const { migrationsDir, metaDir } = dirs
  debug('migrate', `flags: execute=${executeRequested}, allowDestructive=${allowDestructive}, json=${jsonMode}`)

  if (!ctx.hasExecutor) {
    throw new Error('clickhouse config is required for migrate (journal is stored in ClickHouse)')
  }
  const db = ctx.executor
  const journalStore = createJournalStore(db)
  const snapshot = await readSnapshot(metaDir)
  const tableScope = resolveTableScope(tableSelector, tableKeysFromDefinitions(snapshot?.definitions ?? []))
  const mode = executeRequested ? 'execute' : 'plan'

  await pluginRuntime.runOnConfigLoaded({
    command: 'migrate',
    config,
    configPath,
    tableScope,
    flags,
  })

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await journalStore.readJournal()
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pendingAll = files.filter((file) => !appliedNames.has(file))
  debug('migrate', `migrations: total=${files.length}, applied=${journal.applied.length}, pending=${pendingAll.length}`)

  const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)
  if (checksumMismatches.length > 0) {
    debug('migrate', `checksum mismatches: ${checksumMismatches.map((m) => m.name).join(', ')}`)
    if (jsonMode) {
      emitJson('migrate', {
        mode,
        scope: tableScope,
        error: 'Checksum mismatch detected on applied migrations',
        checksumMismatches,
      })
      process.exitCode = 1
      return
    }
    throw new Error(
      `Checksum mismatch detected on applied migrations: ${checksumMismatches.map((item) => item.name).join(', ')}`,
    )
  }

  if (tableScope.enabled && tableScope.matchCount === 0) {
    if (jsonMode) {
      emitJson('migrate', {
        mode,
        scope: tableScope,
        pending: [],
        applied: [],
        warning: `No tables matched selector "${tableScope.selector ?? ''}".`,
      })
    } else {
      console.log(`No tables matched selector "${tableScope.selector ?? ''}". No migrations selected.`)
    }
    return
  }

  const pending = tableScope.enabled
    ? await filterPendingByScope(migrationsDir, pendingAll, new Set(tableScope.matchedTables))
    : pendingAll

  if (pending.length === 0) {
    if (jsonMode) {
      emitJson('migrate', { mode, scope: tableScope, pending: [], applied: [] })
    } else {
      console.log('No pending migrations.')
    }
    return
  }

  if (jsonMode && !executeRequested) {
    emitJson('migrate', { mode, scope: tableScope, pending })
    return
  }

  if (!jsonMode) {
    if (tableScope.enabled) {
      console.log(`Table scope: ${tableScope.selector ?? ''} (${tableScope.matchCount} matched)`)
      for (const table of tableScope.matchedTables) console.log(`- ${table}`)
    }
    console.log(`Pending migrations: ${pending.length}`)
    for (const file of pending) console.log(`- ${file}`)
  }

  if (!executeRequested) {
    if (isBackgroundOrCI() || jsonMode) {
      if (!jsonMode) {
        console.log('\nPlan only. Re-run with --apply to apply and journal these migrations.')
      }
      return
    }

    const confirmed = await confirmApply()
    if (!confirmed) {
      console.log('Migration apply cancelled by user.')
      return
    }
  }

  const destructive = await scanDestructive(migrationsDir, pending)
  let destructiveAllowed = allowDestructive || config.safety?.allowDestructive === true
  if (destructive.migrations.length > 0 && !destructiveAllowed) {
    const error =
      'Blocked destructive migration execution. Re-run with --allow-destructive or set safety.allowDestructive=true after review.'
    if (jsonMode) {
      emitJson('migrate', {
        mode: 'execute',
        scope: tableScope,
        error,
        destructiveMigrations: destructive.migrations,
        destructiveOperations: destructive.operations,
      })
      process.exitCode = 3
      return
    }

    if (isBackgroundOrCI()) {
      printDestructiveOperationDetails(destructive.operations)
      throw new Error(
        `${error}\nDestructive migrations: ${destructive.migrations.join(', ')}\n` +
          'Non-interactive run detected. Pass --allow-destructive to proceed.',
      )
    }

    const confirmed = await confirmDestructiveExecution(destructive.operations)
    if (!confirmed) {
      throw new Error(
        `Destructive migration cancelled by user.\nDestructive migrations: ${destructive.migrations.join(', ')}`,
      )
    }
    destructiveAllowed = true
  }

  if (destructive.migrations.length > 0 && !destructiveAllowed) {
    throw new Error('Blocked destructive migration execution.')
  }

  const appliedNow: MigrationJournalEntry[] = []
  for (const file of pending) {
    const entry = await applyMigration({
      db,
      journalStore,
      pluginRuntime,
      config,
      tableScope,
      flags,
      migrationsDir,
      file,
    })
    appliedNow.push(entry)
    if (!jsonMode) console.log(`Applied: ${file}`)
  }

  if (jsonMode) {
    emitJson('migrate', { mode: 'execute', scope: tableScope, applied: appliedNow })
    return
  }

  console.log('\nMigrations recorded in ClickHouse _chkit_migrations table.')
}
