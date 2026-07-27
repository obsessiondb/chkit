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
  waitForDictionary,
  waitForTable,
} from './e2e-testkit.js'

/**
 * Sources the dictionary from ClickHouse's own HTTP interface (SOURCE(HTTP(...)))
 * pointed back at the seed table, rather than a native-protocol CLICKHOUSE()
 * source or a filesystem FILE() source — both require connection details
 * (native TCP port, server-local file paths) this suite cannot assume for a
 * managed target like ObsessionDB. HTTP only needs the same URL/credentials
 * `getRequiredEnv()` already validated.
 */
function renderSchema(input: {
  database: string
  tableName: string
  dictName: string
  clickhouseUrl: string
  clickhouseUser: string
  clickhousePassword: string
  lifetime: string
}): string {
  const query = `SELECT id, name FROM ${input.database}.${input.tableName} FORMAT JSONEachRow`
  const sourceUrl = `${input.clickhouseUrl}/?query=${encodeURIComponent(query)}&user=${encodeURIComponent(input.clickhouseUser)}&password=${encodeURIComponent(input.clickhousePassword)}`

  return (
    `import { schema, table, dictionary } from '${CORE_ENTRY}'\n\n` +
    `const users = table({\n` +
    `  database: '${input.database}',\n` +
    `  name: '${input.tableName}',\n` +
    `  columns: [\n` +
    `    { name: 'id', type: 'UInt64' },\n` +
    `    { name: 'name', type: 'String' },\n` +
    `  ],\n` +
    `  engine: 'MergeTree()',\n` +
    `  primaryKey: ['id'],\n` +
    `  orderBy: ['id'],\n` +
    `})\n\n` +
    `const usersDict = dictionary({\n` +
    `  database: '${input.database}',\n` +
    `  name: '${input.dictName}',\n` +
    `  attributes: [\n` +
    `    { name: 'id', type: 'UInt64' },\n` +
    `    { name: 'name', type: 'String' },\n` +
    `  ],\n` +
    `  primaryKey: ['id'],\n` +
    `  source: "HTTP(url '${sourceUrl}' format 'JSONEachRow')",\n` +
    `  layout: 'HASHED()',\n` +
    `  lifetime: '${input.lifetime}',\n` +
    `})\n\n` +
    `export default schema(users, usersDict)\n`
  )
}

function renderTableOnlySchema(database: string, tableName: string): string {
  return (
    `import { schema, table } from '${CORE_ENTRY}'\n\n` +
    `export default schema(table({\n` +
    `  database: '${database}',\n` +
    `  name: '${tableName}',\n` +
    `  columns: [\n` +
    `    { name: 'id', type: 'UInt64' },\n` +
    `    { name: 'name', type: 'String' },\n` +
    `  ],\n` +
    `  engine: 'MergeTree()',\n` +
    `  primaryKey: ['id'],\n` +
    `  orderBy: ['id'],\n` +
    `}))\n`
  )
}

describe('@chkit/cli migrate dictionary e2e', () => {
  test(
    'create -> replace -> drift -> drop lifecycle for a ClickHouse dictionary',
    async () => {
      const liveEnv = getRequiredEnv()
      const executor = createLiveExecutor(liveEnv)
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('dict')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
      const prefix = createPrefix('dict')
      const tableName = `${prefix}users`
      const dictName = `${prefix}users_dict`

      const dir = await mkdtemp(join(tmpdir(), 'chkit-dict-e2e-'))
      const configPath = join(dir, 'clickhouse.config.ts')
      const schemaPath = join(dir, 'schema.ts')
      const outDir = join(dir, 'chkit')

      const schemaInput = {
        database,
        tableName,
        dictName,
        clickhouseUrl: liveEnv.clickhouseUrl,
        clickhouseUser: liveEnv.clickhouseUser,
        clickhousePassword: liveEnv.clickhousePassword,
      }

      try {
        await writeFile(schemaPath, renderSchema({ ...schemaInput, lifetime: '300' }), 'utf8')
        await writeFile(
          configPath,
          `export default {\n` +
            `  schema: '${schemaPath}',\n` +
            `  outDir: '${outDir}',\n` +
            `  migrationsDir: '${join(outDir, 'migrations')}',\n` +
            `  metaDir: '${join(outDir, 'meta')}',\n` +
            `  clickhouse: {\n` +
            `    url: '${liveEnv.clickhouseUrl}',\n` +
            `    username: '${liveEnv.clickhouseUser}',\n` +
            `    password: '${liveEnv.clickhousePassword}',\n` +
            `    database: '${database}',\n` +
            `  },\n}\n`,
          'utf8'
        )

        // 1. generate + migrate creates the source table and the dictionary.
        const genInit = runCli(
          dir,
          ['generate', '--config', configPath, '--name', 'init', '--migration-id', '20990101000000', '--json'],
          cliEnv
        )
        expect(genInit.exitCode).toBe(0)

        const migrateInit = await runCliWithRetry(
          dir,
          ['migrate', '--config', configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (migrateInit.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute (init) failed', migrateInit))
        }
        await waitForTable(executor, database, tableName)
        await waitForDictionary(executor, database, dictName)

        await executor.command(
          `INSERT INTO ${quoteIdent(database)}.${quoteIdent(tableName)} (id, name) VALUES (1, 'Alice')`
        )

        const seeded = await executor.query<{ name: string }>(
          `SELECT dictGet('${database}.${dictName}', 'name', toUInt64(1)) AS name`
        )
        expect(seeded[0]?.name).toBe('Alice')

        // 2. a structural change (lifetime) regenerates as a single CREATE OR
        // REPLACE DICTIONARY; the dictionary keeps serving correct data after.
        await writeFile(schemaPath, renderSchema({ ...schemaInput, lifetime: '600' }), 'utf8')
        const genReplace = runCli(
          dir,
          ['generate', '--config', configPath, '--name', 'replace', '--migration-id', '20990101000001', '--json'],
          cliEnv
        )
        expect(genReplace.exitCode).toBe(0)
        const replaceMigrationPath = join(outDir, 'migrations', '20990101000001_replace.sql')
        const replaceSql = await Bun.file(replaceMigrationPath).text()
        expect(replaceSql).toContain('CREATE OR REPLACE DICTIONARY')

        const migrateReplace = await runCliWithRetry(
          dir,
          ['migrate', '--config', configPath, '--execute', '--json'],
          { extraEnv: cliEnv }
        )
        if (migrateReplace.exitCode !== 0) {
          throw new Error(formatTestDiagnostic('migrate --execute (replace) failed', migrateReplace))
        }
        await waitForDictionary(executor, database, dictName)

        const afterReplace = await executor.query<{ name: string }>(
          `SELECT dictGet('${database}.${dictName}', 'name', toUInt64(1)) AS name`
        )
        expect(afterReplace[0]?.name).toBe('Alice')

        // 3. drift is clean immediately after apply; existence-drift (the MV
        // precedent — dictionaries are not deep-shape-compared) is detected
        // once the dictionary is hand-dropped out from under chkit.
        const driftClean = runCli(dir, ['drift', '--config', configPath, '--json'], cliEnv)
        expect(driftClean.exitCode).toBe(0)
        const driftCleanPayload = JSON.parse(driftClean.stdout) as { drifted: boolean }
        expect(driftCleanPayload.drifted).toBe(false)

        await executor.command(`DROP DICTIONARY IF EXISTS ${quoteIdent(database)}.${quoteIdent(dictName)}`)

        const driftDirty = runCli(dir, ['drift', '--config', configPath, '--json'], cliEnv)
        expect(driftDirty.exitCode).toBe(0)
        const driftDirtyPayload = JSON.parse(driftDirty.stdout) as {
          drifted: boolean
          objectDrift: Array<{ code: string; object: string }>
        }
        expect(driftDirtyPayload.drifted).toBe(true)
        expect(
          driftDirtyPayload.objectDrift.some(
            (item) => item.code === 'missing_object' && item.object === `dictionary:${database}.${dictName}`
          )
        ).toBe(true)

        // Restore the dictionary directly (out-of-band, like the hand-DROP
        // above) so the drop-blocking assertion below observes a real
        // `drop_dictionary` op rather than a no-op create. `chkit migrate`
        // can't do this restore itself: the schema file hasn't changed since
        // the last generate, so there's no new pending migration to apply —
        // the journal already recorded the dictionary as created.
        const createDictionaryStatement = replaceSql.match(/CREATE OR REPLACE DICTIONARY[\s\S]*?;/)?.[0]
        expect(createDictionaryStatement).toBeTruthy()
        await executor.command(createDictionaryStatement as string)
        await waitForDictionary(executor, database, dictName)

        // 4. removing the dictionary from schema plans a DROP DICTIONARY,
        // blocked without --allow-destructive.
        await writeFile(schemaPath, renderTableOnlySchema(database, tableName), 'utf8')
        const genDrop = runCli(
          dir,
          ['generate', '--config', configPath, '--name', 'drop_dict', '--migration-id', '20990101000002', '--json'],
          cliEnv
        )
        expect(genDrop.exitCode).toBe(0)

        const migrateDrop = runCli(dir, ['migrate', '--config', configPath, '--execute', '--json'], cliEnv)
        expect(migrateDrop.exitCode).toBe(3)
        const dropPayload = JSON.parse(migrateDrop.stdout) as {
          destructiveOperations: Array<{ type: string; warningCode: string }>
        }
        expect(dropPayload.destructiveOperations.some((op) => op.type === 'drop_dictionary')).toBe(true)
        expect(
          dropPayload.destructiveOperations.some((op) => op.warningCode === 'drop_dictionary_dependency_break')
        ).toBe(true)

        // Blocked, not applied — the dictionary must still exist.
        await waitForDictionary(executor, database, dictName)
      } finally {
        await rm(dir, { recursive: true, force: true })
        await executor.command(`DROP DICTIONARY IF EXISTS ${quoteIdent(database)}.${quoteIdent(dictName)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(tableName)}`)
        await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
        await executor.close()
      }
    },
    240_000
  )
})
