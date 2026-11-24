import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  waitForTable,
} from './e2e-testkit.js'
import { BACKFILL_PLUGIN_ENTRY, CORE_ENTRY, createFixture, runCli } from './testkit.test'

// #821: distributed_foreground_insert = 1 is a default, not a pin a user
// cannot change. A user who sets distributed_foreground_insert = 0 in
// backfill({ insertSettings }) gets it in the chunk INSERT: the chunk is done
// while its rows still sit in the distribution queue, and the run prints one
// warning naming what is off.
//
// The backfill is an mv_replay into a Distributed table over the local
// stack's one-node `cluster` (test/infra/clickhouse.xml), planned and run
// through the CLI. That cluster writes its local shard in place, so the user's
// insertSettings also set prefer_localhost_replica = 0, and delivery is
// stopped: rows that go through the queue stay in it.
//
// ObsessionDB has no shards and no Distributed grant, so there the view
// writes to a plain table, and the run only shows the override is accepted
// and warned about.

const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'
const env = getLiveEnv()
const DATABASE = env.clickhouseDatabase
const SOURCE_ROWS = 1000
const WARNING = "Warning: insertSettings overrides what every backfill chunk INSERT sets by default: distributed_foreground_insert=0 (a chunk can be recorded done before its rows reach a Distributed table's shards)."

describe('backfill insertSettings override of a delivery default', () => {
  test(
    onObsessionDB
      ? 'distributed_foreground_insert = 0 from insertSettings is accepted and warned about'
      : 'distributed_foreground_insert = 0 from insertSettings leaves a done chunk queued, with one warning',
    async () => {
      const prefix = createPrefix('bf_override')
      const fqn = (table: string) => `${quoteIdent(DATABASE)}.${quoteIdent(`${prefix}${table}`)}`
      const target = onObsessionDB ? 'local' : 'dist'
      const db = createLiveExecutor(env)
      const fixture = await createFixture()
      try {
        await db.command(`CREATE TABLE ${fqn('source')} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
        await db.command(`CREATE TABLE ${fqn('local')} (id UInt64, event_time DateTime) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
        await waitForTable(db, DATABASE, `${prefix}source`)
        await waitForTable(db, DATABASE, `${prefix}local`)
        if (!onObsessionDB) {
          await db.command(`CREATE TABLE ${fqn('dist')} AS ${fqn('local')} ENGINE = Distributed(cluster, ${quoteIdent(DATABASE)}, ${quoteIdent(`${prefix}local`)}, rand())`)
          await db.command(`SYSTEM STOP DISTRIBUTED SENDS ${fqn('dist')}`)
        }
        await db.command(`INSERT INTO ${fqn('source')} SELECT number, toDateTime('2026-01-01 12:00:00') FROM numbers(${SOURCE_ROWS})`)
        expect(await pollUntil(() => countRows(db, fqn('source')), (rows) => rows === SOURCE_ROWS)).toBe(SOURCE_ROWS)

        // The view is never created: the replay reads its query from the schema.
        await writeFile(fixture.schemaPath, `import { materializedView, schema } from '${CORE_ENTRY}'

export default schema(materializedView({
  database: '${DATABASE}',
  name: '${prefix}mv',
  to: { database: '${DATABASE}', name: '${prefix}${target}' },
  as: 'SELECT id, event_time FROM ${DATABASE}.${prefix}source',
}))
`, 'utf8')
        const insertSettings = onObsessionDB
          ? '{ distributed_foreground_insert: 0 }'
          : '{ distributed_foreground_insert: 0, prefer_localhost_replica: 0 }'
        const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
        await writeFile(pluginPath, `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin({ insertSettings: ${insertSettings} })\n`, 'utf8')
        await writeFile(fixture.configPath, `import { plugin } from '${pluginPath}'

export default {
  schema: '${fixture.schemaPath}',
  outDir: '${join(fixture.dir, 'chkit')}',
  migrationsDir: '${fixture.migrationsDir}',
  metaDir: '${fixture.metaDir}',
  clickhouse: {
    url: '${env.clickhouseUrl}',
    username: '${env.clickhouseUser}',
    password: '${env.clickhousePassword}',
    database: '${DATABASE}',
  },
  plugins: [{ plugin }],
}
`, 'utf8')

        const plan = runCli(['plugin', 'backfill', 'plan', '--target', `${DATABASE}.${prefix}${target}`, '--config', fixture.configPath, '--json'])
        expect(plan.exitCode, formatTestDiagnostic('backfill plan', plan)).toBe(0)
        const planned = JSON.parse(plan.stdout) as { planId: string; strategy: string }
        expect(planned.strategy).toBe('mv_replay')

        const run = runCli(['plugin', 'backfill', 'run', '--plan-id', planned.planId, '--poll-interval', '500', '--config', fixture.configPath, '--json'])
        expect(run.exitCode, formatTestDiagnostic('backfill run', run)).toBe(0)
        expect((JSON.parse(run.stdout) as { status: string }).status).toBe('completed')
        expect(run.stderr.split('\n').filter((line) => line.startsWith('Warning: insertSettings'))).toEqual([WARNING])

        if (onObsessionDB) {
          expect(await pollUntil(() => countRows(db, fqn('local')), (rows) => rows === SOURCE_ROWS)).toBe(SOURCE_ROWS)
        } else {
          const [queue] = await db.query<{ files: string }>(
            `SELECT toString(sum(data_files)) AS files FROM system.distribution_queue WHERE database = '${DATABASE}' AND table = '${prefix}dist'`,
          )
          expect(Number(queue?.files ?? 0), 'files queued for background delivery once the chunk is done').toBeGreaterThan(0)
          expect(await countRows(db, fqn('local')), 'rows on the shard while delivery is stopped').toBe(0)
        }
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
        for (const table of ['dist', 'local', 'source']) {
          await db.command(`DROP TABLE IF EXISTS ${fqn(table)} SYNC`)
        }
        await db.close()
      }
    },
    120_000,
  )
})

async function countRows(db: ReturnType<typeof createLiveExecutor>, fqn: string): Promise<number> {
  const [row] = await db.query<{ cnt: string }>(`SELECT toString(count()) AS cnt FROM ${fqn} SETTINGS select_sequential_consistency = 1`)
  return Number(row?.cnt ?? 0)
}
