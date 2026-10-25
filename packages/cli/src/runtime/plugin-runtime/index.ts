import { createClickHouseExecutor } from '@chkit/clickhouse'
import { resolveOptions, type ResolvedChxConfig } from '@chkit/core'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'

import type { ChxPlugin, LoadedPlugin, PluginContext, PluginRuntime } from '../../plugins.js'
import { debug } from '../debug.js'
import { bindExecution, ensuring, fromPromise, runEffect, scopedExecution } from '../effect.js'
import { formatPluginError } from './errors.js'
import { wrapExecutorWithDebug } from './executor-debug.js'
import { normalizePluginRegistration, validatePlugin } from './loader.js'
import { NULL_EXECUTOR } from './null-executor.js'
import {
  UNFILTERED_TABLE_SCOPE,
  runOnAfterApply,
  runOnBeforeApply,
  runOnBeforePluginCommand,
  runOnCheck,
  runOnCheckReport,
  runOnComplete,
  runOnConfigLoaded,
  runOnInit,
  runOnPlanCreated,
  runOnSchemaLoaded,
} from './hooks.js'

function resolvePluginOptions(plugin: ChxPlugin, options: Record<string, unknown>): Record<string, unknown> {
  if (!plugin.optionsSchema) return options
  const result = plugin.optionsSchema.safeParse(options)
  // Soft-validate at load time: command-level optionsSchema catches strict errors at dispatch.
  // This lets hooks see filled-in defaults when valid, and raw values otherwise.
  if (!result.success) return options
  return result.data
}

export async function loadPluginRuntime(input: {
  config: ResolvedChxConfig
  configPath: string
  cliVersion: string
  internalPlugins?: ChxPlugin[]
}): Promise<PluginRuntime> {
  const registrations = input.config.plugins ?? []
  const loaded: LoadedPlugin[] = []
  const byName = new Map<string, LoadedPlugin>()
  const contextScopes = new WeakMap<PluginContext, Scope.Closeable>()

  for (const registration of registrations) {
    const normalized = normalizePluginRegistration(registration)
    if (!normalized.enabled) continue

    const plugin = normalized.plugin
    const sourceLabel = `inline registration${normalized.nameHint ? ` (${normalized.nameHint})` : ''}`
    validatePlugin(input.cliVersion, plugin, sourceLabel)

    if (normalized.nameHint && normalized.nameHint !== plugin.manifest.name) {
      throw new Error(
        `Plugin name mismatch for ${sourceLabel}: configured "${normalized.nameHint}" but manifest is "${plugin.manifest.name}".`,
      )
    }
    if (byName.has(plugin.manifest.name)) {
      throw new Error(`Duplicate plugin name "${plugin.manifest.name}" in config.plugins.`)
    }

    debug('plugin', `loaded "${plugin.manifest.name}" v${plugin.manifest.version ?? '?'}`, {
      hooks: Object.keys(plugin.hooks ?? {}),
      commands: (plugin.commands ?? []).map((c) => c.name),
    })

    const resolved = resolvePluginOptions(plugin, normalized.options)
    const item: LoadedPlugin = { plugin, options: resolved, rawOptions: normalized.options }
    loaded.push(item)
    byName.set(plugin.manifest.name, item)
  }

  for (const plugin of input.internalPlugins ?? []) {
    if (byName.has(plugin.manifest.name)) continue
    const resolved = resolvePluginOptions(plugin, {})
    const item: LoadedPlugin = { plugin, options: resolved, rawOptions: {}, internal: true }
    loaded.push(item)
    byName.set(plugin.manifest.name, item)
  }

  const runtimeSelf: PluginRuntime = {
    plugins: loaded,
    async resolveContext(input) {
      return runEffect(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const hasClickhouseConfig = !!input.config.clickhouse
            debug('context', `resolving executor — clickhouse config: ${hasClickhouseConfig ? 'yes' : 'no'}`)
            const rawExecutor = input.config.clickhouse
              ? createClickHouseExecutor(input.config.clickhouse)
              : NULL_EXECUTOR
            const defaults: PluginContext = {
              executor: wrapExecutorWithDebug(rawExecutor),
              hasExecutor: hasClickhouseConfig,
            }
            let ctx = defaults
            let executor = defaults.executor
            const scope = yield* Scope.make()
            yield* Scope.addFinalizer(scope, Effect.scoped(Effect.gen(function* () {
              const closing = yield* fromPromise(() => ({ pending: executor.close() }))
              yield* fromPromise(() => closing.pending).pipe(Effect.interruptible)
            })).pipe(Effect.orDie))
            const resolved = yield* Effect.exit(
              restore(
                Effect.gen(function* () {
                  for (const item of loaded) {
                    const hook = item.plugin.hooks?.getContext
                    if (!hook) continue
                    yield* Effect.gen(function* () {
                      const result = yield* fromPromise(() => hook({ ...input, defaults }))
                      if (result && typeof result === 'object' && 'executor' in result && result.executor) {
                        debug('context', `plugin "${item.plugin.manifest.name}" provided executor override`)
                        if (result.executor !== executor) {
                          const previous = executor
                          executor = result.executor
                          yield* fromPromise(() => previous.close())
                        }
                        ctx = { ...ctx, ...result, hasExecutor: true }
                      }
                    }).pipe(
                      Effect.mapError((error) => formatPluginError(item.plugin.manifest.name, 'getContext', error)),
                    )
                  }
                  return ctx
                }).pipe(Effect.provideService(Scope.Scope, scope)),
              ),
            )
            if (Exit.isFailure(resolved)) {
              yield* Scope.close(scope, resolved)
              return yield* resolved
            }
            contextScopes.set(resolved.value, scope)
            return resolved.value
          }),
        ),
      )
    },
    async disposeContext(ctx) {
      const scope = contextScopes.get(ctx)
      return runEffect(scope ? Scope.close(scope, Exit.void) : fromPromise(() => ctx.executor.close()))
    },
    getCommand(pluginName, commandName) {
      const item = byName.get(pluginName)
      if (!item) return null
      const command = (item.plugin.commands ?? []).find((entry) => entry.name === commandName)
      if (!command) return null
      return { plugin: item, command }
    },
    runOnInit: (context) => runOnInit(loaded, context),
    runOnComplete: (context) => runOnComplete(loaded, context),
    runOnConfigLoaded: (context) => runOnConfigLoaded(loaded, context),
    runOnSchemaLoaded: (context) => runOnSchemaLoaded(loaded, context),
    runOnPlanCreated: (context, plan) => runOnPlanCreated(loaded, context, plan),
    runOnBeforeApply: (context) => runOnBeforeApply(loaded, context),
    runOnAfterApply: (context) => runOnAfterApply(loaded, context),
    runOnCheck: (context) => runOnCheck(loaded, context),
    runOnCheckReport: (results, print) => runOnCheckReport(byName, results, print),
    runOnBeforePluginCommand: (pluginName, commandName, context) =>
      runOnBeforePluginCommand(loaded, pluginName, commandName, context),
    async runPluginCommand(pluginName, commandName, context) {
      return runEffect(
        Effect.gen(function* () {
          debug('command', `running plugin command "${pluginName}:${commandName}"`)
          const item = byName.get(pluginName)
          if (!item) return 1
          const command = (item.plugin.commands ?? []).find((entry) => entry.name === commandName)
          if (!command) return 1

          const beforeResult = yield* fromPromise(() =>
            runOnBeforePluginCommand(loaded, pluginName, commandName, {
              config: context.config,
              configPath: context.configPath,
              jsonMode: context.jsonMode,
              args: context.args,
              flags: context.flags,
              tableScope: context.tableScope ?? UNFILTERED_TABLE_SCOPE,
              print: context.print,
            }),
          )
          if (beforeResult.handled) return beforeResult.exitCode

          let resolvedOptions: Record<string, unknown> = item.options
          if (command.optionsSchema) {
            const schema = command.optionsSchema
            const parsed = yield* Effect.result(
              Effect.try({
                try: () => resolveOptions(schema, item.options, context.flags, command.flagMapping ?? {}),
                catch: (error) => error,
              }),
            )
            if (parsed._tag === 'Failure') {
              const error = parsed.failure
              const message = error instanceof Error ? error.message : String(error)
              if (context.jsonMode) {
                context.print({ ok: false, command: commandName, error: message })
              } else {
                context.print(`${commandName} failed: ${message}`)
              }
              return 2
            }
            resolvedOptions = parsed.success
          }

          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const pluginContext = yield* fromPromise(() =>
                runtimeSelf.resolveContext({
                  config: context.config,
                  configPath: context.configPath,
                  command: commandName,
                  flags: context.flags,
                }),
              )
              return yield* ensuring(
                restore(
                  scopedExecution(
                    Effect.gen(function* () {
                      const pluginRuntime = yield* bindRuntime(runtimeSelf)
                      const code = yield* fromPromise(() =>
                        command.run({
                          ...context,
                          pluginName,
                          options: resolvedOptions,
                          rawOptions: item.rawOptions,
                          tableScope: context.tableScope ?? UNFILTERED_TABLE_SCOPE,
                          pluginRuntime,
                          pluginContext,
                        }),
                      )
                      return typeof code === 'number' ? code : 0
                    }).pipe(
                      Effect.mapError((error) => {
                        if (item.internal) {
                          return error instanceof Error ? error : new Error(String(error))
                        }
                        return formatPluginError(item.plugin.manifest.name, `command:${commandName}`, error)
                      }),
                    ),
                  ),
                ),
                fromPromise(() => runtimeSelf.disposeContext(pluginContext)),
              )
            }),
          )
        }),
      )
    },
  }
  return runtimeSelf
}

function bindRuntime(runtime: PluginRuntime): Effect.Effect<PluginRuntime> {
  return Effect.gen(function* () {
    return {
      ...runtime,
      resolveContext: yield* bindExecution(runtime.resolveContext),
      disposeContext: yield* bindExecution(runtime.disposeContext),
      runOnInit: yield* bindExecution(runtime.runOnInit),
      runOnComplete: yield* bindExecution(runtime.runOnComplete),
      runOnConfigLoaded: yield* bindExecution(runtime.runOnConfigLoaded),
      runOnSchemaLoaded: yield* bindExecution(runtime.runOnSchemaLoaded),
      runOnPlanCreated: yield* bindExecution(runtime.runOnPlanCreated),
      runOnBeforeApply: yield* bindExecution(runtime.runOnBeforeApply),
      runOnAfterApply: yield* bindExecution(runtime.runOnAfterApply),
      runOnCheck: yield* bindExecution(runtime.runOnCheck),
      runOnCheckReport: yield* bindExecution(runtime.runOnCheckReport),
      runOnBeforePluginCommand: yield* bindExecution(runtime.runOnBeforePluginCommand),
      runPluginCommand: yield* bindExecution(runtime.runPluginCommand),
    }
  })
}
