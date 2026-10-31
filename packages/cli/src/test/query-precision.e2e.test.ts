import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createPrefix, formatTestDiagnostic, getLiveEnv, quoteIdent, runCli } from './e2e-testkit.js'

const SQL =
  "SELECT toUInt64(18446744073709551615) AS u64max, toInt64(-9223372036854775808) AS i64min, " +
  "toUInt64(9007199254740993) AS above_2_53, " +
  "toInt128('170141183460469231731687303715884105727') AS i128, " +
  "toUInt256('115792089237316195423570985008687907853269984665640564039457584007913129639935') AS u256, " +
  "toDecimal128('12345678901234567890.123456789', 9) AS d128, " +
  "[toUInt64(18446744073709551615), 1] AS arr_u64, toNullable(toDecimal64('-12.345', 3)) AS nd, " +
  'toUInt32(7) AS u32'

const EXACT = {
  u64max: '18446744073709551615',
  i64min: '-9223372036854775808',
  above_2_53: '9007199254740993',
  i128: '170141183460469231731687303715884105727',
  u256: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
  d128: '12345678901234567890.123456789',
  arr_u64: ['18446744073709551615', '1'],
  nd: '-12.345',
}

async function writeConfig(dir: string): Promise<string> {
  const { clickhouseUrl, clickhouseUser, clickhousePassword, clickhouseDatabase } = getLiveEnv()
  const configPath = join(dir, 'clickhouse.config.ts')
  await writeFile(
    configPath,
    `export default {\n` +
      `  schema: '${join(dir, 'schema.ts')}',\n` +
      `  outDir: '${join(dir, 'chkit')}',\n` +
      `  migrationsDir: '${join(dir, 'chkit/migrations')}',\n` +
      `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
      `  clickhouse: {\n` +
      `    url: '${clickhouseUrl}',\n` +
      `    username: '${clickhouseUser}',\n` +
      `    password: '${clickhousePassword}',\n` +
      `    database: '${clickhouseDatabase}',\n` +
      `  },\n}\n`,
    'utf8',
  )
  return configPath
}

// ClickHouse writes these as bare JSON numbers, and JSON.parse rounds them to
// a double (#381).
describe('@chkit/cli query precision e2e', () => {
  test('--json prints 64-bit and wider integers and Decimals as exact strings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-query-precision-'))
    try {
      const configPath = await writeConfig(dir)
      const result = runCli(dir, ['query', SQL, '--json', '--config', configPath], {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
      })
      expect(result.exitCode, formatTestDiagnostic('query --json failed', result)).toBe(0)
      const payload = JSON.parse(result.stdout) as { data: Array<Record<string, unknown>> }
      // Narrower integers stay JSON numbers.
      expect(payload.data).toEqual([{ ...EXACT, u32: 7 }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('the table output prints every digit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-query-precision-'))
    try {
      const configPath = await writeConfig(dir)
      const result = runCli(dir, ['query', SQL, '--config', configPath], {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
      })
      expect(result.exitCode, formatTestDiagnostic('query failed', result)).toBe(0)
      const [, , values] = result.stdout.split('\n')
      // Every digit, without quotes; an array prints as compact JSON, as in --json.
      expect(values?.split('│').map((cell) => cell.trim())).toEqual([
        ...Object.values(EXACT).map((value) => (typeof value === 'string' ? value : JSON.stringify(value))),
        '7',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a statement without a result set prints no rows, as before queryJson read the table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-query-precision-'))
    try {
      const configPath = await writeConfig(dir)
      const sql = `DROP TABLE IF EXISTS ${quoteIdent(getLiveEnv().clickhouseDatabase)}.${quoteIdent(`${createPrefix('noresult')}t`)}`
      const isolatedEnv = { HOME: dir, XDG_CONFIG_HOME: dir }

      const table = runCli(dir, ['query', sql, '--config', configPath], isolatedEnv)
      const json = runCli(dir, ['query', sql, '--json', '--config', configPath], isolatedEnv)

      expect(table.exitCode, formatTestDiagnostic('query failed', table)).toBe(0)
      expect(table.stdout.trim()).toBe('(no rows)')
      expect(json.exitCode, formatTestDiagnostic('query --json failed', json)).toBe(0)
      expect(JSON.parse(json.stdout)).toEqual({ data: [], meta: [], rows: 0, query_id: expect.any(String) })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
