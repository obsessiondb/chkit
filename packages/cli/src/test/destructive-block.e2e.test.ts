import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  getRequiredEnv,
  quoteIdent,
  runCli,
  waitForColumn,
} from './e2e-testkit.js'

describe('@chkit/cli destructive block e2e (#2)', () => {
  test('a hand-written DROP COLUMN with no markers is blocked, not silently applied', async () => {
    const liveEnv = getRequiredEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('destructive')
    const table = `${createPrefix('destructive')}users`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-destructive-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      await mkdir(migrationsDir, { recursive: true })
      await writeFile(
        configPath,
        `export default {\n` +
          `  schema: '${join(dir, 'schema.ts')}',\n` +
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

      await executor.command(
        `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(table)} (id UInt64, email String) ENGINE = MergeTree ORDER BY id`,
      )
      await waitForColumn(executor, database, table, 'email')

      // Hand-written destructive migration with NO `-- operation:` markers.
      await writeFile(
        join(migrationsDir, '20990101000000_drop_email.sql'),
        `ALTER TABLE ${database}.${table} DROP COLUMN email;\n`,
        'utf8',
      )

      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
      const result = runCli(dir, ['migrate', '--config', configPath, '--execute', '--json'], cliEnv)

      // Blocked: exit 3, lists the offending migration — not applied.
      expect(result.exitCode).toBe(3)
      const payload = JSON.parse(result.stdout) as {
        destructiveMigrations: string[]
        destructiveOperations: Array<{ type: string }>
      }
      expect(payload.destructiveMigrations).toContain('20990101000000_drop_email.sql')
      expect(payload.destructiveOperations.some((op) => op.type === 'alter_table_drop_column')).toBe(true)

      // The column must still exist — the destructive migration was NOT applied.
      const cols = await executor.query<{ x: number }>(
        `SELECT 1 AS x FROM system.columns WHERE database = '${database}' AND table = '${table}' AND name = 'email'`,
      )
      expect(cols.length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(table)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
    }
  }, 120_000)
})
