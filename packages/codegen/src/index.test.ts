import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'bun:test'

import { table } from '@chx/core'

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
        migrationsDir,
        metaDir,
        migrationName: 'smoke',
      })

      const migrationFile = await readFile(result.migrationFile, 'utf8')
      const snapshotFile = await readFile(result.snapshotFile, 'utf8')

      expect(migrationFile).toContain('CREATE TABLE IF NOT EXISTS app.users')
      expect(snapshotFile).toContain('"definitions"')
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })
})
