import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalizeDefinitions,
  planDiff,
  table,
  toCreateSQL,
  type TableDefinition,
  type TextSkipIndex,
} from '@chkit/core'
import { renderSchemaFile } from '../../../plugin-pull/src/render-schema.js'
import fixtures from '../../../../test/fixtures/text-index.json'
import { compareTableShape } from '../commands/drift/compare.js'
import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getRequiredEnv,
  runCli,
  runCliWithRetry,
  waitForTable,
} from './e2e-testkit.js'

const env = getRequiredEnv()
const docs = (name: string, index: TextSkipIndex): TableDefinition =>
  table({
    database: env.clickhouseDatabase,
    name,
    engine: 'MergeTree()',
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 'body', type: 'String' },
    ],
    primaryKey: ['id'],
    orderBy: ['id'],
    indexes: [index],
  })

async function loadPulled(definition: TableDefinition, dir: string): Promise<TableDefinition> {
  const path = join(dir, `${definition.name}.ts`)
  await writeFile(
    path,
    renderSchemaFile([definition]).replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)),
  )
  return (await import(path)).default[0]
}

describe('text index live round trips', () => {
  for (const { name: label, ...params } of fixtures) {
    test(label, async () => {
      const executor = createLiveExecutor(env)
      const name = `${createPrefix('text')}docs`
      const index: TextSkipIndex = {
        name: 'idx',
        expression: 'body',
        type: 'text',
        granularity: 1,
        ...params,
      }
      const definition = docs(name, index)
      const fullName = `${definition.database}.${name}`
      const cloneName = `${name}_clone`
      const dir = await mkdtemp(join(tmpdir(), 'chkit-text-pull-'))
      try {
        // Start from SQL exactly as a user wrote it, independently of our renderer.
        await executor.command(
          `CREATE TABLE ${fullName} (id UInt64, body String, INDEX idx (${index.expression}) TYPE text(tokenizer = ${index.tokenizer}${index.preprocessor ? `, preprocessor = ${index.preprocessor}` : ''}) GRANULARITY 1) ENGINE=MergeTree ORDER BY id`,
        )
        await waitForTable(executor, definition.database, name)
        await executor.command(
          `INSERT INTO ${fullName} VALUES (1, 'alpha  beta gamma'), (2, 'alpha beta gamma'), (3, 'alpha'), (4, 'é東京😀'), (5, 'a,b=c')`,
        )
        const actual = (await executor.listTableDetails([definition.database])).find(
          (item) => item.name === name,
        )
        if (!actual) throw new Error('Missing test table')
        expect(compareTableShape(definition, actual)).toBeNull()
        expect(actual.indexes[0]?.granularity).toBe(100000000)
        const pulled = await loadPulled({ ...definition, indexes: actual.indexes }, dir)
        expect(planDiff([definition], [pulled]).operations).toEqual([])
        await executor.command(toCreateSQL({ ...pulled, name: cloneName }))
        await executor.command(
          `INSERT INTO ${definition.database}.${cloneName} SELECT * FROM ${fullName}`,
        )
        const query = (target: string) =>
          executor.query<{ id: number }>(
            `SELECT id FROM ${target} WHERE hasAllTokens(${index.expression}, ['alpha']) ORDER BY id`,
          )
        const original = await query(fullName)
        expect(await query(`${definition.database}.${cloneName}`)).toEqual(original)
        if (label === 'two spaces') expect(original.map((row) => Number(row.id))).toEqual([1, 3])
      } finally {
        await executor.command(`DROP TABLE IF EXISTS ${fullName} SYNC`)
        await executor.command(`DROP TABLE IF EXISTS ${definition.database}.${cloneName} SYNC`)
        await executor.close()
        await rm(dir, { recursive: true, force: true })
      }
    }, 60000)
  }

  test('generate, migrate, drift, change tokenizer, and migrate again', async () => {
    const executor = createLiveExecutor(env)
    const name = `${createPrefix('text_cli')}docs`
    const definition = docs(name, {
      name: 'idx',
      type: 'text',
      expression: 'body',
      tokenizer: "splitByString(['  '])",
      granularity: 1,
    })
    const dir = await mkdtemp(join(tmpdir(), 'chkit-text-cli-'))
    const schemaPath = join(dir, 'schema.ts')
    const configPath = join(dir, 'clickhouse.config.ts')
    const journal = createJournalTableName('text_index')
    const extraEnv = { CHKIT_JOURNAL_TABLE: journal }
    const command = (args: string[]) => {
      const result = runCli(dir, [...args, '--config', configPath, '--json'], extraEnv)
      if (result.exitCode !== 0) throw new Error(formatTestDiagnostic(args.join(' '), result))
      return JSON.parse(result.stdout)
    }
    try {
      await writeFile(
        configPath,
        `export default ${JSON.stringify({ schema: schemaPath, outDir: join(dir, 'chkit'), migrationsDir: join(dir, 'chkit/migrations'), metaDir: join(dir, 'chkit/meta'), clickhouse: { url: env.clickhouseUrl, username: env.clickhouseUser, password: env.clickhousePassword, database: env.clickhouseDatabase } })}`,
      )
      const writeSchema = async (value: TableDefinition) =>
        writeFile(
          schemaPath,
          renderSchemaFile([value]).replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)),
        )
      const migrate = async () => {
        const result = await runCliWithRetry(
          dir,
          ['migrate', '--execute', '--config', configPath, '--json'],
          { extraEnv },
        )
        if (result.exitCode !== 0) throw new Error(formatTestDiagnostic('migrate', result))
      }
      await writeSchema(definition)
      command(['generate'])
      await migrate()
      await waitForTable(executor, definition.database, name)
      expect(command(['drift', '--table', `${definition.database}.${name}`]).drifted).toBe(false)
      const changed = {
        ...definition,
        indexes: [
          {
            ...definition.indexes?.[0],
            tokenizer: "splitByString([' '])",
          } as TextSkipIndex,
        ],
      }
      expect(planDiff([definition], [changed]).operations).toHaveLength(2)
      await writeSchema(changed)
      command(['generate'])
      await migrate()
      expect(command(['drift', '--table', `${definition.database}.${name}`]).drifted).toBe(false)
      const actual = (await executor.listTableDetails([definition.database])).find(
        (item) => item.name === name,
      )
      if (!actual) throw new Error('Missing test table')
      expect(compareTableShape(definition, actual)?.reasonCodes).toContain('index_mismatch')
      expect(compareTableShape(changed, actual)).toBeNull()
      expect(canonicalizeDefinitions([changed])).not.toEqual(canonicalizeDefinitions([definition]))
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${definition.database}.${name} SYNC`)
      await executor.command(`DROP TABLE IF EXISTS ${definition.database}.${journal} SYNC`)
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120000)
})

test('text index tuning, newer options, and materializing existing rows', async () => {
  const executor = createLiveExecutor(env)
  const name = `${createPrefix('text_options')}docs`
  const [{ version }] = await executor.query<{ version: string }>('SELECT version() AS version')
  const [major, minor] = version.split('.').map(Number)
  const newerOptions = major > 26 || (major === 26 && minor >= 8)
  const index: TextSkipIndex = {
    name: 'idx',
    expression: 'body',
    type: 'text',
    tokenizer: 'splitByNonAlpha',
    dictionaryBlockSize: 512,
    dictionaryBlockFrontcodingCompression: false,
    postingListBlockSize: 1024,
    postingListCodec: 'bitpacking',
    ...(newerOptions ? { postprocessor: 'lower(body)', supportPhraseSearch: true } : {}),
  }
  const definition = {
    ...docs(name, index),
    ...(newerOptions ? { settings: { allow_experimental_text_index_phrase_search: 1 } } : {}),
  }
  const fullName = `${definition.database}.${name}`
  const dir = await mkdtemp(join(tmpdir(), 'chkit-text-options-'))
  try {
    await executor.command(toCreateSQL({ ...definition, indexes: [] }))
    await executor.command(
      `INSERT INTO ${fullName} VALUES (1, 'hello world'), (2, 'goodbye world')`,
    )
    for (const op of planDiff([{ ...definition, indexes: [] }], [definition]).operations)
      await executor.command(op.sql)
    await executor.command(
      `ALTER TABLE ${fullName} MATERIALIZE INDEX idx SETTINGS mutations_sync = 2`,
    )
    const actual = (await executor.listTableDetails([definition.database])).find(
      (item) => item.name === name,
    )
    if (!actual) throw new Error('Missing test table')
    expect(compareTableShape(definition, actual)).toBeNull()
    const pulled = await loadPulled({ ...definition, indexes: actual.indexes }, dir)
    expect(planDiff([definition], [pulled]).operations).toEqual([])
    const fn = newerOptions ? "hasPhrase(body, 'hello world')" : "hasAllTokens(body, ['hello'])"
    expect(
      (await executor.query<{ id: number }>(`SELECT id FROM ${fullName} WHERE ${fn}`)).map((row) =>
        Number(row.id),
      ),
    ).toEqual([1])
  } finally {
    await executor.command(`DROP TABLE IF EXISTS ${fullName} SYNC`)
    await executor.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)

test('normalization preserves every printable ClickHouse string escape', async () => {
  const { normalizeTextIndexSQL } = await import('@chkit/core')
  const executor = createLiveExecutor(env)
  try {
    for (let code = 32; code < 127; code++) {
      const sql = `'\\${String.fromCharCode(code)}'`
      if (code === 120) {
        expect(() => normalizeTextIndexSQL(sql)).toThrow('Invalid hexadecimal')
        continue
      }
      const rows = await executor.query<{ original: string; normalized: string }>(
        `SELECT hex(${sql}) AS original, hex(${normalizeTextIndexSQL(sql)}) AS normalized`,
      )
      expect(rows[0]?.normalized, `escape ${JSON.stringify(sql)}`).toBe(rows[0]?.original)
    }
  } finally {
    await executor.close()
  }
})
