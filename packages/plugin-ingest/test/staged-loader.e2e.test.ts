import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { createPrefix, createStatelessLiveExecutor, LOCAL_STACK_ENV, pollUntil } from '@chkit/clickhouse/e2e-testkit'
import { type ColumnDefinition, type TableDefinition, quoteIdentifier, table, toCreateSQL } from '@chkit/core'

import { createClickHouseDestination, ingestionColumns, stagedLoader, type Row, type StagedLoaderOptions } from '@chkit/plugin-ingest'

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

  async function destination(extra: ColumnDefinition[] = []) {
    const definition = table({
      database, name: `items_${sequence++}`, engine: 'MergeTree()', orderBy: ['id'],
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

  async function publish(definition: TableDefinition, rows: Row[], options: Partial<Omit<StagedLoaderOptions, 'executor'>> = {}) {
    const loader = attempt(definition, options)
    await loader.write({ batchId: 'batch', rows })
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

  test('last winner selects the entire nullable row across physical slices', async () => {
    const definition = await destination([{ name: 'optional', type: 'Nullable(String)' }])
    await publish(definition, [
      { id: 7, payload: 'first', optional: 'earlier' },
      { id: 8, payload: 'other', optional: 'kept' },
      { id: 7, payload: 'last', optional: null },
    ], { winner: 'last', maxRowsPerInsert: 2 })
    expect(await executor.query(`SELECT toString(id) AS id, payload, optional FROM ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)} ORDER BY id`)).toEqual([
      { id: '7', payload: 'last', optional: null }, { id: '8', payload: 'other', optional: 'kept' },
    ])
  })

  test('repeated and all-filtered batches acknowledge input rows without new physical rows', async () => {
    const definition = await destination()
    const rows = [{ id: 1, payload: 'a' }, { id: 1, payload: 'b' }, { id: 2, payload: 'c' }]
    await publish(definition, rows, { maxRowsPerInsert: 1 })
    expect(await publish(definition, rows, { maxRowsPerInsert: 9 })).toEqual({ evidence: 'clickhouse_ack', rows: 3, writeUnits: 1 })
    expect(await contents(definition)).toEqual([{ id: '1', payload: 'a' }, { id: '2', payload: 'c' }])
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

  test('missing/null/unsafe-number keys fail without creating scratch or publishing', async () => {
    const definition = await destination()
    for (const rows of [
      [{ payload: 'missing' }], [{ id: null, payload: 'null' }],
      [{ id: Number.MAX_SAFE_INTEGER + 1, payload: 'unsafe' }],
    ]) {
      await expect(publish(definition, rows)).rejects.toThrow('key')
    }
    expect(await contents(definition)).toEqual([])
    expect(await executor.query(`SELECT name FROM system.tables WHERE database = '${database}' AND startsWith(name, '_chkit_stage_')`)).toEqual([])
  })

  test('materialized and alias default dependencies preserve stored values and explicit overrides', async () => {
    const definition = await destination([
      { name: 'base', type: 'UInt64', defaultKind: 'MATERIALIZED', default: 'fn:id + 1' },
      { name: 'derived', type: 'UInt64', defaultKind: 'ALIAS', default: 'fn:base + 10' },
      { name: 'copy', type: 'UInt64', default: 'fn:derived' },
    ])
    const loader = attempt(definition)
    await loader.write({ batchId: 'computed-default', rows: [{ id: 1, payload: 'default' }, { id: 2, payload: 'explicit', copy: 99 }] })
    await loader.finalize()
    expect(await executor.query(`SELECT toString(id) AS id, toString(base) AS base, toString(derived) AS derived, toString(copy) AS copy FROM ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)} ORDER BY id`)).toEqual([
      { id: '1', base: '2', derived: '12', copy: '12' },
      { id: '2', base: '3', derived: '13', copy: '99' },
    ])
  })

  test('ordinary defaults retain staging time while generated columns use publication time', async () => {
    const definition = await destination([
      { name: 'observed_at', type: "DateTime64(6, 'UTC')", default: 'fn:_chkit_ingested_at' },
      { name: 'published_at', type: "DateTime64(6, 'UTC')", defaultKind: 'MATERIALIZED', default: 'fn:_chkit_ingested_at' },
      { name: 'derived_at', type: "DateTime64(6, 'UTC')", defaultKind: 'ALIAS', default: 'fn:published_at' },
      { name: 'copied_at', type: "DateTime64(6, 'UTC')", default: 'fn:derived_at' },
    ])
    const serverTime = async () => {
      const rows = await executor.query<{ micros: string }>('SELECT toString(toUnixTimestamp64Micro(now64(6))) AS micros')
      return BigInt(rows[0]?.micros ?? '0')
    }
    const loader = attempt(definition)
    const beforeStaging = await serverTime()
    await loader.write({ batchId: 'metadata-default', rows: [{ id: 1, payload: 'default', _chkit_ingested_at: '1900-01-01' }] })
    const afterStaging = await serverTime()
    expect(await contents(definition)).toEqual([])
    expect(await pollUntil(serverTime, (time) => time > afterStaging)).toBeGreaterThan(afterStaging)
    const receipt = await loader.finalize()
    expect(receipt).toEqual({ evidence: 'clickhouse_ack', rows: 1, writeUnits: 1 })
    expect(await executor.query(`SELECT toUnixTimestamp64Micro(observed_at) BETWEEN ${beforeStaging} AND ${afterStaging} AS staged, toUnixTimestamp64Micro(_chkit_ingested_at) > ${afterStaging} AS fresh_publication, published_at = _chkit_ingested_at AS materialized_at_publication, derived_at = _chkit_ingested_at AS alias_at_publication, copied_at = observed_at AS copied_at_staging FROM ${quoteIdentifier(database)}.${quoteIdentifier(definition.name)}`)).toEqual([
      { staged: 1, fresh_publication: 1, materialized_at_publication: 1, alias_at_publication: 1, copied_at_staging: 1 },
    ])
  })

  test('strict join overflow fails instead of treating unread existing keys as absent', async () => {
    const definition = await destination()
    const existing = Array.from({ length: 10 }, (_, id) => ({ id, payload: `existing-${id}` }))
    await publish(definition, existing)
    const constrained: ClickHouseExecutor = {
      ...executor,
      submit(sql, id, settings) {
        return executor.submit(sql, id, { join_overflow_mode: 'break', ...settings, max_rows_in_join: '1', max_block_size: '1', max_threads: 1 })
      },
    }
    const loader = stagedLoader({ executor: constrained, keys: ['id'], winner: 'first', concurrency: 'single-process' })({
      table: definition, destination: createClickHouseDestination(executor), signal: new AbortController().signal, streamId: 'overflow', runId: 'overflow',
    })
    await loader.write({ batchId: 'overflow', rows: [{ id: 8, payload: 'must not duplicate' }, { id: 9, payload: 'must not duplicate either' }, { id: 10, payload: 'must not acknowledge partial selection' }] })
    await expect(loader.finalize()).rejects.toThrow(/JOIN|join/)
    await loader.abort('expected resource failure')
    expect(await contents(definition)).toEqual(existing.map((row) => ({ ...row, id: String(row.id) })))
  }, 30_000)

  test('malformed payloads cannot be skipped and acknowledged', async () => {
    const definition = await destination([{ name: 'quantity', type: 'UInt32' }])
    const permissive: ClickHouseExecutor = {
      ...executor,
      insert(params) {
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
    expect(await executor.query(`SELECT name FROM system.tables WHERE database = '${database}' AND startsWith(name, '_chkit_stage_')`)).toEqual([])
  })

  test('strict candidate-key set overflow rejects instead of hiding existing destination keys', async () => {
    const definition = await destination()
    await publish(definition, [{ id: 1, payload: 'existing' }, { id: 2, payload: 'existing too' }])
    const limited: ClickHouseExecutor = {
      ...executor,
      submit(sql, id, settings) {
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
