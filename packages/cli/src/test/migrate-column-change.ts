import { expect } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForTable,
} from './e2e-testkit.js'

export function expectInOrder(sql: string, statements: string[]): void {
  const positions = statements.map((statement) => sql.indexOf(statement))
  expect(statements.filter((_, index) => positions[index] === -1)).toEqual([])
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
}

/**
 * Generates and migrates a change of one table's columns, then checks the
 * migration order and the columns ClickHouse ends with. `before` and `after`
 * are the column entries after `id`, `beforeTtl` and `afterTtl` the table
 * TTL; `rename` is a `from=to` column rename.
 */
export async function migrateColumnChange(input: {
  label: string
  before: string
  after: string
  beforeTtl?: string
  afterTtl?: string
  rename?: string
  order: string[]
  columns: string[]
}): Promise<void> {
  const liveEnv = getLiveEnv()
  const executor = createLiveExecutor(liveEnv)
  const db = liveEnv.clickhouseDatabase
  const journalTable = createJournalTableName(input.label)
  const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
  const name = `${createPrefix(input.label)}t`
  const dir = await mkdtemp(join(tmpdir(), `chkit-${input.label}-e2e-`))
  const configPath = join(dir, 'clickhouse.config.ts')
  const schemaPath = join(dir, 'schema.ts')
  const migrationsDir = join(dir, 'chkit/migrations')
  const writeSchema = (columns: string, ttl: string | undefined) =>
    writeFile(
      schemaPath,
      `import { schema, table } from '${CORE_ENTRY}'\n\n` +
        `export default schema(table({ database: '${db}', name: '${name}', columns: [{ name: 'id', type: 'UInt64' }, ${columns}], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id']${ttl === undefined ? '' : `, ttl: ${JSON.stringify(ttl)}`} }))\n`,
      'utf8'
    )
  const generateAndMigrate = async (step: string, migrationId: string, extraArgs: string[]) => {
    const generated = runCli(
      dir,
      ['generate', '--config', configPath, '--name', step, '--migration-id', migrationId, ...extraArgs, '--json'],
      cliEnv
    )
    if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic(`generate (${step}) failed`, generated))
    const migrated = await runCliWithRetry(
      dir,
      ['migrate', '--config', configPath, '--execute', '--allow-destructive', '--json'],
      { extraEnv: cliEnv }
    )
    if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic(`migrate --execute (${step}) failed`, migrated))
    return readFile(join(migrationsDir, `${migrationId}_${step}.sql`), 'utf8')
  }
  const readColumns = async () =>
    (
      await executor.query<{ name: string }>(
        `SELECT name FROM system.columns WHERE database = '${db}' AND table = '${name}' ORDER BY name`
      )
    ).map((row) => row.name)

  try {
    await writeFile(
      configPath,
      `export default {\n` +
        `  schema: '${schemaPath}',\n` +
        `  outDir: '${join(dir, 'chkit')}',\n` +
        `  migrationsDir: '${migrationsDir}',\n` +
        `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
        `  clickhouse: {\n` +
        `    url: '${liveEnv.clickhouseUrl}',\n` +
        `    username: '${liveEnv.clickhouseUser}',\n` +
        `    password: '${liveEnv.clickhousePassword}',\n` +
        `    database: '${db}',\n` +
        `  },\n}\n`,
      'utf8'
    )
    await writeSchema(input.before, input.beforeTtl)
    await generateAndMigrate('init', '20990101000000', [])
    await waitForTable(executor, db, name)

    await writeSchema(input.after, input.afterTtl)
    const sql = await generateAndMigrate(
      'change',
      '20990101000001',
      input.rename === undefined ? [] : ['--rename-column', `${db}.${name}.${input.rename}`]
    )
    expectInOrder(sql, input.order)
    const expected = [...input.columns].sort()
    expect(await pollUntil(readColumns, (columns) => columns.join() === expected.join())).toEqual(expected)
  } finally {
    await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(db)}.${quoteIdent(name)}`)
    await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(db)}.${quoteIdent(journalTable)}`)
    await executor.close()
    await rm(dir, { recursive: true, force: true })
  }
}
