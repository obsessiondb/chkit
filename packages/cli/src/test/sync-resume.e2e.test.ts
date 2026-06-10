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
  waitForTable,
} from './e2e-testkit.js'

describe('@chkit/cli sync migration resume e2e (#6)', () => {
  test('a partial failure resumes on re-run instead of replaying statement 1', async () => {
    const liveEnv = getRequiredEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('resume')
    const prefix = createPrefix('resume')
    const tableA = `${prefix}a`
    const tableB = `${prefix}b`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-resume-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const configPath = join(dir, 'clickhouse.config.ts')
    const migrationName = '20990101000000_resume.sql'

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
        `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(tableA)} (id UInt64) ENGINE = MergeTree ORDER BY id`,
      )
      await waitForTable(executor, database, tableA)

      // Statement 1 succeeds (ADD COLUMN); statement 2 fails until table B exists.
      await writeFile(
        join(migrationsDir, migrationName),
        `ALTER TABLE ${database}.${tableA} ADD COLUMN newcol UInt64;\n` +
          `INSERT INTO ${database}.${tableB} SELECT 1;\n`,
        'utf8',
      )

      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
      const migrate = () => runCli(dir, ['migrate', '--config', configPath, '--execute', '--json'], cliEnv)

      // Run 1: stmt1 applies, stmt2 fails (table B missing).
      const run1 = migrate()
      expect(run1.exitCode).not.toBe(0)
      await waitForColumn(executor, database, tableA, 'newcol')

      // Run 2: same file, cause still present. Must fail on stmt2 again — NOT on
      // "column already exists", which would mean statement 1 was replayed.
      const run2 = migrate()
      expect(run2.exitCode).not.toBe(0)
      expect(`${run2.stdout}\n${run2.stderr}`.toLowerCase()).not.toContain('already exists')

      // Resolve the transient cause, then resume.
      await executor.command(
        `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(tableB)} (v UInt64) ENGINE = MergeTree ORDER BY v`,
      )
      await waitForTable(executor, database, tableB)

      const run3 = migrate()
      expect(run3.exitCode).toBe(0)

      const completed = await executor.query<{ n: number }>(
        `SELECT count() AS n FROM ${quoteIdent(database)}.${quoteIdent(journalTable)} FINAL ` +
          `WHERE name = '${migrationName}' AND migration_completed = 1`,
      )
      expect(Number(completed[0]?.n ?? 0)).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(tableA)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(tableB)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
    }
  }, 180_000)
})
