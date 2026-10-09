import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { resolveRetry } from '../../../commands/migrate/retry.js'
import type { JournalStore, MigrationRowState, OperationState } from '../../../runtime/journal-store.js'
import { checksumSQL } from '../../../runtime/migration-store.js'

const FILE_SQL = [
  '-- operation: alter_table_add_column key=table:db.a risk=safe',
  'ALTER TABLE db.a ADD COLUMN c1 UInt64;',
  '',
  '-- operation: create_table key=table:db.b risk=safe',
  'CREATE TABLE db.b (id UInt64) ENGINE = MergeTree ORDER BY id;',
  '',
  '-- operation: create_view key=view:db.v risk=safe',
  'CREATE VIEW db.v AS SELECT id FROM db.b;',
  '',
].join('\n')

function op(index: number, status: OperationState['status'], type: string, key: string): OperationState {
  return {
    operationIndex: index,
    operationKey: key,
    operationType: type,
    queryId: '',
    status,
    startedAt: '2026-09-29 00:11:10.000',
    finishedAt: '2026-09-29 00:11:11.000',
    lastError: status === 'failed' ? 'Code: 60. Unknown table' : '',
  }
}

function stateWith(input: Partial<MigrationRowState>): MigrationRowState {
  return {
    name: 'm.sql',
    appliedAt: '2026-09-29 00:11:11.000',
    checksum: 'old',
    chkitVersion: '0.2.0-test',
    migrationCompleted: false,
    operations: [],
    ...input,
  }
}

function fakeStore(state: MigrationRowState | null) {
  const reads: string[] = []
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState(name) {
      reads.push(name)
      return state
    },
    async writeMigrationState() {
      throw new Error('resolveRetry must not write the journal')
    },
    async appendEntry() {
      throw new Error('resolveRetry must not write the journal')
    },
  }
  return { store, reads }
}

async function withMigration<T>(run: (migrationsDir: string) => Promise<T>): Promise<T> {
  const migrationsDir = await mkdtemp(join(tmpdir(), 'chkit-retry-'))
  await writeFile(join(migrationsDir, 'm.sql'), FILE_SQL, 'utf8')
  return run(migrationsDir).finally(() => rm(migrationsDir, { recursive: true, force: true }))
}

const BASE = { migration: 'm.sql', pending: ['m.sql'], emptyMigrations: [], appliedNames: new Set<string>() }

describe('resolveRetry', () => {
  test('is a no-op for an applied migration, without reading its state', async () => {
    const { store, reads } = fakeStore(null)
    const result = await withMigration((migrationsDir) =>
      resolveRetry({ ...BASE, migrationsDir, appliedNames: new Set(['m.sql']) }, { journalStore: store }),
    )
    expect(result).toEqual({ action: 'none', migration: 'm.sql', reason: 'already_applied' })
    expect(reads).toEqual([])
  })

  test('is a no-op outside the --table scope', async () => {
    const { store } = fakeStore(null)
    const result = await withMigration((migrationsDir) =>
      resolveRetry({ ...BASE, migrationsDir, pending: [] }, { journalStore: store }),
    )
    expect(result).toEqual({ action: 'none', migration: 'm.sql', reason: 'not_in_scope' })
  })

  test('is a no-op for a file without executable statements, without reading its state', async () => {
    const { store, reads } = fakeStore(stateWith({ operations: [op(0, 'failed', 'create_view', 'view:db.v')] }))
    const result = await withMigration((migrationsDir) =>
      resolveRetry({ ...BASE, migrationsDir, emptyMigrations: ['m.sql'] }, { journalStore: store }),
    )
    expect(result).toEqual({ action: 'none', migration: 'm.sql', reason: 'empty_migration' })
    expect(reads).toEqual([])
  })

  test('is a no-op without in-progress state, and for a completed state', async () => {
    const none = await withMigration((migrationsDir) =>
      resolveRetry({ ...BASE, migrationsDir }, { journalStore: fakeStore(null).store }),
    )
    expect(none).toEqual({ action: 'none', migration: 'm.sql', reason: 'not_in_progress' })
    const completed = await withMigration((migrationsDir) =>
      resolveRetry(
        { ...BASE, migrationsDir },
        { journalStore: fakeStore(stateWith({ migrationCompleted: true })).store },
      ),
    )
    expect(completed).toEqual({ action: 'none', migration: 'm.sql', reason: 'already_applied' })
  })

  test('is a no-op when the file did not change since it failed', async () => {
    const result = await withMigration((migrationsDir) =>
      resolveRetry(
        { ...BASE, migrationsDir },
        { journalStore: fakeStore(stateWith({ checksum: checksumSQL(FILE_SQL) })).store },
      ),
    )
    expect(result).toEqual({ action: 'none', migration: 'm.sql', reason: 'checksum_unchanged' })
  })

  test('resumes an edited file at the first statement that did not complete', async () => {
    const state = stateWith({
      operations: [
        op(0, 'completed', 'alter_table_add_column', 'table:db.a'),
        op(1, 'failed', 'create_view', 'view:db.v'),
      ],
    })
    const result = await withMigration((migrationsDir) =>
      resolveRetry({ ...BASE, migrationsDir }, { journalStore: fakeStore(state).store }),
    )
    expect(result).toEqual({
      action: 'resume',
      migration: 'm.sql',
      previousChecksum: 'old',
      checksum: checksumSQL(FILE_SQL),
      totalStatements: 3,
      completedStatements: 1,
      resumeAtStatement: 2,
      unmarkedCompletedStatements: 0,
    })
  })

  test('refuses an edit that changed a completed statement', async () => {
    const state = stateWith({ operations: [op(0, 'completed', 'create_table', 'table:db.x')] })
    const attempt = withMigration((migrationsDir) =>
      resolveRetry({ ...BASE, migrationsDir }, { journalStore: fakeStore(state).store }),
    )
    await expect(attempt).rejects.toMatchObject({ code: 'retry_mismatch' })
    await expect(attempt).rejects.toThrow('statement 1: completed as create_table table:db.x')
    await expect(attempt).rejects.toThrow('chkit migrate --apply --abandon m.sql')
  })

  // The preview used to report the deleted statement's successor as completed.
  test('refuses an edit that left fewer statements with the shared marker of a completed statement', async () => {
    const state = stateWith({
      operations: [
        op(0, 'completed', 'alter_table_add_column', 'table:db.a'),
        op(1, 'failed', 'alter_table_add_column', 'table:db.a'),
      ],
    })
    const attempt = withMigration((migrationsDir) =>
      resolveRetry({ ...BASE, migrationsDir }, { journalStore: fakeStore(state).store }),
    )
    await expect(attempt).rejects.toMatchObject({ code: 'retry_mismatch' })
    await expect(attempt).rejects.toThrow(
      'statements 1 (completed) and 2 (failed) share alter_table_add_column table:db.a, but the edited file has 1 statement with that marker',
    )
  })
})
