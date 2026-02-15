import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'

import { CORE_ENTRY, createFixture, renderUsersSchema, runCli } from './testkit.test'

describe('@chkit/cli migration scenario flows', () => {
  test('start state + schema changes produce expected diff and migrate destructive gate', async () => {
    const fixture = await createFixture()
    try {
      const init = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--name',
        'init',
        '--migration-id',
        '20260101000000',
        '--json',
      ])
      expect(init.exitCode).toBe(0)

      await writeFile(
        fixture.schemaPath,
        renderUsersSchema({
          projectionQuery: 'SELECT id ORDER BY id DESC LIMIT 10',
        }),
        'utf8'
      )
      const projectionPlan = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(projectionPlan.exitCode).toBe(0)
      const projectionPayload = JSON.parse(projectionPlan.stdout) as {
        operations: Array<{ type: string }>
      }
      expect(
        projectionPayload.operations.some((operation) => operation.type === 'alter_table_add_projection')
      ).toBe(true)
      expect(projectionPayload.operations.some((operation) => operation.type === 'drop_table')).toBe(false)

      await writeFile(
        fixture.schemaPath,
        renderUsersSchema({
          uniqueKey: ['id'],
          projectionQuery: 'SELECT id ORDER BY id DESC LIMIT 10',
        }),
        'utf8'
      )
      const structuralPlan = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(structuralPlan.exitCode).toBe(0)
      const structuralPayload = JSON.parse(structuralPlan.stdout) as {
        operations: Array<{ type: string }>
        riskSummary: { danger: number }
      }
      expect(structuralPayload.operations.some((operation) => operation.type === 'drop_table')).toBe(true)
      expect(structuralPayload.operations.some((operation) => operation.type === 'create_table')).toBe(true)
      expect(structuralPayload.riskSummary.danger).toBeGreaterThan(0)

      const structuralGenerate = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--name',
        'structural',
        '--migration-id',
        '20260101020000',
        '--json',
      ])
      expect(structuralGenerate.exitCode).toBe(0)

      const migrateExecute = runCli(['migrate', '--config', fixture.configPath, '--execute', '--json'])
      expect(migrateExecute.exitCode).toBe(3)
      const migratePayload = JSON.parse(migrateExecute.stdout) as {
        error: string
        destructiveMigrations: string[]
      }
      expect(migratePayload.error).toContain('Blocked destructive migration execution')
      expect(migratePayload.destructiveMigrations).toContain('20260101020000_structural.sql')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('explicit rename mappings apply while unrelated heuristic suggestions remain visible', async () => {
    const fixture = await createFixture(
      `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n    { name: 'source', type: 'String', default: 'unknown' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`
    )
    try {
      const init = runCli([
        'generate',
        '--config',
        fixture.configPath,
        '--name',
        'init',
        '--migration-id',
        '20260102000000',
        '--json',
      ])
      expect(init.exitCode).toBe(0)

      await writeFile(
        fixture.schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\nconst customers = table({\n  database: 'app',\n  name: 'customers',\n  renamedFrom: { name: 'users' },\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'user_email', type: 'String', renamedFrom: 'email' },\n    { name: 'event_source', type: 'String', default: 'unknown' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(customers)\n`,
        'utf8'
      )

      const plan = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(plan.exitCode).toBe(0)
      const payload = JSON.parse(plan.stdout) as {
        operations: Array<{ type: string }>
        renameSuggestions: Array<{ from: string; to: string }>
      }
      expect(payload.operations.some((operation) => operation.type === 'alter_table_rename_table')).toBe(true)
      expect(payload.operations.some((operation) => operation.type === 'alter_table_rename_column')).toBe(true)
      expect(payload.renameSuggestions.some((s) => s.from === 'source' && s.to === 'event_source')).toBe(true)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
