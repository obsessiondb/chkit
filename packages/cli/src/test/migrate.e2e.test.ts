import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createFixture, runCli } from './testkit.test'

describe('@chkit/cli migrate e2e', () => {
  test('migrate requires clickhouse config', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['migrate', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for migrate')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('migrate --execute requires clickhouse config', async () => {
    const fixture = await createFixture()
    try {
      await mkdir(fixture.migrationsDir, { recursive: true })
      await writeFile(
        join(fixture.migrationsDir, '20260101000000_drop_users.sql'),
        '-- operation: drop_table key=table:app.users risk=danger\nDROP TABLE IF EXISTS app.users;\n',
        'utf8'
      )

      const result = runCli(['migrate', '--config', fixture.configPath, '--execute', '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for migrate')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('migrate --execute --allow-destructive requires clickhouse config', async () => {
    const fixture = await createFixture()
    try {
      await mkdir(fixture.migrationsDir, { recursive: true })
      await writeFile(
        join(fixture.migrationsDir, '20260101000000_drop_users.sql'),
        '-- operation: drop_table key=table:app.users risk=danger\nDROP TABLE IF EXISTS app.users;\n',
        'utf8'
      )

      const result = runCli([
        'migrate',
        '--config',
        fixture.configPath,
        '--execute',
        '--allow-destructive',
        '--json',
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for migrate')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
