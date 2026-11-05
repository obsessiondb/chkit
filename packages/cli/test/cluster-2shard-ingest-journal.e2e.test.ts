import { describe, expect, test } from 'bun:test'

import { createStatelessClickHouseExecutor, type ClickHouseExecutor } from '@chkit/clickhouse'
import { table } from '@chkit/core'

import { createClickHouseDestination, ingestionColumns } from '../../plugin-ingest/src/destination.js'
import { runIngestion } from '../../plugin-ingest/src/executor.js'
import { cursorState } from '../../plugin-ingest/src/incremental.js'
import { createClickHouseJournal, journalTableSql } from '../../plugin-ingest/src/journal.js'
import { definePipeline, defineStream, selectStreams } from '../../plugin-ingest/src/registry.js'
import { createPrefix } from '../src/test/e2e-testkit.js'

// The ingest journal on test/cluster/2shard (2 shards x 2 replicas). A run can
// land on any node, so every node must read and write one replicated journal.
//
// Outside src/, excluded from default CI. Run via `bun run test:cluster:2shard`
// after `bun run cluster:2shard:up`. Hard-fails (never skips) if unreachable.
const NODES = (
  process.env.CHKIT_CLUSTER_2S_NODES ??
  'http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136'
).split(',')
const CLUSTER = process.env.CHKIT_CLUSTER_2S ?? 'test_cluster_2s'
const USER = process.env.CLICKHOUSE_USER ?? 'default'
const PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? 'clusterpass'
const DATABASE = process.env.CLICKHOUSE_DB ?? 'default'

function executorFor(url: string): ClickHouseExecutor {
  return createStatelessClickHouseExecutor({ url, username: USER, password: PASSWORD, database: DATABASE })
}

function qualified(table: string): string {
  return `\`${DATABASE}\`.\`${table}\``
}

/** How many replicas hold the table, with which engines, and how many Keeper paths they replicate. */
async function onEveryReplica(executor: ClickHouseExecutor, table: string) {
  const where = `database = '${DATABASE}' AND name = '${table}'`
  const [row] = await executor.query<{ tables: number | string; engines: string[]; keeper_paths: number | string }>(`SELECT
    (SELECT count() FROM clusterAllReplicas('${CLUSTER}', system.tables) WHERE ${where}) AS tables,
    (SELECT groupUniqArray(engine) FROM clusterAllReplicas('${CLUSTER}', system.tables) WHERE ${where}) AS engines,
    (SELECT uniqExact(zookeeper_path) FROM clusterAllReplicas('${CLUSTER}', system.replicas) WHERE database = '${DATABASE}' AND table = '${table}') AS keeper_paths`)
  return { tables: Number(row?.tables), engines: row?.engines, keeperPaths: Number(row?.keeper_paths) }
}

const ONE_JOURNAL = { tables: NODES.length, engines: ['ReplicatedMergeTree'], keeperPaths: 1 }

describe('chkit ingest journal on a multi-shard cluster', () => {
  test('runs through alternating nodes of both shards continue one checkpoint', async () => {
    const prefix = createPrefix('ingest_2s')
    const journalTable = `${prefix}journal`
    const executors = NODES.map(executorFor)
    const admin = executors[0] as ClickHouseExecutor
    const destination = table({
      database: DATABASE, name: `${prefix}rows`,
      columns: [{ name: 'id', type: 'UInt64' }, ...ingestionColumns], engine: 'ReplicatedMergeTree()', orderBy: ['id'],
    })
    await admin.command(
      `CREATE TABLE ${qualified(destination.name)} ON CLUSTER '${CLUSTER}' (id UInt64, _chkit_batch_id String, _chkit_run_id String, _chkit_ingested_at DateTime64(6, 'UTC') DEFAULT now64(6)) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{uuid}/rows', '{shard}_{replica}') ORDER BY id`
    )
    const stream = defineStream({
      id: 'cluster.ids', destination,
      incremental: cursorState({ id: 'cluster.cursor', version: 1, parse: Number }),
      async *read({ selection }) {
        const after = selection ?? 0
        yield { rows: [after + 1, after + 2, after + 3].map((id) => ({ id })), state: after + 3 }
      },
    })
    const request = { selected: selectStreams([definePipeline({ id: 'cluster', streams: [stream] })], []), backfill: undefined }

    // ch1 and ch2 are shard 1, ch3 and ch4 shard 2. One target id, as behind a load balancer.
    for (const [step, node] of [0, 2, 1, 3].entries()) {
      const executor = executors[node] as ClickHouseExecutor
      // Replication lag can make a node read an older checkpoint and replay
      // (at least once); this test is about every node reading one journal.
      if (step > 0) await executor.command(`SYSTEM SYNC REPLICA ${qualified(journalTable)}`)
      const result = await runIngestion(request, {
        journal: createClickHouseJournal({ executor, database: DATABASE, table: journalTable, targetId: 'load-balancer', cluster: CLUSTER }),
        destination: createClickHouseDestination(executor),
      })
      expect(result.ok).toBe(true)
    }

    expect(await onEveryReplica(admin, journalTable)).toEqual(ONE_JOURNAL)
    await admin.command(`SYSTEM SYNC REPLICA ${qualified(destination.name)}`)
    const [loaded] = await admin.query<{ rows: string; ids: string; last: string }>(
      `SELECT count() AS rows, uniqExact(id) AS ids, max(id) AS last FROM ${qualified(destination.name)}`
    )
    expect(loaded).toEqual({ rows: '12', ids: '12', last: '12' })

    for (const name of [journalTable, destination.name]) await admin.command(`DROP TABLE IF EXISTS ${qualified(name)} ON CLUSTER '${CLUSTER}' SYNC`)
    await Promise.all(executors.map((executor) => executor.close()))
  }, 120_000)

  test('runs on every node racing asynchronous ON CLUSTER provisioning end with one replicated journal', async () => {
    const prefix = createPrefix('ingest_2s_race')
    const executors = NODES.map(executorFor)
    const admin = executors[0] as ClickHouseExecutor
    for (let trial = 0; trial < 20; trial++) {
      const table = `${prefix}journal_${trial}`
      await Promise.all([
        admin.command(journalTableSql(qualified(table), CLUSTER), { distributed_ddl_task_timeout: 0 }),
        ...executors.map((executor) => createClickHouseJournal({ executor, database: DATABASE, table, targetId: 'race', cluster: CLUSTER }).ensure()),
      ])
      expect(await onEveryReplica(admin, table)).toEqual(ONE_JOURNAL)
      await admin.command(`DROP TABLE IF EXISTS ${qualified(table)} ON CLUSTER '${CLUSTER}' SYNC`)
    }
    await Promise.all(executors.map((executor) => executor.close()))
  }, 180_000)

  // The topology is checked before the journal is read, so these tables only need an engine.
  const refusals: Array<{ name: string; create: (table: string, executors: ClickHouseExecutor[]) => Promise<void>; error: RegExp; tables: number }> = [
    {
      name: 'a local journal an earlier chkit created on one node',
      create: (table, executors) => (executors[1] as ClickHouseExecutor).command(journalTableSql(qualified(table))),
      error: /is not replicated on cluster 'test_cluster_2s': it is a local table on ch2 \(MergeTree\)/,
      tables: 1,
    },
    {
      name: 'a journal replicated per shard',
      create: (table, executors) => (executors[0] as ClickHouseExecutor).command(
        `CREATE TABLE ${qualified(table)} ON CLUSTER '${CLUSTER}' (id UInt64) ENGINE = ReplicatedMergeTree ORDER BY id`
      ),
      error: /is not one table on cluster 'test_cluster_2s': its replicas use 2 Keeper paths/,
      tables: NODES.length,
    },
    {
      name: 'a replicated journal missing on one node',
      create: async (table, executors) => {
        for (const executor of executors.slice(0, 3)) {
          await executor.command(`CREATE TABLE ${qualified(table)} (id UInt64) ENGINE = ReplicatedMergeTree('/clickhouse/tables/${table}', '{shard}_{replica}') ORDER BY id`)
        }
      },
      error: /is missing on ch4 of cluster 'test_cluster_2s' after 20 checks/,
      tables: 3,
    },
  ]
  for (const refusal of refusals) {
    test(`ensure refuses ${refusal.name} and creates nothing`, async () => {
      const table = `${createPrefix('ingest_2s_refuse')}journal`
      const executors = NODES.map(executorFor)
      const admin = executors[0] as ClickHouseExecutor
      await refusal.create(table, executors)
      const journal = createClickHouseJournal({ executor: admin, database: DATABASE, table, targetId: 'refuse', cluster: CLUSTER })
      await expect(journal.ensure()).rejects.toThrow(refusal.error)
      expect((await onEveryReplica(admin, table)).tables).toBe(refusal.tables)
      await Promise.all(executors.map((executor) => executor.command(`DROP TABLE IF EXISTS ${qualified(table)} SYNC`)))
      await Promise.all(executors.map((executor) => executor.close()))
    }, 60_000)
  }
})
