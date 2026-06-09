import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { applyMigration } from '../../../commands/migrate/apply.js'
import type { JournalStore, MigrationJournalEntry, MigrationRowState } from '../../../runtime/journal-store.js'
import type { ParsedFlags, PluginRuntime, TableScope } from '../../../plugins.js'

function createFakeStore() {
  let current: MigrationRowState | null = null
  const appended: MigrationJournalEntry[] = []
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState() {
      return current
    },
    async writeMigrationState(state) {
      current = state
    },
    async appendEntry(entry) {
      appended.push(entry)
      if (current) current = { ...current, migrationCompleted: true }
    },
  }
  return { store, appended, state: () => current }
}

function fakePluginRuntime(): PluginRuntime {
  return {
    async runOnBeforeApply({ statements }: { statements: string[] }) {
      return statements
    },
    async runOnAfterApply() {},
  } as unknown as PluginRuntime
}

const CONFIG = {} as never
const TABLE_SCOPE = { enabled: false } as unknown as TableScope
const FLAGS = {} as ParsedFlags

describe('applyMigration sync resume (#6)', () => {
  test('skips a completed statement on re-run after a partial failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chkit-apply-resume-'))
    writeFileSync(
      join(dir, 'm.sql'),
      'ALTER TABLE t ADD COLUMN a UInt64;\nALTER TABLE t ADD COLUMN b UInt64;\n',
    )

    const commandCalls: string[] = []
    let failSecondStatement = true
    const db = {
      async command(sql: string) {
        commandCalls.push(sql)
        if (failSecondStatement && sql.includes('COLUMN b')) {
          throw new Error('boom: statement b failed')
        }
      },
    } as unknown as ClickHouseExecutor

    const { store, appended, state } = createFakeStore()
    const args = {
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    }

    // Run 1: both statements attempted; statement b fails.
    await expect(applyMigration(args)).rejects.toThrow('boom: statement b failed')
    expect(commandCalls).toEqual([
      'ALTER TABLE t ADD COLUMN a UInt64;',
      'ALTER TABLE t ADD COLUMN b UInt64;',
    ])
    const after1 = state()
    expect(after1?.operations.find((o) => o.operationIndex === 0)?.status).toBe('completed')
    expect(after1?.operations.find((o) => o.operationIndex === 1)?.status).toBe('failed')
    expect(appended).toHaveLength(0)

    // Run 2: statement b now succeeds. Statement a must NOT be replayed.
    failSecondStatement = false
    commandCalls.length = 0
    await applyMigration(args)
    expect(commandCalls).toEqual(['ALTER TABLE t ADD COLUMN b UInt64;'])
    expect(appended).toHaveLength(1)

    rmSync(dir, { recursive: true, force: true })
  })

  // A statement is marked completed BEFORE the DDL-propagation wait, so a
  // propagation timeout can't cause the (already-executed) statement to be
  // replayed into an "already exists" error on re-run.
  test('marks a sync statement completed before waiting for DDL propagation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chkit-apply-order-'))
    writeFileSync(
      join(dir, 'm.sql'),
      '-- operation: create_table key=table:default.t risk=safe\n' +
        'CREATE TABLE default.t (id UInt64) ENGINE = MergeTree ORDER BY id;\n',
    )

    const events: string[] = []
    const db = {
      async command() {
        events.push('command')
      },
      async query() {
        // Used by waitForDDLPropagation → waitForTable; a non-empty row means
        // the table is already visible, so the wait returns immediately.
        events.push('propagation-query')
        return [{ x: 1 }]
      },
    } as unknown as ClickHouseExecutor

    let current: MigrationRowState | null = null
    const store: JournalStore = {
      databaseMissing: false,
      async readJournal() {
        return { version: 1, applied: [] }
      },
      async readMigrationState() {
        return current
      },
      async writeMigrationState(state) {
        current = state
        if (state.operations.some((op) => op.status === 'completed')) events.push('completed-write')
      },
      async appendEntry() {},
    }

    await applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    })
    rmSync(dir, { recursive: true, force: true })

    expect(events).toEqual(['command', 'completed-write', 'propagation-query'])
  })
})
