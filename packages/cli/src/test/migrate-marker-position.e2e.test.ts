import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  runCli,
  waitForRows,
} from './e2e-testkit.js'

// #831: a marker belongs to the statement after it. An unmarked statement
// before an async load runs as itself, and the load runs async.

const TIMEOUT_MS = 120_000

describe('migrate pairs each -- operation: marker with the statement after it (#831)', () => {
  test('an unmarked CREATE TABLE before an async load runs sync, and the load runs async', async () => {
    const env = getLiveEnv()
    const executor = createLiveExecutor(env)
    const prefix = createPrefix('marker_pos')
    const database = `${prefix}db`
    const journalTable = createJournalTableName('marker_pos')
    const migration = `20990101000000_${prefix}load.sql`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-marker-pos-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const configPath = join(dir, 'clickhouse.config.ts')
    try {
      await mkdir(migrationsDir, { recursive: true })
      await writeFile(
        join(migrationsDir, migration),
        [
          'CREATE TABLE events (id UInt64) ENGINE = MergeTree ORDER BY id;',
          '-- operation: load_table_data key=table:events risk=caution mode=async',
          '-- before-retry: TRUNCATE TABLE events',
          'INSERT INTO events SELECT number FROM numbers(3);',
          '',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        configPath,
        `export default {\n  schema: '${join(dir, 'schema.ts')}',\n  outDir: '${join(dir, 'chkit')}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${join(dir, 'chkit/meta')}',\n  clickhouse: {\n    url: '${env.clickhouseUrl}',\n    username: '${env.clickhouseUser}',\n    password: process.env.CHKIT_E2E_PASSWORD,\n    database: '${database}',\n  },\n}\n`,
        'utf8',
      )
      await executor.command(`CREATE DATABASE ${quoteIdent(database)}`)

      const apply = runCli(dir, ['migrate', '--config', configPath, '--apply', '--json'], {
        CHKIT_JOURNAL_TABLE: journalTable,
        CHKIT_E2E_PASSWORD: env.clickhousePassword,
        CI: '1',
      })
      expect(apply.exitCode, formatTestDiagnostic('migrate --apply', apply)).toBe(0)

      const operations = await waitForRows<{ index: number; type: string; key: string; queryId: string; status: string }>(
        executor,
        `SELECT op.operation_index AS index, op.operation_type AS type, op.operation_key AS key, op.query_id AS queryId, op.status AS status ` +
          `FROM ${quoteIdent(database)}.${quoteIdent(journalTable)} FINAL ARRAY JOIN operations AS op ` +
          `WHERE name = '${migration}' AND migration_completed ORDER BY index SETTINGS select_sequential_consistency = 1`,
        (rows) => rows.length === 2,
        'journal of the migration',
      )
      expect(operations.map(({ index, type, key, status }) => ({ index: Number(index), type, key, status }))).toEqual([
        { index: 0, type: 'sql_statement', key: 'statement:0', status: 'completed' },
        { index: 1, type: 'load_table_data', key: 'table:events', status: 'completed' },
      ])
      // Only the load ran async, under a query id of its own.
      expect(operations[0]?.queryId).toBe('')
      expect(operations[1]?.queryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      const [rows] = await executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${quoteIdent(database)}.events`)
      expect(rows?.n).toBe('3')
    } finally {
      await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, TIMEOUT_MS)
})
