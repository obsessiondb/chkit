import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'

import { createClickHouseExecutor } from '@chx/clickhouse'

import { CLI_VERSION } from '../version.js'
import { getCommandContext, hasFlag, parseArg } from '../config.js'
import { emitJson } from '../json-output.js'
import {
  checksumSQL,
  findChecksumMismatches,
  listMigrations,
  readJournal,
  readSnapshot,
  type MigrationJournalEntry,
  writeJournal,
} from '../migration-store.js'
import { loadPluginRuntime } from '../plugin-runtime.js'
import {
  collectDestructiveOperationMarkers,
  extractExecutableStatements,
  extractMigrationOperationSummaries,
  migrationContainsDangerOperation,
  type DestructiveOperationMarker,
} from '../safety-markers.js'
import { databaseKeyFromOperationKey, resolveTableScope, tableKeyFromOperationKey, tableKeysFromDefinitions } from '../table-scope.js'

function isBackgroundOrCI(): boolean {
  return process.env.CI === '1' || process.env.CI === 'true' || !process.stdin.isTTY || !process.stdout.isTTY
}

function printDestructiveOperationDetails(markers: DestructiveOperationMarker[]): void {
  console.log('Destructive operations detected:')
  for (const [index, marker] of markers.entries()) {
    console.log(`${index + 1}. ${marker.migration}`)
    console.log(`   operation: ${marker.type}`)
    console.log(`   key: ${marker.key}`)
    console.log(`   warning: ${marker.warningCode}`)
    console.log(`   reason: ${marker.reason}`)
    console.log(`   impact: ${marker.impact}`)
    console.log(`   recommendation: ${marker.recommendation}`)
  }
}

async function confirmDestructiveExecution(markers: DestructiveOperationMarker[]): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    printDestructiveOperationDetails(markers)
    console.log('')
    console.log('Type "yes" to continue. Any other input cancels.')
    const response = await rl.question('Apply destructive operations? [no/yes]: ')
    return response.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

async function filterPendingByScope(
  migrationsDir: string,
  pending: string[],
  selectedTables: ReadonlySet<string>
): Promise<string[]> {
  const selectedDatabases = new Set([...selectedTables].map((table) => table.split('.')[0] ?? ''))

  const inScope: string[] = []
  for (const file of pending) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    const operations = extractMigrationOperationSummaries(sql)
    const matches = operations.some((operation) => {
      const tableKey = tableKeyFromOperationKey(operation.key)
      if (tableKey) return selectedTables.has(tableKey)

      const database = databaseKeyFromOperationKey(operation.key)
      if (database) return selectedDatabases.has(database)

      return false
    })

    if (matches) inScope.push(file)
  }

  return inScope
}

export async function cmdMigrate(args: string[]): Promise<void> {
  const executeRequested = hasFlag('--apply', args) || hasFlag('--execute', args)
  const allowDestructive = hasFlag('--allow-destructive', args)
  const tableSelector = parseArg('--table', args)

  const { config, configPath, dirs, jsonMode } = await getCommandContext(args)
  const { migrationsDir, metaDir } = dirs
  const snapshot = await readSnapshot(metaDir)
  const tableScope = resolveTableScope(tableSelector, tableKeysFromDefinitions(snapshot?.definitions ?? []))

  const pluginRuntime = await loadPluginRuntime({
    config,
    configPath,
    cliVersion: CLI_VERSION,
  })
  await pluginRuntime.runOnConfigLoaded({
    command: 'migrate',
    config,
    configPath,
    tableScope,
  })

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await readJournal(metaDir)
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pendingAll = files.filter((f) => !appliedNames.has(f))
  const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)

  if (checksumMismatches.length > 0) {
    if (jsonMode) {
      emitJson('migrate', {
        mode: executeRequested ? 'execute' : 'plan',
        scope: tableScope,
        error: 'Checksum mismatch detected on applied migrations',
        checksumMismatches,
      })
      process.exitCode = 1
      return
    }
    throw new Error(
      `Checksum mismatch detected on applied migrations: ${checksumMismatches
        .map((item) => item.name)
        .join(', ')}`
    )
  }

  if (tableScope.enabled && tableScope.matchCount === 0) {
    if (jsonMode) {
      emitJson('migrate', {
        mode: executeRequested ? 'execute' : 'plan',
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
      emitJson('migrate', {
        mode: executeRequested ? 'execute' : 'plan',
        scope: tableScope,
        pending: [],
        applied: [],
      })
    } else {
      console.log('No pending migrations.')
    }
    return
  }

  const planned = {
    mode: executeRequested ? 'execute' : 'plan',
    scope: tableScope,
    pending,
  }

  if (jsonMode && !executeRequested) {
    emitJson('migrate', planned)
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

  let shouldExecute = executeRequested
  if (!shouldExecute) {
    if (isBackgroundOrCI() || jsonMode) {
      if (!jsonMode) {
        console.log('\nPlan only. Re-run with --apply to apply and journal these migrations.')
      }
      return
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      console.log('')
      console.log('Type "yes" to continue. Any other input cancels.')
      const response = await rl.question('Apply pending migrations now? [no/yes]: ')
      shouldExecute = response.trim().toLowerCase() === 'yes'
    } finally {
      rl.close()
    }

    if (!shouldExecute) {
      console.log('Migration apply cancelled by user.')
      return
    }
  }

  const destructiveMigrations: string[] = []
  const destructiveOperations: DestructiveOperationMarker[] = []
  for (const file of pending) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    if (migrationContainsDangerOperation(sql)) {
      destructiveMigrations.push(file)
      destructiveOperations.push(...collectDestructiveOperationMarkers(file, sql))
    }
  }

  let destructiveAllowed = allowDestructive || config.safety?.allowDestructive === true
  if (destructiveMigrations.length > 0 && !destructiveAllowed) {
    const error =
      'Blocked destructive migration execution. Re-run with --allow-destructive or set safety.allowDestructive=true after review.'
    if (jsonMode) {
      emitJson('migrate', {
        mode: 'execute',
        scope: tableScope,
        error,
        destructiveMigrations,
        destructiveOperations,
      })
      process.exitCode = 3
      return
    }

    if (isBackgroundOrCI()) {
      printDestructiveOperationDetails(destructiveOperations)
      throw new Error(
        `${error}\nDestructive migrations: ${destructiveMigrations.join(', ')}\n` +
          'Non-interactive run detected. Pass --allow-destructive to proceed.'
      )
    }

    const confirmed = await confirmDestructiveExecution(destructiveOperations)
    if (!confirmed) {
      throw new Error(
        `Destructive migration cancelled by user.\nDestructive migrations: ${destructiveMigrations.join(', ')}`
      )
    }
    destructiveAllowed = true
  }

  if (destructiveMigrations.length > 0 && !destructiveAllowed) {
    throw new Error('Blocked destructive migration execution.')
  }

  if (!config.clickhouse) {
    throw new Error('clickhouse config is required for --apply')
  }

  const db = createClickHouseExecutor(config.clickhouse)
  const appliedNow: MigrationJournalEntry[] = []

  for (const file of pending) {
    const fullPath = join(migrationsDir, file)
    const sql = await readFile(fullPath, 'utf8')
    const parsedStatements = extractExecutableStatements(sql)
    const statements = await pluginRuntime.runOnBeforeApply({
      command: 'migrate',
      config,
      tableScope,
      migration: file,
      sql,
      statements: parsedStatements,
    })
    for (const statement of statements) {
      await db.execute(statement)
    }

    const entry: MigrationJournalEntry = {
      name: file,
      appliedAt: new Date().toISOString(),
      checksum: checksumSQL(sql),
    }
    journal.applied.push(entry)
    appliedNow.push(entry)
    await writeJournal(metaDir, journal)
    await pluginRuntime.runOnAfterApply({
      command: 'migrate',
      config,
      tableScope,
      migration: file,
      statements,
      appliedAt: entry.appliedAt,
    })

    if (!jsonMode) console.log(`Applied: ${file}`)
  }

  if (jsonMode) {
    emitJson('migrate', {
      mode: 'execute',
      scope: tableScope,
      applied: appliedNow,
      journalFile: join(metaDir, 'journal.json'),
    })
    return
  }

  console.log(`\nJournal updated: ${join(metaDir, 'journal.json')}`)
}
