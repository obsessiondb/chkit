import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractExecutableStatements } from '@chkit/core'

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
  waitForColumn,
  waitForRows,
  waitForTable,
} from './e2e-testkit.js'

// `seen_at` and `day` are not the last column: rendered with its comment, the
// `--` would swallow the comma before the next column and the CREATE would fail.
// `day` is a MATERIALIZED column (#216) written in the same { expression } form.
const CREATE_COLUMNS = [
  "{ name: 'id', type: 'UInt64' }",
  `{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: { expression: 'now64(3)' } }`,
  "{ name: 'day', type: 'Date', defaultKind: 'MATERIALIZED', default: { expression: 'toDate(updated_at) -- day of the update' } }",
  "{ name: 'seen_at', type: 'DateTime', nullable: true, default: { expression: 'now() -- set on insert' } }",
  "{ name: 'status', type: 'String', default: 'new' }",
]

// Adds three expression columns, one with a trailing comment that would
// swallow its statement's `;` and one ALIAS, and switches updated_at and day to
// the legacy fn: spelling, which must plan nothing.
const ALTER_COLUMNS = [
  "{ name: 'id', type: 'UInt64' }",
  `{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: 'fn:now64(3)' }`,
  "{ name: 'day', type: 'Date', defaultKind: 'MATERIALIZED', default: 'fn: toDate(updated_at) -- day of the update' }",
  "{ name: 'seen_at', type: 'DateTime', nullable: true, default: { expression: 'now() -- set on insert' } }",
  "{ name: 'status', type: 'String', default: 'new' }",
  "{ name: 'added_at', type: 'DateTime', default: { expression: 'now() -- added later' } }",
  "{ name: 'added_n', type: 'UInt8', default: { expression: 'toUInt8(1)' } }",
  "{ name: 'label', type: 'String', defaultKind: 'ALIAS', default: { expression: \"concat('id-', toString(id))\" } }",
]

function renderSchema(database: string, tableName: string, columns: string[]): string {
  return [
    `import { schema, table } from '${CORE_ENTRY}'`,
    '',
    'export default schema(',
    `  table({ database: '${database}', name: '${tableName}', engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'], columns: [`,
    ...columns.map((column) => `    ${column},`),
    '  ] }),',
    ')',
    '',
  ].join('\n')
}

describe('@chkit/cli expression column defaults e2e (#234)', () => {
  const liveEnv = getLiveEnv()

  test(
    '{ expression } defaults of every kind migrate as SQL, fill inserted rows, add columns, and read as no drift',
    async () => {
      const executor = createLiveExecutor(liveEnv)
      const database = liveEnv.clickhouseDatabase
      const tableName = `${createPrefix('expr_default')}events`
      const journalTable = createJournalTableName('expr_default')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
      const object = `${quoteIdent(database)}.${quoteIdent(tableName)}`
      const dir = await mkdtemp(join(tmpdir(), 'chkit-expr-default-e2e-'))
      const configPath = join(dir, 'clickhouse.config.ts')
      const schemaPath = join(dir, 'schema.ts')

      const generate = (args: string[]) => {
        const result = runCli(dir, ['generate', '--config', configPath, ...args, '--json'], cliEnv)
        if (result.exitCode !== 0) throw new Error(formatTestDiagnostic('generate failed', result))
        return result
      }
      const migrate = async () => {
        const result = await runCliWithRetry(dir, ['migrate', '--config', configPath, '--execute', '--json'], {
          extraEnv: cliEnv,
        })
        if (result.exitCode !== 0) throw new Error(formatTestDiagnostic('migrate --execute failed', result))
      }
      const expectNoDrift = () => {
        const result = runCli(dir, ['drift', '--config', configPath, '--table', `${database}.${tableName}`, '--json'], cliEnv)
        if (result.exitCode !== 0) throw new Error(formatTestDiagnostic('drift failed', result))
        const payload = JSON.parse(result.stdout) as { drifted: boolean; tableDrift: unknown[] }
        expect(payload.tableDrift).toEqual([])
        expect(payload.drifted).toBe(false)
      }
      const columnDefaults = (count: number) =>
        waitForRows<{ name: string; default_kind: string; default_expression: string }>(
          executor,
          `SELECT name, default_kind, default_expression FROM system.columns WHERE database = '${database}' AND table = '${tableName}' ORDER BY name`,
          (rows) => rows.length === count,
          'expression default columns'
        )

      try {
        await writeFile(
          configPath,
          `export default {\n` +
            `  schema: '${schemaPath}',\n` +
            `  outDir: '${join(dir, 'chkit')}',\n` +
            `  migrationsDir: '${join(dir, 'chkit/migrations')}',\n` +
            `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
            `  clickhouse: {\n` +
            `    url: '${liveEnv.clickhouseUrl}',\n` +
            `    username: '${liveEnv.clickhouseUser}',\n` +
            `    password: '${liveEnv.clickhousePassword}',\n` +
            `    database: '${database}',\n` +
            `  },\n}\n`,
          'utf8'
        )

        // 1. CREATE TABLE renders each expression as SQL, without its comment.
        await writeFile(schemaPath, renderSchema(database, tableName, CREATE_COLUMNS), 'utf8')
        const created = JSON.parse(generate(['--name', 'expr_default']).stdout) as { migrationFile: string | null }
        expect(created.migrationFile).toBeTruthy()
        const createSql = await readFile(String(created.migrationFile), 'utf8')
        expect(createSql).toContain("`updated_at` DateTime64(3, 'UTC') DEFAULT now64(3),")
        expect(createSql).toContain('`day` Date MATERIALIZED toDate(updated_at),')
        expect(createSql).toContain('`seen_at` Nullable(DateTime) DEFAULT now(),')
        expect(createSql).toContain("`status` String DEFAULT 'new'")
        expect(createSql).not.toContain("DEFAULT 'now64(3)'")
        expect(createSql).not.toContain('set on insert')
        expect(createSql).not.toContain('day of the update')

        await migrate()
        await waitForTable(executor, database, tableName)
        expect(await columnDefaults(5)).toEqual([
          { name: 'day', default_kind: 'MATERIALIZED', default_expression: 'toDate(updated_at)' },
          { name: 'id', default_kind: '', default_expression: '' },
          { name: 'seen_at', default_kind: 'DEFAULT', default_expression: 'now()' },
          { name: 'status', default_kind: 'DEFAULT', default_expression: "'new'" },
          { name: 'updated_at', default_kind: 'DEFAULT', default_expression: 'now64(3)' },
        ])

        // 2. ClickHouse evaluates the expressions: not the epoch, not NULL.
        await executor.command(`INSERT INTO ${object} (id) VALUES (1)`)
        const [inserted] = await waitForRows<{ status: string; seen_set: string; updated_recent: string; day_matches: string }>(
          executor,
          `SELECT status, toString(isNotNull(seen_at)) AS seen_set, toString(updated_at > toDateTime64('2020-01-01 00:00:00', 3, 'UTC')) AS updated_recent, toString(day = toDate(updated_at)) AS day_matches FROM ${object}`,
          (rows) => rows.length === 1,
          'inserted row'
        )
        expect(inserted).toEqual({ status: 'new', seen_set: '1', updated_recent: '1', day_matches: '1' })

        // 3. The snapshot holds fn: strings; the live table matches them.
        expectNoDrift()

        // 4. ADD COLUMN with expression defaults; the spelling switch plans nothing.
        await writeFile(schemaPath, renderSchema(database, tableName, ALTER_COLUMNS), 'utf8')
        const planned = JSON.parse(generate(['--dryrun']).stdout) as { operations: Array<{ type: string; key: string }> }
        expect(planned.operations.map((operation) => [operation.type, operation.key])).toEqual([
          ['alter_table_add_column', `table:${database}.${tableName}:column:added_at`],
          ['alter_table_add_column', `table:${database}.${tableName}:column:added_n`],
          ['alter_table_add_column', `table:${database}.${tableName}:column:label`],
        ])
        const altered = JSON.parse(generate(['--name', 'expr_default_add']).stdout) as { migrationFile: string | null }
        expect(altered.migrationFile).toBeTruthy()
        const alterSql = await readFile(String(altered.migrationFile), 'utf8')
        expect(extractExecutableStatements(alterSql)).toHaveLength(3)
        expect(alterSql).toContain('ADD COLUMN IF NOT EXISTS `added_at` DateTime DEFAULT now();')
        expect(alterSql).toContain("ADD COLUMN IF NOT EXISTS `label` String ALIAS concat('id-', toString(id));")
        expect(alterSql).not.toContain('added later')

        await migrate()
        await waitForColumn(executor, database, tableName, 'added_at')
        await waitForColumn(executor, database, tableName, 'added_n')
        await waitForColumn(executor, database, tableName, 'label')
        expect(await columnDefaults(8)).toEqual([
          { name: 'added_at', default_kind: 'DEFAULT', default_expression: 'now()' },
          { name: 'added_n', default_kind: 'DEFAULT', default_expression: 'toUInt8(1)' },
          { name: 'day', default_kind: 'MATERIALIZED', default_expression: 'toDate(updated_at)' },
          { name: 'id', default_kind: '', default_expression: '' },
          { name: 'label', default_kind: 'ALIAS', default_expression: "concat('id-', toString(id))" },
          { name: 'seen_at', default_kind: 'DEFAULT', default_expression: 'now()' },
          { name: 'status', default_kind: 'DEFAULT', default_expression: "'new'" },
          { name: 'updated_at', default_kind: 'DEFAULT', default_expression: 'now64(3)' },
        ])

        await executor.command(`INSERT INTO ${object} (id) VALUES (2)`)
        const rows = await waitForRows<{ id: string; added_n: string; added_recent: string; label: string }>(
          executor,
          `SELECT toString(id) AS id, toString(added_n) AS added_n, toString(added_at > toDateTime('2020-01-01 00:00:00')) AS added_recent, label FROM ${object} ORDER BY id`,
          (result) => result.length === 2,
          'rows after ADD COLUMN'
        )
        expect(rows).toEqual([
          { id: '1', added_n: '1', added_recent: '1', label: 'id-1' },
          { id: '2', added_n: '1', added_recent: '1', label: 'id-2' },
        ])

        // 5. Still no drift, and the snapshot round-trips with nothing to plan.
        expectNoDrift()
        const replanned = JSON.parse(generate(['--dryrun']).stdout) as { operations: unknown[] }
        expect(replanned.operations).toEqual([])
      } finally {
        await executor.command(`DROP TABLE IF EXISTS ${object}`).catch(() => {})
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`).catch(() => {})
        await executor.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
    240_000
  )
})
