import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  createLiveExecutor,
  createPrefix,
  createStatelessLiveExecutor,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  waitForTable,
  waitForView,
  type LiveEnv,
} from '@chkit/clickhouse/e2e-testkit'
import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { executeBackfill, type BackfillProgress, type BackfillResult } from './async-backfill.js'
import { buildChunkExecutionSql } from './chunking/sql.js'
import type { Chunk } from './chunking/types.js'

// #821: a chunk is done only once its rows are written, also downstream.
//
// A chunk INSERT into a Distributed table used to return once its rows were
// queued on the initiator for background delivery (distributed_foreground_insert
// = 0 by default), so the chunk was checkpointed done before any row reached a
// shard. The local stack's one-node `cluster` (test/infra/clickhouse.xml)
// writes its local shard in place, so the chunk runs with
// prefer_localhost_replica = 0, as a profile could set it, and delivery is
// stopped: rows that go through the queue stay in it.
//
// A profile with materialized_views_ignore_errors = 1 let a chunk end done
// although a materialized view on its target failed to write its rows (to a
// shard it could not reach, once delivery is in the foreground).
//
// ObsessionDB has no shards, no Distributed grant and no CREATE USER, so
// there the chunk goes into a plain table, and the failing view runs with
// the default profile.

const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'
const CLUSTER = 'cluster'
const SOURCE_ROWS = 1000

let env: LiveEnv
let ddl: ClickHouseExecutor
let runExecutor: ClickHouseExecutor
let database: string
let prefix: string

const chunk: Chunk = {
  id: 'all-0',
  partitionId: 'all',
  ranges: [],
  estimate: { rows: SOURCE_ROWS, bytesCompressed: 0, bytesUncompressed: 0, confidence: 'exact', reason: 'exact-count' },
  analysis: { lineage: [] },
}

function fqn(table: string): string {
  return `${quoteIdent(database)}.${quoteIdent(`${prefix}${table}`)}`
}

async function countRows(executor: ClickHouseExecutor, table: string): Promise<number> {
  const [row] = await executor.query<{ cnt: string }>(`SELECT toString(count()) AS cnt FROM ${fqn(table)}`)
  return Number(row?.cnt ?? 0)
}

function runChunk(
  executor: ClickHouseExecutor,
  target: string,
  planId: string,
  extraSettings = '',
  onProgress?: (progress: BackfillProgress) => void,
): Promise<BackfillResult> {
  return executeBackfill({
    executor,
    planId,
    onProgress,
    chunks: [{ id: chunk.id }],
    buildQuery: () => `${buildChunkExecutionSql({
      planId,
      chunk,
      target: fqn(target),
      sourceTarget: fqn('source'),
      table: { sortKeys: [] },
    })}${extraSettings}`,
    concurrency: 1,
    pollIntervalMs: 500,
  })
}

beforeAll(async () => {
  env = getLiveEnv()
  database = env.clickhouseDatabase
  ddl = createLiveExecutor(env)
  runExecutor = createStatelessLiveExecutor(env)
  prefix = createPrefix('backfill_dist')
  await ddl.command(`CREATE TABLE ${fqn('source')} (id UInt64) ENGINE = MergeTree ORDER BY id`)
  await ddl.command(`INSERT INTO ${fqn('source')} SELECT number FROM numbers(${SOURCE_ROWS})`)
  await ddl.command(`CREATE TABLE ${fqn('local')} (id UInt64) ENGINE = MergeTree ORDER BY id`)
  // A chunk that lands on a replica which cannot see the source yet copies
  // nothing and still ends done: every one of a few stateless reads sees it.
  let seen = 0
  await pollUntil(async () => {
    seen = (await countRows(runExecutor, 'source')) === SOURCE_ROWS ? seen + 1 : 0
    return seen
  }, (count) => count >= 3, { timeoutMs: 45_000, intervalMs: 250 })
  expect(seen, 'stateless reads in a row that see every source row').toBeGreaterThanOrEqual(3)
}, 90_000)

afterAll(async () => {
  for (const table of ['dist', 'mv', 'sink', 'mv_target', 'local', 'source']) {
    await ddl?.command(`DROP TABLE IF EXISTS ${fqn(table)} SYNC`)
  }
  if (!onObsessionDB) await ddl?.command(`DROP USER IF EXISTS ${quoteIdent(`${prefix}user`)}`)
  await runExecutor?.close()
  await ddl?.close()
})

describe('e2e: a backfill chunk is done only once its rows are written', () => {
  test(
    onObsessionDB
      ? 'a chunk runs with the pinned settings on ObsessionDB'
      : 'a chunk into a Distributed table is done only once its rows reached the shards, not while they sit in the distribution queue',
    async () => {
      if (!onObsessionDB) {
        await ddl.command(
          `CREATE TABLE ${fqn('dist')} AS ${fqn('local')} ENGINE = Distributed(${CLUSTER}, ${quoteIdent(database)}, ${quoteIdent(`${prefix}local`)}, rand())`,
        )
        await ddl.command(`SYSTEM STOP DISTRIBUTED SENDS ${fqn('dist')}`)
      }
      const result = await runChunk(
        runExecutor,
        onObsessionDB ? 'local' : 'dist',
        `${prefix}dist_plan`,
        onObsessionDB ? '' : ', prefer_localhost_replica = 0',
      )
      expect(result.failed).toBe(0)
      expect(result.completed).toBe(1)
      expect(result.progress[chunk.id]?.status).toBe('done')

      if (!onObsessionDB) {
        const [queue] = await ddl.query<{ files: string }>(
          `SELECT toString(sum(data_files)) AS files FROM system.distribution_queue WHERE database = '${database}' AND table = '${prefix}dist'`,
        )
        expect(Number(queue?.files ?? 0), 'files still queued for background delivery once the chunk is done').toBe(0)
      }
      expect(await pollUntil(() => countRows(ddl, 'local'), (rows) => rows === SOURCE_ROWS)).toBe(SOURCE_ROWS)
    },
    90_000,
  )

  test('a chunk whose materialized view fails to write is not done, whatever materialized_views_ignore_errors the profile sets', async () => {
    await ddl.command(`CREATE TABLE ${fqn('mv_target')} (id UInt64) ENGINE = MergeTree ORDER BY id`)
    await ddl.command(`CREATE TABLE ${fqn('sink')} (id UInt64) ENGINE = MergeTree ORDER BY id`)
    await ddl.command(`CREATE MATERIALIZED VIEW ${fqn('mv')} TO ${fqn('sink')} AS SELECT throwIf(id >= 0, 'view write failed') AS id FROM ${fqn('mv_target')}`)
    await waitForTable(ddl, database, `${prefix}mv_target`)
    await waitForView(ddl, database, `${prefix}mv`)

    let executor = runExecutor
    if (!onObsessionDB) {
      const user = `${prefix}user`
      const password = `p_${prefix}`
      await ddl.command(`CREATE USER ${quoteIdent(user)} IDENTIFIED BY '${password}' SETTINGS materialized_views_ignore_errors = 1`)
      await ddl.command(`GRANT ALL ON ${quoteIdent(database)}.* TO ${quoteIdent(user)}`)
      await ddl.command(`GRANT SELECT ON system.processes TO ${quoteIdent(user)}`)
      await ddl.command(`GRANT SELECT ON system.query_log TO ${quoteIdent(user)}`)
      executor = createStatelessLiveExecutor({ ...env, clickhouseUser: user, clickhousePassword: password })
    }
    try {
      // The INSERT's error can come back as its send's response, which stops
      // the run, or later through system.query_log, which records it failed.
      const statuses: Array<string | undefined> = []
      const outcome = await runChunk(executor, 'mv_target', `${prefix}mv_plan`, '', (progress) => {
        statuses.push(progress[chunk.id]?.status)
      }).then(
        (result) => `run ended, chunk ${result.progress[chunk.id]?.status}`,
        (error: unknown) => `run stopped: ${error instanceof Error ? error.message : String(error)}`,
      )
      expect(statuses, 'statuses the checkpoint recorded').not.toContain('done')
      expect(outcome).toMatch(/^(run ended, chunk failed|run stopped: [\s\S]*view write failed)/)
    } finally {
      if (executor !== runExecutor) await executor.close()
    }
  }, 90_000)
})
