import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '@chkit/core'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { loadDefinitionModules, loadSchemaDefinitions } from '@chkit/core/schema-loader'

import { rawTable } from './destination.js'
import { timestampWindow } from './incremental.js'
import { createIngestPlugin } from './plugin.js'
import { collectPipelines, definePipeline, defineStream, selectStreams } from './registry.js'

const start = new Date('2024-01-01T00:00:00Z')
const cutoff = new Date('2026-09-19T00:00:00Z')
const watermark = '2026-09-18T00:00:00.000Z'

describe('timestampWindow options', () => {
  test('bootstraps at start and applies overlap only to the committed watermark', () => {
    const window = timestampWindow({ start, overlapMs: 3_600_000 })
    expect(window.plan({ state: undefined, cutoff, range: undefined })).toEqual({ from: start, to: cutoff })
    const selection = window.plan({ state: window.parseState({ watermark }), cutoff, range: undefined })
    expect(selection.from).toEqual(new Date('2026-09-17T23:00:00Z'))
    expect(window.complete?.({ state: { watermark }, selection })).toEqual({ watermark: cutoff.toISOString() })
    expect(timestampWindow({ start }).plan({ state: { watermark }, cutoff, range: undefined }).from).toEqual(new Date(watermark))
  })

  test('explicit backfill bounds override start, watermark, overlap, and cutoff', () => {
    const window = timestampWindow({ start, overlapMs: 3_600_000 })
    const range = { from: new Date('2025-01-01'), to: new Date('2025-02-01') }
    const selection = window.plan({ state: { watermark }, cutoff, range })
    expect(selection).toEqual(range)
    expect(window.complete?.({ state: { watermark }, selection })).toEqual({ watermark: range.to.toISOString() })
    expect(window.plan({ state: undefined, cutoff, range: { from: undefined, to: range.to } })).toEqual({ from: start, to: range.to })
  })

  test('retains custom callbacks and the existing checkpoint strategy', () => {
    const window = timestampWindow({ from: ({ watermark: saved, cutoff: end }) => saved ?? end })
    expect(window.plan({ state: undefined, cutoff, range: undefined })).toEqual({ from: cutoff, to: cutoff })
    expect(window.plan({ state: { watermark }, cutoff, range: undefined }).from).toEqual(new Date(watermark))
    expect([window.id, window.version]).toEqual(['chkit.timestamp_window', 1])
  })

  test('rejects invalid bounds and overlap', () => {
    expect(() => timestampWindow({ start: new Date('invalid') })).toThrow('valid Date')
    for (const overlapMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => timestampWindow({ start, overlapMs })).toThrow('non-negative')
    }
    expect(() => timestampWindow({ start: cutoff }).plan({ state: undefined, cutoff: start, range: undefined })).toThrow('after upper bound')
    expect(() => timestampWindow({ from: () => new Date('invalid') }).plan({ state: undefined, cutoff, range: undefined })).toThrow('valid dates')
  })
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('exported pipeline discovery', () => {
  test('side-effect imports stay inactive; re-exports activate pipelines even after a cached import', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-exports-'))
    directories.push(directory)
    const provider = join(directory, 'provider.ts')
    const hidden = join(directory, 'hidden.ts')
    const active = join(directory, 'active.ts')
    await writeFile(provider, `
      import { definePipeline, defineStream } from ${JSON.stringify(new URL('./registry.ts', import.meta.url).pathname)}
      import { rawTable } from ${JSON.stringify(new URL('./destination.ts', import.meta.url).pathname)}
      export const rows = rawTable({ database: 'test', name: 'rows' })
      const stream = defineStream({ id: 'test.rows', destination: rows, async *read() { yield { rows: [] } } })
      export const pipeline = definePipeline({ id: 'test', streams: [stream] })
    `)
    await writeFile(hidden, "import './provider.ts'\nexport { rows } from './provider.ts'\n")
    await writeFile(active, "export { rows, pipeline, pipeline as alias } from './provider.ts'\n")

    expect(collectPipelines(await loadDefinitionModules(hidden))).toEqual([])
    expect(collectPipelines(await loadDefinitionModules(active)).map((pipeline) => pipeline.id)).toEqual(['test'])
    expect(collectPipelines(await loadDefinitionModules(hidden))).toEqual([])
    expect(await loadSchemaDefinitions(active)).toHaveLength(1)

    const plugin = createIngestPlugin()
    const inactiveCheck = await plugin.hooks.onCheck({ config: resolveConfig({ entry: hidden }) })
    expect(inactiveCheck.findings.map((finding) => finding.code)).toEqual(['ingest_no_pipelines'])
    const activeCheck = await plugin.hooks.onCheck({ config: resolveConfig({ entry: active }) })
    expect(activeCheck.findings).toEqual([])

    // A selected host service is insufficient: its insert API may discard JSON/settings.
    for (const command of plugin.commands.filter((command) => command.name !== 'list')) {
      const output: unknown[] = []
      const code = await command.run({
        args: [], flags: {}, jsonMode: true,
        options: { journalTable: 'test_journal', maxDurationSeconds: 1, prefetchBatches: 1 },
        config: resolveConfig({ entry: active }), configPath: active,
        pluginContext: { hasExecutor: true, executor: {} as ClickHouseExecutor },
        print: (value) => { output.push(value) },
      })
      expect(code).toBe(2)
      expect(output[0]).toMatchObject({ ok: false, error: expect.stringContaining('direct ClickHouse connection') })
    }
  })

  test('validates only the selected graph and rejects duplicate pipeline or stream IDs', () => {
    const destination = rawTable({ database: 'test', name: 'rows' })
    const stream = defineStream({ id: 'test.rows', destination, async *read() { yield { rows: [] } } })
    const a = definePipeline({ id: 'a', streams: [stream] })
    const b = definePipeline({ id: 'b', streams: [stream] })
    const duplicate = definePipeline({ id: 'a', streams: [] })
    expect(selectStreams([a], [])).toHaveLength(1)
    expect(selectStreams([b], [])).toHaveLength(1)
    expect(() => collectPipelines([{ a, duplicate }])).toThrow('Duplicate pipeline')
    expect(() => collectPipelines([{ a, b }])).toThrow('globally unique')
    expect(() => selectStreams([a, b], ['pipeline:a'])).toThrow('globally unique')
    expect(() => definePipeline({ id: 'repeat', streams: [stream, stream] })).toThrow('more than once')
  })
})
