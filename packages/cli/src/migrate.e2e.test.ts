import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createFixture, renderScopedSchema, runCli, sortedKeys } from './testkit.test'

describe('@chkit/cli migrate e2e', () => {
  test('migrate --json fails on checksum mismatch', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)

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

      const result = runCli(['migrate', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as {
        command: string
        schemaVersion: number
        error: string
        checksumMismatches: Array<{ name: string }>
      }
      expect(payload.command).toBe('migrate')
      expect(payload.schemaVersion).toBe(1)
      expect(payload.error).toContain('Checksum mismatch')
      expect(payload.checksumMismatches[0]?.name).toBe('99999999999999_init.sql')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('migrate --execute --json blocks destructive operations without allow flag', async () => {
    const fixture = await createFixture()
    try {
      await mkdir(fixture.migrationsDir, { recursive: true })
      await writeFile(
        join(fixture.migrationsDir, '20260101000000_drop_users.sql'),
        '-- operation: drop_table key=table:app.users risk=danger\nDROP TABLE IF EXISTS app.users;\n',
        'utf8'
      )

      const result = runCli(['migrate', '--config', fixture.configPath, '--execute', '--json'])
      expect(result.exitCode).toBe(3)
      const payload = JSON.parse(result.stdout) as {
        command: string
        schemaVersion: number
        mode: string
        error: string
        destructiveMigrations: string[]
        destructiveOperations: Array<{
          migration: string
          type: string
          key: string
          warningCode: string
          reason: string
          impact: string
          recommendation: string
        }>
      }
      expect(payload.command).toBe('migrate')
      expect(payload.schemaVersion).toBe(1)
      expect(payload.mode).toBe('execute')
      expect(payload.error).toContain('Blocked destructive migration execution')
      expect(payload.destructiveMigrations).toEqual(['20260101000000_drop_users.sql'])
      expect(payload.destructiveOperations.length).toBeGreaterThan(0)
      expect(payload.destructiveOperations[0]?.type).toBe('drop_table')
      expect(payload.destructiveOperations[0]?.warningCode).toBe('drop_table_data_loss')
      expect(payload.destructiveOperations[0]?.reason).toContain('Dropping a table')
      expect(payload.destructiveOperations[0]?.recommendation).toContain('Verify backups')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('migrate --execute blocks destructive operations in non-interactive mode with explicit guidance', async () => {
    const fixture = await createFixture()
    try {
      await mkdir(fixture.migrationsDir, { recursive: true })
      await writeFile(
        join(fixture.migrationsDir, '20260101000000_drop_users.sql'),
        '-- operation: drop_table key=table:app.users risk=danger\nDROP TABLE IF EXISTS app.users;\n',
        'utf8'
      )

      const result = runCli(['migrate', '--config', fixture.configPath, '--execute'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Blocked destructive migration execution')
      expect(result.stderr).toContain('Non-interactive run detected. Pass --allow-destructive to proceed.')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('migrate --execute --allow-destructive bypasses destructive gate', async () => {
    const fixture = await createFixture()
    try {
      await mkdir(fixture.migrationsDir, { recursive: true })
      await writeFile(
        join(fixture.migrationsDir, '20260101000000_drop_users.sql'),
        '-- operation: drop_table key=table:app.users risk=danger\nDROP TABLE IF EXISTS app.users;\n',
        'utf8'
      )

      const blocked = runCli(['migrate', '--config', fixture.configPath, '--execute', '--json'])
      expect(blocked.exitCode).toBe(3)
      const blockedPayload = JSON.parse(blocked.stdout) as {
        command: string
        schemaVersion: number
        mode: string
        error: string
        destructiveMigrations: string[]
      }
      expect(blockedPayload.command).toBe('migrate')
      expect(blockedPayload.schemaVersion).toBe(1)
      expect(blockedPayload.mode).toBe('execute')
      expect(blockedPayload.error).toContain('Blocked destructive migration execution')
      expect(blockedPayload.destructiveMigrations).toEqual(['20260101000000_drop_users.sql'])

      const allowed = runCli([
        'migrate',
        '--config',
        fixture.configPath,
        '--execute',
        '--allow-destructive',
        '--json',
      ])
      expect(allowed.exitCode).toBe(1)
      expect(allowed.stdout).toBe('')
      expect(allowed.stderr).toContain('clickhouse config is required for --apply')
      expect(allowed.stderr).not.toContain('Blocked destructive migration execution')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('migrate --json uses stable payload keys', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)

      const result = runCli(['migrate', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(sortedKeys(payload)).toEqual(['command', 'mode', 'pending', 'schemaVersion', 'scope'])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('migrate --execute --json destructive gate uses stable error payload keys', async () => {
    const fixture = await createFixture()
    try {
      await mkdir(fixture.migrationsDir, { recursive: true })
      await writeFile(
        join(fixture.migrationsDir, '20260101000000_drop_users.sql'),
        '-- operation: drop_table key=table:app.users risk=danger\nDROP TABLE IF EXISTS app.users;\n',
        'utf8'
      )

      const result = runCli(['migrate', '--config', fixture.configPath, '--execute', '--json'])
      expect(result.exitCode).toBe(3)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(sortedKeys(payload)).toEqual([
        'command',
        'destructiveMigrations',
        'destructiveOperations',
        'error',
        'mode',
        'schemaVersion',
        'scope',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('migrate --json --table only lists in-scope pending migrations', async () => {
    const fixture = await createFixture(renderScopedSchema())
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await mkdir(fixture.migrationsDir, { recursive: true })
      await writeFile(
        join(fixture.migrationsDir, '20260101001000_users.sql'),
        '-- operation: alter_table_add_column key=table:app.users:column:country risk=safe\nALTER TABLE app.users ADD COLUMN country String;\n',
        'utf8'
      )
      await writeFile(
        join(fixture.migrationsDir, '20260101002000_events.sql'),
        '-- operation: alter_table_add_column key=table:app.events:column:ingested_at risk=safe\nALTER TABLE app.events ADD COLUMN ingested_at DateTime;\n',
        'utf8'
      )

      const result = runCli([
        'migrate',
        '--config',
        fixture.configPath,
        '--table',
        'users',
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        pending: string[]
        scope: { enabled: boolean; matchCount: number; matchedTables: string[] }
      }
      expect(payload.scope.enabled).toBe(true)
      expect(payload.scope.matchCount).toBe(1)
      expect(payload.scope.matchedTables).toEqual(['app.users'])
      expect(payload.pending).toContain('20260101001000_users.sql')
      expect(payload.pending).not.toContain('20260101002000_events.sql')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
