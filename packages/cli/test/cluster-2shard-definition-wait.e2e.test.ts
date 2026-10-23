import { describe, expect, test } from 'bun:test'

import { waitForColumn, waitForDDLPropagation } from '@chkit/clickhouse'

import { createLiveExecutor, createPrefix, waitForTable } from '../src/test/e2e-testkit.js'

// A replica that has not applied a MODIFY COLUMN yet still lists the column
// (#290). This stops one replica's replication queue so it keeps the old
// definition, then checks that the migrate wait holds until that replica
// catches up, where the column-presence wait did not.
//
// The ALTERs run on one replica of each shard without ON CLUSTER: an ON CLUSTER
// ALTER would hold the cluster's DDL queue until the stopped replica applies it.
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

function executorFor(url: string) {
  return createLiveExecutor({ clickhouseUrl: url, clickhouseUser: USER, clickhousePassword: PASSWORD, clickhouseDatabase: DATABASE })
}

describe('chkit cluster mode — column definition wait', () => {
  test('MODIFY COLUMN waits until a lagging replica shows the new default (#290)', async () => {
    const table = `${createPrefix('twoshard_defwait')}t`
    const qualified = `${DATABASE}.${table}`
    const executors = NODES.map(executorFor)
    const [shard1, lagging, shard2] = executors as [
      ReturnType<typeof executorFor>,
      ReturnType<typeof executorFor>,
      ReturnType<typeof executorFor>,
    ]
    const statement = `ALTER TABLE ${qualified} MODIFY COLUMN \`s\` String DEFAULT 'new';`
    const defaultOn = async (node: ReturnType<typeof executorFor>) =>
      (await node.query<{ d: string }>(
        `SELECT default_expression AS d FROM system.columns WHERE database = '${DATABASE}' AND table = '${table}' AND name = 's'`,
      ))[0]?.d

    try {
      await shard1.command(
        `CREATE TABLE ${qualified} ON CLUSTER '${CLUSTER}' (id UInt32, s String DEFAULT 'old') ENGINE = ReplicatedMergeTree ORDER BY id`,
      )
      for (const node of executors) await waitForTable(node, DATABASE, table)
      await lagging.command(`SYSTEM STOP REPLICATION QUEUES ${qualified}`)
      await shard1.command(statement)
      await shard2.command(statement)

      // The gap: the column is listed on every replica, so a presence wait
      // passes while the lagging replica still has the old default.
      await waitForColumn(shard1, DATABASE, table, 's', { cluster: CLUSTER })
      expect(await defaultOn(lagging)).toBe("'old'")

      let settled = false
      const waiting = waitForDDLPropagation(shard1, 'alter_table_modify_column', `table:${qualified}:column:s`, {
        cluster: CLUSTER,
        statement,
      }).finally(() => {
        settled = true
      })
      await Bun.sleep(3_000)
      expect(settled).toBe(false)
      expect(await defaultOn(lagging)).toBe("'old'")

      await lagging.command(`SYSTEM START REPLICATION QUEUES ${qualified}`)
      await waiting
      for (const node of executors) expect(await defaultOn(node)).toBe("'new'")
    } finally {
      await lagging.command(`SYSTEM START REPLICATION QUEUES ${qualified}`)
      await shard1.command(`DROP TABLE IF EXISTS ${qualified} ON CLUSTER '${CLUSTER}' SYNC`)
      for (const node of executors) await node.close()
    }
  }, 120_000)
})
