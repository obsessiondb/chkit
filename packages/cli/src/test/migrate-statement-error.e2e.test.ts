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

describe('@chkit/cli migrate statement-error context e2e (#10)', () => {
  test('a rejected statement reports the migration file, statement position, and SQL preview', async () => {
    const liveEnv = getRequiredEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('stmterr')
    const prefix = createPrefix('stmterr')
    const table = `${prefix}t`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-stmterr-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const configPath = join(dir, 'clickhouse.config.ts')
    const migrationName = '20990101000000_break.sql'

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

      // Statement 1 succeeds; statement 2 references an invalid type → CH rejects it.
      await writeFile(
        join(migrationsDir, migrationName),
        `CREATE TABLE IF NOT EXISTS ${database}.${table} (id UInt64) ENGINE = MergeTree ORDER BY id;\n` +
          `ALTER TABLE ${database}.${table} ADD COLUMN bad NotARealType123;\n`,
        'utf8',
      )

      const result = runCli(dir, ['migrate', '--config', configPath, '--execute'], {
        CHKIT_JOURNAL_TABLE: journalTable,
        CI: '1',
      })

      expect(result.exitCode).not.toBe(0)
      const combined = `${result.stdout}\n${result.stderr}`
      // Names the file and the failed statement position...
      expect(combined).toContain(`Migration ${migrationName} failed at statement 2 of 2`)
      // ...shows a preview of the offending SQL...
      expect(combined).toContain('ADD COLUMN bad NotARealType123')
      // ...and still carries the underlying ClickHouse message.
      expect(combined).toContain('NotARealType123')
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
