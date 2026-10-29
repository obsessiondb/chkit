import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  getLiveEnv,
  quoteIdent,
  runCli,
  waitForTable,
} from './e2e-testkit.js'

describe('@chkit/cli migrate --setting e2e (#321)', () => {
  test('sends the settings with each migration statement', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('setting')
    const table = `${createPrefix('setting')}big`
    const qualified = `${quoteIdent(database)}.${quoteIdent(table)}`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-setting-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const configPath = join(dir, 'clickhouse.config.ts')
    const env = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
    const migrate = (setting: string) =>
      runCli(
        dir,
        ['migrate', '--config', configPath, '--apply', '--allow-destructive', '--setting', setting],
        env,
      )

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
      await executor.command(`CREATE TABLE ${qualified} (id UInt64) ENGINE = MergeTree ORDER BY id`)
      await waitForTable(executor, database, table)
      await executor.command(`INSERT INTO ${qualified} SELECT number FROM numbers(1000)`)
      await writeFile(
        join(migrationsDir, '20990101000000_drop_big.sql'),
        `-- operation: drop_table key=table:${database}.${table} risk=danger\n` +
          `DROP TABLE IF EXISTS ${qualified};\n`,
        'utf8',
      )

      // A 1-byte limit makes the server refuse the drop: the setting reached it.
      const refused = migrate('max_table_size_to_drop=1')
      expect(refused.exitCode).not.toBe(0)
      expect(`${refused.stdout}\n${refused.stderr}`).toContain('max_[table/partition]_size_to_drop')
      const [kept] = await executor.query<{ n: number | string }>(`SELECT count() AS n FROM ${qualified}`)
      expect(Number(kept?.n)).toBe(1000)

      // 0 lifts the limit, and the run resumes the failed statement.
      const applied = migrate('max_table_size_to_drop=0')
      expect(applied.exitCode).toBe(0)
      const remaining = await executor.query<{ n: number | string }>(
        `SELECT count() AS n FROM system.tables WHERE database = '${database}' AND name = '${table}'`,
      )
      expect(Number(remaining[0]?.n)).toBe(0)
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${qualified} SETTINGS max_table_size_to_drop = 0`).catch(() => {})
      await executor
        .command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        .catch(() => {})
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
