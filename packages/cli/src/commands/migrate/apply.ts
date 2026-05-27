import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { waitForDDLPropagation, type ClickHouseExecutor } from '@chkit/clickhouse'
import type { ResolvedChxConfig } from '@chkit/core'

import type { ParsedFlags, PluginRuntime, TableScope } from '../../plugins.js'
import { debug } from '../../runtime/debug.js'
import type { createJournalStore } from '../../runtime/journal-store.js'
import { checksumSQL, type MigrationJournalEntry } from '../../runtime/migration-store.js'
import {
  extractExecutableStatements,
  extractMigrationOperationSummaries,
} from '../../runtime/safety-markers.js'
import { applyAsyncStatement } from './async-apply.js'

type JournalStore = ReturnType<typeof createJournalStore>

export async function applyMigration(input: {
  db: ClickHouseExecutor
  journalStore: JournalStore
  pluginRuntime: PluginRuntime
  config: ResolvedChxConfig
  tableScope: TableScope
  flags: ParsedFlags
  migrationsDir: string
  file: string
}): Promise<MigrationJournalEntry> {
  const { db, journalStore, pluginRuntime, config, tableScope, flags, migrationsDir, file } = input

  debug('migrate', `applying ${file}`)
  const sql = await readFile(join(migrationsDir, file), 'utf8')
  const parsedStatements = extractExecutableStatements(sql)
  const operationSummaries = extractMigrationOperationSummaries(sql)
  debug('migrate', `${file}: ${parsedStatements.length} statements, ${operationSummaries.length} operations`)

  const statements = await pluginRuntime.runOnBeforeApply({
    command: 'migrate',
    config,
    tableScope,
    flags,
    migration: file,
    sql,
    statements: parsedStatements,
  })

  const migrationChecksum = checksumSQL(sql)

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i] as string
    const operation = operationSummaries[i]
    if (operation?.mode === 'async') {
      await applyAsyncStatement({
        db,
        journalStore,
        sql: statement,
        migrationName: file,
        migrationChecksum,
        statementIndex: i,
        operationType: operation.type,
        operationKey: operation.key,
        beforeRetry: operation.beforeRetry,
        log: (line) => console.log(line),
      })
      // Async ops are DML (loads, backfills) — no DDL propagation to wait on.
      continue
    }
    await db.command(statement)
    if (operation) {
      await waitForDDLPropagation(db, operation.type, operation.key)
    }
  }

  const entry: MigrationJournalEntry = {
    name: file,
    appliedAt: new Date().toISOString().replace('Z', ''),
    checksum: migrationChecksum,
  }
  await journalStore.appendEntry(entry)

  await pluginRuntime.runOnAfterApply({
    command: 'migrate',
    config,
    tableScope,
    flags,
    migration: file,
    statements,
    appliedAt: entry.appliedAt,
  })

  return entry
}
