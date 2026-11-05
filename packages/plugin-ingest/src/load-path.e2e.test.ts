import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { table, toCreateSQL, type TableDefinition } from '@chkit/core'
import { createPrefix, createStatelessLiveExecutor, LOCAL_STACK_ENV, quoteIdent, waitForColumn, waitForTable } from '@chkit/clickhouse/e2e-testkit'

import { createClickHouseDestination, cursorState, definePipeline, defineStream, ingestionColumns, runIngestion, selectStreams, simpleLoader, stagedLoader, type DestinationAdapter, type Row } from './index.js'
import { createMemoryJournal } from './testing.js'

describe('ingestion load fidelity against ClickHouse', () => {
  const executor = createStatelessLiveExecutor(LOCAL_STACK_ENV)
  const destination = createClickHouseDestination(executor)
  const prefix = createPrefix('load_fidelity')
  const database = prefix.slice(0, -1)
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
  const nested = definition('nested', [{ name: 'items', type: 'Nested(sku String, qty UInt32)' }])
  const raw = definition('raw', [{ name: 'raw', type: 'JSON' }])
  const rest = definition('rest', [{ name: 'label', type: 'String' }, { name: 'raw', type: 'JSON' }, { name: '_chkit_rest', type: 'JSON' }])
  const strict = definition('strict', [{ name: 'label', type: 'String' }])
  const definitions = [replay, timestamps, values, invalid, nested, raw, rest, strict]
  const loaders = { simple: simpleLoader(), staged: stagedLoader({ executor, keys: ['id'], winner: 'first', concurrency: 'single-process' }) }
  const qualified = (def: TableDefinition) => `${quoteIdent(database)}.${quoteIdent(def.name)}`

  beforeAll(async () => {
    await executor.command(`CREATE DATABASE ${quoteIdent(database)} ENGINE = Atomic`)
    for (const def of definitions) {
      await executor.command(toCreateSQL(def))
      await waitForTable(executor, database, def.name)
    }
  }, 60_000)

  afterAll(async () => {
    await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
    await executor.close()
  }, 60_000)

  const runRows = (id: string, def: TableDefinition, rows: readonly Row[], adapter = destination) => {
    const stream = defineStream({
      id: `${prefix}${id}`, destination: def,
      async *read() { yield { rows } },
    })
    return runIngestion({ selected: selectStreams([definePipeline({ id: prefix, streams: [stream] })], []), backfill: undefined }, {
      journal: createMemoryJournal(), destination: adapter,
    })
  }

  test.each([0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])('invalid insert size %p fails at execution without committing rows', async (maxRowsPerInsert) => {
    const journal = createMemoryJournal()
    const stream = defineStream({
      id: `${prefix}invalid_size`, destination: invalid, loader: simpleLoader({ maxRowsPerInsert }),
      incremental: cursorState({ id: 'test.size', version: 1, parse: (state) => state }),
      async *read() { yield { rows: [{ id: 'invalid_size', amount: 1 }], state: 'saved' } },
    })
    const result = await runIngestion({
      selected: selectStreams([definePipeline({ id: prefix, streams: [stream] })], []), backfill: undefined,
    }, { journal, destination })
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, checkpointVersion: 0, error: expect.stringContaining('positive integer') })
    expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
    expect(await executor.query(`SELECT id FROM ${qualified(invalid)} WHERE id = 'invalid_size'`)).toEqual([])
  })

  test.each([[2, 4], [4, 2]])('replay after resizing INSERTs from %i to %i retains every row', async (before, after) => {
    const id = `${prefix}resize_${before}_${after}`
    const journal = createMemoryJournal()
    const rows = [1, 2, 3, 4].map((n) => ({ id: `${before}_${after}_${n}`, value: `row-${n}` }))
    const build = (size: number) => defineStream({
      id, destination: replay, loader: simpleLoader({ maxRowsPerInsert: size }),
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

  test('a delayed column can become visible between load attempts without losing its checkpoint', async () => {
    const def = definition('delayed_column', [
      { name: 'input', type: 'String', defaultKind: 'EPHEMERAL' },
      { name: 'later', type: 'UInt32' },
    ])
    await executor.command(toCreateSQL({ ...def, columns: def.columns.filter((column) => column.name !== 'later') }))
    await waitForTable(executor, database, def.name)
    const journal = createMemoryJournal()
    let failureCode: string | undefined
    const delayed: DestinationAdapter = { async insert(input) {
      try {
        await destination.insert(input)
      } catch (error) {
        if (failureCode !== undefined) throw error
        failureCode = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
        await executor.command(`ALTER TABLE ${qualified(def)} ADD COLUMN later UInt32`)
        await waitForColumn(executor, database, def.name, 'later')
        throw error
      }
    } }
    const stream = defineStream({
      id: `${prefix}delayed_column`, destination: def,
      incremental: cursorState({ id: 'test.column', version: 1, parse: (state) => state }),
      async *read() { yield { rows: [{ id: 'one', later: 7 }], state: 'saved' } },
    })
    const result = await runIngestion({
      selected: selectStreams([definePipeline({ id: prefix, streams: [stream] })], []), backfill: undefined,
    }, { journal, destination: delayed })
    expect(failureCode).toBe('16')
    expect(result.streams[0]).toMatchObject({ outcome: 'succeeded', rows: 1, checkpointVersion: 1 })
    expect((await journal.readCheckpoint(stream.id)).envelope?.state).toBe('saved')
    expect(await executor.query(`SELECT id, later FROM ${qualified(def)}`)).toEqual([{ id: 'one', later: 7 }])
  }, 30_000)

  test('wrong-type rows fail clearly without publishing a checkpoint', async () => {
    const journal = createMemoryJournal()
    const stream = defineStream({
      id: `${prefix}wrong_type`, destination: invalid,
      incremental: cursorState({ id: 'test.type', version: 1, parse: (state) => state }),
      async *read() { yield { rows: [{ id: 'bad_type', amount: 'not a number' }], state: 'saved' } },
    })
    const result = await runIngestion({
      selected: selectStreams([definePipeline({ id: prefix, streams: [stream] })], []), backfill: undefined,
    }, { journal, destination })
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, error: expect.stringContaining('amount') })
    expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
    expect(await executor.query(`SELECT id FROM ${qualified(invalid)} WHERE id = 'bad_type'`)).toEqual([])
  }, 30_000)

  test('Maps whose keys collide in JSON fail instead of dropping an entry', async () => {
    const result = await runRows('map_collision', values, [{ id: 'map_collision', mapped: new Map<unknown, unknown>([[1, 'first'], ['1', 'second']]) }])
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, error: expect.stringContaining('collide') })
    expect(await executor.query(`SELECT id FROM ${qualified(values)} WHERE id = 'map_collision'`)).toEqual([])
  })

  test('Nested parent values fail clearly rather than disappearing, while flattened arrays load', async () => {
    const bad = await runRows('nested_bad', nested, [{ id: 'bad', items: [{ sku: 'a', qty: 2 }] }])
    expect(bad.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, error: expect.stringContaining('items.field') })
    const good = await runRows('nested_good', nested, [{ id: 'good', 'items.sku': ['a'], 'items.qty': [2] }])
    expect(good.ok).toBe(true)
    expect(await executor.query(`SELECT id, items.sku AS skus, items.qty AS qty FROM ${qualified(nested)}`, { select_sequential_consistency: '1' })).toEqual([{ id: 'good', skus: ['a'], qty: [2] }])
  }, 30_000)

  test.each(['simple', 'staged'] as const)('%s loader keeps unknown top-level fields intact in _chkit_rest and logs them once', async (loader) => {
    const logs: string[] = []
    const stream = defineStream({
      id: `${prefix}rest_${loader}`, destination: rest, loader: loaders[loader],
      async *read() {
        yield { rows: [{ id: `${loader}_1`, lable: 'typo', raw: { payload: { kept: 'inside' } } }] }
        yield { rows: [{ id: `${loader}_2`, label: 'fine', extra: { list: ['a', 'b'], flag: true, count: 3 } }], id: 'second' }
      },
    })
    const result = await runIngestion({ selected: selectStreams([definePipeline({ id: prefix, streams: [stream] })], []), backfill: undefined }, {
      journal: createMemoryJournal(), destination, log: (message) => logs.push(message),
    })
    expect(result.streams[0]).toMatchObject({ outcome: 'succeeded', rows: 2, batches: 2 })
    const stored = await executor.query<{ id: string; label: string; rest: string; raw: string }>(
      `SELECT id, label, toJSONString(_chkit_rest) AS rest, toJSONString(raw) AS raw FROM ${qualified(rest)} WHERE startsWith(id, '${loader}_') ORDER BY id`,
      { select_sequential_consistency: '1', output_format_json_quote_64bit_integers: 0 },
    )
    expect(stored.map((row) => ({ ...row, rest: JSON.parse(row.rest), raw: JSON.parse(row.raw) }))).toEqual([
      { id: `${loader}_1`, label: '', rest: { lable: 'typo' }, raw: { payload: { kept: 'inside' } } },
      { id: `${loader}_2`, label: 'fine', rest: { extra: { list: ['a', 'b'], flag: true, count: 3 } }, raw: {} },
    ])
    expect(logs.filter((line) => line.includes('_chkit_rest'))).toEqual([expect.stringContaining('extra, lable')])
  }, 30_000)

  test.each(['simple', 'staged'] as const)('%s loader fails a stream whose field has no column, naming it, and inserts nothing', async (loader) => {
    const journal = createMemoryJournal()
    const stream = defineStream({
      id: `${prefix}strict_${loader}`, destination: strict, loader: loaders[loader],
      incremental: cursorState({ id: 'test.strict', version: 1, parse: (state) => state }),
      async *read() { yield { rows: [{ id: `${loader}_ok`, label: 'fine' }, { id: `${loader}_typo`, lable: 'typo' }], state: 'saved' } },
    })
    const result = await runIngestion({ selected: selectStreams([definePipeline({ id: prefix, streams: [stream] })], []), backfill: undefined }, { journal, destination })
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', rows: 0 })
    for (const name of [stream.id, `${database}.${strict.name}`, 'lable']) expect(result.streams[0]?.error).toContain(name)
    expect((await journal.readCheckpoint(stream.id)).envelope).toBeUndefined()
    expect(await executor.query(`SELECT id FROM ${qualified(strict)} WHERE startsWith(id, '${loader}_')`, { select_sequential_consistency: '1' })).toEqual([])
  }, 30_000)

  test('a row that sets _chkit_rest itself fails instead of being overwritten', async () => {
    const result = await runRows('rest_reserved', rest, [{ id: 'reserved', _chkit_rest: { mine: 1 }, extra: 2 }])
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, error: expect.stringContaining('_chkit_rest') })
    expect(await executor.query(`SELECT id FROM ${qualified(rest)} WHERE id = 'reserved'`)).toEqual([])
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
    expect(terminal).toMatchObject({ workState: 'failed', checkpointVersion: 1 })
    expect(terminal?.detail.error).toContain('_chkit_run_id')
    expect((await journal.readCheckpoint(`${prefix}metadata_resume`)).envelope?.state).toBe('saved')
  }, 30_000)
})
