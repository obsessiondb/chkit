import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listDictionaryDetails } from '@chkit/clickhouse'

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
  waitForCliJson,
  waitForDictionary,
  waitForTable,
} from './e2e-testkit.js'

// Dictionaries load lazily, so ClickHouse never connects with these passwords.
const SCHEMA_SECRET = 'drift-492-schema-secret'
const LIVE_SECRET = 'drift-492-live-secret'

interface DriftPayload {
  drifted: boolean
  objectDrift: Array<{ code: string; object: string; expected?: string; actual?: string }>
}

describe('@chkit/cli drift dictionaries e2e', () => {
  test('dictionary definitions read clean after migrate, and a recreated dictionary drifts per clause (#492)', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const prefix = createPrefix('drift_dicts')
    const journalTable = createJournalTableName('drift_dicts')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
    const users = `${prefix}users`
    const usersDict = `${prefix}users_dict`
    const ratesDict = `${prefix}rates_dict`
    const nullDict = `${prefix}null_dict`
    const nullTable = `${prefix}null_table`
    const q = (name: string) => `${quoteIdent(database)}.${quoteIdent(name)}`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-cli-drift-dicts-e2e-'))
    const configPath = join(dir, 'clickhouse.config.ts')
    const schemaPath = join(dir, 'schema.ts')
    const outDir = join(dir, 'chkit')

    try {
      await writeFile(
        configPath,
        `export default {
  schema: '${schemaPath}',
  outDir: '${outDir}',
  migrationsDir: '${join(outDir, 'migrations')}',
  metaDir: '${join(outDir, 'meta')}',
  clickhouse: {
    url: '${liveEnv.clickhouseUrl}',
    username: '${liveEnv.clickhouseUser}',
    password: '${liveEnv.clickhousePassword}',
    database: '${database}',
  },
}
`,
        'utf8'
      )
      // Spellings that ClickHouse stores another way: lower-case source keys, `Decimal(10,2)`,
      // `hashed(shards 4)`, `MAX 600 MIN 60`, a password it stores as '[HIDDEN]', `\n` and `\t`
      // escapes in a string, and a comment that reads like a SETTINGS clause.
      await writeFile(
        schemaPath,
        `import { dictionary, schema, table } from '${CORE_ENTRY}'
const users = table({
  database: '${database}', name: '${users}', engine: 'MergeTree()', orderBy: ['id'],
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'name', type: 'String' },
    { name: 'price', type: 'Decimal(10,2)' },
    { name: 'start', type: 'Date' },
    { name: 'stop', type: 'Date' },
  ],
})
const usersDict = dictionary({
  database: '${database}', name: '${usersDict}', primaryKey: ['id'],
  attributes: [
    { name: 'id', type: 'UInt64' },
    { name: 'name', type: 'String', default: '' },
    { name: 'price', type: 'Decimal(10,2)', default: 0 },
  ],
  source: "clickhouse(table '${users}' db '${database}' user 'default' password '${SCHEMA_SECRET}')",
  layout: 'hashed(shards 4)', lifetime: 'MAX 600 MIN 60', settings: { format_csv_allow_single_quotes: 0 },
})
const ratesDict = dictionary({
  database: '${database}', name: '${ratesDict}', primaryKey: ['id'],
  attributes: [
    { name: 'id', type: 'UInt64' },
    { name: 'start', type: 'Date' },
    { name: 'stop', type: 'Date' },
    { name: 'price', type: 'Decimal(10,2)', default: 0 },
  ],
  source: "CLICKHOUSE(QUERY 'SELECT id, start, stop, price\\\\nFROM\\\\t${users}' DB '${database}')",
  layout: 'range_hashed()', lifetime: '0', range: { min: 'start', max: 'stop' },
  comment: 'uses SETTINGS(x = 1)',
})
export default schema(users, usersDict, ratesDict)
`,
        'utf8'
      )
      const generated = runCli(dir, ['generate', '--config', configPath, '--json'], cliEnv)
      if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic('dictionaries generate failed', generated))
      const migrated = await runCliWithRetry(dir, ['migrate', '--config', configPath, '--execute', '--json'], {
        extraEnv: cliEnv,
      })
      if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic('dictionaries migrate failed', migrated))
      await waitForDictionary(executor, database, usersDict)
      await waitForDictionary(executor, database, ratesDict)

      const clean = runCli(dir, ['drift', '--config', configPath, '--json'], cliEnv)
      expect(clean.exitCode).toBe(0)
      const cleanPayload = JSON.parse(clean.stdout) as DriftPayload
      // A shared test database holds other runs' objects, reported as extra_object.
      expect(cleanPayload.objectDrift.filter((item) => item.code !== 'extra_object')).toEqual([])
      expect(cleanPayload.drifted).toBe(false)
      const cleanCheck = runCli(dir, ['check', '--strict', '--config', configPath, '--json'], cliEnv)
      expect(cleanCheck.exitCode).toBe(0)

      // A table with ENGINE = Dictionary has the engine name of a dictionary, but it is not one.
      await executor.command(`CREATE DICTIONARY ${q(nullDict)} (id UInt64) PRIMARY KEY id SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)`)
      await executor.command(`CREATE TABLE ${q(nullTable)} (id UInt64) ENGINE = Dictionary('${database}.${nullDict}')`)
      await waitForDictionary(executor, database, nullDict)
      await waitForTable(executor, database, nullTable)
      const listed = (await listDictionaryDetails(executor, [database])).map((item) => item.name)
      expect(listed).toContain(nullDict)
      expect(listed).not.toContain(nullTable)

      // DROP + CREATE rather than CREATE OR REPLACE, which ObsessionDB does not
      // apply on every replica.
      await executor.command(`DROP DICTIONARY ${q(usersDict)} SYNC`)
      await executor.command(
        `CREATE DICTIONARY ${q(usersDict)} (id UInt64, name String DEFAULT 'n/a', price Decimal(10, 2) DEFAULT 0, age UInt8)
PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE '${users}_v2' DB '${database}' USER 'default' PASSWORD '${LIVE_SECRET}'))
LAYOUT(FLAT()) LIFETIME(300) SETTINGS(format_csv_allow_single_quotes = 1)`
      )
      await executor.command(`DROP DICTIONARY ${q(ratesDict)} SYNC`)
      await executor.command(
        `CREATE DICTIONARY ${q(ratesDict)} (id UInt64, start Date, stop Date, price Decimal(10, 2) DEFAULT 0)
PRIMARY KEY id SOURCE(CLICKHOUSE(QUERY 'SELECT id, start, stop, price\\nFROM\\t${users}' DB '${database}'))
LAYOUT(RANGE_HASHED()) LIFETIME(0) RANGE(MIN stop MAX start) COMMENT 'uses SETTINGS(x = 1)'`
      )

      const usersObject = `${database}.${usersDict}`
      const ratesObject = `${database}.${ratesDict}`
      const expectedDrift = [
        { code: 'structure_mismatch', object: ratesObject, expected: '(`id` UInt64, `start` Date, `stop` Date, `price` Decimal(10, 2) DEFAULT 0) PRIMARY KEY id RANGE(MIN start MAX stop)', actual: '(`id` UInt64, `start` Date, `stop` Date, `price` Decimal(10, 2) DEFAULT 0) PRIMARY KEY id RANGE(MIN stop MAX start)' },
        { code: 'source_mismatch', object: usersObject, expected: `CLICKHOUSE(TABLE '${users}' DB '${database}' USER 'default' PASSWORD '[HIDDEN]')`, actual: `CLICKHOUSE(TABLE '${users}_v2' DB '${database}' USER 'default' PASSWORD '[HIDDEN]')` },
        { code: 'structure_mismatch', object: usersObject, expected: "(`id` UInt64, `name` String DEFAULT '', `price` Decimal(10, 2) DEFAULT 0) PRIMARY KEY id", actual: "(`id` UInt64, `name` String DEFAULT 'n/a', `price` Decimal(10, 2) DEFAULT 0, `age` UInt8) PRIMARY KEY id" },
        { code: 'layout_mismatch', object: usersObject, expected: 'HASHED(SHARDS 4)', actual: 'FLAT()' },
        { code: 'lifetime_mismatch', object: usersObject, expected: 'MIN 60 MAX 600', actual: 'MIN 0 MAX 300' },
        { code: 'dictionary_setting_mismatch', object: usersObject, expected: 'format_csv_allow_single_quotes = 0', actual: 'format_csv_allow_single_quotes = 1' },
      ]
      const objectDrift = (payload: DriftPayload) => payload.objectDrift.filter((item) => item.code !== 'extra_object')
      const { result, payload } = await waitForCliJson<DriftPayload>(
        dir,
        ['drift', '--config', configPath, '--json'],
        (drift) => objectDrift(drift).length === expectedDrift.length,
        { extraEnv: cliEnv, maxAttempts: 30 }
      )
      expect(objectDrift(payload)).toEqual(expectedDrift)
      expect(payload.drifted).toBe(true)
      expect(result.stdout).not.toContain(SCHEMA_SECRET)
      expect(result.stdout).not.toContain(LIVE_SECRET)

      const text = runCli(dir, ['drift', '--config', configPath], cliEnv)
      expect(text.stdout).toContain(`- layout_mismatch ${usersObject}\n  expected=HASHED(SHARDS 4)\n  actual=FLAT()\n`)
      expect(text.stdout).not.toContain(SCHEMA_SECRET)

      const strict = runCli(dir, ['check', '--strict', '--config', configPath, '--json'], cliEnv)
      expect(strict.exitCode).toBe(1)
      expect(JSON.parse(strict.stdout)).toMatchObject({
        ok: false,
        failedChecks: ['schema_drift'],
        driftReasonCounts: {
          source_mismatch: 1,
          structure_mismatch: 2,
          layout_mismatch: 1,
          lifetime_mismatch: 1,
          dictionary_setting_mismatch: 1,
        },
      })
    } finally {
      await executor.command(`DROP DICTIONARY IF EXISTS ${q(usersDict)}`)
      await executor.command(`DROP DICTIONARY IF EXISTS ${q(ratesDict)}`)
      await executor.command(`DROP TABLE IF EXISTS ${q(nullTable)}`)
      await executor.command(`DROP DICTIONARY IF EXISTS ${q(nullDict)}`)
      for (const name of [users, journalTable]) {
        await executor.command(`DROP TABLE IF EXISTS ${q(name)}`)
      }
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 240_000)
})
