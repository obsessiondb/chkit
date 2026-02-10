import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import fg from 'fast-glob'

import {
  canonicalizeDefinitions,
  collectDefinitionsFromModule,
  type ChxConfig,
  type ColumnDefinition,
  type MaterializedViewDefinition,
  type SchemaDefinition,
  type TableDefinition,
  type ViewDefinition,
} from '@chx/core'

export interface TypegenPluginOptions {
  outFile?: string
  emitZod?: boolean
  tableNameStyle?: 'pascal' | 'camel' | 'raw'
  bigintMode?: 'string' | 'bigint'
  includeViews?: boolean
  runOnGenerate?: boolean
  failOnUnsupportedType?: boolean
}

export interface TypegenPluginCommandContext {
  args: string[]
  jsonMode: boolean
  options: Record<string, unknown>
  config: ChxConfig
  configPath: string
  print: (value: unknown) => void
}

export interface TypegenPlugin {
  manifest: {
    name: 'typegen'
    apiVersion: 1
    version?: string
  }
  commands: Array<{
    name: 'typegen'
    description: string
    run: (context: TypegenPluginCommandContext) => undefined | number | Promise<undefined | number>
  }>
  hooks?: {
    onConfigLoaded?: (context: { command: string; configPath: string; options: Record<string, unknown> }) => void
    onCheck?: (
      context: TypegenPluginCheckContext
    ) => TypegenPluginCheckResult | undefined | Promise<TypegenPluginCheckResult | undefined>
    onCheckReport?: (context: { result: TypegenPluginCheckResult; print: (line: string) => void }) => void | Promise<void>
  }
}

export interface TypegenFinding {
  code: 'typegen_unsupported_type' | 'typegen_stale_output' | 'typegen_missing_output'
  message: string
  severity: 'warn' | 'error'
  path?: string
}

export interface MapColumnTypeResult {
  tsType: string
  zodType: string
  nullable: boolean
  finding?: TypegenFinding
}

export interface GenerateTypeArtifactsInput {
  definitions: SchemaDefinition[]
  options?: TypegenPluginOptions
  now?: Date
  toolVersion?: string
}

export interface GenerateTypeArtifactsOutput {
  content: string
  outFile: string
  declarationCount: number
  findings: TypegenFinding[]
}

export interface TypegenPluginCheckContext {
  command: 'check'
  config: ChxConfig
  configPath: string
  jsonMode: boolean
  options: Record<string, unknown>
}

export interface TypegenPluginCheckResult {
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

interface ParsedCommandArgs {
  check: boolean
  outFile?: string
  emitZod?: boolean
  bigintMode?: 'string' | 'bigint'
  includeViews?: boolean
}

interface ResolvedTableName {
  definition: TableDefinition | ViewDefinition | MaterializedViewDefinition
  interfaceName: string
}

const DEFAULT_OPTIONS: Required<TypegenPluginOptions> = {
  outFile: './src/generated/chx-types.ts',
  emitZod: false,
  tableNameStyle: 'pascal',
  bigintMode: 'string',
  includeViews: false,
  runOnGenerate: true,
  failOnUnsupportedType: true,
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
])

const STRING_TYPES = new Set(['String', 'Date', 'DateTime', 'DateTime64'])

const BOOLEAN_TYPES = new Set(['Bool', 'Boolean'])

class TypegenConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TypegenConfigError'
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
  key: keyof TypegenPluginOptions
): boolean | undefined {
  const value = options[key]
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  throw new TypegenConfigError(`Invalid plugin option "${key}". Expected boolean.`)
}

function parseStringOption(
  options: Record<string, unknown>,
  key: keyof TypegenPluginOptions
): string | undefined {
  const value = options[key]
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.length > 0) return value
  throw new TypegenConfigError(`Invalid plugin option "${key}". Expected non-empty string.`)
}

function normalizeRuntimeOptions(options: Record<string, unknown>): TypegenPluginOptions {
  const rawTableNameStyle = options.tableNameStyle
  if (
    rawTableNameStyle !== undefined &&
    rawTableNameStyle !== 'pascal' &&
    rawTableNameStyle !== 'camel' &&
    rawTableNameStyle !== 'raw'
  ) {
    throw new TypegenConfigError(
      'Invalid plugin option "tableNameStyle". Expected one of: pascal, camel, raw.'
    )
  }

  const rawBigintMode = options.bigintMode
  if (rawBigintMode !== undefined && rawBigintMode !== 'string' && rawBigintMode !== 'bigint') {
    throw new TypegenConfigError(
      'Invalid plugin option "bigintMode". Expected one of: string, bigint.'
    )
  }

  const normalized: TypegenPluginOptions = {}
  const outFile = parseStringOption(options, 'outFile')
  const emitZod = parseBooleanOption(options, 'emitZod')
  const includeViews = parseBooleanOption(options, 'includeViews')
  const runOnGenerate = parseBooleanOption(options, 'runOnGenerate')
  const failOnUnsupportedType = parseBooleanOption(options, 'failOnUnsupportedType')

  if (outFile !== undefined) normalized.outFile = outFile
  if (emitZod !== undefined) normalized.emitZod = emitZod
  if (rawTableNameStyle !== undefined) normalized.tableNameStyle = rawTableNameStyle
  if (rawBigintMode !== undefined) normalized.bigintMode = rawBigintMode
  if (includeViews !== undefined) normalized.includeViews = includeViews
  if (runOnGenerate !== undefined) normalized.runOnGenerate = runOnGenerate
  if (failOnUnsupportedType !== undefined) normalized.failOnUnsupportedType = failOnUnsupportedType

  return normalized
}

export function normalizeTypegenOptions(options: TypegenPluginOptions = {}): Required<TypegenPluginOptions> {
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
  style: Required<TypegenPluginOptions>['tableNameStyle']
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
  style: Required<TypegenPluginOptions>['tableNameStyle']
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

function mapPrimitiveType(type: string, bigintMode: Required<TypegenPluginOptions>['bigintMode']): string | null {
  if (STRING_TYPES.has(type)) return 'string'
  if (BOOLEAN_TYPES.has(type)) return 'boolean'
  if (NUMBER_TYPES.has(type)) return 'number'
  if (LARGE_INTEGER_TYPES.has(type)) return bigintMode
  return null
}

export function mapColumnType(
  input: { column: ColumnDefinition; path: string },
  options: Pick<Required<TypegenPluginOptions>, 'bigintMode' | 'failOnUnsupportedType'>
): MapColumnTypeResult {
  const mapped = mapPrimitiveType(input.column.type, options.bigintMode)
  const nullable = input.column.nullable === true
  if (!mapped) {
    if (options.failOnUnsupportedType) {
      throw new UnsupportedTypeError(input.path, input.column.type)
    }
    const unknownType = nullable ? 'unknown | null' : 'unknown'
    return {
      tsType: unknownType,
      zodType: 'z.unknown()',
      nullable,
      finding: {
        code: 'typegen_unsupported_type',
        message: `Unsupported type "${input.column.type}" at ${input.path}; emitted unknown.`,
        severity: 'warn',
        path: input.path,
      },
    }
  }

  let zodType = 'z.unknown()'
  if (mapped === 'string') zodType = 'z.string()'
  if (mapped === 'number') zodType = 'z.number()'
  if (mapped === 'boolean') zodType = 'z.boolean()'
  if (mapped === 'bigint') zodType = 'z.bigint()'

  const tsType = nullable ? `${mapped} | null` : mapped
  return { tsType, zodType, nullable }
}

function renderHeader(toolVersion: string): string[] {
  const lines = ['// Generated by chx typegen plugin']
  lines.push(`// chx-typegen-version: ${toolVersion}`)
  return lines
}

function renderTableInterface(
  table: TableDefinition,
  interfaceName: string,
  options: Required<TypegenPluginOptions>
): { lines: string[]; findings: TypegenFinding[] } {
  const lines: string[] = [`export interface ${interfaceName} {`]
  const findings: TypegenFinding[] = []
  const zodFields: string[] = []

  for (const column of table.columns) {
    const path = `${table.database}.${table.name}.${column.name}`
    const mapped = mapColumnType({ column, path }, options)
    if (mapped.finding) findings.push(mapped.finding)
    lines.push(`  ${renderPropertyName(column.name)}: ${mapped.tsType}`)
    const zodExpr = mapped.nullable ? `${mapped.zodType}.nullable()` : mapped.zodType
    zodFields.push(`  ${renderPropertyName(column.name)}: ${zodExpr}`)
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
): { lines: string[]; findings: TypegenFinding[] } {
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
  const normalized = normalizeTypegenOptions(input.options)
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
  const findings: TypegenFinding[] = []
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

async function loadSchemaDefinitions(
  schemaGlobs: string | string[],
  configDir: string
): Promise<SchemaDefinition[]> {
  const patterns = Array.isArray(schemaGlobs) ? schemaGlobs : [schemaGlobs]
  const files = await fg(patterns, { cwd: configDir, absolute: true })

  if (files.length === 0) {
    throw new Error('No schema files matched. Check config.schema patterns.')
  }

  const all: SchemaDefinition[] = []
  for (const file of files) {
    const mod = (await import(file)) as Record<string, unknown>
    all.push(...collectDefinitionsFromModule(mod))
  }

  return canonicalizeDefinitions(all)
}

function parseArgs(args: string[]): ParsedCommandArgs {
  const parsed: ParsedCommandArgs = {
    check: false,
  }

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (!token) continue

    if (token === '--check') {
      parsed.check = true
      continue
    }

    if (token === '--include-views') {
      parsed.includeViews = true
      continue
    }

    if (token === '--emit-zod') {
      parsed.emitZod = true
      continue
    }

    if (token === '--no-emit-zod') {
      parsed.emitZod = false
      continue
    }

    if (token === '--out-file') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) {
        throw new TypegenConfigError('Missing value for --out-file')
      }
      parsed.outFile = value
      i += 1
      continue
    }

    if (token === '--bigint-mode') {
      const value = args[i + 1]
      if (value !== 'string' && value !== 'bigint') {
        throw new TypegenConfigError('Invalid value for --bigint-mode. Expected string or bigint.')
      }
      parsed.bigintMode = value
      i += 1
    }
  }

  return parsed
}

function mergeOptions(
  baseOptions: Required<TypegenPluginOptions>,
  runtimeOptions: Record<string, unknown>,
  argOptions: ParsedCommandArgs
): Required<TypegenPluginOptions> {
  const fromRuntime = normalizeRuntimeOptions(runtimeOptions)
  const withRuntime = normalizeTypegenOptions({ ...baseOptions, ...fromRuntime })

  return normalizeTypegenOptions({
    ...withRuntime,
    outFile: argOptions.outFile ?? withRuntime.outFile,
    emitZod: argOptions.emitZod ?? withRuntime.emitZod,
    bigintMode: argOptions.bigintMode ?? withRuntime.bigintMode,
    includeViews: argOptions.includeViews ?? withRuntime.includeViews,
  })
}

export function isRunOnGenerateEnabled(
  baseOptions: Required<TypegenPluginOptions>,
  runtimeOptions: Record<string, unknown>
): boolean {
  const fromRuntime = normalizeRuntimeOptions(runtimeOptions)
  const effective = normalizeTypegenOptions({ ...baseOptions, ...fromRuntime })
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
  outFile: string
  expected: string
  current: string | null
}): TypegenPluginCheckResult {
  if (input.current === null) {
    return {
      plugin: 'typegen',
      evaluated: true,
      ok: false,
      findings: [
        {
          code: 'typegen_missing_output',
          message: `Typegen output file is missing: ${input.outFile}`,
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
      plugin: 'typegen',
      evaluated: true,
      ok: false,
      findings: [
        {
          code: 'typegen_stale_output',
          message: `Typegen output is stale: ${input.outFile}`,
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
    plugin: 'typegen',
    evaluated: true,
    ok: true,
    findings: [],
    metadata: {
      outFile: input.outFile,
    },
  }
}

export function createTypegenPlugin(options: TypegenPluginOptions = {}): TypegenPlugin {
  const base = normalizeTypegenOptions(options)

  return {
    manifest: {
      name: 'typegen',
      apiVersion: 1,
    },
    commands: [
      {
        name: 'typegen',
        description: 'Generate TypeScript artifacts from CHX schema definitions',
        async run({
          args,
          jsonMode,
          print,
          options: runtimeOptions,
          config,
          configPath,
        }): Promise<undefined | number> {
          try {
            const parsedArgs = parseArgs(args)
            const effectiveOptions = mergeOptions(base, runtimeOptions, parsedArgs)
            const configDir = resolve(configPath, '..')
            const outFile = resolve(configDir, effectiveOptions.outFile)
            const definitions = await loadSchemaDefinitions(config.schema, configDir)
            const generated = generateTypeArtifacts({
              definitions,
              options: effectiveOptions,
            })

            if (parsedArgs.check) {
              const current = await readMaybe(outFile)
              const checkResult = checkGeneratedOutput({
                outFile,
                expected: generated.content,
                current,
              })
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
                  print(`Typegen up-to-date: ${outFile}`)
                } else {
                  const firstCode = checkResult.findings[0]?.code ?? 'typegen_stale_output'
                  print(`Typegen check failed (${firstCode}): ${outFile}`)
                }
              }
              return checkResult.ok ? 0 : 1
            }

            await writeAtomic(outFile, generated.content)
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
              print(`Typegen wrote ${outFile} (${generated.declarationCount} declarations)`)
            }

            return 0
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({
                ok: false,
                error: message,
              })
            } else {
              print(`Typegen failed: ${message}`)
            }

            if (error instanceof TypegenConfigError) {
              return 2
            }
            return 1
          }
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
        const definitions = await loadSchemaDefinitions(config.schema, configDir)
        const generated = generateTypeArtifacts({
          definitions,
          options: effectiveOptions,
        })
        const current = await readMaybe(outFile)
        return checkGeneratedOutput({
          outFile,
          expected: generated.content,
          current,
        })
      },
      onCheckReport({ result, print }) {
        const findingCodes = result.findings.map((finding) => finding.code)
        if (result.ok) {
          print(`typegen check: ok`)
          return
        }
        print(`typegen check: failed${findingCodes.length > 0 ? ` (${findingCodes.join(', ')})` : ''}`)
      },
    },
  }
}
