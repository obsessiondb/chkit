import { describe, expect, test } from 'bun:test'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import type { ResolvedChxConfig } from '@chkit/core'
import type { ChxPlugin } from '../../plugins.js'
import { loadPluginRuntime } from '../../runtime/plugin-runtime/index.js'
import { NULL_EXECUTOR } from '../../runtime/plugin-runtime/null-executor.js'

function makeConfig(plugins: ChxPlugin[]): ResolvedChxConfig {
  return {
    schema: [],
    outDir: '.chkit',
    migrationsDir: 'migrations',
    metaDir: '.chkit/meta',
    plugins: plugins.map((plugin) => ({
      plugin,
      name: plugin.manifest.name,
      enabled: true,
      options: {},
    })),
    check: { unusedTables: true, unusedColumns: true },
    safety: { allowDestructive: false },
  }
}

function makeCommandContext() {
  return {
    config: makeConfig([]),
    configPath: '/fake/clickhouse.config.ts',
    jsonMode: false,
    args: [],
    flags: {},
    print: () => {},
  }
}

describe('onBeforePluginCommand', () => {
  test('returning handled: true skips the original command', async () => {
    let originalRan = false
    const targetPlugin: ChxPlugin = {
      manifest: { name: 'backfill', apiVersion: 1 },
      commands: [
        {
          name: 'run',
          run: () => {
            originalRan = true
            return 0
          },
        },
      ],
    }

    const interceptor: ChxPlugin = {
      manifest: { name: 'obsessiondb', apiVersion: 1 },
      hooks: {
        onBeforePluginCommand: () => ({ handled: true, exitCode: 42 }),
      },
    }

    const config = makeConfig([targetPlugin, interceptor])
    const runtime = await loadPluginRuntime({
      config,
      configPath: '/fake/clickhouse.config.ts',
      cliVersion: '1.0.0',
    })

    const exitCode = await runtime.runPluginCommand('backfill', 'run', makeCommandContext())

    expect(exitCode).toBe(42)
    expect(originalRan).toBe(false)
  })

  test('returning handled: false falls through to original command', async () => {
    let originalRan = false
    const targetPlugin: ChxPlugin = {
      manifest: { name: 'backfill', apiVersion: 1 },
      commands: [
        {
          name: 'run',
          run: () => {
            originalRan = true
            return 0
          },
        },
      ],
    }

    const interceptor: ChxPlugin = {
      manifest: { name: 'obsessiondb', apiVersion: 1 },
      hooks: {
        onBeforePluginCommand: () => ({ handled: false }),
      },
    }

    const config = makeConfig([targetPlugin, interceptor])
    const runtime = await loadPluginRuntime({
      config,
      configPath: '/fake/clickhouse.config.ts',
      cliVersion: '1.0.0',
    })

    const exitCode = await runtime.runPluginCommand('backfill', 'run', makeCommandContext())

    expect(exitCode).toBe(0)
    expect(originalRan).toBe(true)
  })

  test('the owning plugin hook is NOT called for its own commands', async () => {
    let hookCalled = false
    const plugin: ChxPlugin = {
      manifest: { name: 'backfill', apiVersion: 1 },
      commands: [
        {
          name: 'run',
          run: () => 0,
        },
      ],
      hooks: {
        onBeforePluginCommand: () => {
          hookCalled = true
          return { handled: true, exitCode: 99 }
        },
      },
    }

    const config = makeConfig([plugin])
    const runtime = await loadPluginRuntime({
      config,
      configPath: '/fake/clickhouse.config.ts',
      cliVersion: '1.0.0',
    })

    const exitCode = await runtime.runPluginCommand('backfill', 'run', makeCommandContext())

    expect(exitCode).toBe(0)
    expect(hookCalled).toBe(false)
  })

  test('passes correct context to onBeforePluginCommand hook', async () => {
    let receivedContext: Record<string, unknown> = {}
    const targetPlugin: ChxPlugin = {
      manifest: { name: 'backfill', apiVersion: 1 },
      commands: [{ name: 'plan', run: () => 0 }],
    }

    const interceptor: ChxPlugin = {
      manifest: { name: 'obsessiondb', apiVersion: 1 },
      hooks: {
        onBeforePluginCommand: (ctx) => {
          receivedContext = { ...ctx }
          return { handled: false }
        },
      },
    }

    const config = makeConfig([targetPlugin, interceptor])
    const runtime = await loadPluginRuntime({
      config,
      configPath: '/fake/clickhouse.config.ts',
      cliVersion: '1.0.0',
    })

    await runtime.runPluginCommand('backfill', 'plan', {
      ...makeCommandContext(),
      args: ['--window', '7d'],
      flags: { '--window': '7d' },
    })

    expect(receivedContext.targetPlugin).toBe('backfill')
    expect(receivedContext.command).toBe('plan')
    expect(receivedContext.args).toEqual(['--window', '7d'])
  })
})

describe('resolveContext', () => {
  function makeExecutor(name: string, events: string[]): ClickHouseExecutor {
    return {
      ...NULL_EXECUTOR,
      close: async () => {
        events.push(`close:${name}`)
      },
    }
  }

  function makeContextPlugin(
    name: string,
    events: string[],
    executor: ClickHouseExecutor | null,
  ): ChxPlugin {
    return {
      manifest: { name, apiVersion: 1 },
      hooks: {
        getContext: () => {
          events.push(`getContext:${name}`)
          if (!executor) throw new Error('no service')
          return { executor }
        },
      },
    }
  }

  test('runs every getContext hook and the last executor wins', async () => {
    const events: string[] = []
    const first = makeExecutor('first', events)
    const second = makeExecutor('second', events)
    const runtime = await loadPluginRuntime({
      config: makeConfig([
        makeContextPlugin('first', events, first),
        makeContextPlugin('second', events, second),
      ]),
      configPath: '/fake/clickhouse.config.ts',
      cliVersion: '1.0.0',
    })

    const ctx = await runtime.resolveContext({
      config: makeConfig([]),
      configPath: '/fake/clickhouse.config.ts',
      command: 'migrate',
      flags: {},
    })

    expect(ctx.executor).toBe(second)
    expect(ctx.hasExecutor).toBe(true)
    expect(events).toEqual(['getContext:first', 'getContext:second', 'close:first'])
  })

  test('a getContext error closes the current executor', async () => {
    const events: string[] = []
    const first = makeExecutor('first', events)
    const runtime = await loadPluginRuntime({
      config: makeConfig([
        makeContextPlugin('first', events, first),
        makeContextPlugin('broken', events, null),
      ]),
      configPath: '/fake/clickhouse.config.ts',
      cliVersion: '1.0.0',
    })

    await expect(
      runtime.resolveContext({
        config: makeConfig([]),
        configPath: '/fake/clickhouse.config.ts',
        command: 'migrate',
        flags: {},
      }),
    ).rejects.toThrow('Plugin "broken" failed in getContext: no service')
    expect(events).toEqual(['getContext:first', 'getContext:broken', 'close:first'])
  })
})
