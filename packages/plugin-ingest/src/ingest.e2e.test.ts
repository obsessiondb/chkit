import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { table, toCreateSQL } from '@chkit/core'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { createPrefix, createStatelessLiveExecutor, getRequiredEnv, quoteIdent, waitForTable } from '@chkit/clickhouse/e2e-testkit'

import { createClickHouseDestination, ingestionColumns } from './destination.js'
import { runIngestion } from './executor.js'
import { cursorState } from './incremental.js'
import { createClickHouseJournal } from './journal.js'
import { definePipeline, defineStream, resetRegistry, selectStreams } from './registry.js'
import type { DestinationAdapter } from './types.js'

describe('@chkit/plugin-ingest live env e2e', () => {
  const liveEnv = getRequiredEnv()
  const prefix = createPrefix('ingest')
  const database = liveEnv.clickhouseDatabase
  const journalTable = `${prefix}journal`
  const destinationTable = table({
    database,
    name: `${prefix}items`,
    columns: [{ name: 'id', type: 'UInt64' }, { name: 'label', type: 'String' }, ...ingestionColumns],
    engine: 'MergeTree()',
    primaryKey: ['id'],
    orderBy: ['id'],
    settings: { non_replicated_deduplication_window: '100' },
  })
  let executor: ClickHouseExecutor

  beforeAll(async () => {
    // Ingestion fetches, loads and journals concurrently, so it needs a stateless executor.
    executor = createStatelessLiveExecutor(liveEnv)
    await executor.command(toCreateSQL(destinationTable))
    await waitForTable(executor, database, destinationTable.name)
  })

  afterAll(async () => {
    await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(destinationTable.name)}`)
    await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
    await executor.close()
  })

  test('a lost acknowledgement replays from the journaled checkpoint without skipping or duplicating rows', async () => {
    resetRegistry()
    const source = Array.from({ length: 3 }, (_, page) => [0, 1].map((offset) => ({ id: page * 2 + offset, label: `row-${page * 2 + offset}` })))
    const stream = defineStream({
      id: `${prefix}items`,
      destination: destinationTable,
      batchSize: 2,
      incremental: cursorState({ id: 'e2e.page', version: 1, parse: (raw) => Number(raw) }),
      async *read({ selection }) {
        for (let page = selection ?? 0; page < source.length; page += 1) yield { rows: source[page] ?? [], state: page + 1 }
      },
    })
    const pipeline = definePipeline({ id: `${prefix}pipeline`, streams: [stream], retry: { retries: 0 } })
    const journal = () => createClickHouseJournal({ executor, database, targetId: `e2e/${prefix}`, table: journalTable })
    const destination = createClickHouseDestination(executor)
    let inserts = 0
    const lossy: DestinationAdapter = {
      insert: async (input) => {
        inserts += 1
        if (inserts === 2) {
          await destination.insert(input)
          throw new Error('acknowledgement lost')
        }
        if (inserts > 2) throw new Error('target unavailable')
        await destination.insert(input)
      },
    }
    const noSleep = async () => undefined

    const first = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal: journal(), destination: lossy, sleep: noSleep })
    expect(first.ok).toBe(false)
    expect((await journal().readCheckpoint(stream.id)).envelope?.state).toBe(1)

    // A fresh executor process reconstructs everything from the journal.
    const second = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, { journal: journal(), destination, sleep: noSleep })
    expect(second.ok).toBe(true)
    const checkpoint = await journal().readCheckpoint(stream.id)
    expect(checkpoint.envelope).toEqual({ strategy: 'e2e.page', version: 1, state: 3 })
    expect(checkpoint.version).toBe(3)

    const rows = await executor.query<{ id: string; run_ids: string }>(
      `SELECT id, uniqExact(_chkit_run_id) AS run_ids FROM ${quoteIdent(database)}.${quoteIdent(destinationTable.name)} GROUP BY id ORDER BY id`,
      { select_sequential_consistency: '1' }
    )
    expect(rows.map((row) => Number(row.id))).toEqual([0, 1, 2, 3, 4, 5])
    const physical = await executor.query<{ rows: string }>(
      `SELECT count() AS rows FROM ${quoteIdent(database)}.${quoteIdent(destinationTable.name)}`,
      { select_sequential_consistency: '1' }
    )
    expect(Number(physical[0]?.rows)).toBe(6)
  }, 120_000)
})
