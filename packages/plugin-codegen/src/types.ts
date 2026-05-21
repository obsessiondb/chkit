import type {
  ChxInlinePluginRegistration,
  FlagDef,
  FlagMapping,
  MaterializedViewDefinition,
  ParsedFlags,
  ResolvedChxConfig,
  SafeParseable,
  TableDefinition,
  ViewDefinition,
} from '@chkit/core'

import type { CodegenOptions, PluginConfig } from './options.js'

export type CodegenPluginOptions = PluginConfig

export interface CodegenPluginCommandContext {
  args: string[]
  flags: ParsedFlags
  jsonMode: boolean
  options: CodegenOptions
  rawOptions: Record<string, unknown>
  config: ResolvedChxConfig
  configPath: string
  print: (value: unknown) => void
}

export interface CodegenPlugin {
  manifest: {
    name: 'codegen'
    apiVersion: 1
    version?: string
  }
  optionsSchema?: SafeParseable<CodegenOptions>
  commands: Array<{
    name: 'codegen'
    description: string
    flags?: readonly FlagDef[]
    optionsSchema?: SafeParseable<CodegenOptions>
    flagMapping?: FlagMapping
    run: (context: CodegenPluginCommandContext) => undefined | number | Promise<undefined | number>
  }>
  hooks?: {
    onConfigLoaded?: (context: { command: string; configPath: string; options: CodegenOptions }) => void
    onCheck?: (
      context: CodegenPluginCheckContext
    ) => CodegenPluginCheckResult | undefined | Promise<CodegenPluginCheckResult | undefined>
    onCheckReport?: (context: { result: CodegenPluginCheckResult; print: (line: string) => void }) => void | Promise<void>
  }
}

export interface CodegenFinding {
  code:
    | 'codegen_unsupported_type'
    | 'codegen_stale_output'
    | 'codegen_missing_output'
    | 'codegen_stale_ingest_output'
    | 'codegen_missing_ingest_output'
    | 'codegen_stale_migrations_output'
    | 'codegen_missing_migrations_output'
  message: string
  severity: 'warn' | 'error'
  path?: string
}

export interface MapColumnTypeResult {
  tsType: string
  zodType: string
  nullable: boolean
  finding?: CodegenFinding
}

export interface GenerateTypeArtifactsInput {
  definitions: import('@chkit/core').SchemaDefinition[]
  options?: CodegenPluginOptions
  now?: Date
  toolVersion?: string
}

export interface GenerateTypeArtifactsOutput {
  content: string
  outFile: string
  declarationCount: number
  findings: CodegenFinding[]
}

export interface GenerateIngestArtifactsInput {
  definitions: import('@chkit/core').SchemaDefinition[]
  options?: CodegenPluginOptions
  toolVersion?: string
}

export interface GenerateIngestArtifactsOutput {
  content: string
  outFile: string
  functionCount: number
}

export interface GenerateMigrationArtifactsInput {
  migrationsDir: string
  options?: CodegenPluginOptions
  toolVersion?: string
}

export interface GenerateMigrationArtifactsOutput {
  content: string
  outFile: string
  migrationCount: number
}

export interface CodegenPluginCheckContext {
  command: 'check'
  config: ResolvedChxConfig
  configPath: string
  jsonMode: boolean
  options: CodegenOptions
}

export type CodegenPluginRegistration = ChxInlinePluginRegistration<CodegenPlugin, CodegenPluginOptions>

export interface CodegenPluginCheckResult {
  plugin: string
  evaluated: boolean
  ok: boolean
  findings: Array<{
    code: string
    message: string
    severity: 'info' | 'warn' | 'error'
    metadata?: Record<string, unknown>
  }>
  metadata?: Record<string, unknown>
}

export interface ResolvedTableName {
  definition: TableDefinition | ViewDefinition | MaterializedViewDefinition
  interfaceName: string
}

