import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { z } from 'zod'
import {
  type ClickHouseExecutor,
  createClickHouseExecutor,
  type IntrospectedTable,
} from '@chkit/clickhouse'
import {
  canonicalizeDefinitions,
  type ChxInlinePluginRegistration,
  defineFlags,
  type FlagMapping,
  normalizeEngine,
  type ResolvedChxConfig,
  type SafeParseable,
  type SchemaDefinition,
  splitTopLevelComma,
  type TableDefinition,
  wrapPluginRun,
} from '@chkit/core'
export { renderSchemaFile } from './render-schema.js'
import { renderSchemaFile } from './render-schema.js'
import {
  mapSystemTableRowToDefinition,
  parseAsClause,
  parseRefreshClause,
  parseToClause,
  type IntrospectedObject,
  type SystemTableRow,
} from './view-parser.js'

// ───── Pull command schema ─────

export const PullSchema = z.object({
  outFile: z.string().min(1).default('./src/db/schema/pulled.ts'),
  databases: z.array(z.string()).default([]).transform((arr) =>
    [...new Set(arr.map((s) => s.trim()).filter((s) => s.length > 0))].sort()
  ),
  overwrite: z.boolean().default(false),
})
type PullOptions = z.infer<typeof PullSchema>

// ───── Types ─────

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
  options: PullOptions
  rawOptions: Record<string, unknown>
  config: ResolvedChxConfig
  configPath: string
  print: (value: unknown) => void
  /** Executor resolved by the host (e.g. the ObsessionDB remote executor when a service is selected). */
  pluginContext?: { executor: ClickHouseExecutor; hasExecutor: boolean }
}

export interface PullPlugin {
  manifest: {
    name: 'pull'
    apiVersion: 1
    version?: string
  }
  optionsSchema?: SafeParseable<PullOptions>
  commands: Array<{
    name: 'schema'
    description: string
    flags?: ReadonlyArray<{
      name: string
      type: 'boolean' | 'string' | 'string[]'
      description: string
      placeholder?: string
      negation?: boolean
    }>
    optionsSchema?: SafeParseable<PullOptions>
    flagMapping?: FlagMapping
    run: (context: PullPluginCommandContext) => undefined | number | Promise<undefined | number>
  }>
}

export type PullIntrospector = (input: {
  config: NonNullable<ResolvedChxConfig['clickhouse']>
  databases: string[]
}) => Promise<IntrospectedObject[]>

export type PullPluginRegistration = ChxInlinePluginRegistration<PullPlugin, PullPluginOptions>

// ───── CLI flag definitions ─────

const PULL_SCHEMA_FLAGS = defineFlags([
  { name: '--dryrun', type: 'boolean', description: 'Preview without writing files' },
  { name: '--force', type: 'boolean', description: 'Overwrite existing output file' },
  { name: '--overwrite', type: 'boolean', description: 'Overwrite existing output file (alias for --force)' },
  { name: '--out-file', type: 'string', description: 'Output file path', placeholder: '<path>' },
  { name: '--database', type: 'string[]', description: 'Database names to pull', placeholder: '<name>' },
] as const)

// ───── Flag mapping ─────

const PULL_FLAG_MAP: FlagMapping = {
  '--out-file': { key: 'outFile' },
  '--force': { key: 'overwrite' },
  '--overwrite': { key: 'overwrite' },
  '--database': { key: 'databases' },
}

// ───── Errors ─────

class PullConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PullConfigError'
  }
}

// ───── Plugin ─────

interface PullSchemaResult {
  outFile: string
  definitionCount: number
  tableCount: number
  databases: string[]
  skippedObjects: Array<{ kind: string; count: number }>
  content: string
}

function stringArrayFlag(value: string | string[] | boolean | undefined): string[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return [value]
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withFactoryDefaults<T>(
  schema: SafeParseable<T>,
  defaults: Record<string, unknown>,
): SafeParseable<T> {
  return {
    safeParse(data) {
      return schema.safeParse({ ...defaults, ...(isRecord(data) ? data : {}) })
    },
  }
}

export function createPullPlugin(options: PullPluginOptions = {}): PullPlugin {
  const { introspect: introspector, ...factoryOptions } = options
  const optionsSchema = withFactoryDefaults(PullSchema, factoryOptions)

  return {
    manifest: {
      name: 'pull',
      apiVersion: 1,
    },
    optionsSchema,
    commands: [
      {
        name: 'schema',
        description: 'Pull live ClickHouse table schema and write chkit schema file',
        flags: PULL_SCHEMA_FLAGS,
        optionsSchema,
        flagMapping: PULL_FLAG_MAP,
        async run({ flags, jsonMode, print, options: opts, config, pluginContext }) {
          return wrapPluginRun({
            command: 'schema',
            label: 'Pull schema',
            jsonMode,
            print,
            configErrorClass: PullConfigError,
            fn: async () => {
              const flagOptions = {
                ...(typeof flags['--out-file'] === 'string' ? { outFile: flags['--out-file'] } : {}),
                ...(flags['--force'] === true || flags['--overwrite'] === true
                  ? { overwrite: true }
                  : {}),
                ...(stringArrayFlag(flags['--database'])
                  ? { databases: stringArrayFlag(flags['--database']) }
                  : {}),
              }
              const effectiveOptions = PullSchema.parse({
                ...factoryOptions,
                ...(isRecord(opts) ? opts : {}),
                ...flagOptions,
              })
              const dryrun = flags['--dryrun'] === true
              const pulled = await pullSchema({
                config,
                executor: pluginContext?.hasExecutor ? pluginContext.executor : null,
                options: { ...effectiveOptions, introspect: introspector },
              })

              if (!dryrun) {
                await writeSchemaFile({
                  outFile: pulled.outFile,
                  content: pulled.content,
                  overwrite: effectiveOptions.overwrite,
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
                dryrun,
                ...(dryrun ? { content: pulled.content } : {}),
              }

              if (jsonMode) {
                print(payload)
                return 0
              }

              if (dryrun) {
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
            },
          })
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

// ───── Internal helpers ─────

async function pullSchema(input: {
  config: ResolvedChxConfig
  executor?: ClickHouseExecutor | null
  options: PullOptions & { introspect?: PullIntrospector }
}): Promise<PullSchemaResult> {
  const customIntrospector = input.options.introspect

  // Prefer the host-provided executor — e.g. the ObsessionDB remote executor when a service is
  // selected — so pull introspects through whatever target the rest of the CLI targets, not just a
  // direct ClickHouse URL. Fall back to building one from the clickhouse config block.
  const db: ClickHouseExecutor | null =
    input.executor ??
    (input.config.clickhouse ? createClickHouseExecutor(input.config.clickhouse) : null)

  // A custom introspector opens its own raw-ClickHouse connection and needs the config block.
  if (customIntrospector && !input.config.clickhouse) {
    throw new PullConfigError('clickhouse config is required for a custom pull introspector')
  }
  if (!customIntrospector && !db) {
    throw new PullConfigError(
      'pull needs a target: set CLICKHOUSE_URL or select an ObsessionDB service (chkit obsessiondb service select)'
    )
  }

  const outFile = resolve(process.cwd(), input.options.outFile)
  let objects: Array<{ kind: 'table' | 'view' | 'materialized_view'; database: string; name: string }> = []
  let selectedDatabases = input.options.databases

  if (db && (!customIntrospector || selectedDatabases.length === 0)) {
    objects = await db.listSchemaObjects()
    if (selectedDatabases.length === 0) {
      selectedDatabases = [...new Set(objects.map((item) => item.database))].sort()
    }
  }

  const introspected = customIntrospector
    ? await customIntrospector({
        config: input.config.clickhouse as NonNullable<ResolvedChxConfig['clickhouse']>,
        databases: selectedDatabases,
      })
    : await introspectWithExecutor(db as ClickHouseExecutor, selectedDatabases)

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

async function introspectWithExecutor(
  db: ClickHouseExecutor,
  databases: string[]
): Promise<IntrospectedObject[]> {
  const tables = await db.listTableDetails(databases)
  const nonTableRows = await listNonTableRows(db, databases)
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
    engine: normalizeEngine(table.engine ?? 'MergeTree()'),
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
      ...(introspected.refresh ? { refresh: introspected.refresh } : {}),
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
  return splitTopLevelComma(input).map(normalizeWrappedTuple)
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

export const __testUtils = {
  summarizeSkippedObjects,
  parseAsClause,
  parseToClause,
  parseRefreshClause,
  mapSystemTableRowToDefinition,
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
