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
} from './e2e-testkit.js'

describe('@chkit/cli migrate refuses a mode=barrier statement that is not a SELECT (#634)', () => {
  test('refuses before any pending migration runs, in text and --json, then applies a WITH ... SELECT barrier', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('barrier')
    const prefix = createPrefix('barrier')
    const first = `${database}.${prefix}first`
    const second = `${database}.${prefix}second`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-barrier-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const configPath = join(dir, 'clickhouse.config.ts')
    const env = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
    const migrate = (json: boolean) =>
      runCli(dir, ['migrate', '--config', configPath, '--apply', ...(json ? ['--json'] : [])], env)
    const tableCount = async () =>
      Number(
        (
          await executor.query<{ n: number | string }>(
            `SELECT count() AS n FROM system.tables WHERE database = '${database}' AND name IN ('${prefix}first', '${prefix}second')`,
          )
        )[0]?.n,
      )
    const createSecond = `CREATE TABLE ${second} (id UInt64) ENGINE = MergeTree ORDER BY id;`

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
        join(migrationsDir, '20990101000000_first.sql'),
        `-- operation: create_table key=table:${first} risk=safe\n` +
          `CREATE TABLE ${first} (id UInt64) ENGINE = MergeTree ORDER BY id;\n`,
        'utf8',
      )
      const secondFile = join(migrationsDir, '20990101000001_second.sql')
      await writeFile(
        secondFile,
        `-- operation: create_table key=table:${second} risk=safe mode=barrier\n${createSecond}\n`,
        'utf8',
      )
      const expectedMessage =
        'Cannot apply: a statement marked mode=barrier is not a SELECT:\n' +
        `  - 20990101000001_second.sql, statement 1 of 1 (-- operation: create_table key=table:${second} risk=safe mode=barrier):\n` +
        `      ${createSecond}\n` +
        'chkit runs a barrier statement as a read of the running INSERTs, once and then every second, and waits for no change it makes to reach every replica.\n' +
        'Make each statement a SELECT (or WITH ... SELECT) that returns a query_id column, or remove mode=barrier from its -- operation: marker, then re-run chkit migrate --apply. No statement of these migrations ran.'

      const text = migrate(false)
      expect(text.exitCode, formatTestDiagnostic('text run was not refused', text)).toBe(1)
      expect(text.stderr.trim()).toBe(expectedMessage)

      const json = migrate(true)
      expect(json.exitCode, formatTestDiagnostic('--json run was not refused', json)).toBe(1)
      expect(JSON.parse(json.stdout)).toEqual({
        command: 'migrate',
        schemaVersion: 1,
        ok: false,
        error: { code: 'barrier_not_select', message: expectedMessage },
      })
      // Neither migration ran, not even the valid first one.
      expect(await tableCount()).toBe(0)

      await writeFile(
        secondFile,
        `-- operation: cutover_wait_for_inserts key=table:${second}:cutover:mirror_barrier risk=safe mode=barrier\n` +
          "WITH 'Insert' AS kind SELECT query_id FROM system.processes WHERE query_kind = kind;\n",
        'utf8',
      )
      const applied = migrate(true)
      expect(applied.exitCode, formatTestDiagnostic('migrate --apply failed', applied)).toBe(0)
      expect(JSON.parse(applied.stdout).applied.map((entry: { name: string }) => entry.name)).toEqual([
        '20990101000000_first.sql',
        '20990101000001_second.sql',
      ])
      expect(await tableCount()).toBe(1)
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(`${prefix}first`)}`).catch(() => {})
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(`${prefix}second`)}`).catch(() => {})
      await executor
        .command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        .catch(() => {})
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
