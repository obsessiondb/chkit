import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  createLiveExecutor,
  createPrefix,
  createStatelessLiveExecutor,
  getLiveEnv,
  pollUntil,
  quoteIdent,
} from '@chkit/clickhouse/e2e-testkit'
import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { executeBackfill } from './async-backfill.js'
import { buildChunkExecutionSql } from './chunking/sql.js'
import type { Chunk } from './chunking/types.js'

// A chunk INSERT into a Distributed table used to return once its rows were
// queued on the initiator for background delivery (distributed_foreground_insert
// = 0 by default), so the chunk was checkpointed done before any row reached a
// shard. The local stack's one-node `cluster` (test/infra/clickhouse.xml)
// writes its local shard in place, so the chunk runs with
// prefer_localhost_replica = 0, as a profile could set it, and delivery is
// stopped: rows that go through the queue stay in it. ObsessionDB has no
// shards and no Distributed grant, so there a chunk into a plain table checks
// that the server takes the pinned settings.

const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'
const CLUSTER = 'cluster'
const SOURCE_ROWS = 1000

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
  return `${quoteIdent(database)}.${quoteIdent(table)}`
}

async function countRows(table: string): Promise<number> {
  const [row] = await ddl.query<{ cnt: string }>(`SELECT toString(count()) AS cnt FROM ${fqn(table)}`)
  return Number(row?.cnt ?? 0)
}

beforeAll(async () => {
  const env = getLiveEnv()
  database = env.clickhouseDatabase
  ddl = createLiveExecutor(env)
  runExecutor = createStatelessLiveExecutor(env)
  prefix = createPrefix('backfill_dist')
  await ddl.command(`CREATE TABLE ${fqn(`${prefix}source`)} (id UInt64) ENGINE = MergeTree ORDER BY id`)
  await ddl.command(`INSERT INTO ${fqn(`${prefix}source`)} SELECT number FROM numbers(${SOURCE_ROWS})`)
  await ddl.command(`CREATE TABLE ${fqn(`${prefix}local`)} (id UInt64) ENGINE = MergeTree ORDER BY id`)
  if (!onObsessionDB) {
    await ddl.command(
      `CREATE TABLE ${fqn(`${prefix}dist`)} AS ${fqn(`${prefix}local`)} ENGINE = Distributed(${CLUSTER}, ${quoteIdent(database)}, ${quoteIdent(`${prefix}local`)}, rand())`,
    )
    await ddl.command(`SYSTEM STOP DISTRIBUTED SENDS ${fqn(`${prefix}dist`)}`)
  }
}, 60_000)

afterAll(async () => {
  for (const table of ['dist', 'local', 'source']) {
    await ddl?.command(`DROP TABLE IF EXISTS ${fqn(`${prefix}${table}`)} SYNC`)
  }
  await runExecutor?.close()
  await ddl?.close()
})

describe('e2e: backfill into a Distributed target', () => {
  test(
    onObsessionDB
      ? 'a chunk runs with the pinned settings on ObsessionDB'
      : 'a chunk is done only once its rows reached the shards, not while they sit in the distribution queue',
    async () => {
      const target = onObsessionDB ? `${prefix}local` : `${prefix}dist`
      const planId = `${prefix}plan`
      const result = await executeBackfill({
        executor: runExecutor,
        planId,
        chunks: [{ id: chunk.id }],
        buildQuery: () => `${buildChunkExecutionSql({
          planId,
          chunk,
          target: fqn(target),
          sourceTarget: fqn(`${prefix}source`),
          table: { sortKeys: [] },
        })}${onObsessionDB ? '' : ', prefer_localhost_replica = 0'}`,
        concurrency: 1,
        pollIntervalMs: 500,
      })
      expect(result.failed).toBe(0)
      expect(result.completed).toBe(1)
      expect(result.progress[chunk.id]?.status).toBe('done')

      if (!onObsessionDB) {
        const [queue] = await ddl.query<{ files: string }>(
          `SELECT toString(sum(data_files)) AS files FROM system.distribution_queue WHERE database = '${database}' AND table = '${prefix}dist'`,
        )
        expect(Number(queue?.files ?? 0), 'files still queued for background delivery once the chunk is done').toBe(0)
      }
      expect(await pollUntil(() => countRows(`${prefix}local`), (rows) => rows === SOURCE_ROWS)).toBe(SOURCE_ROWS)
    },
    60_000,
  )
})
