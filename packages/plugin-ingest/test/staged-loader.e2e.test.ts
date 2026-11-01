import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { createPrefix, createStatelessLiveExecutor, LOCAL_STACK_ENV } from '@chkit/clickhouse/e2e-testkit'
import { type ColumnDefinition, type TableDefinition, quoteIdentifier, table, toCreateSQL } from '@chkit/core'

import { createClickHouseDestination, ingestionColumns, stagedLoader, type Row, type StagedLoaderOptions } from '../src/index.js'

describe('stagedLoader local ClickHouse identity and publication', () => {
  const database = createPrefix('staged_values').slice(0, -1)
  let executor: ClickHouseExecutor
  let sequence = 0

  beforeAll(async () => {
    executor = createStatelessLiveExecutor(LOCAL_STACK_ENV)
    await executor.command(`CREATE DATABASE ${quoteIdentifier(database)} ENGINE = Atomic`)
  })

  afterAll(async () => {
    await executor.command(`DROP DATABASE ${quoteIdentifier(database)} SYNC`)
    await executor.close()
  }, 60_000)

  async function destination(extra: ColumnDefinition[] = [], engine = 'MergeTree()') {
    const definition = table({
      database, name: `items_${sequence++}`, engine, orderBy: ['id'],
      columns: [{ name: 'id', type: 'UInt64' }, { name: 'payload', type: 'String' }, ...extra, ...ingestionColumns],
      settings: { non_replicated_deduplication_window: '0' },
    })
    await executor.command(toCreateSQL(definition))
    return definition
  }

  function attempt(definition: TableDefinition, options: Partial<Omit<StagedLoaderOptions, 'executor'>> = {}) {
    return stagedLoader({ executor, keys: ['id'], winner: 'first', concurrency: 'single-process', ...options })({
      table: definition, destination: createClickHouseDestination(executor), signal: new AbortController().signal,
      streamId: 'test', runId: 'run',
    })
  }

  async function publish(definition: TableDefinition, rows: Row[], options: Partial<Omit<StagedLoaderOptions, 'executor'>> = {}, batchId = 'batch') {
    const loader = attempt(definition, options)
    await loader.write({ batchId, rows })
    return await loader.finalize()
  }

  const contents = (definition: TableDefinition) => executor.query<{ id: string; payload: string }>(
    `SELECT toString(id) AS id, payload FROM ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)} ORDER BY id`,
  )

  test('staging is invisible; intra-stage and destination filtering each remove duplicates', async () => {
    const definition = await destination()
    await publish(definition, [{ id: 1, payload: 'existing' }])
    const loader = attempt(definition, { maxRowsPerInsert: 2 })
    await loader.write({ batchId: 'overlap', rows: [
      { id: 1, payload: 'changed entity is not an update' },
      { id: 2, payload: 'first' }, { id: 2, payload: 'second' }, { id: 3, payload: 'third' },
    ] })
    expect(await contents(definition)).toEqual([{ id: '1', payload: 'existing' }])
    expect(await loader.finalize()).toEqual({ evidence: 'clickhouse_ack', rows: 4, writeUnits: 1 })
    expect(await contents(definition)).toEqual([
      { id: '1', payload: 'existing' }, { id: '2', payload: 'first' }, { id: '3', payload: 'third' },
    ])
    expect(await executor.query(`SELECT name FROM system.tables WHERE database = '${database}' AND startsWith(name, '_chkit_stage_')`)).toEqual([])
  })

  test('first and last winners use input order across physical insert slices and exact ties', async () => {
    for (const winner of ['first', 'last'] as const) {
      for (const maxRowsPerInsert of [1, 2, 10]) {
        const definition = await destination()
        const rows = [{ id: 7, payload: 'a' }, { id: 8, payload: 'tie' }, { id: 7, payload: 'z' }, { id: 8, payload: 'tie' }]
        await publish(definition, rows, { winner, maxRowsPerInsert })
        expect(await contents(definition)).toEqual([{ id: '7', payload: winner === 'first' ? 'a' : 'z' }, { id: '8', payload: 'tie' }])
      }
    }
  })

  test('repeated and all-filtered batches acknowledge input rows without new physical rows', async () => {
    const definition = await destination()
    const rows = [{ id: 1, payload: 'a' }, { id: 1, payload: 'b' }, { id: 2, payload: 'c' }]
    await publish(definition, rows, { maxRowsPerInsert: 1 })
    expect(await publish(definition, rows, { maxRowsPerInsert: 9 })).toEqual({ evidence: 'clickhouse_ack', rows: 3, writeUnits: 1 })
    expect(await publish(definition, [{ id: 1, payload: 'changed' }], {}, 'different-batch')).toEqual({ evidence: 'clickhouse_ack', rows: 1, writeUnits: 1 })
    expect(await contents(definition)).toEqual([{ id: '1', payload: 'a' }, { id: '2', payload: 'c' }])
  })

  test('empty input performs no SQL and returns none_required', async () => {
    const definition = await destination()
    const calls: string[] = []
    const observed: ClickHouseExecutor = { ...executor, async command(sql, settings) { calls.push(sql); await executor.command(sql, settings) } }
    const loader = stagedLoader({ executor: observed, keys: ['id'], winner: 'first', concurrency: 'single-process' })({
      table: definition, signal: new AbortController().signal, destination: createClickHouseDestination(executor), streamId: 'empty', runId: 'empty',
    })
    await loader.write({ batchId: 'empty', rows: [] })
    expect(await loader.finalize()).toEqual({ evidence: 'none_required', rows: 0, writeUnits: 0 })
    expect(calls).toEqual([])
    expect(await contents(definition)).toEqual([])
  })

  test('composite version identity preserves changed observations; native integer equality is exact', async () => {
    const definition = await destination([{ name: 'account', type: 'LowCardinality(String)' }, { name: 'version', type: 'UInt32' }])
    const options = { keys: ['account', 'id', 'version'], maxRowsPerInsert: 1 }
    await publish(definition, [
      { account: 'a', id: '9007199254740993', version: 1, payload: 'v1' },
      { account: 'a', id: 9007199254740993n, version: 1, payload: 'duplicate' },
      { account: 'a', id: '9007199254740993', version: 2, payload: 'v2' },
      { account: 'b', id: '9007199254740993', version: 1, payload: 'another account' },
      { account: 'a', id: '01', version: 1, payload: 'one' },
      { account: 'a', id: 1, version: 1, payload: 'same native integer' },
    ], options)
    expect(await executor.query(`SELECT account, toString(id) AS id, version, payload FROM ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)} ORDER BY account, id, version`)).toEqual([
      { account: 'a', id: '1', version: 1, payload: 'one' },
      { account: 'a', id: '9007199254740993', version: 1, payload: 'v1' },
      { account: 'a', id: '9007199254740993', version: 2, payload: 'v2' },
      { account: 'b', id: '9007199254740993', version: 1, payload: 'another account' },
    ])
  })

  test('defaults and computed destination columns survive while publication metadata is destination-owned', async () => {
    const definition = await destination([
      { name: 'status', type: 'String', default: 'new' },
      { name: 'upper', type: 'String', defaultKind: 'MATERIALIZED', default: 'fn:upper(payload)' },
    ])
    await publish(definition, [{ id: 1, payload: 'hello', _chkit_batch_id: 'spoof', _chkit_run_id: 'spoof', _chkit_ingested_at: '1900-01-01' }])
    expect(await executor.query(`SELECT status, upper, _chkit_batch_id AS batch, _chkit_run_id AS run, _chkit_ingested_at > toDateTime('2020-01-01') AS fresh FROM ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)}`)).toEqual([
      { status: 'new', upper: 'HELLO', batch: 'batch', run: 'run', fresh: 1 },
    ])
  })

  test('missing/null/unsafe-number keys fail without creating scratch or publishing', async () => {
    const definition = await destination()
    for (const rows of [[{ payload: 'missing' }], [{ id: null, payload: 'null' }], [{ id: Number.MAX_SAFE_INTEGER + 1, payload: 'unsafe' }]]) {
      await expect(publish(definition, rows)).rejects.toThrow('key')
    }
    expect(await contents(definition)).toEqual([])
    expect(await executor.query(`SELECT name FROM system.tables WHERE database = '${database}' AND startsWith(name, '_chkit_stage_')`)).toEqual([])
  })

  test('nullable and float identities, missing keys and replacing engines reject explicitly', async () => {
    const definition = await destination([{ name: 'nullable', type: 'Nullable(String)' }, { name: 'floating', type: 'Float64' }])
    for (const key of ['nullable', 'floating', 'missing']) {
      expect(() => attempt(definition, { keys: [key] })).toThrow('non-null scalar column')
    }
    const replacing = await destination([], 'ReplacingMergeTree()')
    const loader = attempt(replacing)
    await expect(loader.write({ batchId: 'unsupported', rows: [{ id: 1, payload: 'x' }] })).rejects.toThrow('plain MergeTree')
    expect(await contents(replacing)).toEqual([])
  })

  test('supported scalar keys deduplicate using their native stored types', async () => {
    const cases = [
      { type: 'String', first: 'event', second: 'other' },
      { type: 'FixedString(4)', first: 'evt1', second: 'evt2' },
      { type: 'Int64', first: '-9223372036854775808', second: '9223372036854775807' },
      { type: 'UInt128', first: '340282366920938463463374607431768211455', second: '0' },
      { type: 'UUID', first: '12345678-1234-1234-1234-123456789abc', second: '12345678-1234-1234-1234-123456789abd' },
      { type: 'IPv4', first: '192.0.2.1', second: '192.0.2.2' },
      { type: 'IPv6', first: '2001:db8::1', second: '2001:db8::2' },
      { type: 'Date', first: '2026-01-01', second: '2026-01-02' },
      { type: 'Date32', first: '1901-01-01', second: '1901-01-02' },
      { type: "DateTime('UTC')", first: '2026-01-01 00:00:00', second: '2026-01-01 00:00:01' },
      { type: "DateTime64(6, 'UTC')", first: '2026-01-01 00:00:00.123456', second: '2026-01-01 00:00:00.123457' },
      { type: 'LowCardinality(String)', first: 'event', second: 'other' },
    ]
    for (const { type, first, second } of cases) {
      const definition = await destination([{ name: 'identity', type }])
      await publish(definition, [
        { id: 1, identity: first, payload: 'first' }, { id: 2, identity: first, payload: 'duplicate' },
        { id: 3, identity: second, payload: 'distinct' },
      ], { keys: ['identity'], maxRowsPerInsert: 1 })
      await publish(definition, [{ id: 4, identity: first, payload: 'replay' }], { keys: ['identity'] })
      expect(await contents(definition)).toEqual([{ id: '1', payload: 'first' }, { id: '3', payload: 'distinct' }])
    }
  }, 30_000)

  test('the entire winning row preserves null payloads instead of skipping them during aggregation', async () => {
    const definition = await destination([{ name: 'optional', type: 'Nullable(String)' }])
    await publish(definition, [{ id: 1, payload: 'first', optional: null }, { id: 1, payload: 'last', optional: 'not null' }])
    expect(await executor.query(`SELECT payload, optional FROM ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)}`)).toEqual([{ payload: 'first', optional: null }])
  })

  test('existing destination duplicates remain; insert-if-absent does not repair them', async () => {
    const definition = await destination()
    await executor.insert({ table: `${database}.${definition.name}`, values: [{ id: 1, payload: 'a' }, { id: 1, payload: 'b' }] })
    await publish(definition, [{ id: 1, payload: 'new' }, { id: 2, payload: 'c' }])
    expect(await executor.query(`SELECT toString(id) AS id, toString(count()) AS copies FROM ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)} GROUP BY id ORDER BY id`)).toEqual([
      { id: '1', copies: '2' }, { id: '2', copies: '1' },
    ])
  })

  test('actual nullable schema drift rejects a key even if the declaration still says String', async () => {
    const definition = await destination([{ name: 'identity', type: 'String' }])
    await executor.command(`ALTER TABLE ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)} MODIFY COLUMN identity Nullable(String)`)
    const loader = attempt(definition, { keys: ['identity'] })
    await expect(loader.write({ batchId: 'drift', rows: [{ id: 1, identity: 'x', payload: 'x' }] })).rejects.toThrow('non-null scalar column')
    expect(await contents(definition)).toEqual([])
  })

  test('publication-time metadata drift rejects missing defaults and computed aliases', async () => {
    for (const modification of ['REMOVE DEFAULT', "DateTime64(6, 'UTC') ALIAS now64(6)"]) {
      const definition = await destination()
      await executor.command(`ALTER TABLE ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)} MODIFY COLUMN _chkit_ingested_at ${modification}`)
      const loader = attempt(definition)
      await expect(loader.write({ batchId: 'metadata-drift', rows: [{ id: 1, payload: 'x' }] })).rejects.toThrow('publication-time default')
      expect(await contents(definition)).toEqual([])
    }
  })

  test('strict join overflow fails instead of treating unread existing keys as absent', async () => {
    const definition = await destination()
    await publish(definition, Array.from({ length: 10 }, (_, id) => ({ id, payload: `existing-${id}` })))
    const constrained: ClickHouseExecutor = {
      ...executor,
      submit(sql, id, settings) {
        expect(settings?.join_overflow_mode).toBe('throw')
        return executor.submit(sql, id, { join_overflow_mode: 'break', ...settings, max_rows_in_join: '1', max_block_size: '1', max_threads: 1 })
      },
    }
    const loader = stagedLoader({ executor: constrained, keys: ['id'], winner: 'first', concurrency: 'single-process' })({
      table: definition, destination: createClickHouseDestination(executor), signal: new AbortController().signal, streamId: 'overflow', runId: 'overflow',
    })
    await loader.write({ batchId: 'overflow', rows: [{ id: 8, payload: 'must not duplicate' }, { id: 9, payload: 'must not duplicate either' }, { id: 10, payload: 'must not acknowledge partial selection' }] })
    await expect(loader.finalize()).rejects.toThrow(/JOIN|join/)
    await loader.abort('expected resource failure')
    expect((await contents(definition)).length).toBe(10)
  }, 30_000)

  test('strict staging refuses format-error skipping and never finalizes a failed write', async () => {
    const definition = await destination([{ name: 'quantity', type: 'UInt32' }])
    const permissive: ClickHouseExecutor = {
      ...executor,
      insert(params) {
        expect(params.settings).toMatchObject({ input_format_allow_errors_num: '0', input_format_allow_errors_ratio: 0 })
        return executor.insert({ ...params, settings: { input_format_allow_errors_num: '100', input_format_allow_errors_ratio: 1, ...params.settings } })
      },
    }
    const loader = stagedLoader({ executor: permissive, keys: ['id'], winner: 'first', concurrency: 'single-process' })({
      table: definition, destination: createClickHouseDestination(executor), signal: new AbortController().signal, streamId: 'format', runId: 'format',
    })
    await expect(loader.write({ batchId: 'format', rows: [{ id: 1, payload: 'good', quantity: 1 }, { id: 2, payload: 'bad', quantity: 'invalid' }] })).rejects.toThrow()
    await expect(loader.finalize()).rejects.toThrow('must write before finalizing')
    await loader.abort('expected parser failure')
    expect(await contents(definition)).toEqual([])
  })

  test('strict candidate-key set overflow rejects instead of hiding existing destination keys', async () => {
    const definition = await destination()
    await publish(definition, [{ id: 1, payload: 'existing' }, { id: 2, payload: 'existing too' }])
    const limited: ClickHouseExecutor = {
      ...executor,
      submit(sql, id, settings) {
        expect(settings?.set_overflow_mode).toBe('throw')
        return executor.submit(sql, id, { set_overflow_mode: 'break', ...settings, max_rows_in_set: '1' })
      },
    }
    const loader = stagedLoader({ executor: limited, keys: ['id'], winner: 'first', concurrency: 'single-process' })({
      table: definition, destination: createClickHouseDestination(executor), signal: new AbortController().signal, streamId: 'set', runId: 'set',
    })
    await loader.write({ batchId: 'set', rows: [{ id: 1, payload: 'duplicate' }, { id: 2, payload: 'duplicate too' }, { id: 3, payload: 'new' }] })
    await expect(loader.finalize()).rejects.toThrow(/set|Set/)
    await loader.abort('expected set overflow')
    expect(await contents(definition)).toEqual([{ id: '1', payload: 'existing' }, { id: '2', payload: 'existing too' }])
  }, 30_000)
})
