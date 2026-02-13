import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sortedKeys } from './commands.e2e-helpers'
import { createFixture, runCli } from './testkit.test'

describe('@chx/cli status e2e', () => {
  test('generate --json then status --json shows pending migration', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)
      const generatePayload = JSON.parse(generated.stdout) as { migrationFile: string | null }
      expect(generatePayload.migrationFile).toBeTruthy()

      const status = runCli(['status', '--config', fixture.configPath, '--json'])
      expect(status.exitCode).toBe(0)
      const statusPayload = JSON.parse(status.stdout) as {
        schemaVersion: number
        total: number
        pending: number
        checksumMismatchCount: number
      }
      expect(statusPayload.schemaVersion).toBe(1)
      expect(statusPayload.total).toBe(1)
      expect(statusPayload.pending).toBe(1)
      expect(statusPayload.checksumMismatchCount).toBe(0)
      expect(sortedKeys(statusPayload as unknown as Record<string, unknown>)).toEqual([
        'applied',
        'checksumMismatchCount',
        'checksumMismatches',
        'command',
        'migrationsDir',
        'pending',
        'pendingMigrations',
        'schemaVersion',
        'total',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('status fails with actionable error on corrupted journal json', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)
      await Bun.write(join(fixture.metaDir, 'journal.json'), '{not-valid-json')

      const status = runCli(['status', '--config', fixture.configPath, '--json'])
      expect(status.exitCode).toBe(1)
      expect(status.stderr).toContain('Invalid journal JSON')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('status --json reports checksum mismatch for applied migration drift', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)
      const generatePayload = JSON.parse(generated.stdout) as { migrationFile: string | null }
      expect(generatePayload.migrationFile).toBeTruthy()
      if (!generatePayload.migrationFile) {
        throw new Error('expected generated migration file')
      }

      await writeFile(
        join(fixture.metaDir, 'journal.json'),
        `${JSON.stringify(
          {
            version: 1,
            applied: [
              {
                name: '99999999999999_init.sql',
                appliedAt: new Date().toISOString(),
                checksum: 'abc123',
              },
            ],
          },
          null,
          2
        )}\n`,
        'utf8'
      )

      await writeFile(join(fixture.migrationsDir, '99999999999999_init.sql'), 'SELECT 1;\n', 'utf8')

      const status = runCli(['status', '--config', fixture.configPath, '--json'])
      expect(status.exitCode).toBe(0)
      const statusPayload = JSON.parse(status.stdout) as {
        checksumMismatchCount: number
        checksumMismatches: Array<{ name: string }>
      }
      expect(statusPayload.checksumMismatchCount).toBe(1)
      expect(statusPayload.checksumMismatches[0]?.name).toBe('99999999999999_init.sql')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

})
