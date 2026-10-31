import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { table, toCreateSQL, type TableDefinition } from '@chkit/core'
import { createPrefix, createStatelessLiveExecutor, getLiveEnv, quoteIdent, waitForTable } from '@chkit/clickhouse/e2e-testkit'

import { createClickHouseDestination, ingestionColumns } from './destination.js'
import { runIngestion } from './executor.js'
import { cursorState } from './incremental.js'
import { simpleLoader } from './loader.js'
import { definePipeline, defineStream, selectStreams } from './registry.js'
import { createMemoryJournal } from './testing.js'
import type { DestinationAdapter, LoaderFactory, Row } from './types.js'

describe('ingestion load fidelity against ClickHouse', () => {
  const liveEnv = getLiveEnv()
  const executor = createStatelessLiveExecutor(liveEnv)
  const destination = createClickHouseDestination(executor)
  const prefix = createPrefix('load_fidelity')
  const database = liveEnv.clickhouseDatabase
  const definition = (name: string, columns: TableDefinition['columns'], engine = 'MergeTree()') => table({
    database, name: `${prefix}${name}`, columns: [{ name: 'id', type: 'String' }, ...columns, ...ingestionColumns],
    engine, orderBy: ['id'], settings: { non_replicated_deduplication_window: '100' },
  })
  const replay = definition('replay', [{ name: 'value', type: 'String' }], 'ReplacingMergeTree(_chkit_ingested_at)')
  const timestamps = definition('timestamps', [
    { name: 'updated_at', type: "DateTime64(3, 'UTC')" },
    { name: 'raw', type: 'String' },
    { name: 'local', type: "DateTime('America/New_York')" },
    { name: 'precise', type: "DateTime64(9, 'UTC')" },
    { name: 'date', type: 'Date32' },
  ])
  const values = definition('values', [
    { name: 'numbers', type: 'Array(Float64)' },
    { name: 'optional', type: 'Nullable(Float64)' },
    { name: 'mapped', type: 'Map(String, UInt64)' },
    { name: 'signed', type: 'Int128' },
    { name: 'unsigned', type: 'UInt256' },
    { name: 'decimal', type: 'Decimal(38,10)' },
    { name: 'text', type: 'String' },
  ])
  const invalid = definition('invalid', [{ name: 'amount', type: 'UInt32' }])
  const overflow = definition('overflow', [
    { name: 'value', type: 'Float64' },
    { name: 'amount', type: 'Decimal(9,2)', defaultKind: 'MATERIALIZED', default: 'fn:toDecimal32(value,2)' },
  ])
  const nested = definition('nested', [{ name: 'items', type: 'Nested(sku String, qty UInt32)' }])
  const raw = definition('raw', [{ name: 'raw', type: 'JSON' }])
  const definitions = [replay, timestamps, values, invalid, overflow, nested, raw]
  const qualified = (def: TableDefinition) => `${quoteIdent(database)}.${quoteIdent(def.name)}`

  beforeAll(async () => {
    for (const def of definitions) {
      await executor.command(toCreateSQL(def))
      await waitForTable(executor, database, def.name)
    }
  }, 60_000)

  afterAll(async () => {
    for (const def of definitions) await executor.command(`DROP TABLE IF EXISTS ${qualified(def)}`)
    await executor.close()
  }, 60_000)

  const runRows = (id: string, def: TableDefinition, rows: readonly Row[], adapter = destination) => {
    const stream = defineStream({
      id: `${prefix}${id}`, destination: def,
      retry: { retries: 2, minTimeout: 1 },
      async *read() { yield { rows } },
    })
    return runIngestion({ selected: selectStreams([definePipeline({ id: prefix, streams: [stream] })], []), backfill: undefined }, {
      journal: createMemoryJournal(), destination: adapter,
    })
  }

  test.each([[2, 4], [4, 2]])('replay after resizing INSERTs from %i to %i retains every row', async (before, after) => {
    const id = `${prefix}resize_${before}_${after}`
    const journal = createMemoryJournal()
    const rows = [1, 2, 3, 4].map((n) => ({ id: `${before}_${after}_${n}`, value: `row-${n}` }))
    const build = (size: number) => defineStream({
      id, destination: replay, loader: simpleLoader({ maxRowsPerInsert: size }), retry: { retries: 0 },
      incremental: cursorState({ id: 'test.done', version: 1, parse: (raw) => raw }),
      async *read() { yield { rows, state: 'done' } },
    })
    const run = (size: number, adapter: DestinationAdapter) => runIngestion({
      selected: selectStreams([definePipeline({ id: prefix, streams: [build(size)] })], []), backfill: undefined,
    }, { journal, destination: adapter })
    let lost = false
    const lossy: DestinationAdapter = { async insert(input) {
      if (lost) throw new Error('destination unavailable')
      await destination.insert(input)
      lost = true
      throw new Error('acknowledgement lost')
    } }

    expect((await run(before, lossy)).ok).toBe(false)
    expect((await journal.readCheckpoint(id)).envelope).toBeUndefined()
    expect((await run(after, destination)).ok).toBe(true)
    expect((await journal.readCheckpoint(id)).envelope?.state).toBe('done')
    const stored = await executor.query<{ id: string; value: string }>(
      `SELECT id, value FROM ${qualified(replay)} FINAL WHERE startsWith(id, '${before}_${after}_') ORDER BY id`,
      { select_sequential_consistency: '1' },
    )
    expect(stored).toEqual(rows)
  }, 30_000)

  test('the documented shaped-row mapping accepts ISO timestamps, offsets and Date objects', async () => {
    const items = [
      { id: 'iso', updated_at: '2026-01-31T12:34:56.123Z' },
      { id: 'offset', updated_at: '2026-01-31T14:34:56.123+02:00' },
      { id: 'date', updated_at: new Date('2026-01-31T12:34:56.123Z') },
    ]
    const result = await runRows('timestamps', timestamps, items.map((item) => ({
      id: item.id, updated_at: item.updated_at, raw: JSON.stringify(item),
      local: item.updated_at, precise: '2026-01-31T12:34:56.123456789Z', date: '1900-01-01',
    })))
    expect(result.streams[0]).toMatchObject({ outcome: 'succeeded', rows: 3, error: undefined })
    const stored = await executor.query<{ updated: string; local: string; precise: string; date: string; raw: string }>(
      `SELECT toString(updated_at) AS updated, toString(local) AS local, toString(precise) AS precise, toString(date) AS date, raw FROM ${qualified(timestamps)}`,
      { select_sequential_consistency: '1' },
    )
    expect(stored).toHaveLength(3)
    for (const row of stored) {
      expect(row).toMatchObject({ updated: '2026-01-31 12:34:56.123', local: '2026-01-31 07:34:56', precise: '2026-01-31 12:34:56.123456789', date: '1900-01-01' })
      expect(JSON.parse(row.raw)).toHaveProperty('updated_at')
    }
  }, 30_000)

  test('non-finite floats, Maps and exact large values survive content hashing and JSONEachRow', async () => {
    const row = {
      id: 'values', numbers: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5], optional: Number.NaN,
      mapped: new Map([['max', 18446744073709551615n]]), signed: -170141183460469231731687303715884105728n,
      unsigned: (1n << 256n) - 1n, decimal: '1234567890123456789012345678.1234567890', text: 'héllo 🎉 日本\0end',
    }
    const result = await runRows('values', values, [row])
    expect(result.streams[0]).toMatchObject({ outcome: 'succeeded', rows: 1, error: undefined })
    const stored = await executor.query<{
      numbers: string[]; optional: number; mapped: string; signed: string; unsigned: string; decimal: string; text: string
    }>(`SELECT arrayMap(x -> toString(x), numbers) AS numbers, isNaN(optional) AS optional,
      toString(mapped['max']) AS mapped, toString(signed) AS signed, toString(unsigned) AS unsigned,
      toString(decimal) AS decimal, text FROM ${qualified(values)}`, { select_sequential_consistency: '1' })
    expect(stored).toEqual([{
      numbers: ['nan', 'inf', '-inf', '1.5'], optional: 1, mapped: '18446744073709551615',
      signed: row.signed.toString(), unsigned: row.unsigned.toString(), decimal: '1234567890123456789012345678.123456789', text: row.text,
    }])
    expect(Number.isNaN(row.numbers[0])).toBe(true)
    expect(row.mapped.get('max')).toBe(18446744073709551615n)
  }, 30_000)

  test('raw JSON timestamps remain String paths while typed timestamps use best-effort parsing', async () => {
    const source = { iso: '2026-01-31T12:34:56.123Z', spaced: '2026-01-31 12:34:56.123', offset: '2026-01-31T14:34:56.123+02:00' }
    expect((await runRows('raw', raw, [{ id: 'one', raw: source }])).ok).toBe(true)
    const stored = await executor.query<{ iso_type: string; spaced_type: string; offset_type: string; json: string }>(
      `SELECT dynamicType(raw.iso) AS iso_type, dynamicType(raw.spaced) AS spaced_type,
      dynamicType(raw.offset) AS offset_type, toJSONString(raw) AS json FROM ${qualified(raw)}`,
      { select_sequential_consistency: '1' },
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ iso_type: 'String', spaced_type: 'String', offset_type: 'String' })
    expect(JSON.parse(stored[0]?.json ?? '')).toEqual(source)
  }, 30_000)

  test('a deterministic parse error aborts the loader and fails once without reader replay', async () => {
    let writes = 0
    let aborts = 0
    let reads = 0
    const loader: LoaderFactory = (ctx) => {
      const direct = simpleLoader()(ctx)
      return {
        ctx,
        async write(batch) { writes += 1; await direct.write(batch) },
        finalize: () => direct.finalize(),
        async abort(reason) { aborts += 1; await direct.abort(reason) },
      }
    }
    const journal = createMemoryJournal()
    const stream = defineStream({
      id: `${prefix}invalid`, destination: invalid, loader, retry: { retries: 2, minTimeout: 1 },
      async *read() { reads += 1; yield { rows: [{ id: 'bad', amount: 'not a number' }] } },
    })
    const result = await runIngestion({ selected: selectStreams([definePipeline({ id: prefix, streams: [stream] })], []), backfill: undefined }, { journal, destination })
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, error: expect.stringContaining('amount') })
    expect([writes, aborts, reads]).toEqual([1, 1, 1])
    expect(journal.events.filter((event) => event.eventKind === 'batch_committed')).toEqual([])
    expect(journal.events.find((event) => event.eventKind === 'work_finished')?.errorClass).toBe('permanent')
  }, 30_000)

  test('UNKNOWN_TABLE remains retryable until the destination is visible', async () => {
    const def = definition('appearing', [{ name: 'amount', type: 'UInt32' }])
    let attempts = 0
    const delayed: DestinationAdapter = { async insert(input) {
      attempts += 1
      if (attempts === 2) {
        await executor.command(toCreateSQL(def))
        await waitForTable(executor, database, def.name)
      }
      await destination.insert(input)
    } }
    try {
      const result = await runRows('appearing', def, [{ id: 'one', amount: 1 }], delayed)
      expect(result.streams[0]).toMatchObject({ outcome: 'succeeded', rows: 1, error: undefined })
      expect(attempts).toBeGreaterThanOrEqual(2)
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${qualified(def)}`)
    }
  }, 30_000)

  test('a Decimal overflow in a materialized expression fails once and leaves earlier slices uncommitted', async () => {
    let writes = 0
    let reads = 0
    const journal = createMemoryJournal()
    const stream = defineStream({
      id: `${prefix}overflow`, destination: overflow, loader: simpleLoader({ maxRowsPerInsert: 1 }),
      retry: { retries: 1, minTimeout: 1 },
      async *read() { reads += 1; yield { rows: [{ id: 'good', value: 1 }, { id: 'bad', value: 1e30 }] } },
    })
    const result = await runIngestion({ selected: selectStreams([definePipeline({ id: prefix, streams: [stream] })], []), backfill: undefined }, {
      journal, destination: { async insert(input) { writes += 1; await destination.insert(input) } },
    })
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, error: expect.stringContaining('overflow') })
    expect([reads, writes]).toEqual([1, 2])
    expect(journal.events.filter((event) => event.eventKind === 'batch_committed')).toEqual([])
    expect(journal.events.find((event) => event.eventKind === 'work_finished')?.errorClass).toBe('permanent')
    expect(await executor.query(`SELECT id FROM ${qualified(overflow)}`, { select_sequential_consistency: '1' })).toEqual([{ id: 'good' }])
  }, 30_000)

  test('Nested parent values fail clearly rather than disappearing, while flattened arrays load', async () => {
    const bad = await runRows('nested_bad', nested, [{ id: 'bad', items: [{ sku: 'a', qty: 2 }] }])
    expect(bad.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, error: expect.stringContaining('items.field') })
    const good = await runRows('nested_good', nested, [{ id: 'good', 'items.sku': ['a'], 'items.qty': [2] }])
    expect(good.ok).toBe(true)
    expect(await executor.query(`SELECT id, items.sku AS skus, items.qty AS qty FROM ${qualified(nested)}`, { select_sequential_consistency: '1' })).toEqual([{ id: 'good', skus: ['a'], qty: [2] }])
  }, 30_000)

  test('missing declared metadata fails before the reader or destination is called', async () => {
    const def = { ...invalid, columns: invalid.columns.filter((column) => !column.name.startsWith('_chkit_')) }
    let writes = 0
    const result = await runRows('missing_metadata', def, [{ id: 'bad', amount: 1 }], { async insert() { writes += 1 } })
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', chunks: 0, rows: 0, error: expect.stringContaining('ingestionColumns') })
    expect(writes).toBe(0)
  })

  test('a missing-metadata failure retains the reported checkpoint and journals its configuration diagnostic', async () => {
    const journal = createMemoryJournal()
    let reads = 0
    const build = (def: TableDefinition) => defineStream({
      id: `${prefix}metadata_resume`, destination: def,
      incremental: cursorState({ id: 'test.metadata', version: 1, parse: (state) => state }),
      async *read() { reads += 1; yield { rows: [{ id: 'metadata', amount: 1 }], state: 'saved' } },
    })
    const run = (def: TableDefinition) => runIngestion({
      selected: selectStreams([definePipeline({ id: prefix, streams: [build(def)] })], []), backfill: undefined,
    }, { journal, destination })
    expect((await run(invalid)).streams[0]?.checkpointVersion).toBe(1)
    const failed = await run({ ...invalid, columns: invalid.columns.filter((column) => column.name !== '_chkit_run_id') })
    expect(failed.streams[0]).toMatchObject({ outcome: 'failed', checkpointVersion: 1, chunks: 0, rows: 0 })
    expect(reads).toBe(1)
    const terminal = journal.events.find((event) => event.runId === failed.runId && event.eventKind === 'work_finished')
    expect(terminal).toMatchObject({ workState: 'failed', errorClass: 'config', checkpointVersion: 1 })
    expect(terminal?.detail.error).toContain('_chkit_run_id')
    expect((await journal.readCheckpoint(`${prefix}metadata_resume`)).envelope?.state).toBe('saved')
  }, 30_000)
})
