import { describe, expect, test } from 'bun:test'

import { waitForDDLPropagation } from './ddl-propagation.js'
import type { ClickHouseExecutor } from './index.js'
import { resolveReplicaFanout } from './replicas.js'

// A target with two replicas behind one endpoint (#265): `visible` lists how
// many replicas report the object on each successive poll.
function twoReplicaExecutor(visible: number[]): { db: ClickHouseExecutor; queries: string[] } {
  const queries: string[] = []
  let poll = 0
  const db = {
    async query<T>(sql: string): Promise<T[]> {
      queries.push(sql)
      if (sql.includes('system.one')) return [{ replicas: 2 }] as T[]
      const replicas = visible[Math.min(poll, visible.length - 1)]
      poll += 1
      return [{ replicas }] as T[]
    },
  } as unknown as ClickHouseExecutor
  return { db, queries }
}

describe('resolveReplicaFanout', () => {
  test('reports the replicas of a multi-replica target once per executor', async () => {
    const { db, queries } = twoReplicaExecutor([2])

    expect(await resolveReplicaFanout(db)).toEqual({ cluster: 'default', replicas: 2 })
    expect(await resolveReplicaFanout(db)).toEqual({ cluster: 'default', replicas: 2 })
    expect(queries.filter((sql) => sql.includes('system.one'))).toHaveLength(1)
  })

  test('falls back to the single-replica path when the cluster cannot be queried', async () => {
    const db = {
      async query(): Promise<never> {
        throw new Error("Requested cluster 'default' not found. (CLUSTER_DOESNT_EXIST)")
      },
    } as unknown as ClickHouseExecutor

    expect(await resolveReplicaFanout(db)).toBeUndefined()
  })

  test('uses the configured cluster name', async () => {
    const { db, queries } = twoReplicaExecutor([2])

    expect(await resolveReplicaFanout(db, 'prod')).toEqual({ cluster: 'prod', replicas: 2 })
    expect(queries[0]).toContain("clusterAllReplicas('prod', system.one)")
  })
})

describe('waitForDDLPropagation across replicas', () => {
  test('keeps waiting while only one of two replicas shows an added column', async () => {
    const { db, queries } = twoReplicaExecutor([1, 1, 2])

    await waitForDDLPropagation(db, 'alter_table_add_column', 'table:app.events:column:c1')

    const polls = queries.filter((sql) => sql.includes('system.columns'))
    expect(polls).toHaveLength(3)
    expect(polls[0]).toContain("clusterAllReplicas('default', system.columns)")
  })

  test('waits until no replica still shows a dropped column', async () => {
    const { db, queries } = twoReplicaExecutor([1, 0])

    await waitForDDLPropagation(db, 'alter_table_drop_column', 'table:app.events:column:c1')

    expect(queries.filter((sql) => sql.includes('system.columns'))).toHaveLength(2)
  })
})
