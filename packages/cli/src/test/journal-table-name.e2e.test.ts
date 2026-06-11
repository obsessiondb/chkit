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
} from './e2e-testkit.js'

describe('@chkit/cli migrate journal-table message e2e (#38)', () => {
  test('the post-apply message names the resolved journal table, not a hardcoded _chkit_migrations', async () => {
    const liveEnv = getRequiredEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('jname')
    const prefix = createPrefix('jname')
    const table = `${prefix}t`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-jname-e2e-'))
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

      await writeFile(
        join(migrationsDir, '20990101000000_create.sql'),
        `CREATE TABLE IF NOT EXISTS ${database}.${table} (id UInt64) ENGINE = MergeTree ORDER BY id;\n`,
        'utf8',
      )

      // Non-JSON apply so the human "recorded in ClickHouse <table>" line prints.
      const result = runCli(dir, ['migrate', '--config', configPath, '--execute'], {
        CHKIT_JOURNAL_TABLE: journalTable,
        CI: '1',
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`recorded in ClickHouse ${journalTable} table`)
      // The default name must NOT be printed when an override is in effect.
      expect(result.stdout).not.toContain('_chkit_migrations table')
    } finally {
      await executor
        .command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(table)}`)
        .catch(() => {})
      await executor
        .command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        .catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
