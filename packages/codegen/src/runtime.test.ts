import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateEmptyMigration } from './index.js'

test('concurrent migration writers retry only collisions and never overwrite a sibling', async () => {
  const migrationsDir = await mkdtemp(join(tmpdir(), 'chkit-effect-artifacts-'))
  const outputs = await Promise.all(Array.from({ length: 8 }, () => generateEmptyMigration({
    migrationsDir,
    migrationId: 'same',
    migrationName: 'manual',
    now: new Date('2026-01-01T00:00:00.000Z'),
  })))
  expect(new Set(outputs.map((output) => output.migrationFile)).size).toBe(8)
  for (const output of outputs) expect(await readFile(output.migrationFile, 'utf8')).toBe(output.sql)
  await rm(migrationsDir, { recursive: true, force: true })
})
