import { describe, expect, test } from 'bun:test'
import type { ResolvedChxConfig } from '@chkit/core'
import type { ChxPlugin } from '../../plugins.js'
import { loadPluginRuntime } from '../../bin/plugin-runtime.js'

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
