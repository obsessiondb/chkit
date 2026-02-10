import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  canonicalizeDefinitions,
  type ChxLegacyPluginRegistration,
  type ChxPluginRegistration,
  type MigrationPlan,
  type ResolvedChxConfig,
  type SchemaDefinition,
} from '@chx/core'

import type {
  ChxOnCheckContext,
  ChxOnCheckResult,
  ChxOnAfterApplyContext,
  ChxOnBeforeApplyContext,
  ChxOnConfigLoadedContext,
  ChxOnPlanCreatedContext,
  ChxOnSchemaLoadedContext,
  ChxPlugin,
  ChxPluginCommand,
  ChxPluginCommandContext,
} from '../plugins.js'
import { isInlinePluginRegistration } from '../plugins.js'

interface LoadedPlugin {
  options: Record<string, unknown>
  plugin: ChxPlugin
}

export interface PluginRuntime {
  plugins: ReadonlyArray<LoadedPlugin>
  getCommand(pluginName: string, commandName: string): { command: ChxPluginCommand; plugin: LoadedPlugin } | null
  runOnConfigLoaded(context: Omit<ChxOnConfigLoadedContext, 'options'>): Promise<void>
  runOnSchemaLoaded(context: ChxOnSchemaLoadedContext): Promise<SchemaDefinition[]>
  runOnPlanCreated(context: Omit<ChxOnPlanCreatedContext, 'plan'>, plan: MigrationPlan): Promise<MigrationPlan>
  runOnBeforeApply(context: ChxOnBeforeApplyContext): Promise<string[]>
  runOnAfterApply(context: ChxOnAfterApplyContext): Promise<void>
  runOnCheck(context: Omit<ChxOnCheckContext, 'options'>): Promise<ChxOnCheckResult[]>
  runOnCheckReport(results: ChxOnCheckResult[], print: (line: string) => void): Promise<void>
  runPluginCommand(
    pluginName: string,
    commandName: string,
    context: Omit<ChxPluginCommandContext, 'pluginName' | 'options'>
  ): Promise<number>
}

function parseCliMajor(version: string): number {
  const major = Number(version.split('.')[0] ?? Number.NaN)
  if (!Number.isInteger(major) || major < 0) {
    throw new Error(`Invalid CLI version "${version}" while loading plugins.`)
  }
  return major
}

function normalizePluginRegistration(
  entry: ChxPluginRegistration
): {
  kind: 'legacy' | 'inline'
  resolvePath: string
  inlinePlugin?: ChxPlugin
  nameHint?: string
  enabled: boolean
  options: Record<string, unknown>
} {
  if (typeof entry === 'string') {
    return {
      kind: 'legacy',
      resolvePath: entry,
      enabled: true,
      options: {},
    }
  }

  if (isInlinePluginRegistration(entry)) {
    return {
      kind: 'inline',
      resolvePath: '',
      inlinePlugin: entry.plugin,
      nameHint: entry.name,
      enabled: entry.enabled !== false,
      options: entry.options ?? {},
    }
  }

  const legacy = entry as ChxLegacyPluginRegistration
  return {
    kind: 'legacy',
    resolvePath: legacy.resolve,
    nameHint: legacy.name,
    enabled: legacy.enabled !== false,
    options: legacy.options ?? {},
  }
}

function formatPluginError(pluginName: string, hook: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`Plugin "${pluginName}" failed in ${hook}: ${message}`)
}

function validatePlugin(cliVersion: string, plugin: ChxPlugin, sourcePath: string): void {
  const name = plugin.manifest.name
  if (!name || name.trim().length === 0) {
    throw new Error(`Plugin at ${sourcePath} has an empty manifest.name.`)
  }

  if (plugin.manifest.apiVersion !== 1) {
    throw new Error(
      `Plugin "${name}" requires apiVersion=${String(plugin.manifest.apiVersion)} but CLI supports apiVersion=1.`
    )
  }

  const compatibility = plugin.manifest.compatibility?.cli
  if (!compatibility) return

  const cliMajor = parseCliMajor(cliVersion)
  if (compatibility.minMajor !== undefined && cliMajor < compatibility.minMajor) {
    throw new Error(
      `Plugin "${name}" is incompatible with CLI ${cliVersion}. Requires cli major >= ${compatibility.minMajor}.`
    )
  }
  if (compatibility.maxMajor !== undefined && cliMajor > compatibility.maxMajor) {
    throw new Error(
      `Plugin "${name}" is incompatible with CLI ${cliVersion}. Requires cli major <= ${compatibility.maxMajor}.`
    )
  }
}

async function importPluginModule(absolutePath: string): Promise<ChxPlugin> {
  const mod = (await import(pathToFileURL(absolutePath).href)) as { default?: unknown; plugin?: unknown }
  const candidate = (mod.default ?? mod.plugin) as ChxPlugin | undefined
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`Plugin module ${absolutePath} must export default definePlugin(...)`)
  }
  if (!candidate.manifest || typeof candidate.manifest !== 'object') {
    throw new Error(`Plugin module ${absolutePath} is missing manifest.`)
  }
  return candidate
}

export async function loadPluginRuntime(input: {
  config: ResolvedChxConfig
  configPath: string
  cliVersion: string
}): Promise<PluginRuntime> {
  const registrations = input.config.plugins ?? []
  const loaded: LoadedPlugin[] = []
  const byName = new Map<string, LoadedPlugin>()
  const configDir = resolve(input.configPath, '..')

  for (const registration of registrations) {
    const normalized = normalizePluginRegistration(registration)
    if (!normalized.enabled) continue

    const plugin =
      normalized.kind === 'inline'
        ? normalized.inlinePlugin
        : await importPluginModule(resolve(configDir, normalized.resolvePath))
    if (!plugin) continue

    const sourceLabel =
      normalized.kind === 'inline'
        ? `inline registration${normalized.nameHint ? ` (${normalized.nameHint})` : ''}`
        : resolve(configDir, normalized.resolvePath)
    validatePlugin(input.cliVersion, plugin, sourceLabel)

    if (normalized.nameHint && normalized.nameHint !== plugin.manifest.name) {
      throw new Error(
        `Plugin name mismatch for ${sourceLabel}: configured "${normalized.nameHint}" but manifest is "${plugin.manifest.name}".`
      )
    }
    if (byName.has(plugin.manifest.name)) {
      throw new Error(`Duplicate plugin name "${plugin.manifest.name}" in config.plugins.`)
    }

    const item: LoadedPlugin = {
      plugin,
      options: normalized.options,
    }
    loaded.push(item)
    byName.set(plugin.manifest.name, item)
  }

  return {
    plugins: loaded,
    getCommand(pluginName, commandName) {
      const item = byName.get(pluginName)
      if (!item) return null
      const command = (item.plugin.commands ?? []).find((entry) => entry.name === commandName)
      if (!command) return null
      return { plugin: item, command }
    },
    async runOnConfigLoaded(context) {
      for (const item of loaded) {
        const hook = item.plugin.hooks?.onConfigLoaded
        if (!hook) continue
        try {
          await hook({ ...context, options: item.options })
        } catch (error) {
          throw formatPluginError(item.plugin.manifest.name, 'onConfigLoaded', error)
        }
      }
    },
    async runOnSchemaLoaded(context) {
      let definitions = context.definitions
      for (const item of loaded) {
        const hook = item.plugin.hooks?.onSchemaLoaded
        if (!hook) continue
        try {
          const next = await hook({ ...context, definitions })
          if (Array.isArray(next)) {
            definitions = canonicalizeDefinitions(next)
          }
        } catch (error) {
          throw formatPluginError(item.plugin.manifest.name, 'onSchemaLoaded', error)
        }
      }
      return definitions
    },
    async runOnPlanCreated(context, initialPlan) {
      let plan = initialPlan
      for (const item of loaded) {
        const hook = item.plugin.hooks?.onPlanCreated
        if (!hook) continue
        try {
          const next = await hook({ ...context, plan })
          if (next) plan = next
        } catch (error) {
          throw formatPluginError(item.plugin.manifest.name, 'onPlanCreated', error)
        }
      }
      return plan
    },
    async runOnBeforeApply(context) {
      let statements = context.statements
      for (const item of loaded) {
        const hook = item.plugin.hooks?.onBeforeApply
        if (!hook) continue
        try {
          const result = await hook({ ...context, statements })
          if (result?.statements) statements = result.statements
        } catch (error) {
          throw formatPluginError(item.plugin.manifest.name, 'onBeforeApply', error)
        }
      }
      return statements
    },
    async runOnAfterApply(context) {
      for (const item of loaded) {
        const hook = item.plugin.hooks?.onAfterApply
        if (!hook) continue
        try {
          await hook(context)
        } catch (error) {
          throw formatPluginError(item.plugin.manifest.name, 'onAfterApply', error)
        }
      }
    },
    async runOnCheck(context) {
      const results: ChxOnCheckResult[] = []
      for (const item of loaded) {
        const hook = item.plugin.hooks?.onCheck
        if (!hook) continue
        try {
          const result = await hook({ ...context, options: item.options })
          if (!result) continue
          results.push({
            plugin: result.plugin || item.plugin.manifest.name,
            evaluated: result.evaluated,
            ok: result.ok,
            findings: result.findings,
            metadata: result.metadata,
          })
        } catch (error) {
          throw formatPluginError(item.plugin.manifest.name, 'onCheck', error)
        }
      }
      return results
    },
    async runOnCheckReport(results, print) {
      for (const result of results) {
        const item = byName.get(result.plugin)
        if (!item) continue
        const hook = item.plugin.hooks?.onCheckReport
        if (!hook) continue
        try {
          await hook({ result, print })
        } catch (error) {
          throw formatPluginError(item.plugin.manifest.name, 'onCheckReport', error)
        }
      }
    },
    async runPluginCommand(pluginName, commandName, context) {
      const item = byName.get(pluginName)
      if (!item) return 1
      const command = (item.plugin.commands ?? []).find((entry) => entry.name === commandName)
      if (!command) return 1
      try {
        const code = await command.run({
          ...context,
          pluginName,
          options: item.options,
        })
        return typeof code === 'number' ? code : 0
      } catch (error) {
        throw formatPluginError(item.plugin.manifest.name, `command:${commandName}`, error)
      }
    },
  }
}
