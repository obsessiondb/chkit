import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
 * #36: `migrate --apply --table <t>` used to SILENTLY skip hand-written
 * migrations that carry no operation markers (their target tables can't be
 * determined), so the user believed all pending work was applied. The fix
 * fail-safe includes them and reports them as undetermined.
 */
describe('@chkit/cli table-scope unmarked migrations e2e (#36)', () => {
  test('an unmarked migration is applied under --table, not silently skipped', async () => {
    const liveEnv = getRequiredEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('scope_unmarked')
    const prefix = createPrefix('scope_unmarked')
    const usersTable = `${prefix}_users`
    const handTable = `${prefix}_hand`
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }

    const dir = await mkdtemp(join(tmpdir(), 'chkit-scope-unmarked-'))
    const config = join(dir, 'clickhouse.config.ts')
    const migrationsDir = join(dir, 'chkit/migrations')
    const schemaPath = join(dir, 'schema.ts')

    try {
      await mkdir(migrationsDir, { recursive: true })
      await writeFile(
        schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\n` +
          `export default schema(table({\n` +
          `  database: '${database}',\n` +
          `  name: '${usersTable}',\n` +
          `  columns: [{ name: 'id', type: 'UInt64' }],\n` +
          `  engine: 'MergeTree()',\n` +
          `  primaryKey: ['id'],\n` +
          `  orderBy: ['id'],\n` +
          `}))\n`,
        'utf8',
      )
      await writeFile(
        config,
        `export default {\n` +
          `  schema: '${schemaPath}',\n` +
          `  outDir: '${join(dir, 'chkit')}',\n` +
          `  migrationsDir: '${migrationsDir}',\n` +
          `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
          `  clickhouse: {\n` +
          `    url: '${liveEnv.clickhouseUrl}',\n` +
          `    username: '${liveEnv.clickhouseUser}',\n` +
          `    password: '${liveEnv.clickhousePassword}',\n` +
          `    database: '${database}',\n` +
          `  },\n}\n`,
        'utf8',
      )

      // Generated migration (carries `-- operation:` markers for usersTable),
      // and a hand-written one with NO markers — both pending.
      const gen = runCli(dir, ['generate', '--config', config, '--name', 'init', '--migration-id', '20990101000000', '--json'], cliEnv)
      expect(gen.exitCode).toBe(0)
      const handMigration = '20990101000001_hand_written.sql'
      await writeFile(
        join(migrationsDir, handMigration),
        `CREATE TABLE IF NOT EXISTS ${quoteIdent(database)}.${quoteIdent(handTable)} (id UInt64) ENGINE = MergeTree ORDER BY id;\n`,
        'utf8',
      )

      // Scope to the generated table. The hand-written migration has no markers,
      // so its target table is undetermined — it must still be applied (and
      // reported), not silently dropped.
      const migrate = runCli(dir, ['migrate', '--config', config, '--execute', '--table', usersTable, '--json'], cliEnv)
      expect(migrate.exitCode).toBe(0)

      const payload = JSON.parse(migrate.stdout) as {
        applied?: Array<{ name: string }>
        undeterminedMigrations?: string[]
      }
      expect(payload.undeterminedMigrations).toContain(handMigration)
      expect((payload.applied ?? []).map((entry) => entry.name)).toContain(handMigration)

      // The real proof: the hand-written migration's table actually exists.
      // Before the fix it would have been skipped and never created.
      await waitForTable(executor, database, handTable)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(usersTable)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(handTable)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
    }
  }, 180_000)
})
