import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  createClickHouseExecutor,
  inferSchemaKindFromEngine,
  type IntrospectedTable,
} from '@chkit/clickhouse'
import {
  canonicalizeDefinitions,
  type ChxInlinePluginRegistration,
  type MaterializedViewDefinition,
  type ResolvedChxConfig,
  type SchemaDefinition,
  type TableDefinition,
  type ViewDefinition,
} from '@chkit/core'

export interface PullPluginOptions {
  outFile?: string
  databases?: string[]
  overwrite?: boolean
  introspect?: PullIntrospector
}

export interface PullPluginCommandContext {
  args: string[]
  flags: Record<string, string | string[] | boolean | undefined>
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
    flags?: Array<{
      name: string
      type: 'boolean' | 'string' | 'string[]'
      description: string
      placeholder?: string
      negation?: boolean
    }>
    run: (context: PullPluginCommandContext) => undefined | number | Promise<undefined | number>
  }>
}

export type PullIntrospector = (input: {
  config: NonNullable<ResolvedChxConfig['clickhouse']>
  databases: string[]
}) => Promise<IntrospectedObject[]>

export type PullPluginRegistration = ChxInlinePluginRegistration<PullPlugin, PullPluginOptions>

interface FlagOverrides {
  outFile?: string
  databases: string[]
  overwrite?: boolean
  dryrun: boolean
}

interface PullSchemaResult {
  outFile: string
  definitionCount: number
  tableCount: number
  databases: string[]
  skippedObjects: Array<{ kind: string; count: number }>
  content: string
}

type IntrospectedObject =
  | ({ kind: 'table' } & IntrospectedTable)
  | ({ kind: 'view' } & Pick<ViewDefinition, 'database' | 'name' | 'as'>)
  | ({ kind: 'materialized_view' } & Pick<MaterializedViewDefinition, 'database' | 'name' | 'to' | 'as'>)
  | IntrospectedTable

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
        description: 'Pull live ClickHouse table schema and write chkit schema file',
        flags: [
          { name: '--dryrun', type: 'boolean' as const, description: 'Preview without writing files' },
          { name: '--force', type: 'boolean' as const, description: 'Overwrite existing output file' },
          { name: '--overwrite', type: 'boolean' as const, description: 'Overwrite existing output file (alias for --force)' },
          { name: '--out-file', type: 'string' as const, description: 'Output file path', placeholder: '<path>' },
          { name: '--database', type: 'string[]' as const, description: 'Database names to pull', placeholder: '<name>' },
        ],
        async run({ flags, jsonMode, print, options: runtimeOptions, config }) {
          try {
            const overrides = flagsToOverrides(flags)
            const mergedOptions = mergeOptions(base, runtimeOptions, overrides)
            const pulled = await pullSchema({
              config,
              options: { ...mergedOptions, introspect: introspector },
            })

            if (!overrides.dryrun) {
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
              definitionCount: pulled.definitionCount,
              tableCount: pulled.tableCount,
              databases: pulled.databases,
              skippedObjects: pulled.skippedObjects,
              dryrun: overrides.dryrun,
              ...(overrides.dryrun ? { content: pulled.content } : {}),
            }

            if (jsonMode) {
              print(payload)
              return 0
            }

            if (overrides.dryrun) {
              print(
                `Pull preview: ${pulled.definitionCount} objects from ${pulled.databases.join(', ') || '(none)'}`
              )
              print(pulled.content)
            } else {
              print(
                `Pulled ${pulled.definitionCount} objects from ${pulled.databases.join(', ') || '(none)'} to ${pulled.outFile}`
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

function flagsToOverrides(flags: Record<string, string | string[] | boolean | undefined>): FlagOverrides {
  const rawDatabases = flags['--database'] as string[] | undefined
  const databases = normalizeDatabasesOption(rawDatabases ?? [], 'database flag') ?? []

  return {
    dryrun: flags['--dryrun'] === true,
    overwrite: flags['--force'] === true || flags['--overwrite'] === true || undefined,
    outFile: flags['--out-file'] as string | undefined,
    databases,
  }
}

function mergeOptions(
  baseOptions: Required<Omit<PullPluginOptions, 'introspect'>>,
  runtimeOptions: Record<string, unknown>,
  overrides: FlagOverrides
): Required<Omit<PullPluginOptions, 'introspect'>> {
  const runtime = normalizeRuntimeOptions(runtimeOptions)

  return {
    ...baseOptions,
    ...runtime,
    ...(overrides.outFile ? { outFile: overrides.outFile } : {}),
    ...(overrides.databases.length > 0 ? { databases: overrides.databases } : {}),
    ...(overrides.overwrite !== undefined ? { overwrite: overrides.overwrite } : {}),
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
  const usesDefaultIntrospector = introspector === defaultIntrospector
  let objects: Array<{ kind: 'table' | 'view' | 'materialized_view'; database: string; name: string }> = []
  let selectedDatabases = input.options.databases

  if (usesDefaultIntrospector || selectedDatabases.length === 0) {
    const db = createClickHouseExecutor(input.config.clickhouse)
    objects = await db.listSchemaObjects()
    if (selectedDatabases.length === 0) {
      selectedDatabases = [...new Set(objects.map((item) => item.database))].sort()
    }
  }

  const introspected = await introspector({
    config: input.config.clickhouse,
    databases: selectedDatabases,
  })

  const definitions = canonicalizeDefinitions(introspected.map(mapIntrospectedObjectToDefinition))
  const content = renderSchemaFile(definitions)
  const tableCount = definitions.filter((definition) => definition.kind === 'table').length
  const skippedObjects = summarizeSkippedObjects(objects, definitions, selectedDatabases)

  return {
    outFile,
    definitionCount: definitions.length,
    tableCount,
    databases: selectedDatabases,
    skippedObjects,
    content,
  }
}

async function defaultIntrospector(input: {
  config: NonNullable<ResolvedChxConfig['clickhouse']>
  databases: string[]
}): Promise<IntrospectedObject[]> {
  const db = createClickHouseExecutor(input.config)
  const tables = await db.listTableDetails(input.databases)
  const nonTableRows = await listNonTableRows(db, input.databases)
  const nonTableObjects = nonTableRows
    .map(mapSystemTableRowToDefinition)
    .filter((definition): definition is Exclude<IntrospectedObject, IntrospectedTable> => definition !== null)
  return [...tables.map((table) => ({ kind: 'table' as const, ...table })), ...nonTableObjects]
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

function mapIntrospectedObjectToDefinition(introspected: IntrospectedObject): SchemaDefinition {
  if ('kind' in introspected) {
    if (introspected.kind === 'table') return mapIntrospectedTableToDefinition(introspected)
    if (introspected.kind === 'view') {
      return {
        kind: 'view',
        database: introspected.database,
        name: introspected.name,
        as: introspected.as,
      }
    }
    return {
      kind: 'materialized_view',
      database: introspected.database,
      name: introspected.name,
      to: introspected.to,
      as: introspected.as,
    }
  }
  return mapIntrospectedTableToDefinition(introspected)
}

function normalizeDefault(value: TableDefinition['columns'][number]['default']):
  | TableDefinition['columns'][number]['default']
  | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return `fn:${value}`
}

function summarizeSkippedObjects(
  objects: Array<{ kind: 'table' | 'view' | 'materialized_view'; database: string; name: string }>,
  definitions: SchemaDefinition[],
  selectedDatabases: string[]
): Array<{ kind: string; count: number }> {
  if (objects.length === 0) return []

  const scoped = objects.filter((object) => selectedDatabases.includes(object.database))
  const includedKeys = new Set(
    definitions.map((definition) => `${definition.kind}:${definition.database}.${definition.name}`)
  )
  const counts = new Map<string, number>()
  for (const object of scoped) {
    const key = `${object.kind}:${object.database}.${object.name}`
    if (includedKeys.has(key)) continue
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

interface SystemTableRow {
  database: string
  name: string
  engine: string
  create_table_query?: string
}

async function listNonTableRows(
  db: ReturnType<typeof createClickHouseExecutor>,
  databases: string[]
): Promise<SystemTableRow[]> {
  if (databases.length === 0) return []
  const quotedDatabases = databases.map((dbName) => `'${dbName.replace(/'/g, "''")}'`).join(', ')
  return db.query<SystemTableRow>(
    `SELECT database, name, engine, create_table_query
FROM system.tables
WHERE is_temporary = 0
  AND database IN (${quotedDatabases})
  AND engine IN ('View', 'MaterializedView')`
  )
}

function mapSystemTableRowToDefinition(
  row: SystemTableRow
): Exclude<IntrospectedObject, IntrospectedTable> | null {
  const kind = inferSchemaKindFromEngine(row.engine)
  if (kind === 'view') {
    const as = parseAsClause(row.create_table_query)
    if (!as) return null
    return { kind: 'view', database: row.database, name: row.name, as }
  }
  if (kind === 'materialized_view') {
    const as = parseAsClause(row.create_table_query)
    const to = parseToClause(row.create_table_query, row.database)
    if (!as || !to) return null
    return { kind: 'materialized_view', database: row.database, name: row.name, to, as }
  }
  return null
}

function parseAsClause(query: string | undefined): string | null {
  if (!query) return null
  const match = /\bAS\b([\s\S]*)$/i.exec(query)
  if (!match?.[1]) return null
  const asClause = match[1].trim().replace(/;$/, '').trim()
  return asClause.length > 0 ? asClause : null
}

function parseToClause(
  query: string | undefined,
  fallbackDatabase: string
): { database: string; name: string } | null {
  if (!query) return null
  const identifier = /(?:^|\s)TO\s+((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_]+)(?:\.(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_]+))?)/i.exec(
    query
  )?.[1]
  if (!identifier) return null
  const parts = identifier.split('.').map((part) => part.replace(/^[`"]|[`"]$/g, '').trim())
  if (parts.length === 1) {
    const name = parts[0] ?? ''
    if (name.length === 0) return null
    return { database: fallbackDatabase, name }
  }
  if (parts.length === 2) {
    const database = parts[0] ?? fallbackDatabase
    const name = parts[1] ?? ''
    if (database.length === 0 || name.length === 0) return null
    return { database, name }
  }
  return null
}

export const __testUtils = {
  summarizeSkippedObjects,
  parseAsClause,
  parseToClause,
  mapSystemTableRowToDefinition,
}

export function renderSchemaFile(definitions: SchemaDefinition[]): string {
  const canonical = canonicalizeDefinitions(definitions)
  const declarationNames = new Map<string, number>()
  const hasTable = canonical.some((definition) => definition.kind === 'table')
  const hasView = canonical.some((definition) => definition.kind === 'view')
  const hasMaterializedView = canonical.some((definition) => definition.kind === 'materialized_view')
  const imports = ['schema']
  if (hasTable) imports.push('table')
  if (hasView) imports.push('view')
  if (hasMaterializedView) imports.push('materializedView')
  const lines: string[] = [
    `import { ${imports.join(', ')} } from '@chkit/core'`,
    '',
    '// Pulled from live ClickHouse metadata via chkit plugin pull schema',
    '',
  ]

  const references: string[] = []

  for (const definition of canonical) {
    const variableName = resolveTableVariableName(definition.database, definition.name, declarationNames)
    references.push(variableName)

    if (definition.kind === 'table') {
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
    } else if (definition.kind === 'view') {
      lines.push(`const ${variableName} = view({`)
      lines.push(`  database: ${renderString(definition.database)},`)
      lines.push(`  name: ${renderString(definition.name)},`)
      lines.push(`  as: ${renderString(definition.as)},`)
      lines.push('})')
    } else {
      lines.push(`const ${variableName} = materializedView({`)
      lines.push(`  database: ${renderString(definition.database)},`)
      lines.push(`  name: ${renderString(definition.name)},`)
      lines.push(`  to: { database: ${renderString(definition.to.database)}, name: ${renderString(definition.to.name)} },`)
      lines.push(`  as: ${renderString(definition.as)},`)
      lines.push('})')
    }
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
