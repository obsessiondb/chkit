import type {
  ChxInlinePluginRegistration,
  ChxPluginRegistration,
  FlagDef,
  MigrationPlan,
  ParsedFlags,
  ResolvedChxConfig,
  SchemaDefinition,
} from '@chkit/core'
import type { PluginRuntime } from './bin/plugin-runtime.js'
import type { TableScope } from './bin/table-scope.js'

export {
  defineFlags,
  parseFlags,
  typedFlags,
  MissingFlagValueError,
  UnknownFlagError,
  type FlagDef,
  type InferFlags,
  type ParsedFlags,
} from '@chkit/core'

export interface CommandDef {
  name: string
  description: string
  flags: readonly FlagDef[]
  run: (ctx: CommandRunContext) => Promise<void>
}

export interface CommandRunContext {
  command: string
  flags: ParsedFlags
  config: ResolvedChxConfig
  configPath: string
  dirs: { outDir: string; migrationsDir: string; metaDir: string }
  pluginRuntime: PluginRuntime
}

export interface CommandExtension {
  command: string | string[]
  flags: readonly FlagDef[]
}

export interface ChxPluginManifest {
  name: string
  apiVersion: 1
  version?: string
  compatibility?: {
    cli?: {
      minMajor?: number
      maxMajor?: number
    }
  }
}

export interface ChxPluginHookContextBase {
  command: string
  config: ResolvedChxConfig
  tableScope: TableScope
  flags: ParsedFlags
}

export interface ChxOnConfigLoadedContext extends ChxPluginHookContextBase {
  configPath: string
  options: Record<string, unknown>
}

export interface ChxOnSchemaLoadedContext extends ChxPluginHookContextBase {
  definitions: SchemaDefinition[]
}

export interface ChxOnPlanCreatedContext extends ChxPluginHookContextBase {
  plan: MigrationPlan
}

export interface ChxOnBeforeApplyContext extends ChxPluginHookContextBase {
  migration: string
  sql: string
  statements: string[]
}

export interface ChxOnAfterApplyContext extends ChxPluginHookContextBase {
  migration: string
  statements: string[]
  appliedAt: string
}

export interface ChxCheckFinding {
  code: string
  message: string
  severity: 'info' | 'warn' | 'error'
  metadata?: Record<string, unknown>
}

export interface ChxOnCheckContext extends ChxPluginHookContextBase {
  command: 'check'
  configPath: string
  jsonMode: boolean
  options: Record<string, unknown>
}

export interface ChxOnCheckResult {
  plugin: string
  evaluated: boolean
  ok: boolean
  findings: ChxCheckFinding[]
  metadata?: Record<string, unknown>
}

export interface ChxPluginCommandContext {
  pluginName: string
  config: ResolvedChxConfig
  configPath: string
  jsonMode: boolean
  args: string[]
  flags: ParsedFlags
  options: Record<string, unknown>
  tableScope: TableScope
  print: (value: unknown) => void
}

export interface ChxPluginCommand {
  name: string
  description?: string
  flags?: readonly FlagDef[]
  run: (context: ChxPluginCommandContext) => undefined | number | Promise<undefined | number>
}

export interface ChxPluginHooks {
  onConfigLoaded?: (context: ChxOnConfigLoadedContext) => void | Promise<void>
  onSchemaLoaded?: (
    context: ChxOnSchemaLoadedContext
  ) => SchemaDefinition[] | undefined | Promise<SchemaDefinition[] | undefined>
  onPlanCreated?: (
    context: ChxOnPlanCreatedContext
  ) => MigrationPlan | undefined | Promise<MigrationPlan | undefined>
  onBeforeApply?: (
    context: ChxOnBeforeApplyContext
  ) =>
    | undefined
    | { statements?: string[] }
    | Promise<undefined | { statements?: string[] }>
  onAfterApply?: (context: ChxOnAfterApplyContext) => void | Promise<void>
  onCheck?: (context: ChxOnCheckContext) => ChxOnCheckResult | undefined | Promise<ChxOnCheckResult | undefined>
  onCheckReport?: (context: {
    result: ChxOnCheckResult
    print: (line: string) => void
  }) => void | Promise<void>
}

export interface ChxPlugin {
  manifest: ChxPluginManifest
  hooks?: ChxPluginHooks
  commands?: ChxPluginCommand[]
  extendCommands?: CommandExtension[]
}

export function definePlugin(plugin: ChxPlugin): ChxPlugin {
  return plugin
}

export function definePluginConfig<TOptions extends object = Record<string, unknown>>(
  registration: Omit<ChxInlinePluginRegistration<ChxPlugin, TOptions>, 'plugin'> & {
    plugin: ChxPlugin
  }
): ChxInlinePluginRegistration<ChxPlugin, TOptions> {
  return registration
}

export function isInlinePluginRegistration(
  registration: ChxPluginRegistration
): registration is ChxInlinePluginRegistration<ChxPlugin> {
  return typeof registration === 'object' && registration !== null && 'plugin' in registration
}
