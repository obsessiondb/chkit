import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import {
  LOCAL_STACK_ENV,
  createPrefix,
  createStatelessLiveExecutor,
  pollUntil,
  quoteIdent,
} from '@chkit/clickhouse/e2e-testkit'

import { CHECKPOINT_VERSION, executeBackfill, type BackfillProgress } from './async-backfill.js'
import { analyzeAndChunk } from './chunking/analyze.js'
import { buildChunkExecutionSql } from './chunking/sql.js'

// #765: an INSERT SELECT that parallel replicas spread over the replicas of a
// ReplicatedMergeTree target commits rows on the replicas while the initial
// query's query_log row says it wrote none. A failure of such an attempt
// proves nothing, and the chunk INSERT pins settings that keep it from
// running any secondary query. The local stack's embedded Keeper and its
// `parallel_replicas` cluster (test/infra/clickhouse.xml) make that real, so
// this always targets the local stack, also when the rest of the suite targets
// ObsessionDB.

const SOURCE_ROWS = 200_000
// What a profile with parallel replicas sets: the INSERT runs on the replicas,
// each writing its share of the rows.
const PARALLEL_REPLICAS_PROFILE = [
  'allow_experimental_parallel_reading_from_replicas = 1',
  'max_parallel_replicas = 3',
  "cluster_for_parallel_replicas = 'parallel_replicas'",
  'parallel_distributed_insert_select = 2',
  'parallel_replicas_insert_select_local_pipeline = 0',
].join(', ')
const PASSWORD = 'chkit-pr-e2e'

const prefix = createPrefix('bf_parallel_replicas')
const database = `${prefix}db`
const user = `${prefix}user`
const source = `${quoteIdent(database)}.source`
// DDL and counts as the stack's default user, which has no parallel replicas.
const admin = createStatelessLiveExecutor(LOCAL_STACK_ENV)
// Chunks run as a user whose profile has parallel replicas on.
let executor: ClickHouseExecutor

beforeAll(async () => {
  await admin.command(`CREATE DATABASE ${quoteIdent(database)}`)
  await admin.command(`CREATE TABLE ${source} (id UInt64, payload String) ENGINE = ReplicatedMergeTree ORDER BY id`)
  await admin.command(`INSERT INTO ${source} SELECT number, toString(number) FROM numbers(${SOURCE_ROWS})`)
  await admin.command(`CREATE USER ${quoteIdent(user)} IDENTIFIED WITH sha256_password BY '${PASSWORD}' SETTINGS ${PARALLEL_REPLICAS_PROFILE}`)
  await admin.command(`GRANT ALL ON ${quoteIdent(database)}.* TO ${quoteIdent(user)}`)
  await admin.command(`GRANT SELECT ON system.* TO ${quoteIdent(user)}`)
  await admin.command(`GRANT REMOTE ON *.* TO ${quoteIdent(user)}`)
  executor = createStatelessLiveExecutor({ ...LOCAL_STACK_ENV, clickhouseUser: user, clickhousePassword: PASSWORD })
}, 60_000)

afterAll(async () => {
  await executor?.close()
  await admin.command(`DROP USER IF EXISTS ${quoteIdent(user)}`)
  await admin.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
  await admin.close()
})

async function createTarget(name: string): Promise<string> {
  const target = `${quoteIdent(database)}.${quoteIdent(name)}`
  await admin.command(`CREATE TABLE ${target} (id UInt64, payload String) ENGINE = ReplicatedMergeTree ORDER BY id`)
  return target
}

async function countRows(table: string): Promise<number> {
  const [row] = await admin.query<{ rows: string }>(`SELECT toString(count()) AS rows FROM ${table}`)
  return Number(row?.rows)
}

/** query_log rows of the queries `initialQueryId` started, its own included, once both are flushed. */
async function loggedQueries(initialQueryId: string): Promise<Array<{ is_initial_query: number; type: string; written_rows: string }>> {
  await admin.command('SYSTEM FLUSH LOGS')
  return admin.query(
    `SELECT is_initial_query, type, toString(written_rows) AS written_rows FROM system.query_log
     WHERE initial_query_id = '${initialQueryId}' AND type != 'QueryStart'`,
  )
}

describe('executeBackfill with parallel replicas into a ReplicatedMergeTree target (live)', () => {
  test('the chunk INSERT runs no secondary query under a profile with parallel replicas, and counts its rows', async () => {
    // The profile spreads an unpinned INSERT over the replicas: the initial
    // query says it wrote nothing.
    const control = await createTarget('control')
    const controlId = `${prefix}control`
    await executor.submit(`INSERT INTO ${control} SELECT * FROM ${source}`, controlId)
    const controlRows = await loggedQueries(controlId)
    expect(controlRows.filter((row) => Number(row.is_initial_query) === 0).length).toBeGreaterThan(0)
    expect(controlRows.find((row) => Number(row.is_initial_query) === 1)).toMatchObject({ type: 'QueryFinish', written_rows: '0' })
    expect(await countRows(control)).toBe(SOURCE_ROWS)

    const target = await createTarget('target')
    const plan = await analyzeAndChunk({ database, table: 'source', targetChunkBytes: 1 << 30, query: (sql, settings) => admin.query(sql, settings) })
    const planId = `${prefix}pinned`
    const result = await executeBackfill({
      executor,
      planId,
      chunks: plan.chunks,
      buildQuery: (chunk) => buildChunkExecutionSql({ planId, chunk, target, sourceTarget: source, table: plan.table }),
      pollIntervalMs: 250,
    })

    expect(result.failed).toBe(0)
    expect(result.completed).toBe(plan.chunks.length)
    expect(await countRows(target)).toBe(SOURCE_ROWS)
    const chunkRows = (await Promise.all(plan.chunks.map((chunk) => loggedQueries(`backfill-${planId}-${chunk.id}`)))).flat()
    expect(chunkRows.filter((row) => Number(row.is_initial_query) === 0)).toEqual([])
    expect(chunkRows.reduce((sum, row) => sum + Number(row.written_rows), 0)).toBe(SOURCE_ROWS)
  }, 120_000)

  test('a failed attempt that ran secondary queries is not replayed by --replay-failed', async () => {
    const target = await createTarget('failed')
    const planId = `${prefix}failed`
    const chunkId = 'c0'
    const queryId = `backfill-${planId}-${chunkId}`
    // Unpinned, so the profile spreads it over the replicas; it fails once a
    // replica committed blocks, which the initial query does not count.
    const spreadFailure = `INSERT INTO ${target} SELECT id, payload FROM ${source} WHERE throwIf(id = 190000, 'late block') = 0 SETTINGS max_block_size = 1000, max_insert_block_size = 1000, min_insert_block_size_rows = 1000, min_insert_block_size_bytes = 0, insert_deduplicate = 0`
    const saved: BackfillProgress[] = []
    await expect(
      executeBackfill({
        executor,
        planId,
        chunks: [{ id: chunkId }],
        buildQuery: () => spreadFailure,
        pollIntervalMs: 100,
        onProgress: (progress) => { saved.push(progress) },
      }),
    ).rejects.toThrow('late block')
    const written = await pollUntil(() => countRows(target), (rows) => rows > 0)
    const logged = await loggedQueries(queryId)
    expect(logged.find((row) => Number(row.is_initial_query) === 1)).toMatchObject({ type: 'ExceptionWhileProcessing', written_rows: '0' })
    expect(logged.filter((row) => Number(row.is_initial_query) === 0).length).toBeGreaterThan(0)
    expect(saved.at(-1)?.[chunkId]).toMatchObject({ queryId, singleSend: true })

    const submits: string[] = []
    const progress: BackfillProgress[] = []
    await expect(
      executeBackfill({
        executor: { ...executor, submit: async (sql, id) => { submits.push(id ?? sql); return executor.submit(sql, id) } },
        planId,
        chunks: [{ id: chunkId }],
        buildQuery: () => spreadFailure,
        pollIntervalMs: 100,
        resumeFrom: saved.at(-1),
        checkpointVersion: CHECKPOINT_VERSION,
        replayFailed: true,
        onProgress: (next) => { progress.push(next) },
      }),
    ).rejects.toThrow(`the outcome of the last attempt is unknown for chunk ${chunkId} (query_id ${queryId}): it ran a secondary query on another replica or shard`)
    expect(submits).toEqual([])
    expect(progress.at(-1)?.[chunkId]?.secondaryQueryId).toEqual(expect.any(String))
    expect(await countRows(target)).toBe(written)
  }, 120_000)
})
