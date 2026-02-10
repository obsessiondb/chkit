import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'

import { createFixture, renderUsersSchema, runCli } from './testkit.test'

describe('@chx/cli migration scenario flows', () => {
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
      const projectionPlan = runCli(['generate', '--config', fixture.configPath, '--plan', '--json'])
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
      const structuralPlan = runCli(['generate', '--config', fixture.configPath, '--plan', '--json'])
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
})
