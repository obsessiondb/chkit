import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { CORE_ENTRY, createFixture, renderScopedSchema, runCli, sortedKeys } from './testkit.test'

describe('@chkit/cli generate e2e', () => {
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

  test('generate --dryrun keeps heuristic suggestions as add/drop', async () => {
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
      expect(sortedKeys(payload as unknown as Record<string, unknown>)).toEqual([
        'command',
        'error',
        'issues',
        'schemaVersion',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --json accepts comma-delimited orderBy entry', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst claudeSessions = table({\n  database: 'flick_test',\n  name: 'claude_sessions',\n  engine: 'SharedReplacingMergeTree(ingested_at)',\n  columns: [\n    { name: 'session_date', type: "DateTime64(3, 'UTC')", default: 'fn:now64(3)' },\n    { name: 'last_interaction_date', type: "DateTime64(3, 'UTC')", default: 'fn:now64(3)' },\n    { name: 'session_id', type: 'String' },\n    { name: 'organization_id', type: 'String' },\n    { name: 'project_path', type: 'String' },\n    { name: 'repository', type: 'String', nullable: true },\n    { name: 'content', type: 'String' },\n    { name: 'subagents', type: 'Map(String, String)', default: 'fn:map()' },\n    { name: 'skills', type: 'Array(String)', default: 'fn:[]' },\n    { name: 'slash_commands', type: 'Array(String)', default: 'fn:[]' },\n    { name: 'subagent_types', type: 'Array(String)', default: 'fn:[]' },\n    { name: 'ingested_at', type: "DateTime64(3, 'UTC')", default: 'fn:now64(3)' },\n    { name: 'user_id', type: 'String' },\n    { name: 'git_branch', type: 'String', nullable: true },\n    { name: 'git_sha', type: 'String', nullable: true },\n    { name: 'input_tokens', type: 'UInt64', default: 'fn:0' },\n    { name: 'output_tokens', type: 'UInt64', default: 'fn:0' },\n    { name: 'cache_read_input_tokens', type: 'UInt64', default: 'fn:0' },\n    { name: 'cache_creation_input_tokens', type: 'UInt64', default: 'fn:0' },\n    { name: 'total_tokens', type: 'UInt64', default: 'fn:0' },\n    { name: 'tag', type: 'String', nullable: true },\n  ],\n  primaryKey: [],\n  orderBy: ['organization_id, session_date, session_id'],\n  partitionBy: 'toYYYYMM(toDate(session_date))',\n  ttl: 'toDate(session_date) + toIntervalDay(365)',\n  settings: {\n    index_granularity: '8192',\n    storage_policy: "'s3'",\n  },\n})\n\nexport default schema(claudeSessions)\n`,
        'utf8'
      )

      const result = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        command: string
        migrationFile: string | null
        operationCount: number
      }
      expect(payload.command).toBe('generate')
      expect(payload.migrationFile).toBeTruthy()
      expect(payload.operationCount).toBeGreaterThan(0)
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
        'scope',
        'snapshotFile',
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

  test('generate --dryrun --table scopes operations and emits scope payload', async () => {
    const fixture = await createFixture(renderScopedSchema())
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n    { name: 'country', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nconst events = table({\n  database: 'app',\n  name: 'events',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'source', type: 'String' },\n    { name: 'ingested_at', type: 'DateTime' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users, events)\n`,
        'utf8'
      )

      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--table',
        'app.users',
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        scope: { enabled: boolean; selector: string; matchedTables: string[]; matchCount: number }
        operations: Array<{ key: string }>
      }
      expect(payload.scope.enabled).toBe(true)
      expect(payload.scope.selector).toBe('app.users')
      expect(payload.scope.matchCount).toBe(1)
      expect(payload.scope.matchedTables).toEqual(['app.users'])
      expect(payload.operations.every((operation) => operation.key.startsWith('table:app.users'))).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('generate --dryrun --table returns warning no-op for zero matches', async () => {
    const fixture = await createFixture(renderScopedSchema())
    try {
      const result = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--table',
        'missing_*',
        '--json',
      ])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        operationCount: number
        warning: string
        scope: { enabled: boolean; matchCount: number }
      }
      expect(payload.scope.enabled).toBe(true)
      expect(payload.scope.matchCount).toBe(0)
      expect(payload.operationCount).toBe(0)
      expect(payload.warning).toContain('No tables matched selector')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
