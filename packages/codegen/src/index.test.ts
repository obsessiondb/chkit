import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'bun:test'

import { planDiff, table } from '@chx/core'

import { generateArtifacts } from './index'

describe('@chx/codegen smoke', () => {
  test('writes migration and snapshot artifacts', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'chx-codegen-test-'))

    try {
      const migrationsDir = join(workdir, 'migrations')
      const metaDir = join(workdir, 'meta')

      const result = await generateArtifacts({
        definitions: [
          table({
            database: 'app',
            name: 'users',
            columns: [{ name: 'id', type: 'UInt64' }],
            engine: 'MergeTree()',
            primaryKey: ['id'],
            orderBy: ['id'],
          }),
        ],
        plan: planDiff([], [
          table({
            database: 'app',
            name: 'users',
            columns: [{ name: 'id', type: 'UInt64' }],
            engine: 'MergeTree()',
            primaryKey: ['id'],
            orderBy: ['id'],
          }),
        ]),
        migrationsDir,
        metaDir,
        migrationName: 'smoke',
        migrationId: '20260102030405',
        now: new Date('2026-01-02T03:04:05.678Z'),
      })

      expect(result.migrationFile).toBeTruthy()
      if (!result.migrationFile) {
        throw new Error('expected migration file path')
      }
      const migrationFile = await readFile(result.migrationFile, 'utf8')
      const snapshotFile = await readFile(result.snapshotFile, 'utf8')

      expect(result.migrationFile.endsWith('20260102030405_smoke.sql')).toBe(true)
      expect(migrationFile).toContain('CREATE TABLE IF NOT EXISTS app.users')
      expect(migrationFile).toContain('-- chx-migration-format: v1')
      expect(migrationFile).toContain('-- generated-at: 2026-01-02T03:04:05.678Z')
      expect(migrationFile).toContain('-- definition-count: 1')
      expect(migrationFile).toContain('-- rename-suggestion-count: 0')
      expect(snapshotFile).toContain('"definitions"')
      expect(snapshotFile).toContain('"version": 1')
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })

  test('sanitizes custom migration id for file naming', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'chx-codegen-test-'))
    try {
      const usersTable = table({
        database: 'app',
        name: 'users',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
      const result = await generateArtifacts({
        definitions: [usersTable],
        plan: planDiff([], [usersTable]),
        migrationsDir: join(workdir, 'migrations'),
        metaDir: join(workdir, 'meta'),
        migrationName: 'noop',
        migrationId: '2026/01/02:bad-id',
      })

      expect(result.migrationFile).toBeTruthy()
      expect(result.migrationFile?.endsWith('20260102bad-id_noop.sql')).toBe(true)
      expect(result.snapshotFile.endsWith('snapshot.json')).toBe(true)
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })

  test('renders rename suggestion hints in migration header comments', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'chx-codegen-test-'))
    try {
      const oldTable = table({
        database: 'app',
        name: 'users',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'email', type: 'String' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
      const newTable = table({
        database: 'app',
        name: 'users',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'user_email', type: 'String' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })

      const result = await generateArtifacts({
        definitions: [newTable],
        plan: planDiff([oldTable], [newTable]),
        migrationsDir: join(workdir, 'migrations'),
        metaDir: join(workdir, 'meta'),
        migrationName: 'rename-hints',
      })

      expect(result.migrationFile).toBeTruthy()
      if (!result.migrationFile) {
        throw new Error('expected migration file path')
      }
      const migrationFile = await readFile(result.migrationFile, 'utf8')
      expect(migrationFile).toContain('-- rename-suggestion-count: 1')
      expect(migrationFile).toContain(
        '-- rename-suggestion: kind=column table=app.users from=email to=user_email confidence=high'
      )
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })

  test('renders explicit rename table and rename column operations in migration content', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'chx-codegen-test-'))
    try {
      const result = await generateArtifacts({
        definitions: [],
        plan: {
          operations: [
            {
              type: 'alter_table_rename_table',
              key: 'table:app.customers:rename_table',
              risk: 'caution',
              sql: 'RENAME TABLE app.users TO app.customers;',
            },
            {
              type: 'alter_table_rename_column',
              key: 'table:app.customers:column_rename:email:user_email',
              risk: 'caution',
              sql: 'ALTER TABLE app.customers RENAME COLUMN `email` TO `user_email`;',
            },
          ],
          riskSummary: { safe: 0, caution: 2, danger: 0 },
          renameSuggestions: [],
        },
        migrationsDir: join(workdir, 'migrations'),
        metaDir: join(workdir, 'meta'),
        migrationName: 'rename-ops',
      })

      expect(result.migrationFile).toBeTruthy()
      if (!result.migrationFile) throw new Error('expected migration file path')
      const migrationFile = await readFile(result.migrationFile, 'utf8')
      expect(migrationFile).toContain('RENAME TABLE app.users TO app.customers;')
      expect(migrationFile).toContain(
        'ALTER TABLE app.customers RENAME COLUMN `email` TO `user_email`;'
      )
      expect(migrationFile).toContain('-- operation: alter_table_rename_table')
      expect(migrationFile).toContain('-- operation: alter_table_rename_column')
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })
})
