import { describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CORE_ENTRY, createFixture, runCli } from './testkit.test'

function renderSchema(input: { table: string; renamedFrom?: string; baseSql: string; topSql: string }): string {
  const renamed = input.renamedFrom ? `  renamedFrom: { name: '${input.renamedFrom}' },\n` : ''
  return (
    `import { schema, table, view } from '${CORE_ENTRY}'\n\n` +
    `const source = table({\n  database: 'app',\n  name: '${input.table}',\n${renamed}` +
    `  columns: [{ name: 'id', type: 'UInt64' }],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\n` +
    `const zBase = view({ database: 'app', name: 'z_base', as: '${input.baseSql}' })\n` +
    `const aTop = view({ database: 'app', name: 'a_top', as: '${input.topSql}' })\n\n` +
    `export default schema(source, zBase, aTop)\n`
  )
}

describe('@chkit/cli generate dependency order (#231)', () => {
  test('creates a view after the view it reads, including when a rename is applied', async () => {
    const fixture = await createFixture(
      renderSchema({ table: 'users', baseSql: 'SELECT id FROM app.users', topSql: 'SELECT id FROM app.z_base' })
    )
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
      const initSql = await readFile(join(fixture.migrationsDir, '20260101000000_init.sql'), 'utf8')
      expect(initSql.match(/^-- operation: .*$/gm)).toEqual([
        '-- operation: create_database key=database:app risk=safe',
        '-- operation: create_table key=table:app.users risk=safe',
        '-- operation: create_view key=view:app.z_base risk=safe',
        '-- operation: create_view key=view:app.a_top risk=safe',
      ])

      await writeFile(
        fixture.schemaPath,
        renderSchema({
          table: 'customers',
          renamedFrom: 'users',
          baseSql: 'SELECT id FROM app.customers',
          topSql: 'SELECT id FROM app.z_base WHERE id > 0',
        }),
        'utf8'
      )
      const plan = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(plan.exitCode).toBe(0)
      const payload = JSON.parse(plan.stdout) as { operations: Array<{ type: string; key: string }> }
      expect(payload.operations.map((op) => `${op.type} ${op.key}`)).toEqual([
        'drop_view view:app.a_top',
        'drop_view view:app.z_base',
        'alter_table_rename_table table:app.customers:rename_table',
        'create_view view:app.z_base',
        'create_view view:app.a_top',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 60_000)

  // ClickHouse reads `z\x5fbase` as z_base and keeps the backslash of `z\q` (#639).
  test('creates a view after the view it reads through an escaped quoted name', async () => {
    const fixture = await createFixture(
      `import { schema, table, view } from '${CORE_ENTRY}'\n\n` +
        `export default schema(\n` +
        `  table({ database: 'app', name: 'users', columns: [{ name: 'id', type: 'UInt64' }], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] }),\n` +
        `  view({ database: 'app', name: 'z_base', as: 'SELECT id FROM app.users' }),\n` +
        `  view({ database: 'app', name: 'z\\\\q', as: 'SELECT id FROM app.users' }),\n` +
        `  view({ database: 'app', name: 'a_top', as: 'SELECT id FROM app.\`z\\\\x5fbase\`' }),\n` +
        `  view({ database: 'app', name: 'a_q', as: 'SELECT id FROM app.\`z\\\\q\`' }),\n` +
        `)\n`
    )
    try {
      const plan = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'])
      expect(plan.exitCode).toBe(0)
      const keys = (JSON.parse(plan.stdout) as { operations: Array<{ key: string }> }).operations.map((op) => op.key)
      expect(keys.indexOf('view:app.z_base')).toBeLessThan(keys.indexOf('view:app.a_top'))
      expect(keys.indexOf('view:app.z\\q')).toBeLessThan(keys.indexOf('view:app.a_q'))
      expect(keys).toHaveLength(6)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 60_000)
})
