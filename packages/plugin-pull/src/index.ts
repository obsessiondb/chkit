import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { createClickHouseExecutor, type IntrospectedTable } from '@chx/clickhouse'
import {
  canonicalizeDefinitions,
  type ChxInlinePluginRegistration,
  type ResolvedChxConfig,
  type SchemaDefinition,
  type TableDefinition,
} from '@chx/core'

export interface PullPluginOptions {
  outFile?: string
  databases?: string[]
  overwrite?: boolean
  introspect?: PullIntrospector
}

export interface PullPluginCommandContext {
  args: string[]
  jsonMode: boolean
  options: Record<string, unknown>
  config: ResolvedChxConfig
  configPath: string
  print: (value: unknown) => void
}

export interface PullPlugin {
  manifest: {
    name: 'pull'
    apiVersion: 1
    version?: string
  }
  commands: Array<{
    name: 'schema'
    description: string
    run: (context: PullPluginCommandContext) => undefined | number | Promise<undefined | number>
  }>
}

export type PullIntrospector = (input: {
  config: NonNullable<ResolvedChxConfig['clickhouse']>
  databases: string[]
}) => Promise<IntrospectedTable[]>

export type PullPluginRegistration = ChxInlinePluginRegistration<PullPlugin, PullPluginOptions>

interface ParsedCommandArgs {
  outFile?: string
  databases: string[]
  overwrite?: boolean
  dryrun: boolean
}

interface PullSchemaResult {
  outFile: string
  tableCount: number
  databases: string[]
  skippedObjects: Array<{ kind: string; count: number }>
  content: string
}

const DEFAULT_OPTIONS: Required<Omit<PullPluginOptions, 'introspect'>> = {
  outFile: './src/db/schema/pulled.ts',
  databases: [],
  overwrite: false,
}

class PullConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PullConfigError'
  }
}

export function createPullPlugin(options: PullPluginOptions = {}): PullPlugin {
  const base = normalizePullOptions(options)
  const introspector = options.introspect

  return {
    manifest: {
      name: 'pull',
      apiVersion: 1,
    },
    commands: [
      {
        name: 'schema',
        description: 'Pull live ClickHouse table schema and write CHX schema file',
        async run({ args, jsonMode, print, options: runtimeOptions, config }) {
          try {
            const parsedArgs = parseArgs(args)
            const mergedOptions = mergeOptions(base, runtimeOptions, parsedArgs)
            const pulled = await pullSchema({
              config,
              options: { ...mergedOptions, introspect: introspector },
            })

            if (!parsedArgs.dryrun) {
              await writeSchemaFile({
                outFile: pulled.outFile,
                content: pulled.content,
                overwrite: mergedOptions.overwrite,
              })
            }

            const payload = {
              ok: true,
              command: 'schema' as const,
              outFile: pulled.outFile,
              tableCount: pulled.tableCount,
              databases: pulled.databases,
              skippedObjects: pulled.skippedObjects,
              dryrun: parsedArgs.dryrun,
              ...(parsedArgs.dryrun ? { content: pulled.content } : {}),
            }

            if (jsonMode) {
              print(payload)
              return 0
            }

            if (parsedArgs.dryrun) {
              print(`Pull preview: ${pulled.tableCount} tables from ${pulled.databases.join(', ') || '(none)'}`)
              print(pulled.content)
            } else {
              print(
                `Pulled ${pulled.tableCount} tables from ${pulled.databases.join(', ') || '(none)'} to ${pulled.outFile}`
              )
            }
            return 0
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'schema', error: message })
            } else {
              print(`Pull schema failed: ${message}`)
            }

            if (error instanceof PullConfigError) return 2
            return 1
          }
        },
      },
    ],
  }
}

export function pull(options: PullPluginOptions = {}): PullPluginRegistration {
  return {
    plugin: createPullPlugin(options),
    name: 'pull',
    enabled: true,
    options,
  }
}

function normalizePullOptions(options: PullPluginOptions = {}): Required<Omit<PullPluginOptions, 'introspect'>> {
  const outFile = normalizeOutFileOption(options.outFile)
  const databases = normalizeDatabasesOption(options.databases, 'databases')
  const overwrite = normalizeOverwriteOption(options.overwrite)

  return {
    ...DEFAULT_OPTIONS,
    ...(outFile ? { outFile } : {}),
    ...(databases ? { databases } : {}),
    ...(overwrite !== undefined ? { overwrite } : {}),
  }
}

function parseArgs(args: string[]): ParsedCommandArgs {
  const parsed: ParsedCommandArgs = {
    dryrun: false,
    databases: [],
  }

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (!token) continue

    if (token === '--dryrun') {
      parsed.dryrun = true
      continue
    }

    if (token === '--force' || token === '--overwrite') {
      parsed.overwrite = true
      continue
    }

    if (token === '--out-file') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) {
        throw new PullConfigError('Missing value for --out-file')
      }
      parsed.outFile = value
      i += 1
      continue
    }

    if (token === '--database') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) {
        throw new PullConfigError('Missing value for --database')
      }
      parsed.databases.push(...splitCommaValues(value))
      i += 1
    }
  }

  parsed.databases = normalizeDatabasesOption(parsed.databases, 'database flag') ?? []
  return parsed
}

function mergeOptions(
  baseOptions: Required<Omit<PullPluginOptions, 'introspect'>>,
  runtimeOptions: Record<string, unknown>,
  argOptions: ParsedCommandArgs
): Required<Omit<PullPluginOptions, 'introspect'>> {
  const runtime = normalizeRuntimeOptions(runtimeOptions)

  return {
    ...baseOptions,
    ...runtime,
    ...(argOptions.outFile ? { outFile: argOptions.outFile } : {}),
    ...(argOptions.databases.length > 0 ? { databases: argOptions.databases } : {}),
    ...(argOptions.overwrite !== undefined ? { overwrite: argOptions.overwrite } : {}),
  }
}

function normalizeRuntimeOptions(
  options: Record<string, unknown>
): Partial<Required<Omit<PullPluginOptions, 'introspect'>>> {
  const outFile = normalizeOutFileOption(options.outFile)
  const databases = normalizeDatabasesOption(options.databases, 'databases')
  const overwrite = normalizeOverwriteOption(options.overwrite)

  const normalized: Partial<Required<Omit<PullPluginOptions, 'introspect'>>> = {}
  if (outFile) normalized.outFile = outFile
  if (databases) normalized.databases = databases
  if (overwrite !== undefined) normalized.overwrite = overwrite
  return normalized
}

function normalizeOutFileOption(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PullConfigError('Invalid plugin option "outFile". Expected non-empty string.')
  }
  return value.trim()
}

function normalizeOverwriteOption(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new PullConfigError('Invalid plugin option "overwrite". Expected boolean.')
  }
  return value
}

function normalizeDatabasesOption(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new PullConfigError(`Invalid plugin option "${label}". Expected string array.`)
  }

  const normalized = value
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw new PullConfigError(`Invalid plugin option "${label}". Expected string array.`)
      }
      return entry.trim()
    })
    .filter((entry) => entry.length > 0)

  return [...new Set(normalized)].sort()
}

function splitCommaValues(input: string): string[] {
  return input
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

async function pullSchema(input: {
  config: ResolvedChxConfig
  options: Required<Omit<PullPluginOptions, 'introspect'>> & { introspect?: PullIntrospector }
}): Promise<PullSchemaResult> {
  if (!input.config.clickhouse) {
    throw new PullConfigError('clickhouse config is required for pull plugin')
  }

  const outFile = resolve(process.cwd(), input.options.outFile)
  const introspector = input.options.introspect ?? defaultIntrospector
  let objects: Array<{ kind: 'table' | 'view' | 'materialized_view'; database: string; name: string }> = []
  let selectedDatabases = input.options.databases

  if (selectedDatabases.length === 0) {
    const db = createClickHouseExecutor(input.config.clickhouse)
    objects = await db.listSchemaObjects()
    selectedDatabases = [...new Set(objects.map((item) => item.database))].sort()
  }

  const tables = await introspector({
    config: input.config.clickhouse,
    databases: selectedDatabases,
  })

  const definitions = canonicalizeDefinitions(tables.map(mapIntrospectedTableToDefinition))
  const content = renderSchemaFile(definitions)
  const skippedObjects = summarizeSkippedObjects(objects)

  return {
    outFile,
    tableCount: definitions.length,
    databases: selectedDatabases,
    skippedObjects,
    content,
  }
}

async function defaultIntrospector(input: {
  config: NonNullable<ResolvedChxConfig['clickhouse']>
  databases: string[]
}): Promise<IntrospectedTable[]> {
  const db = createClickHouseExecutor(input.config)
  return db.listTableDetails(input.databases)
}

function mapIntrospectedTableToDefinition(table: IntrospectedTable): TableDefinition {
  return {
    kind: 'table',
    database: table.database,
    name: table.name,
    engine: table.engine ?? 'MergeTree()',
    columns: table.columns.map((column) => ({
      ...column,
      default: normalizeDefault(column.default),
    })),
    primaryKey: splitTopLevelCommaSeparated(table.primaryKey),
    orderBy: splitTopLevelCommaSeparated(table.orderBy),
    ...(table.uniqueKey ? { uniqueKey: splitTopLevelCommaSeparated(table.uniqueKey) } : {}),
    ...(table.partitionBy ? { partitionBy: table.partitionBy } : {}),
    ...(table.ttl ? { ttl: table.ttl } : {}),
    ...(Object.keys(table.settings).length > 0 ? { settings: table.settings } : {}),
    ...(table.indexes.length > 0 ? { indexes: table.indexes } : {}),
    ...(table.projections.length > 0 ? { projections: table.projections } : {}),
  }
}

function normalizeDefault(value: TableDefinition['columns'][number]['default']):
  | TableDefinition['columns'][number]['default']
  | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return `fn:${value}`
}

function summarizeSkippedObjects(
  objects: Array<{ kind: 'table' | 'view' | 'materialized_view'; database: string; name: string }>
): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>()
  for (const object of objects) {
    if (object.kind === 'table') continue
    counts.set(object.kind, (counts.get(object.kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind))
}

function splitTopLevelCommaSeparated(input: string | undefined): string[] {
  if (!input) return []

  const values: string[] = []
  let current = ''
  let depth = 0
  let inString = false
  let quote = "'"

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (!char) continue

    if (inString) {
      current += char
      if (char === quote && input[i - 1] !== '\\') {
        inString = false
      }
      continue
    }

    if (char === "'" || char === '"') {
      current += char
      inString = true
      quote = char
      continue
    }

    if (char === '(') {
      depth += 1
      current += char
      continue
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }

    if (char === ',' && depth === 0) {
      const chunk = normalizeWrappedTuple(current)
      if (chunk.length > 0) values.push(chunk)
      current = ''
      continue
    }

    current += char
  }

  const last = normalizeWrappedTuple(current)
  if (last.length > 0) values.push(last)
  return values
}

function normalizeWrappedTuple(input: string): string {
  const trimmed = input.trim()
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) {
    return trimmed
  }

  let depth = 0
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (depth === 0 && i < trimmed.length - 1) {
      return trimmed
    }
  }

  return trimmed.slice(1, -1).trim()
}

export function renderSchemaFile(definitions: SchemaDefinition[]): string {
  const canonical = canonicalizeDefinitions(definitions).filter(
    (definition): definition is TableDefinition => definition.kind === 'table'
  )
  const declarationNames = new Map<string, number>()
  const lines: string[] = [
    "import { schema, table } from '@chx/core'",
    '',
    '// Pulled from live ClickHouse metadata via chx plugin pull schema',
    '',
  ]

  const references: string[] = []

  for (const definition of canonical) {
    const variableName = resolveTableVariableName(definition.database, definition.name, declarationNames)
    references.push(variableName)

    lines.push(`const ${variableName} = table({`)
    lines.push(`  database: ${renderString(definition.database)},`)
    lines.push(`  name: ${renderString(definition.name)},`)
    lines.push(`  engine: ${renderString(definition.engine)},`)
    lines.push('  columns: [')

    for (const column of definition.columns) {
      const parts: string[] = [
        `name: ${renderString(column.name)}`,
        `type: ${renderString(column.type)}`,
      ]
      if (column.nullable) parts.push('nullable: true')
      if (column.default !== undefined) parts.push(`default: ${renderLiteral(column.default)}`)
      if (column.comment) parts.push(`comment: ${renderString(column.comment)}`)
      lines.push(`    { ${parts.join(', ')} },`)
    }

    lines.push('  ],')
    lines.push(`  primaryKey: ${renderStringArray(definition.primaryKey)},`)
    lines.push(`  orderBy: ${renderStringArray(definition.orderBy)},`)
    if (definition.uniqueKey && definition.uniqueKey.length > 0) {
      lines.push(`  uniqueKey: ${renderStringArray(definition.uniqueKey)},`)
    }
    if (definition.partitionBy) {
      lines.push(`  partitionBy: ${renderString(definition.partitionBy)},`)
    }
    if (definition.ttl) {
      lines.push(`  ttl: ${renderString(definition.ttl)},`)
    }
    if (definition.settings && Object.keys(definition.settings).length > 0) {
      lines.push('  settings: {')
      for (const key of Object.keys(definition.settings).sort()) {
        const value = definition.settings[key]
        if (value === undefined) continue
        lines.push(`    ${renderKey(key)}: ${renderLiteral(value)},`)
      }
      lines.push('  },')
    }
    if (definition.indexes && definition.indexes.length > 0) {
      lines.push('  indexes: [')
      for (const index of definition.indexes) {
        lines.push(
          `    { name: ${renderString(index.name)}, expression: ${renderString(index.expression)}, type: ${renderString(index.type)}, granularity: ${index.granularity} },`
        )
      }
      lines.push('  ],')
    }
    if (definition.projections && definition.projections.length > 0) {
      lines.push('  projections: [')
      for (const projection of definition.projections) {
        lines.push(
          `    { name: ${renderString(projection.name)}, query: ${renderString(projection.query)} },`
        )
      }
      lines.push('  ],')
    }
    lines.push('})')
    lines.push('')
  }

  lines.push(`export default schema(${references.join(', ')})`)
  return `${lines.join('\n')}\n`
}

function resolveTableVariableName(
  database: string,
  name: string,
  counts: Map<string, number>
): string {
  const base = sanitizeIdentifier(`${database}_${name}`)
  const current = counts.get(base) ?? 0
  const next = current + 1
  counts.set(base, next)
  return next === 1 ? base : `${base}_${next}`
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (sanitized.length === 0) return 'table_ref'
  if (/^[0-9]/.test(sanitized)) return `table_${sanitized}`
  return sanitized
}

function renderString(value: string): string {
  return JSON.stringify(value)
}

function renderStringArray(values: string[]): string {
  return `[${values.map((value) => renderString(value)).join(', ')}]`
}

function renderLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return renderString(value)
  return String(value)
}

function renderKey(value: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(value)) return value
  return renderString(value)
}

async function writeSchemaFile(input: {
  outFile: string
  content: string
  overwrite: boolean
}): Promise<void> {
  if (!input.overwrite) {
    const exists = await pathExists(input.outFile)
    if (exists) {
      throw new PullConfigError(
        `Output file already exists at ${input.outFile}. Re-run with --force or set plugin option overwrite=true.`
      )
    }
  }

  await mkdir(dirname(input.outFile), { recursive: true })
  const tempPath = join(dirname(input.outFile), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  await writeFile(tempPath, input.content, 'utf8')
  await rename(tempPath, input.outFile)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}
