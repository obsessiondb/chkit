import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import {
  type ChxInlinePluginRegistration,
  canonicalizeDefinitions,
  loadSchemaDefinitions,
  type ColumnDefinition,
  type MaterializedViewDefinition,
  defineFlags,
  typedFlags,
  type ParsedFlags,
  type ResolvedChxConfig,
  type SchemaDefinition,
  type TableDefinition,
  type ViewDefinition,
  wrapPluginRun,
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
    flags?: ReadonlyArray<{
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
  definitions: SchemaDefinition[]
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
  definitions: SchemaDefinition[]
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

interface ResolvedTableName {
  definition: TableDefinition | ViewDefinition | MaterializedViewDefinition
  interfaceName: string
}

const DEFAULT_OPTIONS: Required<CodegenPluginOptions> = {
  outFile: './src/generated/chkit-types.ts',
  emitZod: false,
  tableNameStyle: 'pascal',
  bigintMode: 'string',
  includeViews: false,
  runOnGenerate: true,
  failOnUnsupportedType: true,
  emitIngest: false,
  ingestOutFile: './src/generated/chkit-ingest.ts',
}

const LARGE_INTEGER_TYPES = new Set([
  'Int64',
  'UInt64',
  'Int128',
  'UInt128',
  'Int256',
  'UInt256',
])

const NUMBER_TYPES = new Set([
  'Int8',
  'Int16',
  'Int32',
  'UInt8',
  'UInt16',
  'UInt32',
  'Float32',
  'Float64',
  'BFloat16',
])

const STRING_TYPES = new Set([
  'String',
  'FixedString',
  'Date',
  'Date32',
  'DateTime',
  'DateTime64',
  'UUID',
  'IPv4',
  'IPv6',
  'Enum',
  'Enum8',
  'Enum16',
  'Decimal',
  'Decimal32',
  'Decimal64',
  'Decimal128',
  'Decimal256',
])

const BOOLEAN_TYPES = new Set(['Bool', 'Boolean'])

class CodegenConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodegenConfigError'
  }
}

class UnsupportedTypeError extends Error {
  readonly path: string
  readonly sourceType: string

  constructor(path: string, sourceType: string) {
    super(
      `Unsupported column type "${sourceType}" at ${path}. Set failOnUnsupportedType=false to emit unknown.`
    )
    this.name = 'UnsupportedTypeError'
    this.path = path
    this.sourceType = sourceType
  }
}

function parseBooleanOption(
  options: Record<string, unknown>,
  key: keyof CodegenPluginOptions
): boolean | undefined {
  const value = options[key]
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  throw new CodegenConfigError(`Invalid plugin option "${key}". Expected boolean.`)
}

function parseStringOption(
  options: Record<string, unknown>,
  key: keyof CodegenPluginOptions
): string | undefined {
  const value = options[key]
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.length > 0) return value
  throw new CodegenConfigError(`Invalid plugin option "${key}". Expected non-empty string.`)
}

function normalizeRuntimeOptions(options: Record<string, unknown>): CodegenPluginOptions {
  const rawTableNameStyle = options.tableNameStyle
  if (
    rawTableNameStyle !== undefined &&
    rawTableNameStyle !== 'pascal' &&
    rawTableNameStyle !== 'camel' &&
    rawTableNameStyle !== 'raw'
  ) {
    throw new CodegenConfigError(
      'Invalid plugin option "tableNameStyle". Expected one of: pascal, camel, raw.'
    )
  }

  const rawBigintMode = options.bigintMode
  if (rawBigintMode !== undefined && rawBigintMode !== 'string' && rawBigintMode !== 'bigint') {
    throw new CodegenConfigError(
      'Invalid plugin option "bigintMode". Expected one of: string, bigint.'
    )
  }

  const normalized: CodegenPluginOptions = {}
  const outFile = parseStringOption(options, 'outFile')
  const emitZod = parseBooleanOption(options, 'emitZod')
  const includeViews = parseBooleanOption(options, 'includeViews')
  const runOnGenerate = parseBooleanOption(options, 'runOnGenerate')
  const failOnUnsupportedType = parseBooleanOption(options, 'failOnUnsupportedType')
  const emitIngest = parseBooleanOption(options, 'emitIngest')
  const ingestOutFile = parseStringOption(options, 'ingestOutFile')

  if (outFile !== undefined) normalized.outFile = outFile
  if (emitZod !== undefined) normalized.emitZod = emitZod
  if (rawTableNameStyle !== undefined) normalized.tableNameStyle = rawTableNameStyle
  if (rawBigintMode !== undefined) normalized.bigintMode = rawBigintMode
  if (includeViews !== undefined) normalized.includeViews = includeViews
  if (runOnGenerate !== undefined) normalized.runOnGenerate = runOnGenerate
  if (failOnUnsupportedType !== undefined) normalized.failOnUnsupportedType = failOnUnsupportedType
  if (emitIngest !== undefined) normalized.emitIngest = emitIngest
  if (ingestOutFile !== undefined) normalized.ingestOutFile = ingestOutFile

  return normalized
}

export function normalizeCodegenOptions(options: CodegenPluginOptions = {}): Required<CodegenPluginOptions> {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
  }
}

function toWords(input: string): string[] {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function pascalCase(input: string): string {
  const words = toWords(input)
  if (words.length === 0) return 'Item'
  return words.map((part) => part[0]?.toUpperCase() + part.slice(1)).join('')
}

function camelCase(input: string): string {
  const words = toWords(input)
  if (words.length === 0) return 'item'
  const [head, ...tail] = words
  return `${head?.toLowerCase() ?? 'item'}${tail
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join('')}`
}

function rawCase(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized.length > 0 ? sanitized : 'item'
}

function isValidIdentifier(input: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input)
}

function renderPropertyName(name: string): string {
  if (isValidIdentifier(name)) return name
  return JSON.stringify(name)
}

function baseRowTypeName(
  definition: Pick<TableDefinition | ViewDefinition | MaterializedViewDefinition, 'database' | 'name'>,
  style: Required<CodegenPluginOptions>['tableNameStyle']
): string {
  const combined = `${definition.database}_${definition.name}`
  if (style === 'raw') {
    const candidate = `${rawCase(combined)}_row`
    return isValidIdentifier(candidate) ? candidate : `_${candidate}`
  }
  if (style === 'camel') {
    return `${camelCase(combined)}Row`
  }
  return `${pascalCase(combined)}Row`
}

function resolveTableNames(
  definitions: Array<TableDefinition | ViewDefinition | MaterializedViewDefinition>,
  style: Required<CodegenPluginOptions>['tableNameStyle']
): ResolvedTableName[] {
  const baseNames = definitions.map((definition) => ({
    definition,
    base: baseRowTypeName(definition, style),
  }))
  const counts = new Map<string, number>()

  return baseNames.map((item) => {
    const seen = counts.get(item.base) ?? 0
    const nextSeen = seen + 1
    counts.set(item.base, nextSeen)
    return {
      definition: item.definition,
      interfaceName: nextSeen === 1 ? item.base : `${item.base}_${nextSeen}`,
    }
  })
}

function splitTopLevelArgs(input: string): string[] {
  const args: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      args.push(input.slice(start, i).trim())
      start = i + 1
    }
  }

  const last = input.slice(start).trim()
  if (last.length > 0) args.push(last)
  return args
}

function parseClickHouseType(typeStr: string): { base: string; args: string[] } {
  const trimmed = typeStr.trim()
  const parenIndex = trimmed.indexOf('(')
  if (parenIndex < 0) return { base: trimmed, args: [] }

  const base = trimmed.slice(0, parenIndex)
  const closingParen = trimmed.lastIndexOf(')')
  if (closingParen <= parenIndex) return { base: trimmed, args: [] }

  const inner = trimmed.slice(parenIndex + 1, closingParen)
  if (inner.trim().length === 0) return { base, args: [] }
  return { base, args: splitTopLevelArgs(inner) }
}

function mapScalarType(base: string, bigintMode: Required<CodegenPluginOptions>['bigintMode']): string | null {
  if (STRING_TYPES.has(base)) return 'string'
  if (BOOLEAN_TYPES.has(base)) return 'boolean'
  if (NUMBER_TYPES.has(base)) return 'number'
  if (LARGE_INTEGER_TYPES.has(base)) return bigintMode
  return null
}

function scalarToZod(mapped: string): string {
  if (mapped === 'string') return 'z.string()'
  if (mapped === 'number') return 'z.number()'
  if (mapped === 'boolean') return 'z.boolean()'
  if (mapped === 'bigint') return 'z.bigint()'
  return 'z.unknown()'
}

function resolveInnerType(
  typeStr: string,
  bigintMode: Required<CodegenPluginOptions>['bigintMode']
): { tsType: string; zodType: string } | null {
  const parsed = parseClickHouseType(typeStr)

  const scalar = mapScalarType(parsed.base, bigintMode)
  if (scalar) return { tsType: scalar, zodType: scalarToZod(scalar) }

  switch (parsed.base) {
    case 'Nullable': {
      const arg = parsed.args[0]
      if (!arg) return null
      const inner = resolveInnerType(arg, bigintMode)
      if (!inner) return null
      return { tsType: `${inner.tsType} | null`, zodType: `${inner.zodType}.nullable()` }
    }
    case 'LowCardinality': {
      const arg = parsed.args[0]
      if (!arg) return null
      return resolveInnerType(arg, bigintMode)
    }
    case 'Array': {
      const arg = parsed.args[0]
      if (!arg) return null
      const inner = resolveInnerType(arg, bigintMode)
      if (!inner) return null
      const needsWrap = inner.tsType.includes('|')
      const tsType = needsWrap ? `(${inner.tsType})[]` : `${inner.tsType}[]`
      return { tsType, zodType: `z.array(${inner.zodType})` }
    }
    case 'Map': {
      const keyArg = parsed.args[0]
      const valueArg = parsed.args[1]
      if (!keyArg || !valueArg) return null
      const key = resolveInnerType(keyArg, bigintMode)
      const value = resolveInnerType(valueArg, bigintMode)
      if (!key || !value) return null
      return {
        tsType: `Record<${key.tsType}, ${value.tsType}>`,
        zodType: `z.record(${key.zodType}, ${value.zodType})`,
      }
    }
    case 'Tuple': {
      if (parsed.args.length === 0) return null
      const elements = parsed.args.map((a) => resolveInnerType(a, bigintMode))
      if (elements.some((e) => e === null)) return null
      const valid = elements as { tsType: string; zodType: string }[]
      return {
        tsType: `[${valid.map((e) => e.tsType).join(', ')}]`,
        zodType: `z.tuple([${valid.map((e) => e.zodType).join(', ')}])`,
      }
    }
    case 'SimpleAggregateFunction': {
      const lastArg = parsed.args[parsed.args.length - 1]
      if (parsed.args.length < 2 || !lastArg) return null
      return resolveInnerType(lastArg, bigintMode)
    }
    case 'JSON': {
      return { tsType: 'Record<string, unknown>', zodType: 'z.record(z.string(), z.unknown())' }
    }
    default:
      return null
  }
}

function resolveColumnType(
  typeStr: string,
  bigintMode: Required<CodegenPluginOptions>['bigintMode']
): { tsType: string; zodType: string; nullable: boolean } | null {
  const parsed = parseClickHouseType(typeStr)

  const firstArg = parsed.args[0]

  if (parsed.base === 'LowCardinality' && firstArg) {
    return resolveColumnType(firstArg, bigintMode)
  }

  if (parsed.base === 'Nullable' && firstArg) {
    const inner = resolveColumnType(firstArg, bigintMode)
    if (!inner) return null
    return { tsType: inner.tsType, zodType: inner.zodType, nullable: true }
  }

  const resolved = resolveInnerType(typeStr, bigintMode)
  if (!resolved) return null
  return { tsType: resolved.tsType, zodType: resolved.zodType, nullable: false }
}

export function mapColumnType(
  input: { column: ColumnDefinition; path: string },
  options: Pick<Required<CodegenPluginOptions>, 'bigintMode' | 'failOnUnsupportedType'>
): MapColumnTypeResult {
  const resolved = resolveColumnType(input.column.type, options.bigintMode)
  const columnNullable = input.column.nullable === true

  if (!resolved) {
    if (options.failOnUnsupportedType) {
      throw new UnsupportedTypeError(input.path, input.column.type)
    }
    const unknownType = columnNullable ? 'unknown | null' : 'unknown'
    return {
      tsType: unknownType,
      zodType: 'z.unknown()',
      nullable: columnNullable,
      finding: {
        code: 'codegen_unsupported_type',
        message: `Unsupported type "${input.column.type}" at ${input.path}; emitted unknown.`,
        severity: 'warn',
        path: input.path,
      },
    }
  }

  const nullable = columnNullable || resolved.nullable
  const tsType = nullable ? `${resolved.tsType} | null` : resolved.tsType
  return { tsType, zodType: resolved.zodType, nullable }
}

function renderHeader(toolVersion: string): string[] {
  const lines = ['// Generated by chkit codegen plugin']
  lines.push(`// chkit-codegen-version: ${toolVersion}`)
  return lines
}

function renderTableInterface(
  table: TableDefinition,
  interfaceName: string,
  options: Required<CodegenPluginOptions>
): { lines: string[]; findings: CodegenFinding[] } {
  const lines: string[] = [`export interface ${interfaceName} {`]
  const findings: CodegenFinding[] = []
  const zodFields: string[] = []

  for (const column of table.columns) {
    const path = `${table.database}.${table.name}.${column.name}`
    const mapped = mapColumnType({ column, path }, options)
    if (mapped.finding) findings.push(mapped.finding)
    lines.push(`  ${renderPropertyName(column.name)}: ${mapped.tsType}`)
    const zodExpr = mapped.nullable ? `${mapped.zodType}.nullable()` : mapped.zodType
    zodFields.push(`  ${renderPropertyName(column.name)}: ${zodExpr},`)
  }

  lines.push('}')
  if (options.emitZod) {
    lines.push('')
    lines.push(`export const ${interfaceName}Schema = z.object({`)
    lines.push(...zodFields)
    lines.push('})')
    lines.push('')
    lines.push(`export type ${interfaceName}Input = z.input<typeof ${interfaceName}Schema>`)
    lines.push(`export type ${interfaceName}Output = z.output<typeof ${interfaceName}Schema>`)
  }
  return { lines, findings }
}

function renderViewInterface(
  definition: ViewDefinition | MaterializedViewDefinition,
  interfaceName: string
): { lines: string[]; findings: CodegenFinding[] } {
  const kind = definition.kind === 'view' ? 'view' : 'materialized_view'
  return {
    lines: [
      `export interface ${interfaceName} {`,
      '  [key: string]: unknown',
      '}',
      '',
      `// ${kind} ${definition.database}.${definition.name} is emitted as unknown-key row shape in v1.`,
    ],
    findings: [],
  }
}

export function generateTypeArtifacts(
  input: GenerateTypeArtifactsInput
): GenerateTypeArtifactsOutput {
  const normalized = normalizeCodegenOptions(input.options)
  const definitions = canonicalizeDefinitions(input.definitions)
  const sortedDefinitions = definitions
    .filter((definition): definition is TableDefinition | ViewDefinition | MaterializedViewDefinition => {
      if (definition.kind === 'table') return true
      if (!normalized.includeViews) return false
      return definition.kind === 'view' || definition.kind === 'materialized_view'
    })
    .sort((a, b) => {
      if (a.database !== b.database) return a.database.localeCompare(b.database)
      return a.name.localeCompare(b.name)
    })

  const resolved = resolveTableNames(sortedDefinitions, normalized.tableNameStyle)
  const findings: CodegenFinding[] = []
  const bodyLines: string[] = []

  for (const entry of resolved) {
    const rendered =
      entry.definition.kind === 'table'
        ? renderTableInterface(entry.definition, entry.interfaceName, normalized)
        : renderViewInterface(entry.definition, entry.interfaceName)
    findings.push(...rendered.findings)
    bodyLines.push(...rendered.lines)
    bodyLines.push('')
  }

  const header = renderHeader(input.toolVersion ?? '0.1.0')
  const lines = [
    ...header,
    ...(normalized.emitZod ? ['', "import { z } from 'zod'"] : []),
    '',
    ...bodyLines,
  ]
  const content = `${lines.join('\n').trimEnd()}\n`

  return {
    content,
    outFile: normalized.outFile,
    declarationCount: resolved.length,
    findings,
  }
}

function computeRelativeImportPath(fromFile: string, toFile: string): string {
  const fromDir = dirname(fromFile)
  let rel = relative(fromDir, toFile)
  if (!rel.startsWith('.')) rel = `./${rel}`
  // Replace .ts extension with .js for ESM imports
  return rel.replace(/\.ts$/, '.js')
}

function stripRowSuffix(name: string): string {
  if (name.endsWith('Row')) return name.slice(0, -3)
  if (name.endsWith('_row')) return name.slice(0, -4)
  return name
}

function renderIngestFunction(
  table: TableDefinition,
  interfaceName: string,
  emitZod: boolean
): string[] {
  const funcName = `ingest${stripRowSuffix(interfaceName)}`
  const tableFqn = `${table.database}.${table.name}`
  const lines: string[] = []

  if (emitZod) {
    lines.push(`export async function ${funcName}(`)
    lines.push(`  ingestor: Ingestor,`)
    lines.push(`  rows: ${interfaceName}[],`)
    lines.push(`  options?: { validate?: boolean }`)
    lines.push(`): Promise<void> {`)
    lines.push(`  const data = options?.validate ? rows.map(row => ${interfaceName}Schema.parse(row)) : rows`)
    lines.push(`  await ingestor.insert({ table: '${tableFqn}', values: data })`)
    lines.push(`}`)
  } else {
    lines.push(`export async function ${funcName}(`)
    lines.push(`  ingestor: Ingestor,`)
    lines.push(`  rows: ${interfaceName}[]`)
    lines.push(`): Promise<void> {`)
    lines.push(`  await ingestor.insert({ table: '${tableFqn}', values: rows })`)
    lines.push(`}`)
  }

  return lines
}

export function generateIngestArtifacts(
  input: GenerateIngestArtifactsInput
): GenerateIngestArtifactsOutput {
  const normalized = normalizeCodegenOptions(input.options)
  const definitions = canonicalizeDefinitions(input.definitions)
  const tables = definitions
    .filter((definition): definition is TableDefinition => definition.kind === 'table')
    .sort((a, b) => {
      if (a.database !== b.database) return a.database.localeCompare(b.database)
      return a.name.localeCompare(b.name)
    })

  const resolved = resolveTableNames(tables, normalized.tableNameStyle)
  const importPath = computeRelativeImportPath(normalized.ingestOutFile, normalized.outFile)

  const typeImports: string[] = []
  const valueImports: string[] = []
  for (const entry of resolved) {
    typeImports.push(entry.interfaceName)
    if (normalized.emitZod) {
      valueImports.push(`${entry.interfaceName}Schema`)
    }
  }

  const header = renderHeader(input.toolVersion ?? '0.1.0')
  const lines = [...header, '']

  if (typeImports.length > 0) {
    lines.push(`import type { ${typeImports.join(', ')} } from '${importPath}'`)
  }
  if (valueImports.length > 0) {
    lines.push(`import { ${valueImports.join(', ')} } from '${importPath}'`)
  }

  lines.push('')
  lines.push('export interface Ingestor {')
  lines.push('  insert(params: { table: string; values: Record<string, unknown>[] }): Promise<void>')
  lines.push('}')

  for (const entry of resolved) {
    if (entry.definition.kind !== 'table') continue
    lines.push('')
    lines.push(...renderIngestFunction(entry.definition, entry.interfaceName, normalized.emitZod))
  }

  const content = `${lines.join('\n').trimEnd()}\n`

  return {
    content,
    outFile: normalized.ingestOutFile,
    functionCount: resolved.length,
  }
}

const CODEGEN_FLAGS = defineFlags([
  { name: '--check', type: 'boolean', description: 'Check if generated output is up-to-date' },
  { name: '--out-file', type: 'string', description: 'Output file path', placeholder: '<path>' },
  { name: '--emit-zod', type: 'boolean', description: 'Emit Zod schemas alongside TypeScript types', negation: true },
  { name: '--emit-ingest', type: 'boolean', description: 'Emit ingest helper functions', negation: true },
  { name: '--ingest-out-file', type: 'string', description: 'Ingest output file path', placeholder: '<path>' },
  { name: '--bigint-mode', type: 'string', description: 'How to represent large integers (string or bigint)', placeholder: '<mode>' },
  { name: '--include-views', type: 'boolean', description: 'Include views in generated output' },
] as const)

interface FlagOverrides {
  check: boolean
  outFile?: string
  emitZod?: boolean
  bigintMode?: 'string' | 'bigint'
  includeViews?: boolean
  emitIngest?: boolean
  ingestOutFile?: string
}

function flagsToOverrides(flags: ParsedFlags): FlagOverrides {
  const f = typedFlags(flags, CODEGEN_FLAGS)
  const rawBigintMode = f['--bigint-mode']
  if (rawBigintMode !== undefined && rawBigintMode !== 'string' && rawBigintMode !== 'bigint') {
    throw new CodegenConfigError('Invalid value for --bigint-mode. Expected string or bigint.')
  }

  return {
    check: f['--check'] === true,
    outFile: f['--out-file'],
    emitZod: f['--emit-zod'],
    includeViews: f['--include-views'],
    emitIngest: f['--emit-ingest'],
    ingestOutFile: f['--ingest-out-file'],
    bigintMode: rawBigintMode,
  }
}

function mergeOptions(
  baseOptions: Required<CodegenPluginOptions>,
  runtimeOptions: Record<string, unknown>,
  overrides: FlagOverrides
): Required<CodegenPluginOptions> {
  const fromRuntime = normalizeRuntimeOptions(runtimeOptions)
  const withRuntime = normalizeCodegenOptions({ ...baseOptions, ...fromRuntime })

  return normalizeCodegenOptions({
    ...withRuntime,
    outFile: overrides.outFile ?? withRuntime.outFile,
    emitZod: overrides.emitZod ?? withRuntime.emitZod,
    bigintMode: overrides.bigintMode ?? withRuntime.bigintMode,
    includeViews: overrides.includeViews ?? withRuntime.includeViews,
    emitIngest: overrides.emitIngest ?? withRuntime.emitIngest,
    ingestOutFile: overrides.ingestOutFile ?? withRuntime.ingestOutFile,
  })
}

export function isRunOnGenerateEnabled(
  baseOptions: Required<CodegenPluginOptions>,
  runtimeOptions: Record<string, unknown>
): boolean {
  const fromRuntime = normalizeRuntimeOptions(runtimeOptions)
  const effective = normalizeCodegenOptions({ ...baseOptions, ...fromRuntime })
  return effective.runOnGenerate
}

async function writeAtomic(targetPath: string, content: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = join(dirname(targetPath), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  await writeFile(tempPath, content, 'utf8')
  await rename(tempPath, targetPath)
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function checkGeneratedOutput(input: {
  label: string
  outFile: string
  expected: string
  current: string | null
  missingCode: string
  staleCode: string
}): CodegenPluginCheckResult {
  if (input.current === null) {
    return {
      plugin: 'codegen',
      evaluated: true,
      ok: false,
      findings: [
        {
          code: input.missingCode,
          message: `${input.label} output file is missing: ${input.outFile}`,
          severity: 'error',
          metadata: { outFile: input.outFile },
        },
      ],
      metadata: {
        outFile: input.outFile,
      },
    }
  }

  if (input.current !== input.expected) {
    return {
      plugin: 'codegen',
      evaluated: true,
      ok: false,
      findings: [
        {
          code: input.staleCode,
          message: `${input.label} output is stale: ${input.outFile}`,
          severity: 'error',
          metadata: { outFile: input.outFile },
        },
      ],
      metadata: {
        outFile: input.outFile,
      },
    }
  }

  return {
    plugin: 'codegen',
    evaluated: true,
    ok: true,
    findings: [],
    metadata: {
      outFile: input.outFile,
    },
  }
}

function mergeCheckResults(results: CodegenPluginCheckResult[]): CodegenPluginCheckResult {
  const allFindings = results.flatMap((r) => r.findings)
  const allOk = results.every((r) => r.ok)
  return {
    plugin: 'codegen',
    evaluated: true,
    ok: allOk,
    findings: allFindings,
    metadata: results.reduce((acc, r) => ({ ...acc, ...r.metadata }), {}),
  }
}

export function createCodegenPlugin(options: CodegenPluginOptions = {}): CodegenPlugin {
  const base = normalizeCodegenOptions(options)

  return {
    manifest: {
      name: 'codegen',
      apiVersion: 1,
    },
    commands: [
      {
        name: 'codegen',
        description: 'Generate TypeScript artifacts from chkit schema definitions',
        flags: CODEGEN_FLAGS,
        async run({
          flags,
          jsonMode,
          print,
          options: runtimeOptions,
          config,
          configPath,
        }): Promise<undefined | number> {
          return wrapPluginRun({
            command: 'codegen',
            label: 'Codegen',
            jsonMode,
            print,
            configErrorClass: CodegenConfigError,
            fn: async () => {
              const overrides = flagsToOverrides(flags)
              const effectiveOptions = mergeOptions(base, runtimeOptions, overrides)
              const configDir = resolve(configPath, '..')
              const outFile = resolve(configDir, effectiveOptions.outFile)
              const definitions = await loadSchemaDefinitions(config.schema, { cwd: configDir })
              const generated = generateTypeArtifacts({
                definitions,
                options: effectiveOptions,
              })

              let ingestGenerated: GenerateIngestArtifactsOutput | null = null
              let ingestOutFile: string | null = null
              if (effectiveOptions.emitIngest) {
                ingestGenerated = generateIngestArtifacts({
                  definitions,
                  options: effectiveOptions,
                })
                ingestOutFile = resolve(configDir, effectiveOptions.ingestOutFile)
              }

              if (overrides.check) {
                const current = await readMaybe(outFile)
                const typeCheckResult = checkGeneratedOutput({
                  label: 'Codegen',
                  outFile,
                  expected: generated.content,
                  current,
                  missingCode: 'codegen_missing_output',
                  staleCode: 'codegen_stale_output',
                })

                const results = [typeCheckResult]

                if (ingestGenerated && ingestOutFile) {
                  const ingestCurrent = await readMaybe(ingestOutFile)
                  results.push(checkGeneratedOutput({
                    label: 'Codegen ingest',
                    outFile: ingestOutFile,
                    expected: ingestGenerated.content,
                    current: ingestCurrent,
                    missingCode: 'codegen_missing_ingest_output',
                    staleCode: 'codegen_stale_ingest_output',
                  }))
                }

                const checkResult = mergeCheckResults(results)
                const payload = {
                  ok: checkResult.ok,
                  findingCodes: checkResult.findings.map((finding) => finding.code),
                  outFile,
                  mode: 'check',
                }

                if (jsonMode) {
                  print(payload)
                } else {
                  if (checkResult.ok) {
                    print(`Codegen up-to-date: ${outFile}`)
                  } else {
                    const firstCode = checkResult.findings[0]?.code ?? 'codegen_stale_output'
                    print(`Codegen check failed (${firstCode}): ${outFile}`)
                  }
                }
                return checkResult.ok ? 0 : 1
              }

              await writeAtomic(outFile, generated.content)

              if (ingestGenerated && ingestOutFile) {
                await writeAtomic(ingestOutFile, ingestGenerated.content)
              }

              const payload = {
                ok: true,
                outFile,
                declarationCount: generated.declarationCount,
                findingCodes: generated.findings.map((finding) => finding.code),
                mode: 'write',
              }

              if (jsonMode) {
                print(payload)
              } else {
                print(`Codegen wrote ${outFile} (${generated.declarationCount} declarations)`)
              }

              return 0
            },
          })
        },
      },
    ],
    hooks: {
      onConfigLoaded({ options: runtimeOptions }) {
        normalizeRuntimeOptions(runtimeOptions)
      },
      async onCheck({ config, configPath, options: runtimeOptions }) {
        const effectiveOptions = mergeOptions(base, runtimeOptions, { check: false })
        const configDir = resolve(configPath, '..')
        const outFile = resolve(configDir, effectiveOptions.outFile)
        const definitions = await loadSchemaDefinitions(config.schema, { cwd: configDir })
        const generated = generateTypeArtifacts({
          definitions,
          options: effectiveOptions,
        })
        const current = await readMaybe(outFile)
        const typeResult = checkGeneratedOutput({
          label: 'Codegen',
          outFile,
          expected: generated.content,
          current,
          missingCode: 'codegen_missing_output',
          staleCode: 'codegen_stale_output',
        })

        if (!effectiveOptions.emitIngest) {
          return typeResult
        }

        const ingestOutFile = resolve(configDir, effectiveOptions.ingestOutFile)
        const ingestGenerated = generateIngestArtifacts({
          definitions,
          options: effectiveOptions,
        })
        const ingestCurrent = await readMaybe(ingestOutFile)
        const ingestResult = checkGeneratedOutput({
          label: 'Codegen ingest',
          outFile: ingestOutFile,
          expected: ingestGenerated.content,
          current: ingestCurrent,
          missingCode: 'codegen_missing_ingest_output',
          staleCode: 'codegen_stale_ingest_output',
        })

        return mergeCheckResults([typeResult, ingestResult])
      },
      onCheckReport({ result, print }) {
        const findingCodes = result.findings.map((finding) => finding.code)
        if (result.ok) {
          print(`codegen check: ok`)
          return
        }
        print(`codegen check: failed${findingCodes.length > 0 ? ` (${findingCodes.join(', ')})` : ''}`)
      },
    },
  }
}

export function codegen(options: CodegenPluginOptions = {}): CodegenPluginRegistration {
  return {
    plugin: createCodegenPlugin(),
    name: 'codegen',
    enabled: true,
    options,
  }
}
