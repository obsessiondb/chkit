import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  waitForCliJson,
  waitForTable,
  waitForView,
} from './e2e-testkit.js'

interface SnapshotFile {
  definitions: Array<{ kind: string; name: string; as?: string }>
}

describe('@chkit/cli snapshot rebuild e2e (#235)', () => {
  const liveEnv = getLiveEnv()

  test(
    'a rebuilt snapshot matches the views two merged branches left in ClickHouse',
    async () => {
      const executor = createLiveExecutor(liveEnv)
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('snaprb')
      const prefix = createPrefix('snaprb')
      const eventsTable = `${prefix}events`
      const eventsView = `${prefix}v_events`
      const usersTable = `${prefix}users`
      const usersView = `${prefix}v_users`
      const dir = await mkdtemp(join(tmpdir(), 'chkit-snapshot-rebuild-e2e-'))
      const configPath = join(dir, 'clickhouse.config.ts')
      const baseSchemaPath = join(dir, 'src/base.ts')
      const snapshotPath = join(dir, 'chkit/meta/snapshot.json')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1', XDG_CONFIG_HOME: join(dir, 'xdg') }

      const renderBase = (viewSql: string) =>
        `import { schema, table, view } from '${CORE_ENTRY}'\n\n` +
        `const events = table({ database: '${database}', name: '${eventsTable}', columns: [{ name: 'id', type: 'UInt64' }, { name: 'source', type: 'String' }], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] })\n` +
        `const eventsView = view({ database: '${database}', name: '${eventsView}', as: '${viewSql}' })\n\n` +
        'export default schema(events, eventsView)\n'
      const branchBSchema =
        `import { schema, table, view } from '${CORE_ENTRY}'\n\n` +
        `const users = table({ database: '${database}', name: '${usersTable}', columns: [{ name: 'id', type: 'UInt64' }], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] })\n` +
        `const usersView = view({ database: '${database}', name: '${usersView}', as: 'SELECT id FROM ${database}.${usersTable}' })\n\n` +
        'export default schema(users, usersView)\n'
      const mainViewSql = `SELECT id FROM ${database}.${eventsTable}`
      const branchAViewSql = `SELECT id, source FROM ${database}.${eventsTable}`

      const chkit = (args: string[]) => runCli(dir, [...args, '--config', configPath], cliEnv)
      const generate = (name: string, migrationId: string) => {
        const result = chkit(['generate', '--name', name, '--migration-id', migrationId, '--json'])
        if (result.exitCode !== 0) throw new Error(formatTestDiagnostic(`generate ${name} failed`, result))
      }
      const migrate = async () => {
        const result = await runCliWithRetry(dir, ['migrate', '--config', configPath, '--execute', '--json'], {
          extraEnv: cliEnv,
        })
        if (result.exitCode !== 0) throw new Error(formatTestDiagnostic('migrate --execute failed', result))
      }
      const readAsSelect = async (name: string) => {
        const rows = await executor.query<{ as_select: string }>(
          `SELECT as_select FROM system.tables WHERE database = '${database}' AND name = '${name}'`,
        )
        return rows[0]?.as_select ?? ''
      }

      try {
        await mkdir(join(dir, 'src'), { recursive: true })
        await writeFile(
          configPath,
          `export default {\n` +
            `  schema: '${join(dir, 'src')}/*.ts',\n` +
            `  outDir: '${join(dir, 'chkit')}',\n` +
            `  migrationsDir: '${join(dir, 'chkit/migrations')}',\n` +
            `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
            `  clickhouse: {\n` +
            `    url: '${liveEnv.clickhouseUrl}',\n` +
            `    username: '${liveEnv.clickhouseUser}',\n` +
            `    password: '${liveEnv.clickhousePassword}',\n` +
            `    database: '${database}',\n` +
            `  },\n}\n`,
          'utf8',
        )

        // main: a table and a view over it, applied.
        await writeFile(baseSchemaPath, renderBase(mainViewSql), 'utf8')
        generate('base', '20260101000000')
        await migrate()
        await waitForView(executor, database, eventsView)
        const mainSnapshot = await readFile(snapshotPath, 'utf8')

        // Branch A changes the view; its migration is applied.
        await writeFile(baseSchemaPath, renderBase(branchAViewSql), 'utf8')
        generate('change_view', '20260102000000')
        await migrate()
        const branchASnapshot = await readFile(snapshotPath, 'utf8')

        // Branch B starts from main, adds a table and a view; its migration is applied too.
        await writeFile(baseSchemaPath, renderBase(mainViewSql), 'utf8')
        await writeFile(snapshotPath, mainSnapshot, 'utf8')
        await writeFile(join(dir, 'src/b.ts'), branchBSchema, 'utf8')
        generate('add_users', '20260103000000')
        await migrate()
        await waitForTable(executor, database, usersTable)
        await waitForView(executor, database, usersView)
        const branchBSnapshot = await readFile(snapshotPath, 'utf8')

        // The merge: both branches' schema files, and a snapshot git could not merge.
        await writeFile(baseSchemaPath, renderBase(branchAViewSql), 'utf8')
        await writeFile(
          snapshotPath,
          `<<<<<<< HEAD\n${branchASnapshot}=======\n${branchBSnapshot}>>>>>>> branch-b\n`,
          'utf8',
        )

        const blocked = chkit(['migrate', '--json'])
        expect(blocked.exitCode).toBe(1)
        const envelope = JSON.parse(blocked.stdout) as { ok: boolean; error: { message: string } }
        expect(envelope.ok).toBe(false)
        expect(envelope.error.message).toContain('contains unresolved merge conflict markers')
        expect(envelope.error.message).toContain('chkit snapshot rebuild')

        const rebuild = chkit(['snapshot', 'rebuild', '--json'])
        if (rebuild.exitCode !== 0) throw new Error(formatTestDiagnostic('snapshot rebuild failed', rebuild))
        expect(JSON.parse(rebuild.stdout)).toMatchObject({
          written: true,
          definitionCount: 4,
          previous: { status: 'conflicted' },
        })

        // The rebuilt view entries match the view definitions ClickHouse holds.
        const rebuilt = JSON.parse(await readFile(snapshotPath, 'utf8')) as SnapshotFile
        const rebuiltSql = (name: string) =>
          rebuilt.definitions.find((definition) => definition.kind === 'view' && definition.name === name)?.as ?? ''
        expect(rebuiltSql(eventsView)).toBe(branchAViewSql)
        for (const name of [eventsView, usersView]) {
          const liveSql = await pollUntil(
            () => readAsSelect(name),
            (value) => value === rebuiltSql(name),
          )
          expect(liveSql).toBe(rebuiltSql(name))
        }

        const plan = chkit(['generate', '--dryrun', '--json'])
        expect(plan.exitCode).toBe(0)
        expect((JSON.parse(plan.stdout) as { operationCount: number }).operationCount).toBe(0)

        const { payload: drift } = await waitForCliJson<{ drifted: boolean; missing: string[] }>(
          dir,
          ['drift', '--config', configPath, '--json'],
          (payload) => payload.drifted === false,
          { extraEnv: cliEnv },
        )
        expect(drift.missing).toEqual([])

        const pending = chkit(['migrate', '--json'])
        expect(pending.exitCode).toBe(0)
        expect((JSON.parse(pending.stdout) as { pending: string[] }).pending).toEqual([])
      } finally {
        await rm(dir, { recursive: true, force: true })
        for (const view of [eventsView, usersView]) {
          await executor.command(`DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(view)}`).catch(() => {})
        }
        for (const table of [eventsTable, usersTable, journalTable]) {
          await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(table)}`).catch(() => {})
        }
        await executor.close()
      }
    },
    180_000,
  )
})
