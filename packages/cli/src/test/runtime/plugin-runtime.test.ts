import { describe, expect, test } from 'bun:test'
import type { ResolvedChxConfig } from '@chkit/core'
import type { ChxPlugin, PluginRuntime } from '../../plugins.js'
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
    check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true, failOnExtraObjects: false },
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

describe('owned plugin lifecycle', () => {
  test('ordered transforms receive previous results and stop on failure', async () => {
    const calls: string[] = []
    const plugins: ChxPlugin[] = ['first', 'second', 'third'].map((name) => ({
      manifest: { name, apiVersion: 1 },
      hooks: {
        async onBeforeApply(context) {
          calls.push(`${name}:${context.statements.join(',')}`)
          if (name === 'second') throw new Error('transform failed')
          return { statements: [...context.statements, name] }
        },
      },
    }))
    const config = makeConfig(plugins)
    const runtime = await loadPluginRuntime({ config, configPath: '/config.ts', cliVersion: '1.0.0' })
    await expect(runtime.runOnBeforeApply({
      command: 'migrate', config, flags: {}, tableScope: { enabled: false, matchedTables: [], matchCount: 0 },
      migration: '001.sql', sql: 'SELECT 1', statements: ['SELECT 1'],
    })).rejects.toThrow('Plugin "second" failed in onBeforeApply: transform failed')
    expect(calls).toEqual(['first:SELECT 1', 'second:SELECT 1,first'])
  })

  test('executor overrides close in order and disposal is exactly once', async () => {
    const events: string[] = []
    const first = { ...NULL_EXECUTOR, async close() { events.push('first.close') } }
    const second = { ...NULL_EXECUTOR, async close() { events.push('second.close') } }
    const config = makeConfig([
      { manifest: { name: 'first', apiVersion: 1 }, hooks: { getContext: () => ({ executor: first }) } },
      { manifest: { name: 'same', apiVersion: 1 }, hooks: { getContext: () => ({ executor: first }) } },
      { manifest: { name: 'second', apiVersion: 1 }, hooks: { getContext: () => ({ executor: second }) } },
    ])
    const runtime = await loadPluginRuntime({ config, configPath: '/config.ts', cliVersion: '1.0.0' })
    const context = await runtime.resolveContext({ config, configPath: '/config.ts', command: 'test', flags: {} })
    expect(context.executor).toBe(second)
    expect(context.hasExecutor).toBe(true)
    expect(events).toEqual(['first.close'])
    await runtime.disposeContext(context)
    await runtime.disposeContext(context)
    expect(events).toEqual(['first.close', 'second.close'])
  })

  test('context hook failure releases the selected executor once', async () => {
    const events: string[] = []
    const config = makeConfig([
      { manifest: { name: 'first', apiVersion: 1 }, hooks: { getContext: () => ({
        executor: { ...NULL_EXECUTOR, async close() { events.push('close') } },
      }) } },
      { manifest: { name: 'second', apiVersion: 1 }, hooks: { async getContext() { throw new Error('unavailable') } } },
      { manifest: { name: 'third', apiVersion: 1 }, hooks: { getContext() { events.push('third'); return undefined } } },
    ])
    const runtime = await loadPluginRuntime({ config, configPath: '/config.ts', cliVersion: '1.0.0' })
    await expect(runtime.resolveContext({ config, configPath: '/config.ts', command: 'test', flags: {} }))
      .rejects.toThrow('Plugin "second" failed in getContext: unavailable')
    expect(events).toEqual(['close'])
  })

  test('command errors retain wrapping while cleanup errors retain their identity', async () => {
    const failure = new Error('close failed')
    const commandFailure = new Error('command failed')
    const config = makeConfig([{
      manifest: { name: 'custom', apiVersion: 1 },
      hooks: { getContext: () => ({ executor: { ...NULL_EXECUTOR, async close() { throw failure } } }) },
      commands: [{ name: 'run', run() { throw commandFailure } }],
    }])
    const runtime = await loadPluginRuntime({ config, configPath: '/config.ts', cliVersion: '1.0.0' })
    await expect(runtime.runPluginCommand('custom', 'run', makeCommandContext())).rejects.toBe(failure)
    const internal = await loadPluginRuntime({ config: makeConfig([]), configPath: '/config.ts', cliVersion: '1.0.0',
      internalPlugins: [{ manifest: { name: 'core', apiVersion: 1 }, commands: [{ name: 'run', run() { throw commandFailure } }] }],
    })
    await expect(internal.runPluginCommand('core', 'run', makeCommandContext())).rejects.toBe(commandFailure)
  })

  test('nested commands share lifetime but own separate executors', async () => {
    const events: string[] = []
    let retained: PluginRuntime | undefined
    let next = 0
    const config = makeConfig([{
      manifest: { name: 'custom', apiVersion: 1 },
      hooks: { getContext() {
        const id = ++next
        return { executor: { ...NULL_EXECUTOR, async close() { events.push(`close:${id}`) } } }
      } },
      commands: [
        { name: 'outer', async run(context) {
          retained = context.pluginRuntime
          const code = await context.pluginRuntime.runPluginCommand('custom', 'inner', makeCommandContext())
          events.push(`inner:${code}`)
          return 7
        } },
        { name: 'inner', run() { events.push('inner'); return 3 } },
      ],
    }])
    const runtime = await loadPluginRuntime({ config, configPath: '/config.ts', cliVersion: '1.0.0' })
    expect(await runtime.runPluginCommand('custom', 'outer', makeCommandContext())).toBe(7)
    expect(events).toEqual(['inner', 'close:2', 'inner:3', 'close:1'])
    expect(retained).toBeDefined()
    await expect(retained?.runPluginCommand('custom', 'inner', makeCommandContext())).rejects.toThrow('CLI execution is no longer active.')
    expect(next).toBe(2)
  })

  test('unawaited nested commands are disposed before their owner executor', async () => {
    const events: string[] = []
    const started = Promise.withResolvers<void>()
    const unblock = Promise.withResolvers<void>()
    let nested: Promise<number> | undefined
    let next = 0
    const config = makeConfig([{
      manifest: { name: 'custom', apiVersion: 1 },
      hooks: { getContext() {
        const id = ++next
        return { executor: { ...NULL_EXECUTOR, async close() { events.push(`close:${id}`) } } }
      } },
      commands: [
        { name: 'outer', async run(context) {
          nested = context.pluginRuntime.runPluginCommand('custom', 'inner', makeCommandContext())
          void nested.catch(() => {})
          await started.promise
          return 0
        } },
        { name: 'inner', async run() { started.resolve(); await unblock.promise; return 0 } },
      ],
    }])
    const runtime = await loadPluginRuntime({ config, configPath: '/config.ts', cliVersion: '1.0.0' })
    expect(await runtime.runPluginCommand('custom', 'outer', makeCommandContext())).toBe(0)
    expect(nested).toBeDefined()
    await expect(nested).rejects.toThrow('CLI execution is no longer active.')
    expect(events).toEqual(['close:2', 'close:1'])
    unblock.resolve()
  })
})
