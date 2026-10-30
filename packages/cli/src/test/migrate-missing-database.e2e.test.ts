import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForTable,
} from './e2e-testkit.js'

// A statement whose database does not exist yet falls back to the server's
// default database, so that is where a stray journal row would land (#365).
const SERVER_DEFAULT_DATABASE = 'default'

describe('migrate --apply into a database that does not exist yet', () => {
  const liveEnv = getLiveEnv()

  test(
    'journals the bootstrap migration only in the new database (#365)',
    async () => {
      const executor = createLiveExecutor(liveEnv)
      const prefix = createPrefix('missing_db')
      const database = `${prefix}db`
      const migrationName = `${prefix}bootstrap`
      const journalTable = createJournalTableName('missing_db')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const strayJournal = `${quoteIdent(SERVER_DEFAULT_DATABASE)}.${quoteIdent(journalTable)}`

      // A journal table of this run's name in the default database, so a write
      // that falls back there lands as a row instead of failing on UNKNOWN_TABLE.
      await executor.command(
        `CREATE TABLE ${strayJournal} (name String, applied_at DateTime64(3, 'UTC'), checksum String, chkit_version String, migration_completed Bool, operations Array(Tuple(operation_index Int32, operation_key String, operation_type String, query_id String, status LowCardinality(String), started_at DateTime64(3, 'UTC'), finished_at Nullable(DateTime64(3, 'UTC')), last_error String))) ENGINE = MergeTree ORDER BY name`,
      )

      const dir = await mkdtemp(join(tmpdir(), 'chkit-missing-db-e2e-'))
      const configPath = join(dir, 'clickhouse.config.ts')
      const migrationsDir = join(dir, 'chkit/migrations')
      await writeFile(
        join(dir, 'schema.ts'),
        `import { schema, table } from '${CORE_ENTRY}'\n\nexport default schema(table({\n  database: '${database}',\n  name: 'events',\n  columns: [{ name: 'id', type: 'UInt64' }],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n}))\n`,
        'utf8',
      )
      await writeFile(
        configPath,
        `export default {\n  schema: '${join(dir, 'schema.ts')}',\n  outDir: '${join(dir, 'chkit')}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${join(dir, 'chkit/meta')}',\n  clickhouse: {\n    url: '${liveEnv.clickhouseUrl}',\n    username: '${liveEnv.clickhouseUser}',\n    password: '${liveEnv.clickhousePassword}',\n    database: '${database}',\n  },\n}\n`,
        'utf8',
      )

      try {
        const generate = runCli(dir, ['generate', '--config', configPath, '--name', migrationName, '--json'], cliEnv)
        expect(generate.exitCode).toBe(0)
        const [migration] = await readdir(migrationsDir)
        expect(migration).toEndWith(`_${migrationName}.sql`)

        const apply = runCli(dir, ['migrate', '--config', configPath, '--apply', '--json'], cliEnv)
        if (apply.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --apply failed', apply))
        }

        const stray = await executor.query<{ rows: string }>(
          `SELECT count() AS rows FROM ${strayJournal} WHERE name = '${migration}'`,
        )
        expect(Number(stray[0]?.rows)).toBe(0)

        await waitForTable(executor, database, 'events')
        await waitForTable(executor, database, journalTable)
        const journal = await executor.query<{ name: string; migration_completed: boolean }>(
          `SELECT name, migration_completed FROM ${quoteIdent(database)}.${quoteIdent(journalTable)} FINAL`,
        )
        expect(journal).toEqual([{ name: migration as string, migration_completed: true }])

        const status = runCli(dir, ['status', '--config', configPath, '--json'], cliEnv)
        expect(status.exitCode).toBe(0)
        expect(JSON.parse(status.stdout)).toMatchObject({ applied: 1, pending: 0, checksumMismatchCount: 0 })

        const check = await runCliWithRetry(dir, ['check', '--config', configPath, '--json'], {
          maxAttempts: 5,
          delayMs: 1500,
          extraEnv: cliEnv,
        })
        if (check.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('check --json failed', check))
        }
        expect(JSON.parse(check.stdout)).toMatchObject({ ok: true, failedChecks: [], drifted: false })
      } finally {
        await rm(dir, { recursive: true, force: true })
        await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
        await executor.command(`DROP TABLE IF EXISTS ${strayJournal} SYNC`)
        await executor.close()
      }
    },
    240_000,
  )
})
