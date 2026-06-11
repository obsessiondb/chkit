import type {
  FlagDef,
  FlagMapping,
  MigrationPlan,
  ParsedFlags,
  ResolvedChxConfig,
  SafeParseable,
  SchemaDefinition,
} from '@chkit/core'
import type { ClickHouseExecutor } from '@chkit/clickhouse'

export {
  defineFlags,
  parseFlags,
  typedFlags,
  MissingFlagValueError,
  UnknownFlagError,
  type FlagDef,
  type FlagMapping,
  type InferFlags,
  type ParsedFlags,
  type SafeParseable,
} from '@chkit/core'

export interface TableScope {
  enabled: boolean
  selector?: string
  matchedTables: string[]
  matchCount: number
}

export interface LoadedPlugin {
  options: Record<string, unknown>
  rawOptions: Record<string, unknown>
  plugin: ChxPlugin
  /**
   * True for built-in plugins (e.g. `core`) loaded by the CLI itself rather
   * than from the user's config. Their hook/command errors are surfaced raw,
   * without the `Plugin "<name>" failed in ...` wrapper that only makes sense
   * for third-party plugins the user explicitly registered.
   */
  internal?: boolean
}

export interface PluginRuntime {
  plugins: ReadonlyArray<LoadedPlugin>
  getCommand(
    pluginName: string,
    commandName: string,
  ): { command: ChxPluginCommand; plugin: LoadedPlugin } | null
  resolveContext(
    input: Omit<ChxGetContextInput, 'defaults'>,
  ): Promise<PluginContext>
  disposeContext(ctx: PluginContext): Promise<void>
  runOnInit(context: Omit<ChxOnInitContext, 'options'>): Promise<void>
  runOnComplete(
    context: Omit<ChxOnCompleteContext, 'options' | 'exitCode'> & {
      exitCode?: number
    },
  ): Promise<void>
  runOnConfigLoaded(
    context: Omit<ChxOnConfigLoadedContext, 'options' | 'tableScope'> & {
      tableScope?: TableScope
    },
  ): Promise<void>
  runOnSchemaLoaded(
    context: ChxOnSchemaLoadedContext,
  ): Promise<SchemaDefinition[]>
  runOnPlanCreated(
    context: Omit<ChxOnPlanCreatedContext, 'plan' | 'tableScope'> & {
      tableScope?: TableScope
    },
    plan: MigrationPlan,
  ): Promise<MigrationPlan>
  runOnBeforeApply(context: ChxOnBeforeApplyContext): Promise<string[]>
  runOnAfterApply(context: ChxOnAfterApplyContext): Promise<void>
  runOnCheck(
    context: Omit<ChxOnCheckContext, 'options' | 'tableScope'> & {
      tableScope?: TableScope
    },
  ): Promise<ChxOnCheckResult[]>
  runOnCheckReport(
    results: ChxOnCheckResult[],
    print: (line: string) => void,
  ): Promise<void>
  runOnBeforePluginCommand(
    pluginName: string,
    commandName: string,
    context: Omit<
      ChxOnBeforePluginCommandContext,
      'targetPlugin' | 'command' | 'options'
    >,
  ): Promise<ChxOnBeforePluginCommandResult>
  runPluginCommand(
    pluginName: string,
    commandName: string,
    context: Omit<
      ChxPluginCommandContext,
      'pluginName' | 'options' | 'rawOptions' | 'tableScope' | 'pluginRuntime' | 'pluginContext'
    > & {
      tableScope?: TableScope
    },
  ): Promise<number>
}

export interface PluginContext {
  executor: ClickHouseExecutor
  /** True when an executor was provided (either from config or a plugin). False when using the null executor. */
  hasExecutor: boolean
}

export interface ChxGetContextInput {
  config: ResolvedChxConfig
  configPath: string
  command: string
  flags: ParsedFlags
  defaults: PluginContext
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
  jsonMode?: boolean
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

export interface ChxOnInitContext {
  command: string
  configPath: string
  isInteractive: boolean
  jsonMode: boolean
  flags: ParsedFlags
  config: ResolvedChxConfig
  options: Record<string, unknown>
}

export interface ChxOnCompleteContext {
  command: string
  isInteractive: boolean
  jsonMode: boolean
  exitCode: number
  options: Record<string, unknown>
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

export interface ChxOnBeforePluginCommandContext {
  targetPlugin: string
  command: string
  config: ResolvedChxConfig
  configPath: string
  jsonMode: boolean
  args: string[]
  flags: ParsedFlags
  options: Record<string, unknown>
  tableScope: TableScope
  print: (value: unknown) => void
}

export type ChxOnBeforePluginCommandResult =
  | { handled: true; exitCode: number }
  | { handled: false }

export interface ChxPluginCommandContext<TOptions = Record<string, unknown>> {
  pluginName: string
  config: ResolvedChxConfig
  configPath: string
  jsonMode: boolean
  args: string[]
  flags: ParsedFlags
  options: TOptions
  rawOptions: Record<string, unknown>
  tableScope: TableScope
  print: (value: unknown) => void
  pluginRuntime: PluginRuntime
  pluginContext: PluginContext
}

export interface ChxPluginCommand<TOptions = Record<string, unknown>> {
  name: string
  description?: string
  flags?: readonly FlagDef[]
  optionsSchema?: SafeParseable<TOptions>
  flagMapping?: FlagMapping
  run: (
    context: ChxPluginCommandContext<TOptions>,
  ) => undefined | number | Promise<undefined | number>
}

export interface ChxPluginHooks {
  getContext?: (
    input: ChxGetContextInput
  ) => PluginContext | Partial<PluginContext> | undefined | Promise<PluginContext | Partial<PluginContext> | undefined>
  onInit?: (context: ChxOnInitContext) => void | Promise<void>
  onComplete?: (context: ChxOnCompleteContext) => void | Promise<void>
  onBeforePluginCommand?: (
    context: ChxOnBeforePluginCommandContext
  ) => ChxOnBeforePluginCommandResult | Promise<ChxOnBeforePluginCommandResult>
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
  optionsSchema?: SafeParseable<Record<string, unknown>>
  hooks?: ChxPluginHooks
  commands?: ChxPluginCommand[]
  extendCommands?: CommandExtension[]
}

export function definePlugin(plugin: ChxPlugin): ChxPlugin {
  return plugin
}
