import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'

import { createClickHouseExecutor } from '@chx/clickhouse'

import {
  collectDestructiveOperationMarkers,
  type DestructiveOperationMarker,
  type MigrationJournalEntry,
  checksumSQL,
  emitJson,
  extractExecutableStatements,
  findChecksumMismatches,
  getCommandContext,
  hasFlag,
  listMigrations,
  migrationContainsDangerOperation,
  readJournal,
  writeJournal,
} from '../lib.js'

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

export async function cmdMigrate(args: string[]): Promise<void> {
  const execute = hasFlag('--execute', args)
  const allowDestructive = hasFlag('--allow-destructive', args)
  const planMode = hasFlag('--plan', args)

  const { config, dirs, jsonMode } = await getCommandContext(args)
  const { migrationsDir, metaDir } = dirs

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await readJournal(metaDir)
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pending = files.filter((f) => !appliedNames.has(f))
  const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)

  if (checksumMismatches.length > 0) {
    if (jsonMode) {
      emitJson('migrate', {
        mode: execute ? 'execute' : 'plan',
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

  if (pending.length === 0) {
    if (jsonMode) {
      emitJson('migrate', { pending: [], applied: [], mode: execute ? 'execute' : 'plan' })
    } else {
      console.log('No pending migrations.')
    }
    return
  }

  const planned = {
    mode: execute ? 'execute' : 'plan',
    pending,
  }

  if (planMode || !execute) {
    if (jsonMode) {
      emitJson('migrate', planned)
    } else {
      console.log(`Pending migrations: ${pending.length}`)
      for (const file of pending) console.log(`- ${file}`)
      if (!execute) {
        console.log('\nPlan only. Re-run with --execute to apply and journal these migrations.')
      }
    }
    if (!execute) return
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
    throw new Error('clickhouse config is required for --execute')
  }

  const db = createClickHouseExecutor(config.clickhouse)
  const appliedNow: MigrationJournalEntry[] = []

  for (const file of pending) {
    const fullPath = join(migrationsDir, file)
    const sql = await readFile(fullPath, 'utf8')
    const statements = extractExecutableStatements(sql)
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

    if (!jsonMode) console.log(`Applied: ${file}`)
  }

  if (jsonMode) {
    emitJson('migrate', {
      mode: 'execute',
      applied: appliedNow,
      journalFile: join(metaDir, 'journal.json'),
    })
    return
  }

  console.log(`\nJournal updated: ${join(metaDir, 'journal.json')}`)
}
