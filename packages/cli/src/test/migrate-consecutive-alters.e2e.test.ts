import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  FINAL_COLUMNS,
  columnsOnEveryReplica,
  writeScenarioMigrations,
  type ScenarioTarget,
} from './consecutive-alters-scenario.js'
import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  runCli,
} from './e2e-testkit.js'

describe('@chkit/cli migrate consecutive ALTERs e2e (#240)', () => {
  test('dependent ALTERs on one column apply in order and leave every replica on the final schema', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const journalTable = createJournalTableName('alters')
    const target: ScenarioTarget = {
      database: liveEnv.clickhouseDatabase,
      table: `${createPrefix('alters')}t`,
      engine: 'MergeTree()',
    }
    const dir = await mkdtemp(join(tmpdir(), 'chkit-alters-e2e-'))
    const configPath = join(dir, 'clickhouse.config.ts')

    try {
      await writeScenarioMigrations(join(dir, 'chkit/migrations'), target)
      await writeFile(
        configPath,
        `export default {\n` +
          `  schema: '${join(dir, 'schema.ts')}',\n` +
          `  outDir: '${join(dir, 'chkit')}',\n` +
          `  migrationsDir: '${join(dir, 'chkit/migrations')}',\n` +
          `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
          `  clickhouse: {\n` +
          `    url: '${liveEnv.clickhouseUrl}',\n` +
          `    username: '${liveEnv.clickhouseUser}',\n` +
          `    password: '${liveEnv.clickhousePassword}',\n` +
          `    database: '${target.database}',\n` +
          `  },\n}\n`,
        'utf8',
      )

      const migrate = runCli(dir, ['migrate', '--config', configPath, '--apply', '--json'], {
        CHKIT_JOURNAL_TABLE: journalTable,
        CI: '1',
      })
      expect(migrate.exitCode, formatTestDiagnostic('migrate --apply', migrate)).toBe(0)

      // migrate returns only after its waits saw each change on every replica,
      // so the final schema must already be everywhere: no polling here.
      const { replicas, hosts } = await columnsOnEveryReplica(executor, target)
      expect(hosts).toHaveLength(replicas)
      for (const host of hosts) expect(host.columns).toEqual(FINAL_COLUMNS)
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(target.database)}.${quoteIdent(target.table)} SYNC`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(target.database)}.${quoteIdent(journalTable)} SYNC`)
      await executor.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
