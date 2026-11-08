import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import fixture from '../../../../test/fixtures/sql-splitter.json'
import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  runCli,
} from './e2e-testkit.js'

// chkit-py runs the same migration in tests/test_migrate_statements_e2e.py and
// must hand onBeforeApply the same statements (#486).
describe('@chkit/cli migrate statements e2e (#486)', () => {
  test('onBeforeApply gets the statements of the shared fixture, and they keep their meaning', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const table = `${createPrefix('stmts')}t`
    const journalTable = createJournalTableName('stmts')
    const render = (text: string): string =>
      text.replaceAll('{database}', database).replaceAll('{table}', table)
    const dir = await mkdtemp(join(tmpdir(), 'chkit-stmts-e2e-'))
    const migrationsDir = join(dir, 'chkit/migrations')
    const statementsPath = join(dir, 'statements.json')
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      await mkdir(migrationsDir, { recursive: true })
      await writeFile(join(migrationsDir, '20990101000000_statements.sql'), render(fixture.migration.sql), 'utf8')
      await writeFile(
        join(dir, 'probe-plugin.ts'),
        `import { writeFileSync } from 'node:fs'\n\n` +
          `export const plugin = {\n` +
          `  manifest: { name: 'probe', apiVersion: 1 },\n` +
          `  hooks: {\n` +
          `    onBeforeApply({ statements }: { statements: string[] }) {\n` +
          `      writeFileSync(${JSON.stringify(statementsPath)}, JSON.stringify(statements))\n` +
          `    },\n` +
          `  },\n` +
          `}\n`,
        'utf8',
      )
      await writeFile(
        configPath,
        `import { plugin } from './probe-plugin.ts'\n\n` +
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
          `  },\n` +
          `  plugins: [{ plugin }],\n` +
          `}\n`,
        'utf8',
      )

      const result = runCli(dir, ['migrate', '--config', configPath, '--apply', '--json'], {
        CHKIT_JOURNAL_TABLE: journalTable,
      })
      expect(result.exitCode, formatTestDiagnostic('migrate --apply failed', result)).toBe(0)

      expect(JSON.parse(await readFile(statementsPath, 'utf8'))).toEqual(
        fixture.migration.statements.map(render),
      )

      // The strings, the heredoc and the quoted name reached ClickHouse whole.
      const target = `${quoteIdent(database)}.${quoteIdent(table)}`
      await executor.command(`INSERT INTO ${target} (id) VALUES (1)`)
      const rows = await pollUntil(
        () => executor.query<Record<string, string>>(`SELECT note, \`odd\\\`--;name\` AS odd, extra FROM ${target}`),
        (found) => found.length === 1,
      )
      expect(rows).toEqual([
        { note: "a -- b; it's 'c'", odd: ' -- not a comment; still the string ', extra: 'semi;colon' },
      ])
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(table)}`).catch(() => {})
      await executor
        .command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        .catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
