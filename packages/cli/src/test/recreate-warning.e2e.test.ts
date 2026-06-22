import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  getRequiredEnv,
  quoteIdent,
  runCli,
  waitForTable,
} from './e2e-testkit.js'

/**
 * #23: a structural change (engine / ORDER BY / PRIMARY KEY / PARTITION BY /
 * UNIQUE KEY) generates a DROP + CREATE that destroys all rows. The drop used
 * to surface the same generic `drop_table_data_loss` warning as a deliberate
 * drop. It now carries the distinct, louder `table_recreate_data_loss` warning.
 * This run is BLOCKED (no --allow-destructive), so no data is actually dropped.
 */
describe('@chkit/cli table-recreate warning e2e (#23)', () => {
  test('a structural change surfaces the distinct table_recreate_data_loss warning', async () => {
    const liveEnv = getRequiredEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('recreate')
    const prefix = createPrefix('recreate')
    const tableName = `${prefix}_t`
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }

    const dir = await mkdtemp(join(tmpdir(), 'chkit-recreate-'))
    const config = join(dir, 'clickhouse.config.ts')
    const schemaPath = join(dir, 'schema.ts')

    const renderSchema = (engine: string): string =>
      `import { schema, table } from '${CORE_ENTRY}'\n\n` +
      `export default schema(table({\n` +
      `  database: '${database}',\n` +
      `  name: '${tableName}',\n` +
      `  columns: [{ name: 'id', type: 'UInt64' }],\n` +
      `  engine: '${engine}',\n` +
      `  primaryKey: ['id'],\n` +
      `  orderBy: ['id'],\n` +
      `}))\n`

    try {
      await writeFile(schemaPath, renderSchema('MergeTree()'), 'utf8')
      await writeFile(
        config,
        `export default {\n` +
          `  schema: '${schemaPath}',\n` +
          `  outDir: '${join(dir, 'chkit')}',\n` +
          `  migrationsDir: '${join(dir, 'chkit/migrations')}',\n` +
          `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
          `  clickhouse: {\n` +
          `    url: '${liveEnv.clickhouseUrl}',\n` +
          `    username: '${liveEnv.clickhouseUser}',\n` +
          `    password: '${liveEnv.clickhousePassword}',\n` +
          `    database: '${database}',\n` +
          `  },\n}\n`,
        'utf8',
      )

      const genInit = runCli(dir, ['generate', '--config', config, '--name', 'init', '--migration-id', '20990101000000', '--json'], cliEnv)
      expect(genInit.exitCode).toBe(0)
      const migrateInit = runCli(dir, ['migrate', '--config', config, '--execute', '--json'], cliEnv)
      expect(migrateInit.exitCode).toBe(0)
      await waitForTable(executor, database, tableName)

      // Structural change: engine MergeTree -> ReplacingMergeTree forces a
      // DROP + CREATE recreate of the existing table.
      await writeFile(schemaPath, renderSchema('ReplacingMergeTree()'), 'utf8')
      const genRecreate = runCli(dir, ['generate', '--config', config, '--name', 'recreate', '--migration-id', '20990101000001', '--json'], cliEnv)
      expect(genRecreate.exitCode).toBe(0)

      // Apply in CI without --allow-destructive: blocked (exit 3), and the
      // blocked operation must carry the distinct recreate warning.
      const migrate = runCli(dir, ['migrate', '--config', config, '--execute', '--json'], cliEnv)
      expect(migrate.exitCode).toBe(3)
      const payload = JSON.parse(migrate.stdout) as {
        destructiveOperations?: Array<{ type: string; warningCode: string }>
      }
      const warningCodes = (payload.destructiveOperations ?? []).map((op) => op.warningCode)
      expect(warningCodes).toContain('table_recreate_data_loss')
      expect(warningCodes).not.toContain('drop_table_data_loss')
    } finally {
      await rm(dir, { recursive: true, force: true })
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(tableName)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
    }
  }, 180_000)
})
