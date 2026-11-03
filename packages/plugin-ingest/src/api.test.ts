import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '@chkit/core'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { loadDefinitionModules, loadSchemaDefinitions } from '@chkit/core/schema-loader'

import { rawTable } from './destination.js'
import { timestampWindow } from './incremental.js'
import { checkGraph, createIngestPlugin, formatStreamErrors } from './plugin.js'
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

  test('checks its options when it plans, never when it is defined or selected', () => {
    const plan = (window: ReturnType<typeof timestampWindow>) => () => window.plan({ state: undefined, cutoff, range: undefined })
    expect(selecting({ incremental: timestampWindow({ start: new Date('invalid') }) })()).toHaveLength(1)
    expect(plan(timestampWindow({ start: new Date('invalid') }))).toThrow('timestampWindow: start must be a valid Date.')
    for (const overlapMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(plan(timestampWindow({ start, overlapMs }))).toThrow('non-negative')
    }
    expect(() => timestampWindow({ start: cutoff }).plan({ state: undefined, cutoff: start, range: undefined })).toThrow('after upper bound')
    expect(() => timestampWindow({ from: () => new Date('invalid') }).plan({ state: undefined, cutoff, range: undefined })).toThrow('valid dates')
  })

  test('rejects invalid planned dates while preserving equal windows', () => {
    const window = timestampWindow({ from: () => cutoff })
    const selection = window.plan({ state: undefined, cutoff, range: undefined })
    expect(selection.from.getTime()).toBe(cutoff.getTime())
    expect(window.complete?.({ state: undefined, selection })).toEqual({ watermark: cutoff.toISOString() })
    expect(() => timestampWindow({ from: () => '2026-01-01' as unknown as Date }).plan({ state: undefined, cutoff, range: undefined })).toThrow('planned bounds must be valid dates')
    expect(() => window.plan({ state: undefined, cutoff, range: { from: cutoff, to: 'invalid' as unknown as Date } })).toThrow('planned bounds must be valid dates')
    expect(() => window.plan({ state: undefined, cutoff, range: { from: cutoff, to: new Date('invalid') } })).toThrow('planned bounds must be valid dates')
  })
})

function selecting(input: Partial<Parameters<typeof defineStream>[0]>) {
  const stream = defineStream({ id: 'x', destination: rawTable({ database: 'test', name: 'rows' }), async *read() {}, ...input })
  return () => selectStreams([definePipeline({ id: 'p', streams: [stream] })], [])
}

describe('run output', () => {
  test('identical stream errors are printed once with the streams they affect', () => {
    const stream = (namespaceId: string, outcome: 'failed' | 'succeeded', error?: string) => ({
      streamId: namespaceId, pipelineId: 'meet', namespaceId, outcome, rows: 0, batches: 0, chunks: 0, checkpointVersion: 0, error,
    })
    expect(formatStreamErrors([
      stream('meet.conferences', 'failed', 'Set GOOGLE_MEET_ACCESS_TOKEN.'),
      stream('meet.recordings', 'succeeded'),
      stream('meet.transcripts', 'failed', 'Set GOOGLE_MEET_ACCESS_TOKEN.'),
      stream('meet.participants', 'failed', 'HTTP 403 Forbidden'),
    ])).toEqual([
      '2 streams failed: Set GOOGLE_MEET_ACCESS_TOKEN.',
      '  meet.conferences, meet.transcripts',
      'meet.participants failed: HTTP 403 Forbidden',
    ])
  })
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('recovery command registration', () => {
  test('offers read-only doctor and review-first repair with an explicit fingerprint', () => {
    const commands = createIngestPlugin().commands
    expect(commands.map((command) => command.name)).toEqual(['run', 'list', 'doctor', 'repair', 'status'])
    const repair = commands.find((command) => command.name === 'repair')
    expect(repair?.flags.find((flag) => flag.name === '--apply')).toMatchObject({ type: 'string' })
    expect(repair?.flags.find((flag) => flag.name === '--backfill')).toBeDefined()
  })
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
    expect(() => selectStreams([definePipeline({ id: 'repeat', streams: [stream, stream] })], [])).toThrow('more than once')
  })

  test('malformed definitions import cleanly and fail when an ingest command selects them', () => {
    const destination = rawTable({ database: 'test', name: 'rows' })
    const read = async function* () { yield { rows: [] } }
    expect(selecting({ id: undefined as unknown as string })).toThrow('Invalid stream id undefined')
    expect(selecting({ destination: { database: 'test', name: 'rows' } as never })).toThrow('destination must be a table definition')
    expect(selecting({ read: undefined as never })).toThrow('read must be a function')
    expect(selecting({ tags: 'schedule:1h' as never })).toThrow('tags must be an array of non-empty strings')
    expect(selecting({ tags: [''] })).toThrow('tags must be an array of non-empty strings')
    for (const maxChunks of [0, 1.5, Number.NaN]) {
      expect(selecting({ budget: { maxChunks } })).toThrow('budget.maxChunks must be a positive integer')
    }
    expect(selecting({ budget: { maxChunkRows: -5 } })).toThrow('budget.maxChunkRows must be a positive integer')

    const stream = defineStream({ id: 'test.rows', destination, read })
    const pipeline = (input: Partial<Parameters<typeof definePipeline>[0]>) => () => selectStreams([definePipeline({ id: 'p', streams: [stream], ...input })], [])
    expect(pipeline({ streams: undefined as never })).toThrow('streams must be an array')
    expect(pipeline({ streams: [{ id: 'q' } as never] })).toThrow('streams must contain only defineStream(...) values')
    expect(pipeline({ maxLoads: 0 })).toThrow('maxLoads must be a positive integer')

    const spread = { ...definePipeline({ id: 'p', streams: [{ ...defineStream({ id: 'x', destination, read }), budget: { maxChunks: 0 } }] }) }
    expect(() => selectStreams([spread], [])).toThrow('Stream "x": budget.maxChunks must be a positive integer.')
  })

  test('a definition error is raised only for the pipelines a command selects', () => {
    const destination = rawTable({ database: 'test', name: 'rows' })
    const meet = definePipeline({
      id: 'meet', tags: ['provider:meet'],
      streams: [defineStream({ id: 'meet.rows', destination, budget: { maxChunks: 0 }, async *read() {} })],
    })
    const slack = definePipeline({ id: 'slack', tags: ['provider:slack'], streams: [defineStream({ id: 'slack.rows', destination, async *read() {} })] })

    expect(selectStreams([meet, slack], ['provider:slack']).map((entry) => entry.stream.id)).toEqual(['slack.rows'])
    expect(() => selectStreams([meet, slack], [])).toThrow('Stream "meet.rows": budget.maxChunks must be a positive integer.')
    expect(checkGraph([meet, slack])).toEqual([
      { code: 'ingest_invalid_pipeline', message: 'Stream "meet.rows": budget.maxChunks must be a positive integer.', severity: 'error' },
    ])
  })

  test('declared tags cannot impersonate the derived stream: and pipeline: tags', () => {
    const destination = rawTable({ database: 'test', name: 'rows' })
    const read = async function* () { yield { rows: [] } }
    expect(selecting({ id: 'one', tags: ['stream:two'] })).toThrow('tag "stream:two" uses a reserved prefix')
    expect(() => selectStreams([definePipeline({ id: 'p', streams: [], tags: ['pipeline:other'] })], [])).toThrow('tag "pipeline:other" uses a reserved prefix')
    const one = defineStream({ id: 'one', destination, read, tags: ['Schedule:1h', 'streams:all'] })
    const two = defineStream({ id: 'two', destination, read })
    const pipelines = [definePipeline({ id: 'p', streams: [one] }), definePipeline({ id: 'other', streams: [two] })]
    expect(selectStreams(pipelines, ['stream:two']).map((entry) => entry.stream.id)).toEqual(['two'])
    expect(selectStreams(pipelines, ['pipeline:other']).map((entry) => entry.stream.id)).toEqual(['two'])
    expect(selectStreams(pipelines, ['streams:all']).map((entry) => entry.stream.id)).toEqual(['one'])
    expect(() => selectStreams(pipelines, ['schedule:1h'])).toThrow('No stream matches')
  })

  test('run rejects an execution budget the timer cannot hold instead of expiring it at once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-budget-'))
    directories.push(directory)
    const entry = join(directory, 'entry.ts')
    await writeFile(entry, `
      import { definePipeline, defineStream } from ${JSON.stringify(new URL('./registry.ts', import.meta.url).pathname)}
      import { rawTable } from ${JSON.stringify(new URL('./destination.ts', import.meta.url).pathname)}
      export const rows = rawTable({ database: 'test', name: 'rows' })
      export const pipeline = definePipeline({ id: 'test', streams: [defineStream({ id: 'test.rows', destination: rows, async *read() { yield { rows: [] } } })] })
    `)
    const run = createIngestPlugin().commands.find((command) => command.name === 'run')
    const output: unknown[] = []
    const code = await run?.run({
      args: [], flags: { '--max-duration': '2147484' }, jsonMode: true,
      options: { journalTable: 'test_journal', maxDurationSeconds: 1, prefetchBatches: 1 },
      config: resolveConfig({ entry }), configPath: entry,
      print: (value) => { output.push(value) },
    })
    expect(code).toBe(2)
    expect(output[0]).toMatchObject({ ok: false, command: 'run', error: expect.stringContaining('Invalid value for --max-duration: 2147484') })
    expect(createIngestPlugin().optionsSchema.safeParse({ maxDurationSeconds: 2_147_484 }).success).toBe(false)
    expect(createIngestPlugin().optionsSchema.safeParse({ maxDurationSeconds: 2_147_483 }).success).toBe(true)
  })

  test('an invalid definition leaves schema loading alone and fails every ingest command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-definition-'))
    directories.push(directory)
    const entry = join(directory, 'entry.ts')
    await writeFile(entry, `
      import { definePipeline, defineStream } from ${JSON.stringify(new URL('./registry.ts', import.meta.url).pathname)}
      import { rawTable } from ${JSON.stringify(new URL('./destination.ts', import.meta.url).pathname)}
      export const rows = rawTable({ database: 'test', name: 'rows' })
      export const pipeline = definePipeline({
        id: 'test',
        streams: [defineStream({ id: 'test.rows', destination: rows, budget: { maxChunks: 0 }, async *read() {} })],
      })
    `)
    expect((await loadSchemaDefinitions(entry)).map((definition) => definition.name)).toEqual(['rows'])

    const plugin = createIngestPlugin()
    const check = await plugin.hooks.onCheck({ config: resolveConfig({ entry }) })
    expect(check).toMatchObject({ ok: false, findings: [{ code: 'ingest_invalid_pipeline', message: 'Stream "test.rows": budget.maxChunks must be a positive integer.' }] })
    for (const command of plugin.commands) {
      const output: unknown[] = []
      const code = await command.run({
        args: [], flags: {}, jsonMode: true,
        options: { journalTable: 'test_journal', maxDurationSeconds: 1, prefetchBatches: 1 },
        config: resolveConfig({ entry }), configPath: entry,
        print: (value) => { output.push(value) },
      })
      expect(code).toBe(2)
      expect(output[0]).toMatchObject({ ok: false, command: command.name, error: 'Stream "test.rows": budget.maxChunks must be a positive integer.' })
    }
  })

  test('any error thrown while building a pipeline is a configuration error for every command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-setup-'))
    directories.push(directory)
    const entry = join(directory, 'entry.ts')
    await writeFile(entry, `
      function createPipeline(pageSize: number) {
        if (pageSize > 100) throw new RangeError('pageSize must be at most 100')
      }
      export const pipeline = createPipeline(500)
    `)
    for (const command of createIngestPlugin().commands) {
      const output: unknown[] = []
      const code = await command.run({
        args: [], flags: {}, jsonMode: true,
        options: { journalTable: 'test_journal', maxDurationSeconds: 1, prefetchBatches: 1 },
        config: resolveConfig({ entry }), configPath: entry,
        print: (value) => { output.push(value) },
      })
      expect(code).toBe(2)
      expect(output[0]).toMatchObject({ ok: false, command: command.name, error: expect.stringContaining('pageSize must be at most 100') })
    }
  })
})
