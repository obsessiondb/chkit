import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderQualifiedName } from '@chkit/core'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getRequiredEnv,
  pollUntil,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForDictionary,
  waitForTable,
  waitForView,
} from './e2e-testkit.js'

/**
 * Objects whose names sort against their dependencies (#231), so the old
 * kind-then-name order fails at the steps ClickHouse validates:
 * - a_top → b_mid → c_base → events: stacked views. b_mid reads c_base
 *   unqualified; ClickHouse resolves that against the session database, which
 *   is the database these objects live in. Key order fails at b_mid → c_base.
 *   b_mid's digit-led name sorts it before a_top, so a_top → b_mid stays
 *   ordered only if the lexer reads `1…b_mid` as a name.
 * - a_mv_reader → m_mv (TO counts): a view reading a materialized view.
 * - a_named → d and a_events → d: a view calling dictGet, and a column
 *   DEFAULT dictGet, on a dictionary created in the same migration; d reads
 *   src through a CLICKHOUSE(TABLE … DB …) source.
 * - a_named_ident → d: dictGet naming the dictionary by a bare identifier,
 *   which ClickHouse resolves against the session database.
 * Creating the view and the table does not load the dictionary, so the test
 * needs no connection details for its source.
 */
function renderSchema(input: {
  database: string
  prefix: string
  baseFilter: string
  midFilter: string
  withDictionary: boolean
}): string {
  const db = input.database
  const n = (name: string) => objectName(input.prefix, name)
  const dictionaryObjects = input.withDictionary
    ? `const src = table({ database: '${db}', name: '${n('src')}', columns: [{ name: 'id', type: 'UInt64' }, { name: 'name', type: 'String' }], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] })\n` +
      `const d = dictionary({ database: '${db}', name: '${n('d')}', attributes: [{ name: 'id', type: 'UInt64' }, { name: 'name', type: 'String' }], primaryKey: ['id'], source: "CLICKHOUSE(TABLE '${n('src')}' DB '${db}')", layout: 'FLAT()', lifetime: '0' })\n` +
      `const aEvents = table({ database: '${db}', name: '${n('a_events')}', columns: [{ name: 'id', type: 'UInt64' }, { name: 'name', type: 'String', default: "fn:dictGet('${db}.${n('d')}', 'name', id)" }], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] })\n` +
      `const aNamed = view({ database: '${db}', name: '${n('a_named')}', as: "SELECT id, dictGet('${db}.${n('d')}', 'name', id) AS name FROM ${db}.${n('events')}" })\n` +
      `const aNamedIdent = view({ database: '${db}', name: '${n('a_named_ident')}', as: "SELECT id, dictGet(${n('d')}, 'name', id) AS name FROM ${db}.${n('events')}" })\n`
    : ''
  const dictionaryExports = input.withDictionary ? ', src, d, aEvents, aNamed, aNamedIdent' : ''
  return (
    `import { dictionary, materializedView, schema, table, view } from '${CORE_ENTRY}'\n\n` +
    `const events = table({ database: '${db}', name: '${n('events')}', columns: [{ name: 'id', type: 'UInt64' }, { name: 'kind', type: 'String' }], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] })\n` +
    `const counts = table({ database: '${db}', name: '${n('counts')}', columns: [{ name: 'kind', type: 'String' }, { name: 'n', type: 'UInt64' }], engine: 'MergeTree()', primaryKey: ['kind'], orderBy: ['kind'] })\n` +
    `const cBase = view({ database: '${db}', name: '${n('c_base')}', as: "SELECT id, kind FROM ${db}.${n('events')} WHERE ${input.baseFilter}" })\n` +
    `const bMid = view({ database: '${db}', name: '${n('b_mid')}', as: "SELECT id, kind FROM ${n('c_base')} WHERE ${input.midFilter}" })\n` +
    `const aTop = view({ database: '${db}', name: '${n('a_top')}', as: "SELECT count() AS n FROM ${db}.${n('b_mid')}" })\n` +
    `const mMv = materializedView({ database: '${db}', name: '${n('m_mv')}', to: { database: '${db}', name: '${n('counts')}' }, as: "SELECT kind, count() AS n FROM ${db}.${n('events')} GROUP BY kind" })\n` +
    `const aMvReader = view({ database: '${db}', name: '${n('a_mv_reader')}', as: "SELECT kind, n FROM ${db}.${n('m_mv')}" })\n` +
    dictionaryObjects +
    `\nexport default schema(events, counts, cBase, bMid, aTop, mMv, aMvReader${dictionaryExports})\n`
  )
}

// b_mid's name starts with a digit (`1chkit_e2e_…`). ClickHouse reads that as
// a name, and a_top must still be created after it.
function objectName(prefix: string, name: string): string {
  return name === 'b_mid' ? `1${prefix}${name}` : `${prefix}${name}`
}

function expectInOrder(sql: string, statements: string[]): void {
  const positions = statements.map((statement) => sql.indexOf(statement))
  expect(statements.filter((_, index) => positions[index] === -1)).toEqual([])
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
}

describe('@chkit/cli migrate dependency order e2e (#231)', () => {
  test(
    'creates and drops views, materialized views, dictionaries and dictGet defaults in dependency order',
    async () => {
      const liveEnv = getRequiredEnv()
      const executor = createLiveExecutor(liveEnv)
      const db = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('deporder')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
      const p = createPrefix('deporder')
      const dir = await mkdtemp(join(tmpdir(), 'chkit-deporder-e2e-'))
      const configPath = join(dir, 'clickhouse.config.ts')
      const schemaPath = join(dir, 'schema.ts')
      const migrationsDir = join(dir, 'chkit/migrations')
      const n = (name: string) => objectName(p, name)
      const object = (name: string) => `${quoteIdent(db)}.${quoteIdent(n(name))}`
      // Generated DDL backtick-quotes names that are not plain identifiers,
      // such as the digit-led b_mid.
      const rendered = (name: string) => renderQualifiedName(db, n(name))
      const createView = (name: string) => `CREATE VIEW IF NOT EXISTS ${rendered(name)} AS`
      const createDictionary = `CREATE DICTIONARY IF NOT EXISTS ${rendered('d')}\n`
      const countRows = async (sql: string) => Number((await executor.query<{ n: string }>(sql))[0]?.n ?? -1)

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

        // 1. Initial create: every object lands after the objects it reads.
        await writeFile(
          schemaPath,
          renderSchema({ database: db, prefix: p, baseFilter: 'id > 0', midFilter: 'id > 0', withDictionary: true }),
          'utf8'
        )
        const genInit = runCli(
          dir,
          ['generate', '--config', configPath, '--name', 'init', '--migration-id', '20990101000000', '--json'],
          cliEnv
        )
        if (genInit.exitCode !== 0) throw new Error(formatTestDiagnostic('generate (init) failed', genInit))
        const initSql = await readFile(join(migrationsDir, '20990101000000_init.sql'), 'utf8')
        expectInOrder(initSql, [createView('c_base'), createView('b_mid'), createView('a_top')])
        expectInOrder(initSql, [`CREATE MATERIALIZED VIEW IF NOT EXISTS ${rendered('m_mv')} TO`, createView('a_mv_reader')])
        expectInOrder(initSql, [createDictionary, `CREATE TABLE IF NOT EXISTS ${rendered('a_events')}\n`])
        expectInOrder(initSql, [createDictionary, createView('a_named')])
        expectInOrder(initSql, [createDictionary, createView('a_named_ident')])

        const migrateInit = await runCliWithRetry(dir, ['migrate', '--config', configPath, '--execute', '--json'], {
          extraEnv: cliEnv,
        })
        if (migrateInit.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute (init) failed', migrateInit))
        }
        await waitForView(executor, db, n('a_top'))
        await waitForView(executor, db, n('a_mv_reader'))
        await waitForView(executor, db, n('a_named'))
        await waitForView(executor, db, n('a_named_ident'))
        await waitForDictionary(executor, db, n('d'))
        await waitForTable(executor, db, n('a_events'))

        await executor.command(`INSERT INTO ${object('events')} (id, kind) VALUES (1, 'a'), (2, 'b'), (3, 'b')`)
        const readTop = () => countRows(`SELECT n FROM ${object('a_top')}`)
        expect(await pollUntil(readTop, (count) => count === 3)).toBe(3)
        const readMvKinds = () => countRows(`SELECT count() AS n FROM ${object('a_mv_reader')}`)
        expect(await pollUntil(readMvKinds, (count) => count === 2)).toBe(2)

        // 2. Change the base view and the view that reads it, and remove the
        // dictionary with everything around it. ClickHouse refuses to drop a
        // dictionary while a column default calls it, and a table while a
        // dictionary sources from it; the base view must exist again before
        // its reader is recreated. (View drops are never blocked, so their
        // relative order is not asserted.)
        await writeFile(
          schemaPath,
          renderSchema({ database: db, prefix: p, baseFilter: "kind != 'skip'", midFilter: 'id > 1', withDictionary: false }),
          'utf8'
        )
        const genRestack = runCli(
          dir,
          ['generate', '--config', configPath, '--name', 'restack', '--migration-id', '20990101000001', '--json'],
          cliEnv
        )
        if (genRestack.exitCode !== 0) throw new Error(formatTestDiagnostic('generate (restack) failed', genRestack))
        const restackSql = await readFile(join(migrationsDir, '20990101000001_restack.sql'), 'utf8')
        expectInOrder(restackSql, [
          `DROP TABLE IF EXISTS ${rendered('a_events')};`,
          `DROP DICTIONARY IF EXISTS ${rendered('d')};`,
          `DROP TABLE IF EXISTS ${rendered('src')};`,
          createView('c_base'),
          createView('b_mid'),
        ])

        const migrateRestack = await runCliWithRetry(
          dir,
          ['migrate', '--config', configPath, '--execute', '--allow-destructive', '--json'],
          { extraEnv: cliEnv }
        )
        if (migrateRestack.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute (restack) failed', migrateRestack))
        }
        await waitForView(executor, db, n('b_mid'))
        expect(await pollUntil(readTop, (count) => count === 2)).toBe(2)
        const removed = ['a_events', 'd', 'src', 'a_named', 'a_named_ident'].map((name) => `'${n(name)}'`).join(', ')
        const readRemoved = () =>
          countRows(`SELECT count() AS n FROM system.tables WHERE database = '${db}' AND name IN (${removed})`)
        expect(await pollUntil(readRemoved, (count) => count === 0)).toBe(0)
      } finally {
        for (const name of ['a_named', 'a_named_ident', 'a_mv_reader', 'a_top', 'b_mid', 'c_base']) {
          await executor.command(`DROP VIEW IF EXISTS ${object(name)}`)
        }
        await executor.command(`DROP TABLE IF EXISTS ${object('m_mv')} SYNC`)
        await executor.command(`DROP TABLE IF EXISTS ${object('a_events')}`)
        await executor.command(`DROP DICTIONARY IF EXISTS ${object('d')}`)
        for (const name of ['src', 'counts', 'events']) {
          await executor.command(`DROP TABLE IF EXISTS ${object(name)}`)
        }
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(db)}.${quoteIdent(journalTable)}`)
        await executor.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
    240_000
  )
})
