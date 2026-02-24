import type {
  ChxInlinePluginRegistration,
  MaterializedViewDefinition,
  ResolvedChxConfig,
  TableDefinition,
  ViewDefinition,
} from '@chkit/core'

export interface CodegenPluginOptions {
  outFile?: string
  emitZod?: boolean
  tableNameStyle?: 'pascal' | 'camel' | 'raw'
  bigintMode?: 'string' | 'bigint'
  includeViews?: boolean
  runOnGenerate?: boolean
  failOnUnsupportedType?: boolean
  emitIngest?: boolean
  ingestOutFile?: string
}

export interface CodegenPluginCommandContext {
  args: string[]
  flags: Record<string, string | string[] | boolean | undefined>
  jsonMode: boolean
  options: Record<string, unknown>
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
  commands: Array<{
    name: 'codegen'
    description: string
    flags?: Array<{
      name: string
      type: 'boolean' | 'string' | 'string[]'
      description: string
      placeholder?: string
      negation?: boolean
    }>
    run: (context: CodegenPluginCommandContext) => undefined | number | Promise<undefined | number>
  }>
  hooks?: {
    onConfigLoaded?: (context: { command: string; configPath: string; options: Record<string, unknown> }) => void
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

export interface CodegenPluginCheckContext {
  command: 'check'
  config: ResolvedChxConfig
  configPath: string
  jsonMode: boolean
  options: Record<string, unknown>
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

export interface FlagOverrides {
  check: boolean
  outFile?: string
  emitZod?: boolean
  bigintMode?: 'string' | 'bigint'
  includeViews?: boolean
  emitIngest?: boolean
  ingestOutFile?: string
}
