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
  waitForTable,
} from './e2e-testkit.js'

const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'

describe('@chkit/cli migrate --setting e2e (#321)', () => {
  test('sends the settings with every migration statement, and none without the flag', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('setting')
    const prefix = createPrefix('setting')
    const table = `${prefix}big`
    const sink = `${prefix}sink`
    const qualified = `${quoteIdent(database)}.${quoteIdent(table)}`
    const qualifiedSink = `${quoteIdent(database)}.${quoteIdent(sink)}`
    // A unique log_comment the statements read back with getSetting().
    const tag = prefix
    const unsetCheck = (step: string) =>
      `throwIf(getSetting('log_comment') != '${tag}', '--setting log_comment is not set for the ${step}')`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-setting-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const configPath = join(dir, 'clickhouse.config.ts')
    const env = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
    const migrate = (settings: string[]) =>
      runCli(
        dir,
        [
          'migrate',
          '--config',
          configPath,
          '--apply',
          '--allow-destructive',
          ...settings.flatMap((setting) => ['--setting', setting]),
        ],
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
      await executor.command(`CREATE TABLE ${qualifiedSink} (comment String) ENGINE = MergeTree ORDER BY comment`)
      await waitForTable(executor, database, sink)
      // A sync DROP with a before-retry guard, an async INSERT and a barrier,
      // each of which reads the settings it was sent.
      await writeFile(
        join(migrationsDir, '20990101000000_drop_big.sql'),
        `-- operation: drop_table key=table:${database}.${table} risk=danger\n` +
          `-- before-retry: SELECT ${unsetCheck('before-retry SQL')}\n` +
          `DROP TABLE IF EXISTS ${qualified};\n` +
          `-- operation: load_table_data key=table:${database}.${sink} risk=caution mode=async\n` +
          `INSERT INTO ${qualifiedSink} SELECT getSetting('log_comment');\n` +
          `-- operation: cutover_wait_for_inserts key=table:${database}.${sink}:cutover:mirror_barrier risk=safe mode=barrier\n` +
          `SELECT query_id FROM system.processes WHERE ${unsetCheck('barrier')} = 1 OR query_kind IN ('Insert', 'AsyncInsertFlush');\n`,
        'utf8',
      )
      const rowCount = async (sql: string) =>
        Number((await executor.query<{ n: number | string }>(sql))[0]?.n)

      // A 1-byte limit makes the server refuse the drop: the setting reached it.
      const refused = migrate(['max_table_size_to_drop=1', `log_comment=${tag}`])
      expect(refused.exitCode, formatTestDiagnostic('drop was not refused', refused)).not.toBe(0)
      expect(`${refused.stdout}\n${refused.stderr}`).toContain('max_[table/partition]_size_to_drop')
      expect(await rowCount(`SELECT count() AS n FROM ${qualified}`)).toBe(1000)

      // Without --setting no setting is sent: the before-retry guard of the
      // failed DROP finds log_comment unset and stops the run.
      const unset = migrate([])
      expect(unset.exitCode, formatTestDiagnostic('guard did not stop the run', unset)).not.toBe(0)
      expect(`${unset.stdout}\n${unset.stderr}`).toContain('--setting log_comment is not set for the before-retry SQL')
      expect(await rowCount(`SELECT count() AS n FROM ${qualified}`)).toBe(1000)

      // 0 lifts the limit: the run resumes at the DROP, and the before-retry
      // SQL, the async INSERT and the barrier all see the settings.
      const applied = migrate(['max_table_size_to_drop=0', `log_comment=${tag}`])
      expect(applied.exitCode, formatTestDiagnostic('migrate --apply failed', applied)).toBe(0)
      expect(
        await rowCount(`SELECT count() AS n FROM system.tables WHERE database = '${database}' AND name = '${table}'`),
      ).toBe(0)
      const written = await executor.query<{ comment: string }>(`SELECT comment FROM ${qualifiedSink}`)
      expect(written).toEqual([{ comment: tag }])
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${qualified} SETTINGS max_table_size_to_drop = 0`).catch(() => {})
      await executor.command(`DROP TABLE IF EXISTS ${qualifiedSink}`).catch(() => {})
      await executor
        .command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        .catch(() => {})
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  // #790: async_insert and wait_for_async_insert are defaults --setting may
  // override, used as written on sync and async statements with one warning,
  // and sent after a --setting profile, so the profile cannot change them.
  // chkit-py: test_migrate_settings_e2e.py.
  test.skipIf(onObsessionDB)('insert setting overrides are sent as written, after a settings profile, with one warning', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('insert_override')
    const prefix = createPrefix('insert_override')
    const sink = `${prefix}sink`
    const profile = `${prefix}fire_and_forget`
    const qualifiedSink = `${quoteIdent(database)}.${quoteIdent(sink)}`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-insert-override-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const configPath = join(dir, 'clickhouse.config.ts')
    const migrate = (settings: string[]) =>
      runCli(dir, ['migrate', '--config', configPath, '--apply', ...settings.flatMap((setting) => ['--setting', setting])], { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' })
    const writeMigration = (name: string, first: number) =>
      writeFile(
        join(migrationsDir, name),
        `INSERT INTO ${qualifiedSink} VALUES (${first});\n` +
          `-- operation: load_table_data key=table:${database}.${sink} risk=caution mode=async\n` +
          `INSERT INTO ${qualifiedSink} SELECT ${first + 1};\n`,
        'utf8',
      )
    const stored = async () => Number((await executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${qualifiedSink}`))[0]?.n)
    const sentSettings = async (tag: string) => {
      await executor.command('SYSTEM FLUSH LOGS')
      // Settings lists a setting only when its value is not the server's default.
      const effective = (name: string) => `if(mapContains(Settings, '${name}'), Settings['${name}'], (SELECT default FROM system.settings WHERE name = '${name}')) AS ${name}`
      return await executor.query<{ async_insert: string; wait_for_async_insert: string }>(
        `SELECT ${effective('async_insert')}, ${effective('wait_for_async_insert')} FROM system.query_log ` +
          `WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND Settings['log_comment'] = '${tag}' AND has(tables, '${database}.${sink}')`,
      )
    }
    const warnings = (stderr: string) => stderr.split('\n').filter((line) => line.startsWith('Warning: --setting'))

    try {
      await mkdir(migrationsDir, { recursive: true })
      await writeFile(
        configPath,
        `export default {\n  schema: '${join(dir, 'schema.ts')}',\n  outDir: '${join(dir, 'chkit')}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${join(dir, 'chkit/meta')}',\n` +
          `  clickhouse: { url: '${liveEnv.clickhouseUrl}', username: '${liveEnv.clickhouseUser}', password: '${liveEnv.clickhousePassword}', database: '${database}' },\n}\n`,
        'utf8',
      )
      // Fire-and-forget: without chkit's settings after it, an INSERT would
      // return with its rows still buffered for 3 s.
      await executor.command(
        `CREATE SETTINGS PROFILE ${quoteIdent(profile)} SETTINGS async_insert = 1, wait_for_async_insert = 0, async_insert_use_adaptive_busy_timeout = 0, async_insert_busy_timeout_max_ms = 3000`,
      )
      await executor.command(`CREATE TABLE ${qualifiedSink} (id UInt64) ENGINE = MergeTree ORDER BY id`)
      await waitForTable(executor, database, sink)

      // A profile, and async_insert at chkit's default in another spelling:
      // no warning, and both statements are stored when the run exits.
      await writeMigration('20990101000000_first.sql', 1)
      const profiled = migrate([`log_comment=${prefix}a`, `profile=${profile}`, 'async_insert=FALSE'])
      expect(profiled.exitCode, formatTestDiagnostic('migrate --apply with a profile failed', profiled)).toBe(0)
      expect(warnings(profiled.stderr)).toEqual([])
      expect(await stored()).toBe(2)
      expect(await sentSettings(`${prefix}a`)).toEqual([
        { async_insert: '0', wait_for_async_insert: '1' },
        { async_insert: '0', wait_for_async_insert: '1' },
      ])

      // An override is used as written on both statements, with one warning.
      await writeMigration('20990101000001_second.sql', 3)
      const overridden = migrate([`log_comment=${prefix}b`, 'async_insert=true'])
      expect(overridden.exitCode, formatTestDiagnostic('migrate --apply with an override failed', overridden)).toBe(0)
      expect(warnings(overridden.stderr)).toEqual([
        'Warning: --setting overrides what every migration write sets by default: async_insert=true (an INSERT is queued as an asynchronous insert, which migrate cannot cancel).',
      ])
      expect(await stored()).toBe(4)
      expect(await sentSettings(`${prefix}b`)).toEqual([
        { async_insert: '1', wait_for_async_insert: '1' },
        { async_insert: '1', wait_for_async_insert: '1' },
      ])
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${qualifiedSink} SYNC`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)} SYNC`)
      await executor.command(`DROP SETTINGS PROFILE IF EXISTS ${quoteIdent(profile)}`)
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
