import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { sortedKeys } from './commands.e2e-helpers'
import { createFixture, runCli } from './testkit.test'

describe('@chx/cli check e2e', () => {
  test('check --json fails when migrations are pending', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(generated.exitCode).toBe(0)

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as {
        command: string
        schemaVersion: number
        ok: boolean
        failedChecks: string[]
      }
      expect(payload.command).toBe('check')
      expect(payload.schemaVersion).toBe(1)
      expect(payload.ok).toBe(false)
      expect(payload.failedChecks).toContain('pending_migrations')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('check --json passes on clean state with no migrations', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        command: string
        ok: boolean
        failedChecks: string[]
      }
      expect(payload.command).toBe('check')
      expect(payload.ok).toBe(true)
      expect(payload.failedChecks).toEqual([])
      expect(sortedKeys(payload as unknown as Record<string, unknown>)).toEqual([
        'checksumMismatchCount',
        'command',
        'drifted',
        'driftEvaluated',
        'driftReasonCounts',
        'driftReasonTotals',
        'failedChecks',
        'ok',
        'pendingCount',
        'plugins',
        'policy',
        'schemaVersion',
        'strict',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('check policy can ignore pending migrations', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(generated.exitCode).toBe(0)

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  check: {\n    failOnPending: false,\n  },\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        failedChecks: string[]
        policy: { failOnPending: boolean }
      }
      expect(payload.ok).toBe(true)
      expect(payload.failedChecks).not.toContain('pending_migrations')
      expect(payload.policy.failOnPending).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('check --strict overrides config policy', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(generated.exitCode).toBe(0)

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  check: {\n    failOnPending: false,\n  },\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--strict', '--json'])
      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as {
        strict: boolean
        ok: boolean
        failedChecks: string[]
        policy: { failOnPending: boolean }
      }
      expect(payload.strict).toBe(true)
      expect(payload.ok).toBe(false)
      expect(payload.policy.failOnPending).toBe(true)
      expect(payload.failedChecks).toContain('pending_migrations')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('check policy can ignore checksum mismatches', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(generated.exitCode).toBe(0)
      const generatePayload = JSON.parse(generated.stdout) as { migrationFile: string | null }
      expect(generatePayload.migrationFile).toBeTruthy()
      if (!generatePayload.migrationFile) throw new Error('expected migration file')

      await writeFile(
        join(fixture.metaDir, 'journal.json'),
        `${JSON.stringify(
          {
            version: 1,
            applied: [
              {
                name: basename(generatePayload.migrationFile),
                appliedAt: new Date().toISOString(),
                checksum: 'bad-checksum',
              },
            ],
          },
          null,
          2
        )}\n`,
        'utf8'
      )

      await writeFile(
        fixture.configPath,
        `export default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chx')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  check: {\n    failOnChecksumMismatch: false,\n  },\n}\n`,
        'utf8'
      )

      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        ok: boolean
        failedChecks: string[]
        checksumMismatchCount: number
        policy: { failOnChecksumMismatch: boolean }
      }
      expect(payload.checksumMismatchCount).toBe(1)
      expect(payload.policy.failOnChecksumMismatch).toBe(false)
      expect(payload.ok).toBe(true)
      expect(payload.failedChecks).not.toContain('checksum_mismatch')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

})
