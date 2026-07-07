import { describe, expect, test } from 'bun:test'
import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createFixture, runCli } from './testkit.test'

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

describe('@chkit/cli generate --empty', () => {
  test('scaffolds a blank migration and leaves the snapshot untouched', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--empty',
        '--name',
        'backfill signups',
        '--migration-id',
        '20260101000000',
        '--json',
      ])

      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { mode: string; migrationFile: string }
      expect(payload.mode).toBe('empty')
      expect(payload.migrationFile.endsWith('20260101000000_backfill_signups.sql')).toBe(true)

      const migration = await readFile(payload.migrationFile, 'utf8')
      expect(migration).toContain('-- chkit-migration-format: v1')
      expect(migration).toContain('-- operation-count: 0')
      expect(migration).toContain('-- Empty migration scaffold. Write your SQL statements below.')
      expect(migration).not.toContain('CREATE TABLE')

      // Empty mode must never write a snapshot — otherwise it would silently
      // absorb pending schema drift.
      expect(await exists(join(fixture.metaDir, 'snapshot.json'))).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('defaults the migration name to "manual"', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--empty',
        '--migration-id',
        '20260101000000',
        '--json',
      ])

      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { migrationFile: string }
      expect(payload.migrationFile.endsWith('20260101000000_manual.sql')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
