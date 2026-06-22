import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  getRequiredEnv,
  quoteIdent,
  runCli,
} from './e2e-testkit.js'

/**
 * #31: on a shared ObsessionDB journal the `Applied` count must reflect only
 * the migrations present in THIS project's migrations dir, not every tenant's
 * rows in the shared table. The bug let `Applied` exceed `Total`.
 */
describe('@chkit/cli status applied scope e2e (#31)', () => {
  test('Applied counts only this project\'s migrations, not foreign rows in a shared journal', async () => {
    const liveEnv = getRequiredEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    // One journal table shared by two independent projects — the multi-tenant
    // scenario that previously inflated the global Applied count.
    const journalTable = createJournalTableName('status_scope')
    const prefix = createPrefix('status_scope')
    const tableA = `${prefix}_a`
    const tableB = `${prefix}_b`
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }

    const makeProject = async (label: string, tableName: string): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), `chkit-status-${label}-`))
      const schemaPath = join(dir, 'schema.ts')
      await writeFile(
        schemaPath,
        `import { schema, table } from '${CORE_ENTRY}'\n\n` +
          `export default schema(table({\n` +
          `  database: '${database}',\n` +
          `  name: '${tableName}',\n` +
          `  columns: [{ name: 'id', type: 'UInt64' }],\n` +
          `  engine: 'MergeTree()',\n` +
          `  primaryKey: ['id'],\n` +
          `  orderBy: ['id'],\n` +
          `}))\n`,
        'utf8',
      )
      await writeFile(
        join(dir, 'clickhouse.config.ts'),
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
        'utf8',
      )
      return dir
    }

    const applyProject = (dir: string, name: string, migrationId: string): void => {
      const config = join(dir, 'clickhouse.config.ts')
      const gen = runCli(dir, ['generate', '--config', config, '--name', name, '--migration-id', migrationId, '--json'], cliEnv)
      expect(gen.exitCode).toBe(0)
      const migrate = runCli(dir, ['migrate', '--config', config, '--execute', '--json'], cliEnv)
      expect(migrate.exitCode).toBe(0)
    }

    const journalCompletedCount = async (): Promise<number> => {
      const rows = await executor.query<{ n: number }>(
        `SELECT count() AS n FROM ${quoteIdent(database)}.${quoteIdent(journalTable)} FINAL ` +
          `WHERE migration_completed = true SETTINGS select_sequential_consistency = 1`,
      )
      return Number(rows[0]?.n ?? 0)
    }

    const dirA = await makeProject('a', tableA)
    const dirB = await makeProject('b', tableB)

    try {
      // Two independent projects, distinct migration names, one shared journal.
      applyProject(dirA, 'init_a', '20990101000000')
      applyProject(dirB, 'init_b', '20990101000001')

      // Make the foreign row's visibility deterministic: assert the shared
      // journal really holds BOTH rows before checking status, so the scoping
      // (not propagation lag) is what keeps Applied at 1.
      let total = 0
      for (let attempt = 0; attempt < 20 && total < 2; attempt++) {
        total = await journalCompletedCount()
        if (total < 2) await new Promise((r) => setTimeout(r, 1000))
      }
      expect(total).toBe(2)

      const status = runCli(dirB, ['status', '--config', join(dirB, 'clickhouse.config.ts'), '--json'], cliEnv)
      expect(status.exitCode).toBe(0)
      const payload = JSON.parse(status.stdout) as { total: number; applied: number; pending: number }
      expect(payload.total).toBe(1)
      expect(payload.applied).toBe(1)
      expect(payload.pending).toBe(0)
      // The invariant the bug violated: Applied never exceeds Total.
      expect(payload.applied).toBeLessThanOrEqual(payload.total)
    } finally {
      await rm(dirA, { recursive: true, force: true })
      await rm(dirB, { recursive: true, force: true })
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(tableA)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(tableB)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
    }
  }, 180_000)
})
