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
})
