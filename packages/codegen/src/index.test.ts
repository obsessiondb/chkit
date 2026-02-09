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
      })

      expect(result.migrationFile).toBeTruthy()
      if (!result.migrationFile) {
        throw new Error('expected migration file path')
      }
      const migrationFile = await readFile(result.migrationFile, 'utf8')
      const snapshotFile = await readFile(result.snapshotFile, 'utf8')

      expect(migrationFile).toContain('CREATE TABLE IF NOT EXISTS app.users')
      expect(migrationFile).toContain('-- chx-migration-format: v1')
      expect(snapshotFile).toContain('"definitions"')
      expect(snapshotFile).toContain('"version": 1')
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })
})
