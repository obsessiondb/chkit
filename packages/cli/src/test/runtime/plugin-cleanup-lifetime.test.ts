import { expect, test } from 'bun:test'
import { setImmediate } from 'node:timers/promises'
import { resolveConfig } from '@chkit/core'
import { type ClickHouseExecutor, waitForTableAbsent } from '@chkit/clickhouse'

import type { ChxPlugin } from '../../plugins.js'
import { loadPluginRuntime } from '../../runtime/plugin-runtime/index.js'
import { NULL_EXECUTOR } from '../../runtime/plugin-runtime/null-executor.js'

test('natural plugin completion waits beyond the interruption grace for its one executor close', async () => {
  const closing = gate<void>()
  const release = gate<void>()
  let closes = 0
  const { runtime, context } = await runtimeFor({
    manifest: { name: 'cleanup', apiVersion: 1 },
    hooks: { getContext: () => ({ executor: { ...NULL_EXECUTOR, async close() {
      closes += 1
      closing.resolve()
      await release.promise
    } } }) },
    commands: [{ name: 'run', run: () => 7 }],
  })
  const result = outcome(runtime.runPluginCommand('cleanup', 'run', context))
  try {
    await closing.promise
    expect(await observeWithin(result, 5_200)).toEqual({ kind: 'timeout' })
    expect(closes).toBe(1)
    release.resolve()
    expect(await result).toEqual({ kind: 'fulfilled', value: 7 })
    expect(closes).toBe(1)
  } finally {
    release.resolve()
    await result
  }
}, 10_000)

test.each([false, true])('natural cleanup failure preserves its exact identity and runs once (body failed: %s)', async (bodyFailed) => {
  const bodyFailure = new Error('command failed')
  const closeFailure = new Error('executor close failed')
  let closes = 0
  const { runtime, context } = await runtimeFor({
    manifest: { name: 'cleanup', apiVersion: 1 },
    hooks: { getContext: () => ({ executor: { ...NULL_EXECUTOR, async close() {
      closes += 1
      throw closeFailure
    } } }) },
    commands: [{ name: 'run', run() {
      if (bodyFailed) throw bodyFailure
      return 7
    } }],
  })
  await expect(runtime.runPluginCommand('cleanup', 'run', context)).rejects.toBe(closeFailure)
  expect(closes).toBe(1)
})

test('an ordinary executor close can await public SDK work before and after an await', async () => {
  const queries: string[] = []
  const discovery: ClickHouseExecutor = { ...NULL_EXECUTOR, async query<T>(sql: string): Promise<T[]> {
    queries.push(sql)
    return []
  } }
  let closes = 0
  const { runtime, context } = await runtimeFor({
    manifest: { name: 'cleanup', apiVersion: 1 },
    hooks: { getContext: () => ({ executor: { ...NULL_EXECUTOR, async close() {
      closes += 1
      await waitForTableAbsent(discovery, 'app', 'before_await')
      await setImmediate()
      await waitForTableAbsent(discovery, 'app', 'after_await')
    } } }) },
    commands: [{ name: 'run', run: () => 7 }],
  })
  expect(await runtime.runPluginCommand('cleanup', 'run', context)).toBe(7)
  expect(queries.filter(sql => sql.includes('system.tables'))).toEqual([
    "SELECT 1 AS x FROM system.tables WHERE database = 'app' AND name = 'before_await'",
    "SELECT 1 AS x FROM system.tables WHERE database = 'app' AND name = 'after_await'",
  ])
  expect(closes).toBe(1)
})

test('abandoning a held plugin body bounds its executor cleanup without closing twice or accepting a late failure', async () => {
  const fixture = await nestedCleanup('body')
  try {
    await fixture.closeEntered.promise
    const started = performance.now()
    const observed = await observeWithin(fixture.owner, 7_000)
    expect(observed).toEqual({ kind: 'settled', result: { kind: 'fulfilled', value: 0 } })
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_500)
    expect(await fixture.child.promise).toMatchObject({ kind: 'rejected', error: expect.any(Error) })
    expect(fixture.events.filter(event => event === 'close:inner:start')).toHaveLength(1)
    expect(fixture.events.filter(event => event === 'close:outer:start')).toHaveLength(1)
    expect(fixture.events).not.toContain('close:inner:end')
    const rejected = await fixture.child.promise
    fixture.releaseClose.reject(new Error('late close rejection'))
    fixture.releaseBody.resolve()
    await setImmediate()
    expect(await fixture.child.promise).toBe(rejected)
    expect(fixture.events.filter(event => event === 'close:inner:start')).toHaveLength(1)
    expect(fixture.events.filter(event => event === 'close:outer:start')).toHaveLength(1)
  } finally {
    fixture.releaseClose.resolve()
    fixture.releaseBody.resolve()
    await fixture.owner
    await fixture.child.promise
  }
}, 10_000)

test('abandoning a child already in natural cleanup stops waiting without invoking close again', async () => {
  const fixture = await nestedCleanup('cleanup')
  try {
    await fixture.closeEntered.promise
    expect(await observeWithin(fixture.owner, 7_000)).toEqual({ kind: 'settled', result: { kind: 'fulfilled', value: 0 } })
    expect(await fixture.child.promise).toMatchObject({ kind: 'rejected', error: expect.any(Error) })
    expect(fixture.events.filter(event => event === 'close:inner:start')).toHaveLength(1)
    expect(fixture.events).not.toContain('close:inner:end')
    fixture.releaseClose.resolve()
    await setImmediate()
    expect(fixture.events.filter(event => event === 'close:inner:end')).toHaveLength(1)
    expect(fixture.events.filter(event => event === 'close:inner:start')).toHaveLength(1)
    expect(fixture.events.filter(event => event === 'close:outer:start')).toHaveLength(1)
  } finally {
    fixture.releaseClose.resolve()
    fixture.releaseBody.resolve()
    await fixture.owner
    await fixture.child.promise
  }
}, 10_000)

test('a cleanup continuation cannot start new public SDK work after its owner has abandoned it', async () => {
  const queries: string[] = []
  const late = gate<Outcome<void>>()
  const discovery: ClickHouseExecutor = { ...NULL_EXECUTOR, async query<T>(sql: string): Promise<T[]> {
    queries.push(sql)
    return []
  } }
  const fixture = await nestedCleanup('body', async (pending) => {
    await waitForTableAbsent(discovery, 'app', 'before_abandonment')
    await pending
    late.resolve(await outcome(waitForTableAbsent(discovery, 'app', 'after_abandonment')))
  })
  try {
    await fixture.closeEntered.promise
    expect(await observeWithin(fixture.owner, 7_000)).toEqual({ kind: 'settled', result: { kind: 'fulfilled', value: 0 } })
    expect(queries.some(sql => sql.includes("name = 'before_abandonment'"))).toBe(true)
    const whileActive = [...queries]
    fixture.releaseClose.resolve()
    expect(await late.promise).toMatchObject({ kind: 'rejected', error: expect.any(Error) })
    expect(queries).toEqual(whileActive)
    expect(fixture.events.filter(event => event === 'close:inner:start')).toHaveLength(1)
  } finally {
    fixture.releaseClose.resolve()
    fixture.releaseBody.resolve()
    await fixture.owner
    await fixture.child.promise
  }
}, 10_000)

test('a cooperative close failure during abandonment settles the child and leaves parent cleanup intact', async () => {
  const fixture = await nestedCleanup('body')
  const closeFailure = new Error('cooperative cleanup failed')
  try {
    await fixture.closeEntered.promise
    fixture.releaseClose.reject(closeFailure)
    expect(await observeWithin(fixture.owner, 1_000)).toEqual({ kind: 'settled', result: { kind: 'fulfilled', value: 0 } })
    expect(await fixture.child.promise).toEqual({ kind: 'rejected', error: closeFailure })
    expect(fixture.events.filter(event => event === 'close:inner:start')).toHaveLength(1)
    expect(fixture.events.filter(event => event === 'close:outer:start')).toHaveLength(1)
  } finally {
    fixture.releaseClose.resolve()
    fixture.releaseBody.resolve()
    await fixture.owner
    await fixture.child.promise
  }
})

async function nestedCleanup(mode: 'body' | 'cleanup', closeWork?: (pending: Promise<void>) => Promise<void>) {
  const bodyEntered = gate<void>()
  const closeEntered = gate<void>()
  const releaseBody = gate<void>()
  const releaseClose = gate<void>()
  const child = gate<Outcome<number>>()
  const events: string[] = []
  const { runtime, context } = await runtimeFor({
    manifest: { name: 'cleanup', apiVersion: 1 },
    hooks: { getContext: ({ command }) => ({ executor: { ...NULL_EXECUTOR, async close() {
      events.push(`close:${command}:start`)
      if (command === 'inner') {
        closeEntered.resolve()
        await (closeWork ? closeWork(releaseClose.promise) : releaseClose.promise)
      }
      events.push(`close:${command}:end`)
    } } }) },
    commands: [
      { name: 'inner', async run() {
        bodyEntered.resolve()
        if (mode === 'body') await releaseBody.promise
        return 7
      } },
      { name: 'outer', async run({ pluginRuntime }) {
        void outcome(pluginRuntime.runPluginCommand('cleanup', 'inner', context)).then(child.resolve)
        if (mode === 'body') await bodyEntered.promise
        else await closeEntered.promise
        return 0
      } },
    ],
  })
  const owner = outcome(runtime.runPluginCommand('cleanup', 'outer', context))
  return { owner, child, closeEntered, releaseBody, releaseClose, events }
}

async function runtimeFor(plugin: ChxPlugin) {
  const config = resolveConfig({ schema: [], plugins: [{ plugin }] })
  const context = { config, configPath: '/fixture/clickhouse.config.ts', jsonMode: true, args: [], flags: {}, print() {} }
  const runtime = await loadPluginRuntime({ config, configPath: context.configPath, cliVersion: '0.2.0-beta.11' })
  return { runtime, context }
}

type Outcome<T> = { kind: 'fulfilled'; value: T } | { kind: 'rejected'; error: unknown }

function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(value => ({ kind: 'fulfilled', value }), error => ({ kind: 'rejected', error }))
}

function observeWithin<T>(promise: Promise<T>, milliseconds: number): Promise<{ kind: 'settled'; result: T } | { kind: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<{ kind: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), milliseconds) })
  return Promise.race([promise.then(result => ({ kind: 'settled' as const, result })), expired]).finally(() => clearTimeout(timer))
}

function gate<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
