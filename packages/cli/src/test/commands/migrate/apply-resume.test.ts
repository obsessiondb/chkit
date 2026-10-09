import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { applyMigration } from '../../../commands/migrate/apply.js'
import type {
  JournalStore,
  MigrationRowState,
  OperationState,
} from '../../../runtime/journal-store.js'
import { checksumSQL, type MigrationJournalEntry } from '../../../runtime/migration-store.js'
import type { ParsedFlags, PluginRuntime, TableScope } from '../../../plugins.js'

function createFakeStore(initial: MigrationRowState | null = null) {
  let current: MigrationRowState | null = initial
  const appended: MigrationJournalEntry[] = []
  const writes: MigrationRowState[] = []
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState() {
      return current
    },
    async writeMigrationState(state) {
      writes.push(state)
      current = state
    },
    async appendEntry(entry) {
      appended.push(entry)
      if (current) current = { ...current, checksum: entry.checksum, migrationCompleted: true }
    },
  }
  return { store, appended, writes, state: () => current }
}

function fakePluginRuntime(
  transform: (statements: string[]) => string[] = (statements) => statements,
): PluginRuntime {
  return {
    async runOnBeforeApply({ statements }: { statements: string[] }) {
      return transform(statements)
    },
    async runOnAfterApply() {},
  } as unknown as PluginRuntime
}

function operation(
  index: number,
  status: OperationState['status'],
  identity: { type: string; key: string } = { type: 'sql_statement', key: `statement:${index}` },
): OperationState {
  return {
    operationIndex: index,
    operationKey: identity.key,
    operationType: identity.type,
    queryId: '',
    status,
    startedAt: '2026-09-29 00:11:10.000',
    finishedAt: status === 'started' ? null : '2026-09-29 00:11:11.000',
    lastError: status === 'failed' ? 'Code: 60. Unknown table' : '',
  }
}

function inProgressState(checksum: string, operations: OperationState[]): MigrationRowState {
  return {
    name: 'm.sql',
    appliedAt: '2026-09-29 00:11:11.000',
    checksum,
    chkitVersion: '0.2.0-test',
    migrationCompleted: false,
    operations,
  }
}

function recordingDb(options: { fail?: (sql: string) => boolean } = {}) {
  const commandCalls: string[] = []
  const db = {
    async command(sql: string) {
      commandCalls.push(sql)
      if (options.fail?.(sql)) throw new Error(`boom: ${sql}`)
    },
  } as unknown as ClickHouseExecutor
  return { db, commandCalls }
}

function writeMigration(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chkit-apply-edit-'))
  writeFileSync(join(dir, 'm.sql'), sql)
  return dir
}

const EDITED_SQL = 'ALTER TABLE t ADD COLUMN a UInt64;\nALTER TABLE t ADD COLUMN b2 UInt64;\n'

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

describe('applyMigration with an edited in-progress migration (#233)', () => {
  test('refuses an edited file when a statement already completed and --retry was not given', async () => {
    const dir = writeMigration(EDITED_SQL)
    const { db, commandCalls } = recordingDb()
    const { store, writes, appended } = createFakeStore(
      inProgressState('old', [operation(0, 'completed'), operation(1, 'failed')]),
    )

    const attempt = applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    })
    await expect(attempt).rejects.toMatchObject({ code: 'in_progress_checksum_mismatch' })
    await expect(attempt).rejects.toThrow('chkit migrate --apply --retry m.sql')
    await expect(attempt).rejects.toThrow('chkit migrate --apply --abandon m.sql')
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
    expect(writes).toEqual([])
    expect(appended).toEqual([])
  })

  test('--retry re-keys the state to the new checksum, then skips the completed statement', async () => {
    const dir = writeMigration(EDITED_SQL)
    const { db, commandCalls } = recordingDb()
    const { store, writes, appended } = createFakeStore(
      inProgressState('old', [operation(0, 'completed'), operation(1, 'failed')]),
    )

    await applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
      retry: { previousChecksum: 'old', checksum: checksumSQL(EDITED_SQL) },
    })
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual(['ALTER TABLE t ADD COLUMN b2 UInt64;'])
    expect(writes[0]?.checksum).toBe(checksumSQL(EDITED_SQL))
    expect(writes[0]?.operations.map((op) => [op.operationIndex, op.status])).toEqual([
      [0, 'completed'],
      [1, 'failed'],
    ])
    expect(writes.every((state) => state.checksum === checksumSQL(EDITED_SQL))).toBe(true)
    expect(appended[0]?.checksum).toBe(checksumSQL(EDITED_SQL))
  })

  test('refuses a --retry verified against another journal checksum', async () => {
    const dir = writeMigration(EDITED_SQL)
    const { db, commandCalls } = recordingDb()
    const { store, writes } = createFakeStore(
      inProgressState('old', [operation(0, 'completed'), operation(1, 'failed')]),
    )

    await expect(
      applyMigration({
        db,
        journalStore: store,
        pluginRuntime: fakePluginRuntime(),
        config: CONFIG,
        tableScope: TABLE_SCOPE,
        flags: FLAGS,
        migrationsDir: dir,
        file: 'm.sql',
        retry: { previousChecksum: 'other', checksum: checksumSQL(EDITED_SQL) },
      }),
    ).rejects.toMatchObject({ code: 'in_progress_checksum_mismatch' })
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
    expect(writes).toEqual([])
  })

  test('runs an edited file from statement 1 when no statement is recorded as completed or started', async () => {
    const dir = writeMigration(EDITED_SQL)
    const { db, commandCalls } = recordingDb()
    const { store, writes, appended } = createFakeStore(
      inProgressState('old', [operation(0, 'failed')]),
    )
    const lines: string[] = []

    await applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
      log: (line) => lines.push(line),
    })
    rmSync(dir, { recursive: true, force: true })

    expect(lines).toEqual([
      'm.sql changed since its last failed attempt; no statement is recorded as completed, so it runs again from statement 1.',
    ])
    expect(commandCalls).toEqual([
      'ALTER TABLE t ADD COLUMN a UInt64;',
      'ALTER TABLE t ADD COLUMN b2 UInt64;',
    ])
    expect(writes[0]?.checksum).toBe(checksumSQL(EDITED_SQL))
    expect(appended[0]?.checksum).toBe(checksumSQL(EDITED_SQL))
  })

  // --abandon marks completed statements failed; they ran, but the journal no
  // longer records them as completed, so the edited file starts over.
  test('runs an abandoned, edited file from statement 1, including the statement that had completed', async () => {
    const dir = writeMigration(EDITED_SQL)
    const { db, commandCalls } = recordingDb()
    const { store, appended } = createFakeStore(
      inProgressState('old', [
        { ...operation(0, 'completed'), status: 'failed', lastError: 'abandoned via chkit migrate --abandon (was completed)' },
        { ...operation(1, 'failed'), lastError: 'abandoned via chkit migrate --abandon (was failed)' },
      ]),
    )
    const lines: string[] = []

    await applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
      log: (line) => lines.push(line),
    })
    rmSync(dir, { recursive: true, force: true })

    expect(lines).toEqual([
      'm.sql changed since its last failed attempt; no statement is recorded as completed, so it runs again from statement 1.',
    ])
    expect(commandCalls).toEqual([
      'ALTER TABLE t ADD COLUMN a UInt64;',
      'ALTER TABLE t ADD COLUMN b2 UInt64;',
    ])
    expect(appended[0]?.checksum).toBe(checksumSQL(EDITED_SQL))
  })

  test('a started statement still requires --retry: it may have run', async () => {
    const dir = writeMigration(EDITED_SQL)
    const { db, commandCalls } = recordingDb()
    const { store } = createFakeStore(inProgressState('old', [operation(0, 'started')]))

    await expect(
      applyMigration({
        db,
        journalStore: store,
        pluginRuntime: fakePluginRuntime(),
        config: CONFIG,
        tableScope: TABLE_SCOPE,
        flags: FLAGS,
        migrationsDir: dir,
        file: 'm.sql',
      }),
    ).rejects.toMatchObject({ code: 'in_progress_checksum_mismatch' })
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
  })

  test('a --retry run that fails again resumes later without --retry', async () => {
    const dir = writeMigration(EDITED_SQL)
    let failB2 = true
    const { db, commandCalls } = recordingDb({ fail: (sql) => failB2 && sql.includes('b2') })
    const { store, appended, state } = createFakeStore(
      inProgressState('old', [operation(0, 'completed'), operation(1, 'failed')]),
    )
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

    await expect(
      applyMigration({ ...args, retry: { previousChecksum: 'old', checksum: checksumSQL(EDITED_SQL) } }),
    ).rejects.toThrow('failed at statement 2 of 2')
    expect(state()?.checksum).toBe(checksumSQL(EDITED_SQL))

    failB2 = false
    commandCalls.length = 0
    await applyMigration(args)
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual(['ALTER TABLE t ADD COLUMN b2 UInt64;'])
    expect(appended).toHaveLength(1)
  })

  // A column's REMOVE MATERIALIZED carries the marker of the MODIFY COLUMN after
  // it. Deleting the completed REMOVE slid the MODIFY into its slot, where
  // --retry skipped it as completed and recorded the migration as applied.
  describe('a REMOVE that completed before its MODIFY COLUMN failed', () => {
    const MARKER = '-- operation: alter_table_modify_column key=table:db.t:column:f risk=caution\n'
    const REMOVE = 'ALTER TABLE db.t MODIFY COLUMN `f` REMOVE MATERIALIZED;'
    const MODIFY = 'ALTER TABLE db.t MODIFY COLUMN `f` DateTime;'
    const failedState = () =>
      inProgressState('old', [
        operation(0, 'completed', { type: 'alter_table_modify_column', key: 'table:db.t:column:f' }),
        operation(1, 'failed', { type: 'alter_table_modify_column', key: 'table:db.t:column:f' }),
      ])

    test('--retry refuses an edit that deleted the completed REMOVE, and runs nothing', async () => {
      const sql = `${MARKER}${MODIFY}\n`
      const dir = writeMigration(sql)
      const { db, commandCalls } = recordingDb()
      const { store, writes, appended } = createFakeStore(failedState())

      await expect(
        applyMigration({
          db,
          journalStore: store,
          pluginRuntime: fakePluginRuntime(),
          config: CONFIG,
          tableScope: TABLE_SCOPE,
          flags: FLAGS,
          migrationsDir: dir,
          file: 'm.sql',
          retry: { previousChecksum: 'old', checksum: checksumSQL(sql) },
        }),
      ).rejects.toMatchObject({ code: 'retry_mismatch' })
      rmSync(dir, { recursive: true, force: true })

      expect(commandCalls).toEqual([])
      expect(writes).toEqual([])
      expect(appended).toEqual([])
    })

    test('--retry skips the completed REMOVE kept in place and runs the edited MODIFY COLUMN', async () => {
      const sql = `${MARKER}${REMOVE}\n${MARKER}${MODIFY}\n`
      const dir = writeMigration(sql)
      const { db, commandCalls } = recordingDb()
      // waitForColumn polls system.columns after each column statement.
      const dbWithColumns = Object.assign(db, { query: async () => [{ x: 1 }] })
      const { store, appended } = createFakeStore(failedState())

      await applyMigration({
        db: dbWithColumns,
        journalStore: store,
        pluginRuntime: fakePluginRuntime(),
        config: CONFIG,
        tableScope: TABLE_SCOPE,
        flags: FLAGS,
        migrationsDir: dir,
        file: 'm.sql',
        retry: { previousChecksum: 'old', checksum: checksumSQL(sql) },
      })
      rmSync(dir, { recursive: true, force: true })

      expect(commandCalls).toEqual([MODIFY])
      expect(appended[0]?.checksum).toBe(checksumSQL(sql))
    })
  })

  test('--retry checks again against the statements onBeforeApply returns', async () => {
    const sql =
      '-- operation: alter_table_add_column key=table:default.t risk=safe\n' +
      'ALTER TABLE t ADD COLUMN a UInt64;\n' +
      '-- operation: alter_table_add_column key=table:default.t2 risk=safe\n' +
      'ALTER TABLE t2 ADD COLUMN b UInt64;\n'
    const dir = writeMigration(sql)
    const { db, commandCalls } = recordingDb()
    const { store } = createFakeStore(
      inProgressState('old', [
        operation(0, 'completed', { type: 'alter_table_add_column', key: 'table:default.t' }),
        operation(1, 'completed', { type: 'alter_table_add_column', key: 'table:default.t2' }),
      ]),
    )

    // A plugin that drops the first statement shifts every index.
    await expect(
      applyMigration({
        db,
        journalStore: store,
        pluginRuntime: fakePluginRuntime((statements) => statements.slice(1)),
        config: CONFIG,
        tableScope: TABLE_SCOPE,
        flags: FLAGS,
        migrationsDir: dir,
        file: 'm.sql',
        retry: { previousChecksum: 'old', checksum: checksumSQL(sql) },
      }),
    ).rejects.toMatchObject({ code: 'retry_mismatch' })
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
  })
})

