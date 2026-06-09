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
  runCliWithRetry,
  waitForTable,
} from './e2e-testkit.js'

function renderConfig(dir: string, env: ReturnType<typeof getRequiredEnv>, database: string, extra: string): string {
  return (
    `export default {\n` +
    `  schema: '${join(dir, 'schema.ts')}',\n` +
    `  outDir: '${join(dir, 'chkit')}',\n` +
    `  migrationsDir: '${join(dir, 'chkit/migrations')}',\n` +
    `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
    `  check: {${extra}},\n` +
    `  clickhouse: {\n` +
    `    url: '${env.clickhouseUrl}',\n` +
    `    username: '${env.clickhouseUser}',\n` +
    `    password: '${env.clickhousePassword}',\n` +
    `    database: '${database}',\n` +
    `  },\n}\n`
  )
}

describe('@chkit/cli drift extra-objects e2e (#5)', () => {
  test('unmanaged tables are reported but do not fail drift/check by default; opt-in flips it', async () => {
    const env = getRequiredEnv()
    const executor = createLiveExecutor(env)
    const database = env.clickhouseDatabase
    const journalTable = createJournalTableName('drift_extra')
    const prefix = createPrefix('drift_extra')
    const managed = `${prefix}managed`
    const unmanaged = `${prefix}unmanaged`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-drift-extra-e2e-'))
    const defaultConfig = join(dir, 'clickhouse.config.ts')
    const strictConfig = join(dir, 'clickhouse.strict.config.ts')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }

    try {
      await writeFile(
        join(dir, 'schema.ts'),
        `import { schema, table } from '${CORE_ENTRY}'\n\n` +
          `const managed = table({\n` +
          `  database: '${database}',\n  name: '${managed}',\n` +
          `  columns: [{ name: 'id', type: 'UInt64' }],\n` +
          `  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\n` +
          `export default schema(managed)\n`,
        'utf8',
      )
      await writeFile(defaultConfig, renderConfig(dir, env, database, ''), 'utf8')
      await writeFile(strictConfig, renderConfig(dir, env, database, ' failOnExtraObjects: true '), 'utf8')

      // Create the managed table via chkit, then an UNMANAGED table directly.
      expect(runCli(dir, ['generate', '--config', defaultConfig, '--json'], cliEnv).exitCode).toBe(0)
      const migrated = await runCliWithRetry(dir, ['migrate', '--config', defaultConfig, '--execute', '--json'], {
        extraEnv: cliEnv,
      })
      expect(migrated.exitCode).toBe(0)
      await waitForTable(executor, database, managed)
      await executor.command(
        `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(unmanaged)} (x UInt64) ENGINE = MergeTree ORDER BY x`,
      )
      await waitForTable(executor, database, unmanaged)

      // Default: the unmanaged table is reported as extra_object but does NOT drift.
      const drift = runCli(dir, ['drift', '--config', defaultConfig, '--json'], cliEnv)
      expect(drift.exitCode).toBe(0)
      const driftPayload = JSON.parse(drift.stdout) as {
        drifted: boolean
        missing: string[]
        objectDrift: Array<{ code: string; object: string }>
      }
      expect(driftPayload.missing).toEqual([])
      expect(driftPayload.drifted).toBe(false)
      expect(
        driftPayload.objectDrift.some((d) => d.code === 'extra_object' && d.object.includes(unmanaged)),
      ).toBe(true)

      // check passes (the CI gate is not broken by unmanaged tables).
      const check = runCli(dir, ['check', '--config', defaultConfig, '--json'], cliEnv)
      expect(check.exitCode).toBe(0)
      const checkPayload = JSON.parse(check.stdout) as { ok: boolean; failedChecks: string[] }
      expect(checkPayload.ok).toBe(true)
      expect(checkPayload.failedChecks).not.toContain('schema_drift')

      // Opt-in: failOnExtraObjects makes the same state drift.
      const strictDrift = runCli(dir, ['drift', '--config', strictConfig, '--json'], cliEnv)
      const strictPayload = JSON.parse(strictDrift.stdout) as { drifted: boolean }
      expect(strictPayload.drifted).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(managed)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(unmanaged)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
    }
  }, 180_000)
})
