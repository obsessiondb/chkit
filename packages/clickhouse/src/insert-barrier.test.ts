import { describe, expect, test } from 'bun:test'

import { parseExchangeTables, waitForExchange } from './ddl-propagation.js'
import type { ClickHouseExecutor, ClickHouseSettings } from './index.js'
import { waitForInsertBarrier } from './insert-barrier.js'

// `polls` lists the query ids system.processes returns on each successive read.
function processesExecutor(
  polls: string[][],
  replicas = 1,
): { db: ClickHouseExecutor; queries: string[]; sentSettings: Array<ClickHouseSettings | undefined> } {
  const queries: string[] = []
  const sentSettings: Array<ClickHouseSettings | undefined> = []
  let poll = 0
  const db = {
    async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
      queries.push(sql)
      sentSettings.push(settings)
      if (sql.includes('system.one')) return [{ replicas }] as T[]
      const ids = polls[Math.min(poll, polls.length - 1)] ?? []
      poll += 1
      return ids.map((query_id) => ({ query_id })) as T[]
    },
  } as unknown as ClickHouseExecutor
  return { db, queries, sentSettings }
}

const SQL = "SELECT query_id FROM system.processes WHERE query_kind IN ('Insert', 'AsyncInsertFlush');"
const noSleep = async () => {}

describe('waitForInsertBarrier', () => {
  test('returns at once when no INSERT is running', async () => {
    const { db, queries } = processesExecutor([[]])
    expect(await waitForInsertBarrier(db, SQL, { sleep: noSleep })).toEqual({ waitedFor: 0 })
    expect(queries.filter((sql) => sql.includes('system.processes'))).toHaveLength(1)
  })

  test('waits for the INSERTs of the first read only, not for INSERTs that start later', async () => {
    const { db, queries } = processesExecutor([['a', 'b'], ['b', 'c'], ['c', 'd']])
    expect(await waitForInsertBarrier(db, SQL, { sleep: noSleep })).toEqual({ waitedFor: 2 })
    expect(queries.filter((sql) => sql.includes('system.processes'))).toHaveLength(3)
    expect(queries.at(-1)).not.toContain(';')
  })

  test('reads every replica through clusterAllReplicas', async () => {
    const { db, queries } = processesExecutor([['a'], []], 2)
    await waitForInsertBarrier(db, SQL, { sleep: noSleep })
    expect(queries.at(-1)).toContain("FROM clusterAllReplicas('default', system.processes) WHERE")
  })

  test('sends the settings with its reads only, not with the replica probe', async () => {
    const { db, sentSettings } = processesExecutor([['a'], []], 2)
    const settings = { max_execution_time: '60' }
    await waitForInsertBarrier(db, SQL, { settings, sleep: noSleep })
    expect(sentSettings).toEqual([undefined, settings, settings])
  })

  test('fails with the query ids that are still running after the timeout', async () => {
    let clock = 0
    const { db } = processesExecutor([['a', 'b'], ['a']])
    const run = waitForInsertBarrier(db, SQL, {
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock,
      pollIntervalMs: 1000,
      timeoutMs: 3000,
    })
    await expect(run).rejects.toThrow(
      '1 INSERT query that started before this step is still running after 3s (query_id a)'
    )
  })
})

describe('parseExchangeTables', () => {
  test('reads both tables, quoted or bare', () => {
    expect(parseExchangeTables('EXCHANGE TABLES app.events AND app.`events shadow` ON CLUSTER \'c\';')).toEqual([
      { database: 'app', name: 'events' },
      { database: 'app', name: 'events shadow' },
    ])
    expect(parseExchangeTables('DROP TABLE app.events')).toBeUndefined()
  })
})

describe('waitForExchange', () => {
  test('waits until every replica lists both tables with one uuid each', async () => {
    const answers = [
      [
        { database: 'app', name: 'a', replicas: 2, uuids: 2, sample_uuid: 'u1' },
        { database: 'app', name: 'b', replicas: 2, uuids: 2, sample_uuid: 'u2' },
      ],
      [
        { database: 'app', name: 'a', replicas: 2, uuids: 1, sample_uuid: 'u2' },
        { database: 'app', name: 'b', replicas: 2, uuids: 1, sample_uuid: 'u1' },
      ],
    ]
    let poll = 0
    const db = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('system.one')) return [{ replicas: 2 }] as T[]
        const rows = answers[Math.min(poll, answers.length - 1)]
        poll += 1
        return rows as T[]
      },
    } as unknown as ClickHouseExecutor
    await waitForExchange(db, 'EXCHANGE TABLES app.a AND app.b;')
    expect(poll).toBe(2)
  })

  test('does not wait for an ON CLUSTER exchange', async () => {
    const db = {
      async query(): Promise<never> {
        throw new Error('no query expected')
      },
    } as unknown as ClickHouseExecutor
    await waitForExchange(db, "EXCHANGE TABLES app.a AND app.b ON CLUSTER 'c';", { cluster: 'c' })
  })
})
