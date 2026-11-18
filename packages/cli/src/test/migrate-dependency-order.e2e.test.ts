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
  getLiveEnv,
  pollUntil,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForColumn,
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
      const liveEnv = getLiveEnv()
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

  // `Total` sorts before `price` by code point, but its DEFAULT reads `price`
  // (#681). ClickHouse rejects the ADD COLUMN of `Total` while `price` is missing.
  test('adds a column before the ADD COLUMN whose DEFAULT reads it', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const db = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('addorder')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
    const orders = `${createPrefix('addorder')}orders`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-addorder-e2e-'))
    const configPath = join(dir, 'clickhouse.config.ts')
    const schemaPath = join(dir, 'schema.ts')
    const migrationsDir = join(dir, 'chkit/migrations')
    const writeSchema = (columns: string) =>
      writeFile(
        schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\n` +
          `export default schema(table({ database: '${db}', name: '${orders}', columns: [{ name: 'id', type: 'UInt64' }${columns}], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] }))\n`,
        'utf8'
      )
    const generateAndMigrate = async (name: string, migrationId: string) => {
      const generated = runCli(
        dir,
        ['generate', '--config', configPath, '--name', name, '--migration-id', migrationId, '--json'],
        cliEnv
      )
      if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic(`generate (${name}) failed`, generated))
      const migrated = await runCliWithRetry(dir, ['migrate', '--config', configPath, '--execute', '--json'], {
        extraEnv: cliEnv,
      })
      if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic(`migrate --execute (${name}) failed`, migrated))
      return readFile(join(migrationsDir, `${migrationId}_${name}.sql`), 'utf8')
    }

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
      await writeSchema('')
      await generateAndMigrate('init', '20990101000000')
      await waitForTable(executor, db, orders)

      await writeSchema(
        ", { name: 'price', type: 'UInt64' }, { name: 'Total', type: 'UInt64', default: { expression: 'price + 1' } }"
      )
      const addSql = await generateAndMigrate('add', '20990101000001')
      expectInOrder(addSql, [
        'ADD COLUMN IF NOT EXISTS `price` UInt64;',
        'ADD COLUMN IF NOT EXISTS `Total` UInt64 DEFAULT price + 1;',
      ])
      await waitForColumn(executor, db, orders, 'Total')

      await executor.command(`INSERT INTO ${quoteIdent(db)}.${quoteIdent(orders)} (id, price) VALUES (1, 41)`)
      const rows = await executor.query<{ Total: string }>(`SELECT Total FROM ${quoteIdent(db)}.${quoteIdent(orders)}`)
      expect(rows.map((row) => Number(row.Total))).toEqual([42])
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(db)}.${quoteIdent(orders)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(db)}.${quoteIdent(journalTable)}`)
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  // `a` sorts before `n.x`, and its DEFAULT reads `n.x` without backquotes
  // (#748). ClickHouse rejects the ADD COLUMN of `a` while `n.x` is missing.
  // Then `k.b` sorts before `z`, whose `t.1.k.b` is a path into the tuple `t`,
  // not a read of `k.b`; ClickHouse rejects `k.b DEFAULT z + 1` before `z`.
  test('adds a dotted column before the ADD COLUMN whose DEFAULT reads it unquoted', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const db = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('dotorder')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
    const orders = `${createPrefix('dotorder')}orders`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-dotorder-e2e-'))
    const configPath = join(dir, 'clickhouse.config.ts')
    const schemaPath = join(dir, 'schema.ts')
    const migrationsDir = join(dir, 'chkit/migrations')
    const writeSchema = (columns: string) =>
      writeFile(
        schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\n` +
          `export default schema(table({ database: '${db}', name: '${orders}', columns: [{ name: 'id', type: 'UInt64' }, { name: 't', type: 'Tuple(u Tuple(k Tuple(b UInt64)))' }${columns}], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] }))\n`,
        'utf8'
      )
    const generateAndMigrate = async (name: string, migrationId: string) => {
      const generated = runCli(
        dir,
        ['generate', '--config', configPath, '--name', name, '--migration-id', migrationId, '--json'],
        cliEnv
      )
      if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic(`generate (${name}) failed`, generated))
      const migrated = await runCliWithRetry(dir, ['migrate', '--config', configPath, '--execute', '--json'], {
        extraEnv: cliEnv,
      })
      if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic(`migrate --execute (${name}) failed`, migrated))
      return readFile(join(migrationsDir, `${migrationId}_${name}.sql`), 'utf8')
    }

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
      await writeSchema('')
      await generateAndMigrate('init', '20990101000000')
      await waitForTable(executor, db, orders)

      await writeSchema(
        ", { name: 'a', type: 'UInt64', default: { expression: 'arraySum(n.x)' } }, { name: 'n.x', type: 'Array(UInt64)' }"
      )
      const addSql = await generateAndMigrate('add', '20990101000001')
      expectInOrder(addSql, [
        'ADD COLUMN IF NOT EXISTS `n.x` Array(UInt64);',
        'ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT arraySum(n.x);',
      ])
      await waitForColumn(executor, db, orders, 'a')

      await executor.command(`INSERT INTO ${quoteIdent(db)}.${quoteIdent(orders)} (id, \`n.x\`) VALUES (1, [40, 2])`)
      const rows = await executor.query<{ a: string }>(`SELECT a FROM ${quoteIdent(db)}.${quoteIdent(orders)}`)
      expect(rows.map((row) => Number(row.a))).toEqual([42])

      await writeSchema(
        ", { name: 'a', type: 'UInt64', default: { expression: 'arraySum(n.x)' } }, { name: 'n.x', type: 'Array(UInt64)' }" +
          ", { name: 'k.b', type: 'UInt64', default: { expression: 'z + 1' } }, { name: 'z', type: 'UInt64', default: { expression: 't.1.k.b' } }"
      )
      const elementSql = await generateAndMigrate('element', '20990101000002')
      expectInOrder(elementSql, [
        'ADD COLUMN IF NOT EXISTS `z` UInt64 DEFAULT t.1.k.b;',
        'ADD COLUMN IF NOT EXISTS `k.b` UInt64 DEFAULT z + 1;',
      ])
      await waitForColumn(executor, db, orders, 'k.b')

      await executor.command(`INSERT INTO ${quoteIdent(db)}.${quoteIdent(orders)} (id, t) VALUES (2, (((41))))`)
      const elementRows = await executor.query<{ z: string; kb: string }>(
        `SELECT z, \`k.b\` AS kb FROM ${quoteIdent(db)}.${quoteIdent(orders)} WHERE id = 2`
      )
      expect(elementRows.map((row) => [Number(row.z), Number(row.kb)])).toEqual([[41, 42]])
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(db)}.${quoteIdent(orders)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(db)}.${quoteIdent(journalTable)}`)
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  // The column DROP INDEX sorts after the DROP COLUMN by key (`column` <
  // `index`); the planner runs it first, and a rename in the same plan must
  // keep that (#747). ClickHouse rejects dropping `x` while `idx_x` reads it.
  test('drops a skip index before the column it reads when a column rename is applied', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const db = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('idxdrop')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
    const events = `${createPrefix('idxdrop')}events`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-idxdrop-e2e-'))
    const configPath = join(dir, 'clickhouse.config.ts')
    const schemaPath = join(dir, 'schema.ts')
    const migrationsDir = join(dir, 'chkit/migrations')
    const writeSchema = (columns: string, indexes: string) =>
      writeFile(
        schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\n` +
          `export default schema(table({ database: '${db}', name: '${events}', columns: [{ name: 'id', type: 'UInt64' }${columns}], indexes: [${indexes}], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] }))\n`,
        'utf8'
      )
    const generateAndMigrate = async (name: string, migrationId: string, extraArgs: string[]) => {
      const generated = runCli(
        dir,
        ['generate', '--config', configPath, '--name', name, '--migration-id', migrationId, ...extraArgs, '--json'],
        cliEnv
      )
      if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic(`generate (${name}) failed`, generated))
      const migrated = await runCliWithRetry(
        dir,
        ['migrate', '--config', configPath, '--execute', '--allow-destructive', '--json'],
        { extraEnv: cliEnv }
      )
      if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic(`migrate --execute (${name}) failed`, migrated))
      return readFile(join(migrationsDir, `${migrationId}_${name}.sql`), 'utf8')
    }

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
      await writeSchema(
        ", { name: 'a', type: 'String' }, { name: 'x', type: 'String' }",
        "{ name: 'idx_x', expression: 'x', type: 'bloom_filter', granularity: 1 }"
      )
      await generateAndMigrate('init', '20990101000000', [])
      await waitForColumn(executor, db, events, 'x')

      await writeSchema(", { name: 'b', type: 'String' }", '')
      const dropSql = await generateAndMigrate('drop', '20990101000001', ['--rename-column', `${db}.${events}.a=b`])
      expectInOrder(dropSql, [
        'DROP INDEX IF EXISTS `idx_x`;',
        'DROP COLUMN IF EXISTS `x`;',
        'RENAME COLUMN IF EXISTS `a` TO `b`;',
      ])
      await waitForColumn(executor, db, events, 'b')
      const readColumns = async () =>
        (
          await executor.query<{ name: string }>(
            `SELECT name FROM system.columns WHERE database = '${db}' AND table = '${events}' ORDER BY name`
          )
        ).map((row) => row.name)
      expect(await pollUntil(readColumns, (names) => !names.includes('x'))).toEqual(['b', 'id'])
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(db)}.${quoteIdent(events)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(db)}.${quoteIdent(journalTable)}`)
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

/**
 * Generates and migrates a change of one table's columns, then checks the
 * migration order and the columns ClickHouse ends with. `before` and `after`
 * are the column entries after `id`, `beforeTtl` and `afterTtl` the table
 * TTL; `rename` is a `from=to` column rename.
 */
async function migrateColumnChange(input: {
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

// Each change below fails on ClickHouse in the order of an earlier plan: a
// statement reads a column that does not exist yet, or a DROP COLUMN runs
// while another column still reads it.
describe('@chkit/cli migrate orders the column statements of a table (#745, #746, #758)', () => {
  test('a MODIFY COLUMN runs after the ADD COLUMN its new DEFAULT reads (#745)', async () => {
    await migrateColumnChange({
      label: 'modafteradd',
      before: "{ name: 'Total', type: 'UInt64' }",
      after: "{ name: 'Total', type: 'UInt64', default: { expression: 'price + 1' } }, { name: 'price', type: 'UInt64' }",
      order: ['ADD COLUMN IF NOT EXISTS `price` UInt64;', 'MODIFY COLUMN `Total` UInt64 DEFAULT price + 1;'],
      columns: ['Total', 'id', 'price'],
    })
  }, 120_000)

  test('a RENAME COLUMN runs before the ADD COLUMN that reads its new name (#746)', async () => {
    await migrateColumnChange({
      label: 'addafterrename',
      before: "{ name: 'a', type: 'String' }",
      after: "{ name: 'b', type: 'String' }, { name: 'Copy', type: 'String', defaultKind: 'MATERIALIZED', default: { expression: \"concat(b, '!')\" } }",
      rename: 'a=b',
      order: ['RENAME COLUMN IF EXISTS `a` TO `b`;', 'ADD COLUMN IF NOT EXISTS `Copy` String MATERIALIZED'],
      columns: ['Copy', 'b', 'id'],
    })
  }, 120_000)

  test('a RENAME COLUMN runs before the MODIFY COLUMN that reads its new name (#758)', async () => {
    await migrateColumnChange({
      label: 'modafterrename',
      before: "{ name: 'a', type: 'String' }, { name: 'code', type: 'String', default: { expression: 'a' } }",
      after: "{ name: 'b', type: 'String' }, { name: 'code', type: 'String', default: { expression: 'b' } }",
      rename: 'a=b',
      order: ['RENAME COLUMN IF EXISTS `a` TO `b`;', 'MODIFY COLUMN `code` String DEFAULT b;'],
      columns: ['b', 'code', 'id'],
    })
  }, 120_000)

  // Passes on main too; it fails when the DROP keeps its slot while the
  // MODIFY of `b` moves behind the ADD of `z`.
  test('a DROP COLUMN runs after the MODIFY of the column whose old DEFAULT reads it', async () => {
    await migrateColumnChange({
      label: 'dropaftermod',
      before: "{ name: 'b', type: 'UInt64', default: { expression: 'c' } }, { name: 'c', type: 'UInt64' }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'z' } }, { name: 'b', type: 'UInt64', default: { expression: 'z' } }, { name: 'z', type: 'UInt64' }",
      order: ['ADD COLUMN IF NOT EXISTS `z` UInt64;', 'MODIFY COLUMN `b` UInt64 DEFAULT z;', 'DROP COLUMN IF EXISTS `c`;'],
      columns: ['a', 'b', 'id', 'z'],
    })
  }, 120_000)

  test('a DROP COLUMN runs after the dropped column whose expression reads it', async () => {
    await migrateColumnChange({
      label: 'dropafterdrop',
      before: "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', defaultKind: 'ALIAS', default: { expression: 'a + 1' } }",
      after: "{ name: 'x', type: 'UInt64' }",
      order: ['DROP COLUMN IF EXISTS `b`;', 'DROP COLUMN IF EXISTS `a`;'],
      columns: ['id', 'x'],
    })
  }, 120_000)

  // Passes on main too; it fails when the ADD and the RENAME move while the
  // MODIFY of `d` keeps its slot before the ADD of `c`.
  test('a MODIFY COLUMN stays after the ADD COLUMN it reads when a rename runs too', async () => {
    await migrateColumnChange({
      label: 'modaddrename',
      before: "{ name: 'a', type: 'UInt64' }, { name: 'd', type: 'UInt64' }",
      after:
        "{ name: 'c', type: 'UInt64', default: { expression: \"length('abc')\" } }, { name: 'd', type: 'UInt64', default: { expression: 'c + 1' } }, { name: 'length', type: 'UInt64' }",
      rename: 'a=length',
      order: ['ADD COLUMN IF NOT EXISTS `c` UInt64', 'MODIFY COLUMN `d` UInt64 DEFAULT c + 1;'],
      columns: ['c', 'd', 'id', 'length'],
    })
  }, 120_000)

  test('a function call named like a new column does not hold back the rename it reads', async () => {
    await migrateColumnChange({
      label: 'fnrename',
      before: "{ name: 'a', type: 'UInt64', default: { expression: \"length('abc')\" } }",
      after:
        "{ name: 'b', type: 'UInt64', default: { expression: \"length('abc')\" } }, { name: 'length', type: 'UInt64', default: { expression: 'b + 1' } }",
      rename: 'a=b',
      order: ['RENAME COLUMN IF EXISTS `a` TO `b`;', 'ADD COLUMN IF NOT EXISTS `length` UInt64 DEFAULT b + 1;'],
      columns: ['b', 'id', 'length'],
    })
  }, 120_000)

  // Reading the lambda parameter `c` as the new column `c` ran MODIFY `a`
  // last, so MODIFY `b` DEFAULT a met the old `a DEFAULT b`: Cyclic alias
  // detected in column DEFAULT expressions (#768).
  test('a lambda parameter named like a new column does not hold back the MODIFY that declares it (#768)', async () => {
    await migrateColumnChange({
      label: 'lambdaparam',
      before:
        "{ name: 'a', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64', default: { expression: 'id' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'arraySum(arrayMap(c -> c, [1]))' } }, { name: 'b', type: 'UInt64', default: { expression: 'a' } }, { name: 'c', type: 'UInt64', default: { expression: 'id' } }",
      order: ['MODIFY COLUMN `a` UInt64 DEFAULT arraySum(arrayMap(c -> c, [1]));', 'MODIFY COLUMN `b` UInt64 DEFAULT a;'],
      columns: ['a', 'b', 'c', 'id'],
    })
  }, 120_000)
})

// Each change below fails on ClickHouse 26.3 in the order of the #759 plan:
// `Cyclic alias detected` when a MODIFY reads back a column whose old DEFAULT
// still reads it, `Missing columns` when a DROP COLUMN runs while the table
// TTL still reads the column.
describe('@chkit/cli migrate orders MODIFY read releases and table TTL changes (#769)', () => {
  test('a MODIFY COLUMN that reads a column back runs after that column stops reading it', async () => {
    await migrateColumnChange({
      label: 'modrelease',
      before: "{ name: 'a', type: 'UInt64' }, { name: 'z', type: 'UInt64', default: { expression: 'a' } }",
      after: "{ name: 'a', type: 'UInt64', default: { expression: 'z' } }, { name: 'z', type: 'UInt64' }",
      order: ['MODIFY COLUMN `z` REMOVE DEFAULT;', 'MODIFY COLUMN `a` UInt64 DEFAULT z;'],
      columns: ['a', 'id', 'z'],
    })
  }, 120_000)

  test('a MODIFY COLUMN that closes a longer cycle runs after the release', async () => {
    await migrateColumnChange({
      label: 'modrelease3',
      before:
        "{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: 'c' } }, { name: 'c', type: 'UInt64', default: { expression: 'a' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64', default: { expression: 'c' } }, { name: 'c', type: 'UInt64', default: { expression: 'id' } }",
      order: ['MODIFY COLUMN `c` UInt64 DEFAULT id;', 'MODIFY COLUMN `a` UInt64 DEFAULT b;'],
      columns: ['a', 'b', 'c', 'id'],
    })
  }, 120_000)

  test('a MODIFY COLUMN that closes a cycle through an added column runs after the release', async () => {
    await migrateColumnChange({
      label: 'modreleaseadd',
      before: "{ name: 'b', type: 'UInt64' }, { name: 'c', type: 'UInt64', default: { expression: 'b' } }",
      after:
        "{ name: 'a', type: 'UInt64', default: { expression: 'c' } }, { name: 'b', type: 'UInt64', default: { expression: 'a' } }, { name: 'c', type: 'UInt64' }",
      order: ['ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT c;', 'MODIFY COLUMN `c` REMOVE DEFAULT;', 'MODIFY COLUMN `b` UInt64 DEFAULT a;'],
      columns: ['a', 'b', 'c', 'id'],
    })
  }, 120_000)

  test('a TTL change runs after the ADD of the column it reads and before the DROP of the column it stops reading', async () => {
    await migrateColumnChange({
      label: 'ttlswap',
      before: "{ name: 'x', type: 'DateTime' }",
      beforeTtl: 'x + INTERVAL 1 DAY',
      after: "{ name: 'y', type: 'DateTime' }",
      afterTtl: 'y + INTERVAL 1 DAY',
      order: ['ADD COLUMN IF NOT EXISTS `y` DateTime;', 'MODIFY TTL y + INTERVAL 1 DAY;', 'DROP COLUMN IF EXISTS `x`;'],
      columns: ['id', 'y'],
    })
  }, 120_000)

  test('a REMOVE TTL runs before the DROP of the column the TTL reads', async () => {
    await migrateColumnChange({
      label: 'ttlremove',
      before: "{ name: 'x', type: 'DateTime' }",
      beforeTtl: 'x + INTERVAL 1 DAY',
      after: "{ name: 'w', type: 'UInt64' }",
      order: ['REMOVE TTL;', 'DROP COLUMN IF EXISTS `x`;'],
      columns: ['id', 'w'],
    })
  }, 120_000)

  test('a TTL change keeps its order when a column rename runs too', async () => {
    await migrateColumnChange({
      label: 'ttlrename',
      before: "{ name: 'a', type: 'UInt64' }, { name: 'x', type: 'DateTime' }",
      beforeTtl: 'x + INTERVAL 1 DAY',
      after: "{ name: 'b', type: 'UInt64' }, { name: 'y', type: 'DateTime' }",
      afterTtl: 'y + INTERVAL 1 DAY',
      rename: 'a=b',
      order: ['ADD COLUMN IF NOT EXISTS `y` DateTime;', 'MODIFY TTL y + INTERVAL 1 DAY;', 'DROP COLUMN IF EXISTS `x`;'],
      columns: ['b', 'id', 'y'],
    })
  }, 120_000)
})
