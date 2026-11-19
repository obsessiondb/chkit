import { describe, expect, test } from 'bun:test'

import { waitForDDLPropagation } from './ddl-propagation.js'
import type { ClickHouseExecutor } from './index.js'
import { probeReplicaAccess, resolveReplicaFanout, resolveReplicaFanoutOrThrow } from './replicas.js'

const FAST = { pollIntervalMs: 1 }

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

function failingExecutor(error: Error): ClickHouseExecutor {
  return {
    async query(): Promise<never> {
      throw error
    },
  } as unknown as ClickHouseExecutor
}

describe('probeReplicaAccess (#765)', () => {
  test('reads every replica strictly and fans out even to one host', async () => {
    const queries: string[] = []
    const db = {
      async query<T>(sql: string): Promise<T[]> {
        queries.push(sql)
        return [{ replicas: '1' }] as T[]
      },
    } as unknown as ClickHouseExecutor

    expect(await probeReplicaAccess(db)).toEqual({ kind: 'fanout', fanout: { cluster: 'default', replicas: 1 } })
    expect(queries[0]).toContain("FROM clusterAllReplicas('default', system.one) SETTINGS skip_unavailable_shards = 0")
  })

  test('reports a denied or missing cluster, or an empty result, as partial', async () => {
    const denied = Object.assign(new Error('Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)'), { code: '497' })
    const missing = new Error("Requested cluster 'default' not found. (CLUSTER_DOESNT_EXIST)")
    const empty = { async query<T>(): Promise<T[]> { return [] as T[] } } as unknown as ClickHouseExecutor

    expect(await probeReplicaAccess(failingExecutor(denied))).toEqual({ kind: 'partial', reason: `the user may not read every replica (${denied.message})` })
    expect(await probeReplicaAccess(failingExecutor(missing))).toEqual({ kind: 'partial', reason: 'the cluster default does not exist, so not every replica can be read' })
    expect(await probeReplicaAccess(empty)).toEqual({ kind: 'partial', reason: 'the replica probe of cluster default returned no replica count' })
    // The lenient and strict fan-out helpers keep their single-replica fallback.
    expect(await resolveReplicaFanoutOrThrow(failingExecutor(denied))).toBeUndefined()
  })

  // Two replicas, one unavailable: a probe that skipped it would count one
  // host and pass for a single-node target.
  test('rejects when a replica does not answer, instead of counting the ones that do', async () => {
    const db = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('skip_unavailable_shards = 0')) throw new Error('Code: 279. DB::NetException: All connection tries failed. (ALL_CONNECTION_TRIES_FAILED)')
        return [{ replicas: '1' }] as T[]
      },
    } as unknown as ClickHouseExecutor

    await expect(probeReplicaAccess(db)).rejects.toThrow('ALL_CONNECTION_TRIES_FAILED')
  })
})

describe('waitForDDLPropagation across replicas', () => {
  test('skips backfill assertions and still waits for subsequent DDL on every replica', async () => {
    const { db, queries } = twoReplicaExecutor([1, 2])

    await waitForDDLPropagation(db, 'assert_backfill', 'table:brain.knowledge:backfill', FAST)
    expect(queries).toEqual([])

    await waitForDDLPropagation(db, 'create_table', 'table:brain.knowledge', FAST)

    const polls = queries.filter((sql) => sql.includes('system.tables'))
    expect(polls).toHaveLength(2)
    expect(polls.every((sql) => sql.includes("name = 'knowledge'"))).toBe(true)
    expect(polls.every((sql) => sql.includes("clusterAllReplicas('default', system.tables)"))).toBe(true)
  })

  test('waits until no replica still shows a dropped column', async () => {
    const { db, queries } = twoReplicaExecutor([1, 0])

    await waitForDDLPropagation(db, 'alter_table_drop_column', 'table:app.events:column:c1', FAST)

    expect(queries.filter((sql) => sql.includes('system.columns'))).toHaveLength(2)
  })

  test('waits until every replica stores the same dictionary uuid after a password-only replace', async () => {
    const queries: string[] = []
    let poll = 0
    // A replace leaves the row in place. ClickHouse redacts the SOURCE
    // password, so both replicas can already show the same create_table_query
    // while one still has the previous uuid. The loader table is not consulted.
    const visible = [
      { replicas: 2, agreed: 0 },
      { replicas: 2, agreed: 1 },
    ]
    const db = {
      async query<T>(sql: string): Promise<T[]> {
        queries.push(sql)
        if (sql.includes('system.one')) return [{ replicas: 2 }] as T[]
        const row = visible[Math.min(poll, visible.length - 1)]
        poll += 1
        return [row] as T[]
      },
    } as unknown as ClickHouseExecutor

    await waitForDDLPropagation(db, 'create_dictionary', 'dictionary:app.users_dict', FAST)

    const polls = queries.filter((sql) => sql.includes('system.tables'))
    expect(polls).toHaveLength(2)
    expect(polls[0]).toContain("clusterAllReplicas('default', system.tables)")
    expect(polls[0]).toContain("engine = 'Dictionary'")
    expect(polls[0]).toContain('min(uuid) = max(uuid)')
    expect(polls[0]).toContain("toUUID('00000000-0000-0000-0000-000000000000')")
    expect(polls[0]).not.toContain('create_table_query')
    expect(polls[0]).not.toContain('system.dictionaries')
  })
})
