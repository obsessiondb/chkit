import { describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { CORE_ENTRY, createFixture, runCli } from './testkit.test'

function renderDualTableSchema(input?: {
  usersExtraColumn?: string
  eventsExtraColumn?: string
}): string {
  const usersExtra = input?.usersExtraColumn
    ? `,\n    { name: '${input.usersExtraColumn}', type: 'String' }`
    : ''
  const eventsExtra = input?.eventsExtraColumn
    ? `,\n    { name: '${input.eventsExtraColumn}', type: 'DateTime' }`
    : ''

  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' }${usersExtra},\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nconst events = table({\n  database: 'app',\n  name: 'events',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'source', type: 'String' }${eventsExtra},\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users, events)\n`
}

describe('@chkit/cli table scope e2e', () => {
  test('scoped generate only writes selected-table migration and updates selected table snapshot state', async () => {
    const fixture = await createFixture(renderDualTableSchema())
    try {
      const init = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--name',
        'init',
        '--migration-id',
        '20260103000000',
        '--json',
      ])
      expect(init.exitCode).toBe(0)

      await writeFile(
        fixture.schemaPath,
        renderDualTableSchema({ usersExtraColumn: 'country', eventsExtraColumn: 'ingested_at' }),
        'utf8'
      )

      const scopedPlan = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--dryrun',
        '--table',
        'users',
        '--json',
      ])
      expect(scopedPlan.exitCode).toBe(0)
      const scopedPlanPayload = JSON.parse(scopedPlan.stdout) as {
        scope: { enabled: boolean; selector: string; matchedTables: string[] }
        operations: Array<{ key: string }>
      }
      expect(scopedPlanPayload.scope.enabled).toBe(true)
      expect(scopedPlanPayload.scope.selector).toBe('users')
      expect(scopedPlanPayload.scope.matchedTables).toEqual(['app.users'])
      expect(scopedPlanPayload.operations.every((operation) => operation.key.startsWith('table:app.users'))).toBe(
        true
      )

      const scopedGenerate = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--name',
        'users_only',
        '--migration-id',
        '20260103010000',
        '--table',
        'users',
        '--json',
      ])
      expect(scopedGenerate.exitCode).toBe(0)

      const scopedGeneratePayload = JSON.parse(scopedGenerate.stdout) as {
        migrationFile: string | null
      }
      expect(scopedGeneratePayload.migrationFile).toBeTruthy()
      const migrationPath = scopedGeneratePayload.migrationFile as string
      expect(basename(migrationPath)).toBe('20260103010000_users_only.sql')

      const migrationSql = await readFile(migrationPath, 'utf8')
      expect(migrationSql).toContain('ALTER TABLE app.users')
      expect(migrationSql).not.toContain('ALTER TABLE app.events')

      const snapshot = JSON.parse(await readFile(join(fixture.metaDir, 'snapshot.json'), 'utf8')) as {
        definitions: Array<{ kind: string; database: string; name: string; columns?: Array<{ name: string }> }>
      }
      const users = snapshot.definitions.find((def) => def.kind === 'table' && def.name === 'users')
      const events = snapshot.definitions.find((def) => def.kind === 'table' && def.name === 'events')
      expect(users).toBeTruthy()
      expect(events).toBeTruthy()
      expect(users?.columns?.some((column) => column.name === 'country')).toBe(true)
      expect(events?.columns?.some((column) => column.name === 'ingested_at')).toBe(false)

      const migrateUsers = runCli([
        'migrate',
        '--config',
        fixture.configPath,
        '--table',
        'users',
        '--json',
      ])
      expect(migrateUsers.exitCode).toBe(1)
      expect(migrateUsers.stderr).toContain('clickhouse config is required for migrate')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
