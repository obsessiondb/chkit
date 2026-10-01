import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getRequiredEnv,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForTable,
} from './e2e-testkit.js'

// Names a CDC source catalog (e.g. Postgres) may legally contain. Each one
// breaks unescaped SQL or naive parsing: parens and commas in the table name,
// spaces, escaped backticks, and a comma inside a key column.
function renderSchema(database: string, tableName: string): string {
  const definition = {
    database,
    name: tableName,
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 'a b', type: 'String' },
      { name: 'c`d', type: 'String' },
      { name: 'e,f)', type: 'UInt8' },
    ],
    engine: 'MergeTree()',
    primaryKey: ['id', 'a b'],
    orderBy: ['id', 'a b', 'c`d', 'e,f)'],
    indexes: [{ name: 'i x', expression: '`a b`', type: 'minmax', granularity: 1 }],
    projections: [{ name: 'p`q', query: 'SELECT `a b` ORDER BY `c\\`d`' }],
  }
  return (
    `import { schema, table } from '${CORE_ENTRY}'\n\n` +
    `export default schema(table(${JSON.stringify(definition, null, 2)}))\n`
  )
}

describe('@chkit/cli quoted identifiers e2e', () => {
  const liveEnv = getRequiredEnv()

  test(
    'generate -> migrate -> drift round-trips names that need quoting',
    async () => {
      const executor = createLiveExecutor(liveEnv)
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('quoted_ident')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const tableName = `${createPrefix('quoted_ident')}we\`ird(x) na,me`
      const dir = await mkdtemp(join(tmpdir(), 'chkit-cli-quoted-ident-e2e-'))
      const schemaPath = join(dir, 'schema.ts')
      const configPath = join(dir, 'clickhouse.config.ts')
      const outDir = join(dir, 'chkit')

      await writeFile(schemaPath, renderSchema(database, tableName), 'utf8')
      await writeFile(
        configPath,
        `export default ${JSON.stringify(
          {
            schema: schemaPath,
            outDir,
            migrationsDir: join(outDir, 'migrations'),
            metaDir: join(outDir, 'meta'),
            clickhouse: {
              url: liveEnv.clickhouseUrl,
              username: liveEnv.clickhouseUser,
              password: liveEnv.clickhousePassword,
              database,
            },
          },
          null,
          2
        )}\n`,
        'utf8'
      )

      try {
        const generated = runCli(dir, ['generate', '--config', configPath, '--json'], cliEnv)
        if (generated.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('generate failed', generated))
        }

        const executed = await runCliWithRetry(
          dir,
          ['migrate', '--config', configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (executed.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute failed', executed))
        }

        await waitForTable(executor, database, tableName)

        const drift = runCli(dir, ['drift', '--config', configPath, '--json'], cliEnv)
        if (drift.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('drift failed', drift))
        }
        const payload = JSON.parse(drift.stdout) as {
          drifted: boolean
          tableDrift: Array<{ table: string; reasonCodes: string[] }>
        }
        expect(payload.tableDrift).toEqual([])
        expect(payload.drifted).toBe(false)
      } finally {
        await rm(dir, { recursive: true, force: true })
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(tableName)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )
})
