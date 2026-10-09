import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { createPrefix, createStatelessLiveExecutor, getLiveEnv, quoteIdent } from '@chkit/clickhouse/e2e-testkit'

import { rawTable } from './destination.js'
import { runIngestion } from './executor.js'
import { cursorState } from './incremental.js'
import { validateJournalHistory } from './journal-history.js'
import { createClickHouseJournal, type JournalRow } from './journal.js'
import { definePipeline, defineStream, selectStreams } from './registry.js'
import { createMemoryDestination } from './testing.js'

describe('independent run histories with live ClickHouse', () => {
  const live = getLiveEnv()
  const database = live.clickhouseDatabase
  const table = `${createPrefix('run_journal')}facts`
  const targetId = `test/${table}`
  const qualified = `${quoteIdent(database)}.${quoteIdent(table)}`
  const destination = rawTable({ database, name: `${table}_unused` })
  const executor = createStatelessLiveExecutor(live)

  beforeAll(async () => {
    await createClickHouseJournal({ executor, database, table, targetId }).ensure()
  }, 60_000)

  afterAll(async () => {
    await executor.command(`DROP TABLE IF EXISTS ${qualified}`)
    await executor.close()
  }, 60_000)

  test('a valid stale checkpoint six days later creates a distinct replay history and the next run continues', async () => {
    const starts: unknown[] = []
    const stream = defineStream({
      id: `${table}.stale`, destination,
      incremental: cursorState({ id: 'test.cursor', version: 1, parse: Number }),
      async *read({ selection }) {
        starts.push(selection)
        yield { rows: [], state: (selection ?? 0) + 1 }
      },
    })
    const request = { selected: selectStreams([definePipeline({ id: 'stale', streams: [stream] })], []), backfill: undefined }
    const run = (startedAt: string, source = executor) => runIngestion(request, {
      journal: createClickHouseJournal({ executor: source, database, table, targetId }),
      destination: createMemoryDestination(), now: () => new Date(startedAt),
    })
    const first = await run('2026-10-01T00:00:00.000Z')
    expect(first.ok).toBe(true)
    expect((await run('2026-10-04T00:00:00.000Z')).ok).toBe(true)

    let staleReads = 0
    const stale: ClickHouseExecutor = {
      ...executor,
      query<T>(sql: string, settings?: Parameters<ClickHouseExecutor['query']>[1]): Promise<T[]> {
        if (sql.startsWith(`SELECT * FROM ${qualified}`)) {
          staleReads += 1
          return executor.query<T>(sql.replace(/ ORDER BY /, ` AND run_id = '${first.runId}' ORDER BY `), settings)
        }
        return executor.query<T>(sql, settings)
      },
    }
    const replayed = await run('2026-10-07T00:00:00.000Z', stale)
    expect(replayed.ok).toBe(true)
    expect(staleReads).toBeGreaterThan(0)
    expect((await run('2026-10-08T00:00:00.000Z')).ok).toBe(true)
    expect(starts).toEqual([undefined, 1, 1, 2])
    const rows = await history(stream.id)
    const beginnings = rows.filter((row) => row.event_seq === '1')
    expect(beginnings).toHaveLength(4)
    expect(new Set(beginnings.map((row) => row.event_id)).size).toBe(4)
    expect(validateJournalHistory(rows, stream.id).checkpoint.envelope?.state).toBe(3)
  }, 60_000)

  test('a missing checkpoint insert replays uncertain sink work without poisoning other run histories', async () => {
    const starts: unknown[] = []
    const stream = defineStream({
      id: `${table}.unconfirmed`, destination, retry: { retries: 0 },
      incremental: cursorState({ id: 'test.cursor', version: 1, parse: Number }),
      async *read({ selection }) { starts.push(selection); yield { rows: [{ id: 1 }], state: (selection ?? 0) + 1 } },
    })
    const request = { selected: selectStreams([definePipeline({ id: 'unconfirmed', streams: [stream] })], []), backfill: undefined }
    let refused = 0
    const unavailable: ClickHouseExecutor = {
      ...executor,
      async insert(params) {
        if (isCheckpointInsert(params)) {
          refused += 1
          throw new Error('journal unavailable before checkpoint insert')
        }
        await executor.insert(params)
      },
    }
    const memory = createMemoryDestination()
    const first = await runIngestion(request, {
      journal: createClickHouseJournal({ executor: unavailable, database, table, targetId }), destination: memory,
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    })
    expect(first.ok).toBe(false)
    expect(refused).toBeGreaterThan(0)
    const journal = createClickHouseJournal({ executor, database, table, targetId })
    expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
    const second = await runIngestion(request, { journal, destination: memory, now: () => new Date('2026-10-07T00:00:00.000Z') })
    expect(second.ok).toBe(true)
    expect(starts).toEqual([undefined, undefined])
    expect((await journal.readCheckpoint(stream.id)).envelope?.state).toBe(1)
  }, 60_000)

  test('a lost journal acknowledgement retries the exact immutable facts', async () => {
    let lost = false
    const attempts: string[][] = []
    const stream = defineStream({
      id: `${table}.lost`, destination,
      incremental: cursorState({ id: 'test.cursor', version: 1, parse: Number }),
      async *read() { yield { rows: [], state: 1 } },
    })
    const lossy: ClickHouseExecutor = {
      ...executor,
      async insert(params) {
        if (isCheckpointInsert(params)) attempts.push(params.values.map((row) => `${row.event_id}:${row.payload_hash}`))
        await executor.insert(params)
        if (!lost && isCheckpointInsert(params)) {
          lost = true
          throw new Error('journal acknowledgement lost')
        }
      },
    }
    const journal = createClickHouseJournal({ executor: lossy, database, table, targetId })
    const result = await runIngestion({ selected: selectStreams([definePipeline({ id: 'lost', streams: [stream] })], []), backfill: undefined }, { journal, destination: createMemoryDestination() })
    expect(result.ok).toBe(true)
    expect(lost).toBe(true)
    expect(attempts.length).toBeGreaterThan(1)
    expect(attempts.every((attempt) => JSON.stringify(attempt) === JSON.stringify(attempts[0]))).toBe(true)
    expect((await journal.readCheckpoint(stream.id)).version).toBe(1)
    const committed = (await history(stream.id)).filter((row) => row.event_kind === 'batch_committed')
    expect(new Set(committed.map((row) => row.event_id)).size).toBe(1)
    expect(new Set(committed.map((row) => row.payload_hash)).size).toBe(1)
    expect(validateJournalHistory(await history(stream.id), stream.id).rows.filter((row) => row.event_kind === 'batch_committed')).toHaveLength(1)
  }, 60_000)

  test('a persisted checkpoint remains resumable when every acknowledgement for its insert is lost', async () => {
    const starts: unknown[] = []
    const stream = defineStream({
      id: `${table}.lost_all`, destination, retry: { retries: 0 },
      incremental: cursorState({ id: 'test.cursor', version: 1, parse: Number }),
      async *read({ selection }) { starts.push(selection); yield { rows: [], state: (selection ?? 0) + 1 } },
    })
    const request = { selected: selectStreams([definePipeline({ id: 'lost_all', streams: [stream] })], []), backfill: undefined }
    let lost = 0
    const lossy: ClickHouseExecutor = {
      ...executor,
      async insert(params) {
        await executor.insert(params)
        if (isCheckpointInsert(params)) {
          lost += 1
          throw new Error('journal acknowledgement lost')
        }
      },
    }
    const first = await runIngestion(request, {
      journal: createClickHouseJournal({ executor: lossy, database, table, targetId }), destination: createMemoryDestination(),
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    })
    expect(first.ok).toBe(false)
    expect(lost).toBeGreaterThan(1)
    const journal = createClickHouseJournal({ executor, database, table, targetId })
    expect((await journal.readCheckpoint(stream.id)).envelope?.state).toBe(1)
    const second = await runIngestion(request, { journal, destination: createMemoryDestination(), now: () => new Date('2026-10-07T00:00:00.000Z') })
    expect(second.ok).toBe(true)
    expect(starts).toEqual([undefined, 1])
    expect((await journal.readCheckpoint(stream.id)).envelope?.state).toBe(2)
  }, 60_000)

  async function history(namespaceId: string): Promise<JournalRow[]> {
    return executor.query<JournalRow>(`SELECT * FROM ${qualified} WHERE namespace_id = '${namespaceId}' ORDER BY run_id, event_seq`, {
      select_sequential_consistency: '1', use_query_cache: 0, output_format_json_quote_64bit_integers: 1,
    })
  }

  function isCheckpointInsert(params: Parameters<ClickHouseExecutor['insert']>[0]): boolean {
    return params.table === `${database}.${table}` && params.values.some((row) => row.event_kind === 'batch_committed')
  }
})
