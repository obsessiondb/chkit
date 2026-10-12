import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { checksumSQL } from '../runtime/migration-store.js'
import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  runCli,
  waitForColumn,
  waitForRows,
  waitForTable,
} from './e2e-testkit.js'

describe('@chkit/cli sync migration resume e2e (#6)', () => {
  test('a backfill guard blocks DROP COLUMN, then resumes after the data is upgraded (#274)', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('backfill_guard')
    const table = `${createPrefix('backfill_guard')}knowledge`
    const object = `${quoteIdent(database)}.${quoteIdent(table)}`
    const journal = `${quoteIdent(database)}.${quoteIdent(journalTable)}`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-guard-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const configPath = join(dir, 'clickhouse.config.ts')
    const migrationName = '20990101000000_guard_backfill.sql'
    const guardKey = `table:${database}.${table}:backfill`
    const migration = [
      `-- operation: alter_table_add_column key=table:${database}.${table}:column:upgraded risk=safe`,
      `ALTER TABLE ${object} ADD COLUMN upgraded UInt8 DEFAULT 1;`,
      `-- operation: assert_backfill key=${guardKey} risk=safe`,
      `SELECT throwIf((SELECT count() FROM ${object} FINAL WHERE format_version < 3) > 0, 'Republish repository knowledge');`,
      `-- operation: alter_table_drop_column key=table:${database}.${table}:column:owners risk=danger`,
      `ALTER TABLE ${object} DROP COLUMN owners;`,
      '',
    ].join('\n')
    const journalQuery = `SELECT checksum, toUInt8(migration_completed) AS completed, ` +
      `arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses, ` +
      `arrayStringConcat(arrayMap(o -> o.operation_type, operations), ',') AS operation_types, ` +
      `arrayFirst(o -> o.operation_type = 'assert_backfill', operations).operation_key AS guard_key ` +
      `FROM ${journal} FINAL WHERE name = '${migrationName}'`
    interface GuardJournalRow {
      checksum: string
      completed: number
      statuses: string
      operation_types: string
      guard_key: string
    }

    try {
      await mkdir(migrationsDir, { recursive: true })
      await writeFile(configPath, `export default ${JSON.stringify({
        schema: join(dir, 'schema.ts'),
        outDir: join(dir, 'chkit'),
        migrationsDir,
        metaDir: join(dir, 'chkit/meta'),
        clickhouse: {
          url: liveEnv.clickhouseUrl,
          username: liveEnv.clickhouseUser,
          password: liveEnv.clickhousePassword,
          database,
        },
      })};\n`, 'utf8')
      await writeFile(join(migrationsDir, migrationName), migration, 'utf8')
      await executor.command(`CREATE TABLE ${object} (` +
        `id UInt64, body String, owners Array(String), format_version UInt8, version UInt64` +
        `) ENGINE = ReplacingMergeTree(version) ORDER BY id`)
      await waitForTable(executor, database, table)
      await executor.command(`INSERT INTO ${object} (id, body, owners, format_version, version) ` +
        `VALUES (1, 'original body preserved', ['legacy owner'], 1, 1)`)
      await waitForRows<{ n: number }>(executor, `SELECT count() AS n FROM ${object} FINAL WHERE format_version < 3`,
        (rows) => Number(rows[0]?.n) === 1, 'backfill-guard: legacy data visible')

      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
      const migrate = () => runCli(dir,
        ['migrate', '--config', configPath, '--apply', '--allow-destructive', '--json'], cliEnv)

      const blocked = migrate()
      expect(blocked.exitCode, formatTestDiagnostic('backfill guard blocks migration', blocked)).toBe(1)
      expect(`${blocked.stdout}\n${blocked.stderr}`).toContain('Republish repository knowledge')
      await waitForColumn(executor, database, table, 'upgraded')
      await waitForColumn(executor, database, table, 'owners')
      const failedJournal = await waitForRows<GuardJournalRow>(executor, journalQuery,
        (rows) => rows[0]?.statuses === 'completed,failed', 'backfill-guard: failed guard journaled')
      expect(failedJournal[0]).toMatchObject({
        checksum: checksumSQL(migration),
        completed: 0,
        statuses: 'completed,failed',
        operation_types: 'alter_table_add_column,assert_backfill',
        guard_key: guardKey,
      })

      await executor.command(`INSERT INTO ${object} (id, body, owners, format_version, version) ` +
        `VALUES (1, 'original body preserved', [], 3, 2)`)
      await waitForRows<{ n: number }>(executor, `SELECT count() AS n FROM ${object} FINAL WHERE format_version < 3`,
        (rows) => Number(rows[0]?.n) === 0, 'backfill-guard: upgraded data visible')

      // ADD COLUMN has already completed. Native journal resume must skip it,
      // execute the guard again, and continue to DROP without a phantom-table wait.
      const resumed = migrate()
      expect(resumed.exitCode, formatTestDiagnostic('backfill guard resumes migration', resumed)).toBe(0)
      const completedJournal = await waitForRows<GuardJournalRow>(executor, journalQuery,
        (rows) => Number(rows[0]?.completed) === 1, 'backfill-guard: migration completed')
      expect(completedJournal[0]).toMatchObject({
        checksum: checksumSQL(migration),
        completed: 1,
        statuses: 'completed,completed,completed',
        operation_types: 'alter_table_add_column,assert_backfill,alter_table_drop_column',
        guard_key: guardKey,
      })
      const columns = await executor.query<{ name: string }>(
        `SELECT name FROM system.columns WHERE database = '${database}' AND table = '${table}'`)
      expect(columns.map((column) => column.name)).not.toContain('owners')
      expect(await executor.query<{ body: string; format_version: number; upgraded: number }>(
        `SELECT body, format_version, upgraded FROM ${object} FINAL`)).toEqual([
          { body: 'original body preserved', format_version: 3, upgraded: 1 },
        ])

      const complete = migrate()
      expect(complete.exitCode, formatTestDiagnostic('completed backfill migration', complete)).toBe(0)
      expect(JSON.parse(complete.stdout).applied).toEqual([])
      expect(await executor.query<GuardJournalRow>(journalQuery)).toEqual(completedJournal)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await executor.command(`DROP TABLE IF EXISTS ${object}`)
      await executor.command(`DROP TABLE IF EXISTS ${journal}`)
      await executor.close()
    }
  }, 180_000)

  test('a partial failure resumes on re-run instead of replaying statement 1', async () => {
    const liveEnv = getLiveEnv()
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

      // The journal write races propagation on managed ClickHouse, so poll
      // (FINAL read) until the completed row is visible rather than asserting once.
      const completed = await waitForRows<{ n: number }>(
        executor,
        `SELECT count() AS n FROM ${quoteIdent(database)}.${quoteIdent(journalTable)} FINAL ` +
          `WHERE name = '${migrationName}' AND migration_completed = 1`,
        (rows) => Number(rows[0]?.n ?? 0) === 1,
        'sync-resume: migration_completed',
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
