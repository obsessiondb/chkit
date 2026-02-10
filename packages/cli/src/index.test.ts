import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import * as cliModule from './index'
import { CORE_ENTRY, createFixture, runCli } from './testkit.test'

describe('@chx/cli smoke', () => {
  test('imports package entry', () => {
    expect(typeof cliModule).toBe('object')
  })
})

function sortedKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).sort((a, b) => a.localeCompare(b))
}

describe('@chx/cli command flows', () => {
  test('generate --dryrun --json emits operation plan payload', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        command: string
        schemaVersion: number
        mode: string
        operationCount: number
        operations: Array<{ type: string }>
      }
      expect(payload.command).toBe('generate')
      expect(payload.schemaVersion).toBe(1)
      expect(payload.mode).toBe('plan')
      expect(payload.operationCount).toBeGreaterThan(0)
      expect(payload.operations.some((op) => op.type === 'create_table')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --dryrun --json includes rename suggestions when a column is likely renamed', async () => {
    const fixture = await createFixture()
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])

      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'user_email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        renameSuggestions: Array<{ kind: string; from: string; to: string; confidence: string }>
      }
      expect(payload.renameSuggestions).toHaveLength(1)
      expect(payload.renameSuggestions[0]).toMatchObject({
        kind: 'column',
        from: 'email',
        to: 'user_email',
        confidence: 'high',
      })
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --dryrun without --interactive-renames keeps heuristic suggestions as add/drop', async () => {
    const fixture = await createFixture()
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'user_email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`,
        'utf8'
      )

      const preview = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(preview.exitCode).toBe(0)
      const plan = JSON.parse(preview.stdout) as {
        operations: Array<{ type: string }>
        renameSuggestions: unknown[]
      }
      expect(plan.operations.some((op) => op.type === 'alter_table_add_column')).toBe(true)
      expect(plan.operations.some((op) => op.type === 'alter_table_drop_column')).toBe(true)
      expect(plan.operations.some((op) => op.type === 'alter_table_rename_column')).toBe(false)
      expect(plan.renameSuggestions.length).toBeGreaterThan(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --dryrun with --rename-column emits explicit rename column operation', async () => {
    const fixture = await createFixture()
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'user_email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`,
        'utf8'
      )

      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--rename-column',
        'app.users.email=user_email',
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        operations: Array<{ type: string }>
        renameSuggestions: unknown[]
      }
      expect(payload.operations.some((operation) => operation.type === 'alter_table_rename_column')).toBe(true)
      expect(payload.operations.some((operation) => operation.type === 'alter_table_add_column')).toBe(false)
      expect(payload.operations.some((operation) => operation.type === 'alter_table_drop_column')).toBe(false)
      expect(payload.renameSuggestions).toEqual([])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --dryrun with --rename-table emits explicit rename table operation', async () => {
    const fixture = await createFixture()
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst customers = table({\n  database: 'app',\n  name: 'customers',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(customers)\n`,
        'utf8'
      )

      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--rename-table',
        'app.users=app.customers',
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        operations: Array<{ type: string }>
      }
      expect(payload.operations.some((operation) => operation.type === 'alter_table_rename_table')).toBe(true)
      expect(payload.operations.some((operation) => operation.type === 'drop_table')).toBe(false)
      expect(payload.operations.some((operation) => operation.type === 'create_table')).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('schema renamedFrom metadata emits explicit rename table and column operations', async () => {
    const fixture = await createFixture()
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst customers = table({\n  database: 'app',\n  name: 'customers',\n  renamedFrom: { name: 'users' },\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'user_email', type: 'String', renamedFrom: 'email' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(customers)\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        operations: Array<{ type: string }>
        renameSuggestions: unknown[]
      }
      expect(payload.operations.some((operation) => operation.type === 'alter_table_rename_table')).toBe(true)
      expect(payload.operations.some((operation) => operation.type === 'alter_table_rename_column')).toBe(true)
      expect(payload.operations.some((operation) => operation.type === 'drop_table')).toBe(false)
      expect(payload.operations.some((operation) => operation.type === 'create_table')).toBe(false)
      expect(payload.renameSuggestions).toEqual([])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('cli --rename-table overrides conflicting schema renamedFrom metadata', async () => {
    const fixture = await createFixture()
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst customers = table({\n  database: 'app',\n  name: 'customers',\n  renamedFrom: { name: 'legacy_users' },\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(customers)\n`,
        'utf8'
      )

      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--rename-table',
        'app.users=app.customers',
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { operations: Array<{ type: string }> }
      expect(payload.operations.some((operation) => operation.type === 'alter_table_rename_table')).toBe(true)
      expect(payload.operations.some((operation) => operation.type === 'drop_table')).toBe(false)
      expect(payload.operations.some((operation) => operation.type === 'create_table')).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('cli --rename-column overrides conflicting schema renamedFrom metadata', async () => {
    const fixture = await createFixture()
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'primary_email', type: 'String', renamedFrom: 'legacy_email' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`,
        'utf8'
      )

      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--rename-column',
        'app.users.email=primary_email',
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { operations: Array<{ type: string }> }
      expect(payload.operations.some((operation) => operation.type === 'alter_table_rename_column')).toBe(true)
      expect(payload.operations.some((operation) => operation.type === 'alter_table_add_column')).toBe(false)
      expect(payload.operations.some((operation) => operation.type === 'alter_table_drop_column')).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate fails on conflicting --rename-column target mappings', async () => {
    const fixture = await createFixture()
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'preferred_email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`,
        'utf8'
      )

      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--rename-column',
        'app.users.email=preferred_email,app.users.legacy_email=preferred_email',
        '--json',
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('did not find both matching drop and add operations')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate fails when --rename-table source is missing in previous snapshot', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--rename-table',
        'app.missing=app.users',
        '--json',
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('source table is missing from previous snapshot')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate fails when --rename-column does not match drop/add operations', async () => {
    const fixture = await createFixture()
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`,
        'utf8'
      )

      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--rename-column',
        'app.users.email=user_email',
        '--json',
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('did not find both matching drop and add operations')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

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

  test('generate --json returns structured validation errors', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst broken = table({\n  database: 'app',\n  name: 'broken',\n  columns: [{ name: 'id', type: 'UInt64' }],\n  engine: 'MergeTree()',\n  primaryKey: ['missing_col'],\n  orderBy: ['id'],\n})\n\nexport default schema(broken)\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)

      const payload = JSON.parse(result.stdout) as {
        command: string
        error: string
        issues: Array<{ code: string; message: string }>
      }
      expect(payload.command).toBe('generate')
      expect(payload.error).toBe('validation_failed')
      expect(payload.issues.some((issue) => issue.code === 'primary_key_missing_column')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

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

  test('second generate --json is a no-op with no migration file', async () => {
    const fixture = await createFixture()
    try {
      const first = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(first.exitCode).toBe(0)
      const firstPayload = JSON.parse(first.stdout) as {
        migrationFile: string | null
        operationCount: number
      }
      expect(firstPayload.migrationFile).toBeTruthy()
      expect(firstPayload.operationCount).toBeGreaterThan(0)

      const second = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(second.exitCode).toBe(0)
      const secondPayload = JSON.parse(second.stdout) as {
        migrationFile: string | null
        operationCount: number
      }
      expect(secondPayload.operationCount).toBe(0)
      expect(secondPayload.migrationFile).toBeNull()
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

  test('drift --json fails with actionable error when clickhouse config is missing', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(generated.exitCode).toBe(0)

      const result = runCli(['drift', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for drift checks')
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

  test('generate --json uses stable success payload keys', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(sortedKeys(payload)).toEqual([
        'command',
        'definitionCount',
        'migrationFile',
        'operationCount',
        'riskSummary',
        'schemaVersion',
        'snapshotFile',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --json uses stable validation error payload keys', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst broken = table({\n  database: 'app',\n  name: 'broken',\n  columns: [{ name: 'id', type: 'UInt64' }],\n  engine: 'MergeTree()',\n  primaryKey: ['missing_col'],\n  orderBy: ['id'],\n})\n\nexport default schema(broken)\n`,
        'utf8'
      )
      const result = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(sortedKeys(payload)).toEqual(['command', 'error', 'issues', 'schemaVersion'])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('status --json uses stable payload keys', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)

      const result = runCli(['status', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(sortedKeys(payload)).toEqual([
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

  test('migrate --json uses stable payload keys', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      expect(generated.exitCode).toBe(0)

      const result = runCli(['migrate', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(sortedKeys(payload)).toEqual(['command', 'mode', 'pending', 'schemaVersion'])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('check --json uses stable payload keys', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(sortedKeys(payload)).toEqual([
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
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --migration-id sets deterministic migration filename prefix', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--name',
        'init',
        '--migration-id',
        '20260102030405',
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { migrationFile: string | null }
      expect(payload.migrationFile).toBeTruthy()
      expect(basename(payload.migrationFile ?? '')).toBe('20260102030405_init.sql')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
