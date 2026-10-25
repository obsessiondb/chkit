import { expect, test } from 'bun:test'
import { resolveConfig, table } from '@chkit/core'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { createPullPlugin } from '../../../../plugin-pull/src/index.js'
import { executeBackfill, type BackfillProgress } from '../../../../plugin-backfill/src/async-backfill.js'
import { waitForRows } from '../../../../clickhouse/src/ddl-propagation.js'
import { definePipeline, defineStream, runIngestion, selectStreams } from '../../../../plugin-ingest/src/index.js'
import { createMemoryJournal } from '../../../../plugin-ingest/src/testing.js'
import type { ChxPlugin } from '../../plugins.js'
import { loadPluginRuntime } from '../../runtime/plugin-runtime/index.js'
import { NULL_EXECUTOR } from '../../runtime/plugin-runtime/null-executor.js'

test('abandoning a nested built-in pull prevents first-party continuation after a late introspector', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const returned = Promise.withResolvers<void>()
  let nested: Promise<number> | undefined
  const output: unknown[] = []
  const pull = createPullPlugin({ databases: ['app'], introspect: async () => {
    entered.resolve()
    await release.promise
    returned.resolve()
    return [{ kind: 'view', database: 'app', name: 'late', as: 'SELECT 1' }]
  } })
  const outer: ChxPlugin = {
    manifest: { name: 'outer', apiVersion: 1 },
    hooks: { getContext: () => ({ executor: NULL_EXECUTOR }) },
    commands: [{ name: 'run', async run(context) {
      nested = context.pluginRuntime.runPluginCommand('pull', 'schema', context)
      void nested.catch(() => {})
      await entered.promise
      return 0
    } }],
  }
  const config = resolveConfig({ schema: [], clickhouse: { url: 'http://localhost:8123' }, plugins: [{ plugin: pull }, { plugin: outer }] })
  const runtime = await loadPluginRuntime({ config, configPath: '/config.ts', cliVersion: '0.2.0-beta.11' })
  const input = { config, configPath: '/config.ts', args: [], flags: { '--dryrun': true }, jsonMode: true, print(value: unknown) { output.push(value) } }
  expect(await runtime.runPluginCommand('outer', 'run', input)).toBe(0)
  expect(nested).toBeDefined()
  await expect(nested).rejects.toThrow('CLI execution is no longer active.')
  const atCompletion = [...output]
  release.resolve()
  await returned.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(output).toEqual(atCompletion)
  expect(output.some((value) => typeof value === 'object' && value !== null && 'ok' in value && value.ok === true)).toBe(false)
})

test('a plain SDK call after await inherits its command lifetime without owning the supplied executor', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const returned = Promise.withResolvers<void>()
  const progress: BackfillProgress[] = []
  let closes = 0
  let nested: ReturnType<typeof executeBackfill> | undefined
  const executor: ClickHouseExecutor = {
    ...NULL_EXECUTOR,
    async submit(_sql, queryId) { return queryId ?? 'query' },
    async queryStatus() {
      entered.resolve()
      await release.promise
      returned.resolve()
      return { status: 'finished' }
    },
    async close() { closes += 1 },
  }
  const plugin: ChxPlugin = {
    manifest: { name: 'sdk', apiVersion: 1 },
    commands: [{ name: 'run', async run() {
      await Promise.resolve()
      nested = executeBackfill({
        executor, planId: 'owned', chunks: [{ id: 'one' }], buildQuery: () => 'SELECT 1', pollIntervalMs: 1,
        onProgress(value) { progress.push(value) },
      })
      void nested.catch(() => {})
      await entered.promise
      return 0
    } }],
  }
  const config = resolveConfig({ schema: [], plugins: [{ plugin }] })
  const runtime = await loadPluginRuntime({ config, configPath: '/config.ts', cliVersion: '0.2.0-beta.11' })
  expect(await runtime.runPluginCommand('sdk', 'run', { config, configPath: '/config.ts', args: [], flags: {}, jsonMode: true, print() {} })).toBe(0)
  expect(nested).toBeDefined()
  await expect(nested).rejects.toThrow('Backfill observation interrupted')
  expect(progress).toHaveLength(1)
  release.resolve()
  await returned.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(progress).toHaveLength(1)
  expect(progress[0]?.one?.status).toBe('submitted')
  expect(closes).toBe(0)
})

test('getContext transfers pending initialization into the returned executor lifetime', async () => {
  const release = Promise.withResolvers<void>()
  let closes = 0
  const discovery: ClickHouseExecutor = { ...NULL_EXECUTOR, async query<T>(): Promise<T[]> { await release.promise; return [] } }
  const plugin: ChxPlugin = {
    manifest: { name: 'initialization', apiVersion: 1 },
    hooks: { getContext() {
      const ready = waitForRows(discovery, 'SELECT 1', () => true)
      void ready.catch(() => {})
      return { executor: {
        ...NULL_EXECUTOR,
        async query<T>(): Promise<T[]> { await ready; return [] },
        async close() { closes += 1 },
      } }
    } },
  }
  const config = resolveConfig({ schema: [], plugins: [{ plugin }] })
  const runtime = await loadPluginRuntime({ config, configPath: '/config.ts', cliVersion: '0.2.0-beta.11' })
  const context = await runtime.resolveContext({ config, configPath: '/config.ts', command: 'test', flags: {} })
  release.resolve()
  await expect(context.executor.query('SELECT 1')).resolves.toEqual([])
  expect(closes).toBe(0)
  await runtime.disposeContext(context)
  expect(closes).toBe(1)
})

test('loader construction may start initialization that write subsequently awaits', async () => {
  let written = 0
  const discovery: ClickHouseExecutor = {
    ...NULL_EXECUTOR,
    async query<T>(): Promise<T[]> { await new Promise<void>((resolve) => setImmediate(resolve)); return [] },
  }
  const stream = defineStream({
    id: 'readiness',
    destination: table({ database: 'app', name: 'events', columns: [{ name: 'id', type: 'UInt32' }], engine: 'MergeTree()', orderBy: ['id'] }),
    retry: { retries: 0 },
    async *read() { yield { rows: [{ id: 1 }] } },
    loader(ctx) {
      const ready = waitForRows(discovery, 'SELECT 1', () => true)
      void ready.catch(() => {})
      return {
        ctx,
        async write(batch) {
          await ready
          await ctx.destination.insert({ table: ctx.table, rows: batch.rows, token: batch.batchId })
        },
        async finalize() { return { evidence: 'clickhouse_ack', rows: 1, writeUnits: 1 } },
        async abort() {},
      }
    },
  })
  const pipeline = definePipeline({ id: 'readiness', streams: [stream] })
  const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, {
    journal: createMemoryJournal(), destination: { async insert(input) { written += input.rows.length } },
  })
  expect(result.ok).toBe(true)
  expect(result.streams[0]?.rows).toBe(1)
  expect(written).toBe(1)
})
