import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import * as clickhouse from '@chkit/clickhouse'
import { resolveConfig } from '@chkit/core'

import { createIngestPlugin, type IngestPlugin } from './plugin.js'

const directories: string[] = []
const restorers: Array<() => void> = []

afterEach(async () => {
  for (const restore of restorers.splice(0)) restore()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ingest command runtime boundaries', () => {
  test('preserves factory defaults, option validation, and literal flag metadata', () => {
    const plugin: IngestPlugin = createIngestPlugin({ journalTable: 'custom_journal', maxDurationSeconds: 15 })
    expect(plugin.optionsSchema.safeParse({})).toEqual({
      success: true, data: { journalTable: 'custom_journal', maxDurationSeconds: 15, prefetchBatches: 1 },
    })
    expect(plugin.optionsSchema.safeParse({ prefetchBatches: 0 }).success).toBe(false)
    const run = command(plugin, 'run')
    expect(run.optionsSchema).toBe(plugin.optionsSchema)
    expect(run.flags.find((flag) => flag.name === '--max-duration')).toEqual({
      name: '--max-duration', type: 'string', description: 'Execution budget in seconds', placeholder: '<seconds>',
    })
  })

  test('closes a failed run target and restores process signal listeners', async () => {
    const error = new Error('journal ensure failed')
    const target = executor({ command() { throw error } })
    installTarget(target)
    const { context, output } = await commandContext()
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }

    expect(await command(createIngestPlugin(), 'run').run(context)).toBe(1)
    expect(output).toEqual([{ ok: false, command: 'run', error: error.message }])
    expect(target.closed).toBe(1)
    expect(process.listenerCount('SIGINT')).toBe(before.int)
    expect(process.listenerCount('SIGTERM')).toBe(before.term)
  })

  test('returns the ordinary successful run output and releases its resources', async () => {
    const target = executor()
    installTarget(target)
    const { context, output } = await commandContext()
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }

    expect(await command(createIngestPlugin(), 'run').run(context)).toBe(0)
    expect(output).toEqual([{
      command: 'run', ok: true, runId: expect.any(String), cutoff: expect.any(String), streams: [
        expect.objectContaining({ streamId: 'test.first', outcome: 'succeeded', rows: 0 }),
        expect.objectContaining({ streamId: 'test.second', outcome: 'succeeded', rows: 0 }),
      ],
    }])
    expect(target.closed).toBe(1)
    expect(process.listenerCount('SIGINT')).toBe(before.int)
    expect(process.listenerCount('SIGTERM')).toBe(before.term)
  })

  test('lists ordinary stream descriptions without acquiring a target', async () => {
    const acquisition = spyOn(clickhouse, 'createStatelessClickHouseExecutor').mockReturnValue(executor())
    restorers.push(() => acquisition.mockRestore())
    const { context, output } = await commandContext()

    expect(await command(createIngestPlugin(), 'list').run(context)).toBe(0)
    expect(output[0]).toMatchObject({
      ok: true, command: 'list', streams: [
        { streamId: 'test.first', pipelineId: 'test', destination: 'test.rows' },
        { streamId: 'test.second', pipelineId: 'test', destination: 'test.rows' },
      ],
    })
    expect(acquisition).not.toHaveBeenCalled()
  })

  test('keeps close failures ahead of body failures like the previous finally block', async () => {
    const target = executor({
      query() { throw new Error('snapshot failed') },
      close() { throw new Error('close failed') },
    })
    installTarget(target)
    const { context, output } = await commandContext()

    expect(await command(createIngestPlugin(), 'doctor').run(context)).toBe(1)
    expect(output).toEqual([{ ok: false, command: 'doctor', error: 'close failed' }])
    expect(target.closed).toBe(1)
  })

  test('bounds an uncooperative target finalizer with an ordinary error', async () => {
    const release = gate()
    const target = executor({ async close() { await release.promise } })
    installTarget(target)
    const { context, output } = await commandContext()
    expect(await command(createIngestPlugin(), 'doctor').run(context)).toBe(1)
    expect(output.at(-1)).toEqual({ ok: false, command: 'doctor', error: 'Ingestion target cleanup timed out' })
    expect(target.closed).toBe(1)
    release.resolve()
  }, 7000)

  test('closes the target after a print callback fails', async () => {
    const target = executor()
    installTarget(target)
    const { context, output } = await commandContext()
    let prints = 0
    context.print = (value) => {
      prints += 1
      if (prints === 1) throw new Error('output failed')
      output.push(value)
    }

    expect(await command(createIngestPlugin(), 'status').run(context)).toBe(1)
    expect(output).toEqual([{ ok: false, command: 'status', error: 'output failed' }])
    expect(target.closed).toBe(1)
  })

  test('reads checkpoints concurrently but prints them in selection order', async () => {
    const first = gate()
    const secondStarted = gate()
    const calls: string[] = []
    const target = executor({
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('system.one')) return []
        if (sql.includes('system.tables')) return [{ x: 1 }] as T[]
        const namespaceId = sql.includes("namespace_id = 'test.first'") ? 'first' : 'second'
        calls.push(namespaceId)
        if (namespaceId === 'first') await first.promise
        else secondStarted.resolve()
        return []
      },
    })
    installTarget(target)
    const { context, output } = await commandContext()
    const pending = command(createIngestPlugin(), 'status').run(context)
    await secondStarted.promise
    expect(calls).toEqual(['first', 'second'])
    expect(target.closed).toBe(0)
    first.resolve()

    expect(await pending).toBe(0)
    expect(output[0]).toMatchObject({
      ok: true, command: 'status', streams: [
        { streamId: 'test.first', checkpointVersion: 0, checkpoint: null },
        { streamId: 'test.second', checkpointVersion: 0, checkpoint: null },
      ],
    })
    expect(target.closed).toBe(1)
  })

  test('abandons an in-flight doctor snapshot when a sibling fails without publishing late output', async () => {
    const bothStarted = gate()
    const failFirst = gate()
    const finishSecond = gate()
    let reads = 0
    let secondFinished = false
    let closedBeforeSecondFinished = false
    const target = executor({
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('system.tables')) return [{ x: 1 }] as T[]
        reads += 1
        if (reads === 1) {
          await failFirst.promise
          throw new Error('first snapshot failed')
        }
        bothStarted.resolve()
        await finishSecond.promise
        secondFinished = true
        return []
      },
      async close() { closedBeforeSecondFinished = !secondFinished },
    })
    installTarget(target)
    const { context, output } = await commandContext()
    const pending = command(createIngestPlugin(), 'doctor').run(context)
    await bothStarted.promise
    failFirst.resolve()
    expect(await pending).toBe(1)
    expect(output).toEqual([{ ok: false, command: 'doctor', error: 'first snapshot failed' }])
    expect(closedBeforeSecondFinished).toBe(true)
    expect(target.closed).toBe(1)
    finishSecond.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(secondFinished).toBe(true)
    expect(output).toHaveLength(1)
  })

  test('plans repairs sequentially and keeps apply validation ahead of acquisition', async () => {
    const firstStarted = gate()
    const firstFinished = gate()
    let reads = 0
    const target = executor({
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('system.tables')) return [{ x: 1 }] as T[]
        reads += 1
        if (reads === 1) {
          firstStarted.resolve()
          await firstFinished.promise
        }
        return []
      },
    })
    const acquisition = spyOn(clickhouse, 'createStatelessClickHouseExecutor').mockReturnValue(target)
    restorers.push(() => acquisition.mockRestore())
    const { context, output } = await commandContext()
    const repair = command(createIngestPlugin(), 'repair')
    expect(await repair.run({ ...context, flags: { '--apply': 'reviewed' } })).toBe(2)
    expect(acquisition).not.toHaveBeenCalled()
    output.length = 0
    const pending = repair.run(context)
    await firstStarted.promise
    expect(reads).toBe(1)
    firstFinished.resolve()

    expect(await pending).toBe(0)
    expect(reads).toBe(2)
    expect(output[0]).toMatchObject({
      ok: true, command: 'repair', streams: [
        { streamId: 'test.first', applied: false, activated: false },
        { streamId: 'test.second', applied: false, activated: false },
      ],
    })
    expect(target.closed).toBe(1)
  })
})

function command(plugin: IngestPlugin, name: string): IngestPlugin['commands'][number] {
  const found = plugin.commands.find((entry) => entry.name === name)
  if (!found) throw new Error(`Missing command: ${name}`)
  return found
}

async function commandContext() {
  const directory = await mkdtemp(join(tmpdir(), 'chkit-ingest-runtime-'))
  directories.push(directory)
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `
    import { definePipeline, defineStream } from ${JSON.stringify(new URL('./registry.ts', import.meta.url).pathname)}
    import { rawTable } from ${JSON.stringify(new URL('./destination.ts', import.meta.url).pathname)}
    const destination = rawTable({ database: 'test', name: 'rows' })
    export const pipeline = definePipeline({ id: 'test', streams: ['first', 'second'].map((name) =>
      defineStream({ id: 'test.' + name, destination, async *read() { yield { rows: [] } } })
    ) })
  `)
  const output: unknown[] = []
  const context: Parameters<IngestPlugin['commands'][number]['run']>[0] = {
    args: [], flags: {}, jsonMode: true,
    options: { journalTable: 'ingest_journal', maxDurationSeconds: 1, prefetchBatches: 1 },
    config: resolveConfig({ entry, clickhouse: { url: 'http://localhost:8123', database: 'test' } }),
    configPath: entry,
    print: (value) => { output.push(value) },
  }
  return { context, output }
}

function executor(overrides: Partial<clickhouse.ClickHouseExecutor> = {}) {
  const target = {
    async command() {},
    async query<T>(sql: string): Promise<T[]> { return sql.includes('system.tables') ? [{ x: 1 }] as T[] : [] },
    async insert() {},
    async listSchemaObjects() { return [] },
    async listTableDetails() { return [] },
    async submit() { throw new Error('Unexpected submit') },
    async queryStatus() { throw new Error('Unexpected queryStatus') },
    ...overrides,
    closed: 0,
    async close() {
      target.closed += 1
      await overrides.close?.()
    },
  } satisfies clickhouse.ClickHouseExecutor & { closed: number }
  return target
}

function installTarget(target: clickhouse.ClickHouseExecutor): void {
  const spy = spyOn(clickhouse, 'createStatelessClickHouseExecutor').mockReturnValue(target)
  restorers.push(() => spy.mockRestore())
}

function gate() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
