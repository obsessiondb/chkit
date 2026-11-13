import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { statementFingerprint } from '@chkit/core'

import { applyMigration, PROPAGATION_WAIT_PENDING } from '../../../commands/migrate/apply.js'
import { abandonMigrationState } from '../../../commands/migrate/abandon.js'
import { MigrateError } from '../../../commands/migrate/errors.js'
import type {
  JournalStore,
  MigrationRowState,
  OperationState,
} from '../../../runtime/journal-store.js'
import { checksumSQL, type MigrationJournalEntry } from '../../../runtime/migration-store.js'
import { CLI_VERSION } from '../../../runtime/version.js'
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
    fingerprint: '',
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

  // #701: an async retry runs under a random query id, so a record the edit
  // drops is the only trace of an attempt that may still run (a submit that
  // failed while the server ran it). The edit stops while it runs.
  for (const running of [true, false]) {
    test(`an edit that drops the record of an async attempt ${running ? 'stops while it still runs' : 'runs once it stopped'}`, async () => {
      const dir = writeMigration(EDITED_SQL)
      const { db: recording, commandCalls } = recordingDb()
      const statusCalls: Array<{ queryId: string; everyReplica?: boolean; runningOnly?: boolean }> = []
      const db = {
        ...recording,
        async queryStatus(queryId: string, options?: { everyReplica?: boolean; runningOnly?: boolean }) {
          statusCalls.push({ queryId, ...options })
          return { status: running ? 'running' : 'unknown' }
        },
      } as unknown as ClickHouseExecutor
      const { store, writes } = createFakeStore(
        inProgressState('old', [
          operation(0, 'failed'),
          { ...operation(1, 'failed', { type: 'load_table_data', key: 'table:t' }), queryId: 'retry-query-id' },
        ]),
      )

      const run = applyMigration({
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
      if (running) {
        await expect(run).rejects.toMatchObject({
          code: 'retry_mismatch',
          message: expect.stringContaining("KILL QUERY WHERE query_id = 'retry-query-id'"),
        })
      } else {
        await run
      }
      rmSync(dir, { recursive: true, force: true })

      expect(statusCalls).toEqual([{ queryId: 'retry-query-id', everyReplica: true, runningOnly: true }])
      expect(commandCalls).toHaveLength(running ? 0 : 2)
      expect(writes.length > 0).toBe(!running)
    })
  }

  for (const mode of ['sync', 'barrier'] as const) {
    for (const prior of ['started', 'failed', 'abandoned', 'stopped', 'unreadable', 'no-before-retry'] as const) {
      test(`a mode-only async to ${mode} edit preserves its attempt until stopped (${prior})`, async () => {
        const sql = mode === 'barrier' ? 'SELECT query_id FROM system.processes WHERE 0;' : 'INSERT INTO db.a SELECT 1;'
        const compensation = prior === 'no-before-retry' ? '' : '-- before-retry: TRUNCATE TABLE db.a\n'
        const original = `-- operation: load_table_data key=table:db.a risk=safe mode=async\n${compensation}${sql}\n`
        const edited = original.replace('mode=async', `mode=${mode}`)
        const dir = writeMigration(edited)
        const recorded = inProgressState(checksumSQL(original), [{
          ...operation(0, prior === 'failed' || prior === 'stopped' || prior === 'unreadable' ? 'failed' : 'started', { type: 'load_table_data', key: 'table:db.a' }),
          queryId: 'random-retry-query-id',
          fingerprint: statementFingerprint(sql),
        }])
        const { store, writes, appended, state } = createFakeStore(recorded)
        // A crash immediately after an ID-clearing write must remain unreachable
        // while the original attempt runs, so the next run can still find it.
        const writeState = store.writeMigrationState.bind(store)
        store.writeMigrationState = async (next) => {
          await writeState(next)
          if (prior !== 'stopped' && next.operations[0]?.queryId === '') throw new Error('crash after ID overwrite')
        }
        if (prior === 'abandoned') await abandonMigrationState(recorded, { journalStore: store })
        const { db: recording, commandCalls } = recordingDb()
        const checks: Array<{ queryId: string; everyReplica?: boolean; runningOnly?: boolean }> = []
        const db = {
          ...recording,
          async query(query: string) { return query.includes('system.tables') ? [{ x: 1 }] : [] },
          async queryStatus(queryId: string, options?: { everyReplica?: boolean; runningOnly?: boolean }) {
            checks.push({ queryId, ...options })
            if (prior === 'unreadable') throw new Error('replica unavailable')
            return { status: prior === 'stopped' ? 'unknown' : 'running' }
          },
        } as unknown as ClickHouseExecutor
        try {
          const run = applyMigration({
            db, journalStore: store, pluginRuntime: fakePluginRuntime(), config: CONFIG,
            tableScope: TABLE_SCOPE, flags: FLAGS, migrationsDir: dir, file: 'm.sql',
            retry: { previousChecksum: checksumSQL(original), checksum: checksumSQL(edited) }, log: () => {},
          })
          if (prior === 'stopped') {
            await run
            expect(commandCalls).toEqual(mode === 'sync' ? ['TRUNCATE TABLE db.a', sql] : ['TRUNCATE TABLE db.a'])
            expect(state()?.migrationCompleted).toBe(true)
          } else {
            if (prior === 'unreadable') await expect(run).rejects.toThrow('replica unavailable')
            else await expect(run).rejects.toMatchObject({ code: 'retry_mismatch' })
            expect(commandCalls).toEqual([])
            expect(appended).toEqual([])
            expect(state()?.operations[0]?.queryId).toBe('random-retry-query-id')
            expect(writes.every((write) => write.operations[0]?.queryId === 'random-retry-query-id')).toBe(true)
          }
          expect(checks).toEqual([{ queryId: 'random-retry-query-id', everyReplica: true, runningOnly: true }])
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    }
  }

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

// Releases before #562 cut at a `;` inside a `//` comment: this file was
// [a, DROP z, b, c] for them, and is [a…b, c] now.
describe('applyMigration with a state another release split differently (#562)', () => {
  const SPLIT_SQL =
    'ALTER TABLE t ADD COLUMN a UInt64 // keep; ALTER TABLE t DROP COLUMN z;\n' +
    'ALTER TABLE t ADD COLUMN b UInt64;\n' +
    'ALTER TABLE t ADD COLUMN c UInt64;\n'

  function apply(dir: string, store: JournalStore, db: ClickHouseExecutor) {
    return applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    })
  }

  test('refuses to resume when the recorded statements are not the same in this split', async () => {
    const dir = writeMigration(SPLIT_SQL)
    const { db, commandCalls } = recordingDb()
    // The old release ran a and DROP z, then b failed. Resuming by position
    // would skip c, which never ran.
    const { store, writes, appended } = createFakeStore(
      inProgressState(checksumSQL(SPLIT_SQL), [
        operation(0, 'completed'),
        operation(1, 'completed'),
        operation(2, 'failed'),
      ]),
    )

    const attempt = apply(dir, store, db)
    await expect(attempt).rejects.toMatchObject({ code: 'statement_split_changed' })
    await expect(attempt).rejects.toThrow(
      `Cannot resume m.sql: chkit 0.2.0-test recorded its partial run, and this chkit (${CLI_VERSION}) splits the file into different statements.`,
    )
    await expect(attempt).rejects.toThrow('The journal recorded statements 1, 2 as completed or started')
    await expect(attempt).rejects.toThrow('chkit migrate --apply --abandon m.sql')
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
    expect(writes).toEqual([])
    expect(appended).toEqual([])
  })

  test('refuses a started statement too, and names a state without a release as an earlier one', async () => {
    const dir = writeMigration(SPLIT_SQL)
    const { db, commandCalls } = recordingDb()
    const { store } = createFakeStore({
      ...inProgressState(checksumSQL(SPLIT_SQL), [operation(0, 'completed'), operation(1, 'started')]),
      chkitVersion: '',
    })

    const attempt = apply(dir, store, db)
    await expect(attempt).rejects.toThrow('Cannot resume m.sql: an earlier chkit release recorded its partial run')
    await expect(attempt).rejects.toThrow('The journal recorded statements 1, 2 as completed or started')
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
  })

  test('resumes a state this release recorded', async () => {
    const dir = writeMigration(SPLIT_SQL)
    const { db, commandCalls } = recordingDb()
    const { store, appended } = createFakeStore({
      ...inProgressState(checksumSQL(SPLIT_SQL), [operation(0, 'completed'), operation(1, 'failed')]),
      chkitVersion: CLI_VERSION,
    })

    await apply(dir, store, db)
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual(['ALTER TABLE t ADD COLUMN c UInt64;'])
    expect(appended).toHaveLength(1)
  })

  test('resumes when every recorded statement is the same in both splits', async () => {
    const sql =
      'ALTER TABLE t ADD COLUMN a UInt64;\n' +
      'ALTER TABLE t ADD COLUMN b UInt64;\n' +
      'ALTER TABLE t ADD COLUMN c UInt64 // keep; ALTER TABLE t DROP COLUMN z;\n' +
      'ALTER TABLE t ADD COLUMN d UInt64;\n'
    const dir = writeMigration(sql)
    const { db, commandCalls } = recordingDb()
    const { store, appended } = createFakeStore(
      inProgressState(checksumSQL(sql), [operation(0, 'completed'), operation(1, 'failed')]),
    )

    await apply(dir, store, db)
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([
      'ALTER TABLE t ADD COLUMN b UInt64;',
      'ALTER TABLE t ADD COLUMN c UInt64 // keep; ALTER TABLE t DROP COLUMN z;\nALTER TABLE t ADD COLUMN d UInt64;',
    ])
    expect(appended).toHaveLength(1)
  })

  // The journal indexes the statements onBeforeApply returns: once a plugin
  // removes one, the old and new positions cannot be matched.
  test('refuses when onBeforeApply removed statements of a file the two splits differ on', async () => {
    const sql = `SET allow_experimental_x = 1;\n${SPLIT_SQL}`
    const dir = writeMigration(sql)
    const { db, commandCalls } = recordingDb()
    const { store } = createFakeStore(inProgressState(checksumSQL(sql), [operation(0, 'completed')]))

    const attempt = applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime((statements) => statements.filter((s) => !s.startsWith('SET '))),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    })
    await expect(attempt).rejects.toMatchObject({ code: 'statement_split_changed' })
    await expect(attempt).rejects.toThrow('The journal recorded statement 1 as completed or started, which is not')
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
  })

  test('refuses when onBeforeApply moved statements without changing their count', async () => {
    const sql = `SET allow_experimental_x = 1;\n${SPLIT_SQL}`
    const dir = writeMigration(sql)
    const { db, commandCalls } = recordingDb()
    const { store } = createFakeStore(inProgressState(checksumSQL(sql), [operation(0, 'completed')]))

    const attempt = applyMigration({
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(([first, second, ...rest]) =>
        first !== undefined && second !== undefined ? [second, first, ...rest] : [],
      ),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
    })
    await expect(attempt).rejects.toMatchObject({ code: 'statement_split_changed' })
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
  })

  test('runs an abandoned state from statement 1', async () => {
    const dir = writeMigration(SPLIT_SQL)
    const { db, commandCalls } = recordingDb()
    const { store, appended } = createFakeStore(
      inProgressState(checksumSQL(SPLIT_SQL), [
        { ...operation(0, 'failed'), lastError: 'abandoned via chkit migrate --abandon (was completed)' },
        { ...operation(1, 'failed'), lastError: 'abandoned via chkit migrate --abandon (was completed)' },
        { ...operation(2, 'failed'), lastError: 'abandoned via chkit migrate --abandon (was failed)' },
      ]),
    )

    await apply(dir, store, db)
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([
      'ALTER TABLE t ADD COLUMN a UInt64 // keep; ALTER TABLE t DROP COLUMN z;\nALTER TABLE t ADD COLUMN b UInt64;',
      'ALTER TABLE t ADD COLUMN c UInt64;',
    ])
    expect(appended).toHaveLength(1)
  })
})

// The journal records each statement's fingerprint, so a resume checks that a
// statement it skips is the one that ran, whatever its position (#599).
describe('applyMigration with statement fingerprints (#599)', () => {
  const A = 'CREATE TABLE p_a (id UInt64) ENGINE = MergeTree ORDER BY id;'
  const B = 'CREATE TABLE p_b (id UInt64) ENGINE = MergeTree ORDER BY id;'
  const C_BROKEN = 'CREATE TABLE p_c (id UInt64) ENGINE = MergeTree ORDER BY missing_col;'
  const C = 'CREATE TABLE p_c (id UInt64) ENGINE = MergeTree ORDER BY id;'
  const D = 'CREATE TABLE p_d (id UInt64) ENGINE = MergeTree ORDER BY id;'
  const ORIGINAL = [A, B, C_BROKEN, D].join('\n')

  function args(dir: string, store: JournalStore, db: ClickHouseExecutor, retry?: { previousChecksum: string; checksum: string }) {
    return {
      db,
      journalStore: store,
      pluginRuntime: fakePluginRuntime(),
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
      retry,
    }
  }

  // Run ORIGINAL until statement 3 fails; returns the recorded state.
  async function failedRun(): Promise<MigrationRowState> {
    const dir = writeMigration(ORIGINAL)
    const { db } = recordingDb({ fail: (sql) => sql.includes('missing_col') })
    const { store, state } = createFakeStore()
    await expect(applyMigration(args(dir, store, db))).rejects.toThrow('failed at statement 3 of 4')
    rmSync(dir, { recursive: true, force: true })
    const recorded = state()
    expect(recorded).not.toBeNull()
    return recorded as MigrationRowState
  }

  test('records the fingerprint of the statement with every write', async () => {
    const recorded = await failedRun()
    expect(recorded.operations.map((op) => [op.operationIndex, op.status, op.fingerprint])).toEqual([
      [0, 'completed', statementFingerprint(A)],
      [1, 'completed', statementFingerprint(B)],
      [2, 'failed', statementFingerprint(C_BROKEN)],
    ])
  })

  test('--retry after a comment-only edit runs exactly the statements that never ran', async () => {
    const recorded = await failedRun()
    const edited = [`-- created first\n${A.replace('ENGINE', '/* the engine */ ENGINE')}`, `  ${B.replace(';', ' // b; with a semicolon\n;')}`, C, D].join('\n\n')
    const dir = writeMigration(edited)
    const { db, commandCalls } = recordingDb()
    const { store, appended, state } = createFakeStore(recorded)

    await applyMigration(args(dir, store, db, { previousChecksum: recorded.checksum, checksum: checksumSQL(edited) }))
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([C, D])
    expect(appended).toHaveLength(1)
    expect(state()?.operations.map((op) => op.fingerprint)).toEqual([A, B, C, D].map(statementFingerprint))
  })

  test('--retry refuses an edit that changed the SQL of a completed statement', async () => {
    const recorded = await failedRun()
    // The completed statement 2 (p_b) was removed and p_c fixed: by position
    // the fixed statement would be skipped as completed.
    const edited = [A, C, D].join('\n')
    const dir = writeMigration(edited)
    const { db, commandCalls } = recordingDb()
    const { store, writes, appended } = createFakeStore(recorded)

    const attempt = applyMigration(args(dir, store, db, { previousChecksum: recorded.checksum, checksum: checksumSQL(edited) }))
    await expect(attempt).rejects.toMatchObject({ code: 'retry_mismatch' })
    await expect(attempt).rejects.toThrow(
      'statement 2: completed as sql_statement statement:1, but the edited file has different SQL there',
    )
    await expect(attempt).rejects.toThrow('must keep their position, operation marker and SQL (comments and whitespace may change)')
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
    expect(writes).toEqual([])
    expect(appended).toEqual([])
  })

  test('a state without fingerprints still resumes by position and marker', async () => {
    const recorded = await failedRun()
    const legacy = { ...recorded, operations: recorded.operations.map((op) => ({ ...op, fingerprint: '' })) }
    const edited = [A, C, D].join('\n')
    const dir = writeMigration(edited)
    const { db, commandCalls } = recordingDb()
    const { store } = createFakeStore(legacy)

    await applyMigration(args(dir, store, db, { previousChecksum: recorded.checksum, checksum: checksumSQL(edited) }))
    rmSync(dir, { recursive: true, force: true })

    // What every release before #599 does with this state.
    expect(commandCalls).toEqual([D])
  })

  test('refuses to resume an unchanged file whose statements no longer match the recorded ones', async () => {
    const recorded = await failedRun()
    const dir = writeMigration(ORIGINAL)
    const { db, commandCalls } = recordingDb()
    const { store, writes } = createFakeStore(recorded)

    // A plugin that now drops the first statement moves every other one.
    const attempt = applyMigration({ ...args(dir, store, db), pluginRuntime: fakePluginRuntime((all) => all.slice(1)) })
    await expect(attempt).rejects.toMatchObject({ code: 'statement_split_changed' })
    await expect(attempt).rejects.toThrow(
      'Cannot resume m.sql: the journal recorded statements 1, 2 as completed or started, but this run gets different SQL from the file at those positions.',
    )
    await expect(attempt).rejects.toThrow('chkit migrate --apply --abandon m.sql')
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
    expect(writes).toEqual([])
  })

  test('an unchanged file resumes when its statements match the recorded fingerprints', async () => {
    const recorded = await failedRun()
    const dir = writeMigration(ORIGINAL)
    const { db, commandCalls } = recordingDb()
    const { store } = createFakeStore(recorded)

    await expect(applyMigration(args(dir, store, db))).resolves.toBeDefined()
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([C_BROKEN, D])
  })

  test('checks the record of every skip, not only the state the run started with', async () => {
    const recorded = await failedRun()
    const dir = writeMigration(ORIGINAL)
    const { db, commandCalls } = recordingDb()
    // The first read sees no state (a stale replica); a later one returns the
    // recorded run, whose statement 1 is not the one this run gets.
    let reads = 0
    const store: JournalStore = {
      databaseMissing: false,
      async readJournal() {
        return { version: 1, applied: [] }
      },
      async readMigrationState() {
        reads += 1
        return reads === 1 ? null : recorded
      },
      async writeMigrationState() {},
      async appendEntry() {},
    }

    const attempt = applyMigration({
      ...args(dir, store, db),
      pluginRuntime: fakePluginRuntime((all) => [all[0]?.replace('p_a', 'p_x') ?? '', ...all.slice(1)]),
    })
    await expect(attempt).rejects.toMatchObject({ code: 'statement_split_changed' })
    await expect(attempt).rejects.toThrow('the journal recorded statement 1 as completed or started')
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual([])
  })

  test("another release's state with fingerprints is checked by them, not by the split before #562", async () => {
    // The two splits differ on statement 1; its fingerprint shows the
    // statement there is the one that ran.
    const sql = 'SELECT 1 // x; SELECT 2\n;\nALTER TABLE t ADD COLUMN b UInt64;\nALTER TABLE t ADD COLUMN c UInt64;\n'
    const ran = 'SELECT 1 // x; SELECT 2\n;'
    const dir = writeMigration(sql)
    const { db, commandCalls } = recordingDb()
    const { store } = createFakeStore(
      inProgressState(checksumSQL(sql), [
        { ...operation(0, 'completed'), fingerprint: statementFingerprint(ran) },
        operation(1, 'failed'),
      ]),
    )

    await applyMigration(args(dir, store, db))
    rmSync(dir, { recursive: true, force: true })

    expect(commandCalls).toEqual(['ALTER TABLE t ADD COLUMN b UInt64;', 'ALTER TABLE t ADD COLUMN c UInt64;'])
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

  // A two-replica target where no INSERT is running; every other read
  // (a propagation wait) is recorded.
  function twoReplicaDb() {
    const events: string[] = []
    const db = {
      async command(statement: string) {
        events.push(`command ${statement}`)
      },
      async query<T>(statement: string): Promise<T[]> {
        if (statement.includes('system.one')) return [{ replicas: 2 }] as T[]
        events.push(statement.includes('system.processes') ? 'barrier read' : `query ${statement}`)
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

  test('refuses a barrier a plugin rewrote into another statement before anything runs (#634)', async () => {
    const sql =
      '-- operation: exchange_tables key=table:default.a risk=caution mode=barrier\n' +
      "SELECT query_id FROM system.processes WHERE query_kind = 'Insert';\n" +
      '-- operation: drop_table key=table:default.b risk=danger\n' +
      'DROP TABLE IF EXISTS default.b SYNC;\n'
    const dir = writeMigration(sql)
    const { db, events } = twoReplicaDb()
    const { store, appended, writes } = createFakeStore()
    const rewrite = fakePluginRuntime((statements) => [
      'EXCHANGE TABLES default.a AND default.b;',
      ...statements.slice(1),
    ])
    const error = await applyMigration({
      db,
      journalStore: store,
      pluginRuntime: rewrite,
      config: CONFIG,
      tableScope: TABLE_SCOPE,
      flags: FLAGS,
      migrationsDir: dir,
      file: 'm.sql',
      log: () => {},
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MigrateError)
    expect(error).toMatchObject({ code: 'barrier_not_select' })
    expect(String(error)).toContain(
      '  - m.sql, statement 1 of 2 (-- operation: exchange_tables key=table:default.a risk=caution mode=barrier):\n' +
        '      EXCHANGE TABLES default.a AND default.b;',
    )
    expect(events).toEqual([])
    expect(writes).toEqual([])
    expect(appended).toEqual([])
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
