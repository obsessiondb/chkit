import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { applyMigration, PROPAGATION_WAIT_PENDING } from '../../../commands/migrate/apply.js'
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
      async query(sql: string) {
        // The replica probe (#265): answer as a single-replica server.
        if (sql.includes('system.one')) return []
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

    // The second write clears the pending-wait marker once the wait passed (#513).
    expect(events).toEqual(['command', 'completed-write', 'propagation-query', 'completed-write'])
    expect(current?.operations[0]?.lastError).toBe('')
  })
})

describe('applyMigration resume after a propagation wait timeout (#513)', () => {
  const CREATE = 'CREATE TABLE IF NOT EXISTS default.t (id UInt64) ENGINE = MergeTree ORDER BY id;'
  const INSERT = 'INSERT INTO default.t VALUES (1);'
  const SQL = `-- operation: create_table key=table:default.t risk=safe\n${CREATE}\n${INSERT}\n`

  // A single-replica target on which default.t is listed in system.tables
  // only while `visible` is set.
  function propagationDb(events: string[], visible: { value: boolean }) {
    return {
      async command(sql: string) {
        events.push(`command ${sql}`)
      },
      async query(sql: string) {
        if (sql.includes('system.one')) return []
        events.push('propagation-query')
        return visible.value ? [{ x: 1 }] : []
      },
    } as unknown as ClickHouseExecutor
  }

  function recordingStore(events: string[]) {
    const fake = createFakeStore()
    const appendEntry = fake.store.appendEntry
    fake.store.appendEntry = async (entry) => {
      events.push('append')
      await appendEntry(entry)
    }
    return fake
  }

  test('waits again for a completed statement whose wait timed out, then runs the next statement and records', async () => {
    const dir = writeMigration(SQL)
    const events: string[] = []
    const visible = { value: false }
    const { store, state, appended } = recordingStore(events)
    const args = {
      db: propagationDb(events, visible),
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    }

    await expect(applyMigration(args)).rejects.toThrow('waitForTable: default.t not yet visible')
    expect(events[0]).toBe(`command ${CREATE}`)
    expect(events.filter((event) => event.startsWith('command'))).toHaveLength(1)
    expect(state()?.operations.map((op) => [op.operationIndex, op.status, op.lastError])).toEqual([
      [0, 'completed', PROPAGATION_WAIT_PENDING],
    ])
    expect(appended).toEqual([])

    visible.value = true
    events.length = 0
    await applyMigration(args)
    rmSync(dir, { recursive: true, force: true })

    expect(events).toEqual(['propagation-query', `command ${INSERT}`, 'append'])
    expect(state()?.operations.map((op) => [op.operationIndex, op.status, op.lastError])).toEqual([
      [0, 'completed', ''],
      [1, 'completed', ''],
    ])
    expect(appended).toMatchObject([{ name: 'm.sql', checksum: checksumSQL(SQL) }])
  }, 30_000)

  // --abandon keeps every record as failed, so the next run restarts at
  // statement 1 with the abandoned record of statement 2 still in the state.
  test('waits again after a restart from --abandon, although a later statement is recorded', async () => {
    const dir = writeMigration(SQL)
    const events: string[] = []
    const visible = { value: false }
    const abandoned = (index: number, was: string): OperationState => ({
      ...operation(index, 'failed'),
      lastError: `abandoned via chkit migrate --abandon (was ${was})`,
    })
    const { store, appended } = createFakeStore(
      inProgressState(checksumSQL(SQL), [
        { ...abandoned(0, 'completed'), operationType: 'create_table', operationKey: 'table:default.t' },
        abandoned(1, 'failed'),
      ]),
    )
    const args = {
      db: propagationDb(events, visible),
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    }

    await expect(applyMigration(args)).rejects.toThrow('waitForTable: default.t not yet visible')
    expect(events.filter((event) => event.startsWith('command'))).toEqual([`command ${CREATE}`])

    visible.value = true
    events.length = 0
    await applyMigration(args)
    rmSync(dir, { recursive: true, force: true })

    expect(events).toEqual(['propagation-query', `command ${INSERT}`])
    expect(appended).toHaveLength(1)
  }, 30_000)

  test('does not record the migration when the wait times out again', async () => {
    const dir = writeMigration(SQL)
    const events: string[] = []
    const visible = { value: false }
    const { store, state, writes, appended } = recordingStore(events)
    const args = {
      db: propagationDb(events, visible),
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    }

    await expect(applyMigration(args)).rejects.toThrow('waitForTable: default.t not yet visible')
    const writesAfterFirstRun = writes.length
    events.length = 0
    await expect(applyMigration(args)).rejects.toThrow('waitForTable: default.t not yet visible')
    rmSync(dir, { recursive: true, force: true })

    expect(events.length).toBeGreaterThan(1)
    expect(events.every((event) => event === 'propagation-query')).toBe(true)
    expect(writes).toHaveLength(writesAfterFirstRun)
    expect(state()?.migrationCompleted).toBe(false)
    expect(state()?.operations.map((op) => [op.operationIndex, op.status])).toEqual([[0, 'completed']])
    expect(appended).toEqual([])
  }, 60_000)

  // A completed statement whose wait passed is not waited for again, even
  // when no later statement is recorded (--retry drops the record of an
  // edited statement). Here a DROP that ran before its acknowledgement was
  // lost removed what the CREATE's wait looks for: that wait could never pass.
  test('does not wait again for a completed statement whose wait passed', async () => {
    const sql =
      `-- operation: create_table key=table:default.t risk=safe\n${CREATE}\n` +
      '-- operation: drop_table key=table:default.t risk=danger\nDROP TABLE IF EXISTS default.t;\n'
    const dir = writeMigration(sql)
    const events: string[] = []
    const { store, appended } = createFakeStore(
      inProgressState(checksumSQL(sql), [
        operation(0, 'completed', { type: 'create_table', key: 'table:default.t' }),
      ]),
    )

    await applyMigration({
      db: propagationDb(events, { value: false }),
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    })
    rmSync(dir, { recursive: true, force: true })

    expect(events).toEqual(['command DROP TABLE IF EXISTS default.t;', 'propagation-query'])
    expect(appended).toHaveLength(1)
  }, 30_000)
})

describe('applyMigration backfill assertions (#274)', () => {
  const GUARD = "SELECT throwIf((SELECT count() FROM brain.knowledge FINAL WHERE format_version < 3) > 0, 'Republish repository knowledge');"
  const GUARD_MARKER = '-- operation: assert_backfill key=table:brain.knowledge:backfill risk=safe\n'
  const DROP = 'ALTER TABLE brain.knowledge DROP COLUMN owners;'
  const DROP_MARKER = '-- operation: alter_table_drop_column key=table:brain.knowledge:column:owners risk=danger\n'

  test('journals a successful guard and resumes subsequent DDL without replaying the guard', async () => {
    const sql = `${GUARD_MARKER}${GUARD}\n${DROP_MARKER}${DROP}\n`
    const dir = writeMigration(sql)
    const { store, state, appended } = createFakeStore()
    const commands: string[] = []
    const queries: string[] = []
    let failDrop = true
    const db = {
      async command(statement: string) {
        commands.push(statement)
        if (statement === DROP && failDrop) throw new Error('drop temporarily failed')
      },
      async query(statement: string) {
        queries.push(statement)
        // The column has disappeared after DROP. Other rows would falsely
        // satisfy the old wait for the nonexistent knowledge:backfill table.
        return statement.includes('system.columns') || statement.includes('system.one') ? [] : [{ x: 1 }]
      },
    } as unknown as ClickHouseExecutor
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

    await expect(applyMigration(args)).rejects.toThrow('drop temporarily failed')
    expect(state()?.operations).toMatchObject([
      { operationType: 'assert_backfill', operationKey: 'table:brain.knowledge:backfill', status: 'completed' },
      { operationType: 'alter_table_drop_column', status: 'failed' },
    ])
    expect(queries).toEqual([])
    expect(appended).toEqual([])

    failDrop = false
    await applyMigration(args)
    rmSync(dir, { recursive: true, force: true })

    expect(commands).toEqual([GUARD, DROP, DROP])
    expect(queries).toHaveLength(2)
    expect(queries[1]).toContain("table = 'knowledge' AND name = 'owners'")
    expect(queries.some((query) => query.includes('knowledge:backfill'))).toBe(false)
    expect(state()?.migrationCompleted).toBe(true)
    expect(state()?.operations.every((operation) => operation.status === 'completed')).toBe(true)
    expect(appended).toMatchObject([{ name: 'm.sql', checksum: checksumSQL(sql) }])
  })

  test('a rejected guard blocks destructive DDL and runs again after the backfill is complete', async () => {
    const sql = `${GUARD_MARKER}${GUARD}\n${DROP_MARKER}${DROP}\n`
    const dir = writeMigration(sql)
    const { store, state, appended } = createFakeStore()
    const commands: string[] = []
    const queries: string[] = []
    let backfillComplete = false
    const db = {
      async command(statement: string) {
        commands.push(statement)
        if (statement === GUARD && !backfillComplete) throw new Error('Republish repository knowledge')
      },
      async query(statement: string) {
        queries.push(statement)
        return statement.includes('system.columns') || statement.includes('system.one') ? [] : [{ x: 1 }]
      },
    } as unknown as ClickHouseExecutor
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

    await expect(applyMigration(args)).rejects.toThrow('Republish repository knowledge')
    expect(commands).toEqual([GUARD])
    expect(queries).toEqual([])
    expect(state()?.operations).toMatchObject([
      { operationType: 'assert_backfill', status: 'failed', lastError: 'Republish repository knowledge' },
    ])
    expect(appended).toEqual([])

    backfillComplete = true
    await applyMigration(args)
    rmSync(dir, { recursive: true, force: true })

    expect(commands).toEqual([GUARD, GUARD, DROP])
    expect(queries).toHaveLength(2)
    expect(queries[1]).toContain("table = 'knowledge' AND name = 'owners'")
    expect(queries.some((query) => query.includes('knowledge:backfill'))).toBe(false)
    expect(state()?.migrationCompleted).toBe(true)
    expect(state()?.operations.every((operation) => operation.status === 'completed')).toBe(true)
    expect(appended).toMatchObject([{ name: 'm.sql', checksum: checksumSQL(sql) }])
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

describe('applyMigration -- before-retry on sync statements', () => {
  const SQL =
    '-- operation: cutover_validate key=table:default.t:cutover:start risk=caution\n' +
    'SELECT 1;\n' +
    '-- operation: exchange_tables key=table:default.t risk=caution\n' +
    "-- before-retry: SELECT throwIf(swapped, 'already swapped')\n" +
    'EXCHANGE TABLES default.t AND default.s;\n'
  const START = { type: 'cutover_validate', key: 'table:default.t:cutover:start' }
  const EXCHANGE = { type: 'exchange_tables', key: 'table:default.t' }

  function args(db: ClickHouseExecutor, store: JournalStore, dir: string) {
    return {
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
      log: () => {},
    }
  }

  test('does not run before-retry SQL on the first attempt', async () => {
    const dir = writeMigration(SQL)
    const { db, commandCalls } = recordingDb()
    const { store } = createFakeStore()
    await applyMigration(args(db, store, dir))
    expect(commandCalls).toEqual(['SELECT 1;', 'EXCHANGE TABLES default.t AND default.s;'])
    rmSync(dir, { recursive: true, force: true })
  })

  // A lost acknowledgement leaves the EXCHANGE recorded as started although it
  // ran. Its guard runs first and stops the retry instead of swapping back.
  test('runs the guard before retrying an interrupted statement, and stops when it throws', async () => {
    const dir = writeMigration(SQL)
    const { store } = createFakeStore(
      inProgressState(checksumSQL(SQL), [operation(0, 'completed', START), operation(1, 'started', EXCHANGE)]),
    )
    const { db, commandCalls } = recordingDb({ fail: (sql) => sql.startsWith('SELECT throwIf(swapped') })
    await expect(applyMigration(args(db, store, dir))).rejects.toThrow('boom: SELECT throwIf(swapped')
    expect(commandCalls).toEqual(["SELECT throwIf(swapped, 'already swapped')"])
    rmSync(dir, { recursive: true, force: true })
  })

  test('retries a failed statement once its guard passes', async () => {
    const dir = writeMigration(SQL)
    const { store, appended } = createFakeStore(
      inProgressState(checksumSQL(SQL), [operation(0, 'completed', START), operation(1, 'failed', EXCHANGE)]),
    )
    const { db, commandCalls } = recordingDb()
    await applyMigration(args(db, store, dir))
    expect(commandCalls).toEqual([
      "SELECT throwIf(swapped, 'already swapped')",
      'EXCHANGE TABLES default.t AND default.s;',
    ])
    expect(appended).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('applyMigration mode=barrier', () => {
  test('waits for the INSERTs running at the first read instead of executing the statement', async () => {
    const sql =
      '-- operation: cutover_wait_for_inserts key=table:default.t:cutover:mirror_barrier risk=safe mode=barrier\n' +
      "SELECT query_id FROM system.processes WHERE query_kind IN ('Insert', 'AsyncInsertFlush');\n"
    const dir = writeMigration(sql)
    const polls = [['q1'], ['q1'], []]
    const reads: string[] = []
    const commandCalls: string[] = []
    const db = {
      async command(statement: string) {
        commandCalls.push(statement)
      },
      async query<T>(statement: string): Promise<T[]> {
        if (statement.includes('system.one')) throw new Error('no cluster')
        reads.push(statement)
        return (polls[Math.min(reads.length - 1, polls.length - 1)] ?? []).map((query_id) => ({ query_id })) as T[]
      },
    } as unknown as ClickHouseExecutor
    const { store, appended } = createFakeStore()
    await applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
      log: () => {},
    })
    expect(commandCalls).toEqual([])
    expect(reads).toHaveLength(3)
    expect(appended).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  }, 15_000)

  // An exchange_tables statement keeps its replica wait when marked barrier:
  // the barrier read runs an EXCHANGE TABLES as ClickHouse would (#577).
  const EXCHANGE_BARRIER_SQL =
    '-- operation: exchange_tables key=table:default.a risk=caution mode=barrier\n' +
    'EXCHANGE TABLES default.a AND default.b;\n' +
    '-- operation: drop_table key=table:default.b risk=danger\n' +
    'DROP TABLE IF EXISTS default.b SYNC;\n'
  const DROP_SENT = 'DROP TABLE IF EXISTS default.b SYNC;'

  // A two-replica target: no INSERT is running, the replicas agree on both
  // exchanged tables, and the dropped table is gone everywhere.
  function twoReplicaDb() {
    const events: string[] = []
    const db = {
      async command(statement: string) {
        events.push(`command ${statement}`)
      },
      async query<T>(statement: string): Promise<T[]> {
        if (statement.includes('system.one')) return [{ replicas: 2 }] as T[]
        if (statement.includes('EXCHANGE TABLES')) events.push('barrier read')
        if (statement.includes('system.processes')) events.push('barrier read')
        if (statement.includes('uniqExact(uuid)')) {
          events.push('exchange wait')
          return [
            { database: 'default', name: 'a', replicas: 2, uuids: 1, sample_uuid: 'u1' },
            { database: 'default', name: 'b', replicas: 2, uuids: 1, sample_uuid: 'u2' },
          ] as T[]
        }
        return [] as T[]
      },
    } as unknown as ClickHouseExecutor
    return { db, events }
  }

  function applyOnTwoReplicas(db: ClickHouseExecutor, dir: string, store: JournalStore) {
    return applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
      log: () => {},
    })
  }

  test('an EXCHANGE TABLES marked mode=barrier waits for every replica before the next statement', async () => {
    const dir = writeMigration(EXCHANGE_BARRIER_SQL)
    const { db, events } = twoReplicaDb()
    const { store, appended, writes } = createFakeStore()
    await applyOnTwoReplicas(db, dir, store)
    expect(events).toEqual(['barrier read', 'exchange wait', `command ${DROP_SENT}`])
    const exchangeRecords = writes.flatMap((state) =>
      state.operations.filter((op) => op.operationIndex === 0).map((op) => [op.status, op.lastError]),
    )
    expect(exchangeRecords.slice(0, 3)).toEqual([
      ['started', ''],
      ['completed', PROPAGATION_WAIT_PENDING],
      ['completed', ''],
    ])
    expect(appended).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a resumed EXCHANGE TABLES barrier with a pending marker waits again before the next statement', async () => {
    const dir = writeMigration(EXCHANGE_BARRIER_SQL)
    const { db, events } = twoReplicaDb()
    const { store, appended, state } = createFakeStore(
      inProgressState(checksumSQL(EXCHANGE_BARRIER_SQL), [
        {
          ...operation(0, 'completed', { type: 'exchange_tables', key: 'table:default.a' }),
          lastError: PROPAGATION_WAIT_PENDING,
        },
      ]),
    )
    await applyOnTwoReplicas(db, dir, store)
    expect(events).toEqual(['exchange wait', `command ${DROP_SENT}`])
    expect(state()?.operations.map((op) => [op.operationIndex, op.status, op.lastError])).toEqual([
      [0, 'completed', ''],
      [1, 'completed', ''],
    ])
    expect(appended).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a SELECT barrier has no propagation wait', async () => {
    const sql =
      '-- operation: cutover_wait_for_inserts key=table:default.a:cutover:mirror_barrier risk=safe mode=barrier\n' +
      "SELECT query_id FROM system.processes WHERE query_kind = 'Insert';\n"
    const dir = writeMigration(sql)
    const { db, events } = twoReplicaDb()
    const { store, appended, writes } = createFakeStore()
    await applyOnTwoReplicas(db, dir, store)
    expect(events).toEqual(['barrier read'])
    expect(writes.flatMap((state) => state.operations.map((op) => [op.status, op.lastError]))).toEqual([
      ['started', ''],
      ['completed', ''],
    ])
    expect(appended).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })
})


describe('applyMigration fire-and-forget async insert guard', () => {
  const SQL =
    '-- operation: cutover_validate key=table:app.events:cutover:start risk=caution\n' +
    'SELECT 1;\n' +
    '-- operation: cutover_snapshot key=table:app.events:cutover:snapshot risk=caution\n' +
    'ALTER TABLE app.events__cutover_1_snapshot ATTACH PARTITION ALL FROM app.events;\n' +
    '-- operation: exchange_tables key=table:app.events risk=caution\n' +
    'EXCHANGE TABLES app.events AND app.events__cutover_1;\n'

  // query_log reports fire-and-forget async inserts into the tables listed in `busy`.
  function queryLogDb(busy: (sql: string) => string[]) {
    const commandCalls: string[] = []
    const guardReads: string[] = []
    const db = {
      async command(statement: string) {
        commandCalls.push(statement)
      },
      async query<T>(statement: string): Promise<T[]> {
        if (statement.includes('system.one')) throw new Error('no cluster')
        if (!statement.includes('system.query_log')) return [] as T[]
        guardReads.push(statement)
        return busy(statement).map((table) => ({ table, inserts: 3 })) as T[]
      },
    } as unknown as ClickHouseExecutor
    return { db, commandCalls, guardReads }
  }

  function run(db: ClickHouseExecutor, dir: string, store: JournalStore) {
    return applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
      log: () => {},
    })
  }

  test('checks the cutover table at the first step and both tables before the EXCHANGE', async () => {
    const dir = writeMigration(SQL)
    const { db, commandCalls, guardReads } = queryLogDb(() => [])
    const { store } = createFakeStore()
    await run(db, dir, store)
    expect(guardReads).toHaveLength(2)
    expect(guardReads[0]).toContain("hasAny(tables, ['app.events'])")
    expect(guardReads[1]).toContain("hasAny(tables, ['app.events', 'app.events__cutover_1'])")
    expect(commandCalls).toHaveLength(3)
    rmSync(dir, { recursive: true, force: true })
  })

  test('stops a cutover before its copy while fire-and-forget async inserts reach the table', async () => {
    const dir = writeMigration(SQL)
    const { db, commandCalls } = queryLogDb(() => ['app.events'])
    const { store } = createFakeStore()
    await expect(run(db, dir, store)).rejects.toThrow('3 into app.events')
    expect(commandCalls).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  test('refuses the EXCHANGE when such inserts started during the cutover', async () => {
    const dir = writeMigration(SQL)
    const { db, commandCalls } = queryLogDb((sql) => (sql.includes('app.events__cutover_1') ? ['app.events'] : []))
    const { store } = createFakeStore()
    await expect(run(db, dir, store)).rejects.toThrow('wait_for_async_insert = 0')
    expect(commandCalls).toEqual(['SELECT 1;', 'ALTER TABLE app.events__cutover_1_snapshot ATTACH PARTITION ALL FROM app.events;'])
    rmSync(dir, { recursive: true, force: true })
  })
})
