import type { ChxConfig, MigrationPlan, SchemaDefinition } from '@chx/core'

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

export interface ChxPluginRegistrationMeta {
  resolve: string
  options: Record<string, unknown>
}

export interface ChxPluginHookContextBase {
  command: string
  config: ChxConfig
}

export interface ChxOnConfigLoadedContext extends ChxPluginHookContextBase {
  configPath: string
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

export interface ChxPluginCommandContext {
  pluginName: string
  config: ChxConfig
  jsonMode: boolean
  args: string[]
  options: Record<string, unknown>
  print: (value: unknown) => void
}

export interface ChxPluginCommand {
  name: string
  description?: string
  run: (context: ChxPluginCommandContext) => void | number | Promise<void | number>
}

export interface ChxPluginHooks {
  onConfigLoaded?: (context: ChxOnConfigLoadedContext) => void | Promise<void>
  onSchemaLoaded?: (
    context: ChxOnSchemaLoadedContext
  ) => SchemaDefinition[] | void | Promise<SchemaDefinition[] | void>
  onPlanCreated?: (
    context: ChxOnPlanCreatedContext
  ) => MigrationPlan | void | Promise<MigrationPlan | void>
  onBeforeApply?: (
    context: ChxOnBeforeApplyContext
  ) =>
    | void
    | { statements?: string[] }
    | Promise<void | { statements?: string[] }>
  onAfterApply?: (context: ChxOnAfterApplyContext) => void | Promise<void>
}

export interface ChxPlugin {
  manifest: ChxPluginManifest
  hooks?: ChxPluginHooks
  commands?: ChxPluginCommand[]
}

export function definePlugin(plugin: ChxPlugin): ChxPlugin {
  return plugin
}
