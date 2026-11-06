import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CORE_ENTRY, createJournalTableName, createPrefix, formatTestDiagnostic, getLiveEnv, runCli } from './e2e-testkit.js'

describe('@chkit/cli quoted string defaults', () => {
  test('generate and check warn about a plain string default written as a SQL literal, without failing', async () => {
    const env = getLiveEnv()
    const dir = await mkdtemp(join(tmpdir(), 'chkit-quoted-default-'))
    const prefix = createPrefix('quoted_default')
    const table = `${env.clickhouseDatabase}.${prefix}plans`
    const dictionary = `${env.clickhouseDatabase}.${prefix}plans_dict`
    const configPath = join(dir, 'clickhouse.config.ts')
    const cliEnv = { CHKIT_JOURNAL_TABLE: createJournalTableName('quoted_default') }
    await writeFile(join(dir, 'schema.ts'), `import { dictionary, schema, table } from '${CORE_ENTRY}'

const plans = table({
  database: '${env.clickhouseDatabase}',
  name: '${prefix}plans',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'tier', type: 'String', default: "'standard'" },
    { name: 'label', type: 'String', default: 'standard' },
    { name: 'code', type: 'String', default: { expression: "'standard'" } },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})

const plansDict = dictionary({
  database: '${env.clickhouseDatabase}',
  name: '${prefix}plans_dict',
  attributes: [
    { name: 'id', type: 'UInt64' },
    { name: 'tier', type: 'String', default: "'standard'" },
    { name: 'label', type: 'String', default: 'standard' },
  ],
  primaryKey: ['id'],
  source: "CLICKHOUSE(TABLE '${prefix}plans')",
  layout: 'HASHED()',
  lifetime: '300',
})

export default schema(plans, plansDict)
`, 'utf8')
    await writeFile(configPath, `export default {
  schema: './schema.ts',
  outDir: './chkit',
  clickhouse: {
    url: '${env.clickhouseUrl}',
    username: '${env.clickhouseUser}',
    password: '${env.clickhousePassword}',
    database: '${env.clickhouseDatabase}',
  },
}
`, 'utf8')
    const expected = [
      `Table ${table} column "tier" has plain string default "'standard'", which renders as DEFAULT '''standard''' and keeps the quotes in the value. Use default: "standard" for the value, or default: { expression: "'standard'" } for SQL. If the quotes belong to the value, ignore this warning.`,
      `Dictionary ${dictionary} attribute "tier" has plain string default "'standard'", which renders as DEFAULT '''standard''' and keeps the quotes in the value. Use default: "standard" for the value; dictionary defaults are literals only. If the quotes belong to the value, ignore this warning.`,
    ]
    try {
      const generate = runCli(dir, ['generate', '--config', configPath, '--name', 'init', '--json'], cliEnv)
      expect(generate.exitCode, formatTestDiagnostic('generate --json', generate)).toBe(0)
      const generated = JSON.parse(generate.stdout) as { migrationFile: string | null; warnings: string[] }
      expect(generated.migrationFile).toBeTruthy()
      expect(generated.warnings).toEqual(expected)

      const check = runCli(dir, ['check', '--config', configPath, '--json'], cliEnv)
      const checked = JSON.parse(check.stdout) as { warnings: string[] }
      expect(checked.warnings, formatTestDiagnostic('check --json', check)).toEqual(expected)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
