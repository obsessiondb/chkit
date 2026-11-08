import { join } from 'node:path'

import { clickhouseType } from './clickhouse-type.js'
import type {
  ChxConfigFn,
  ChxConfigInput,
  ChxResolvedConfig,
  ChxUserClickHouseConfig,
  ChxUserConfig,
  ColumnInput,
  DictionaryDefinition,
  KafkaTableInput,
  KeylessTableInput,
  MaterializedViewDefinition,
  SchemaDefinition,
  TableColumns,
  TableDefinition,
  TableInput,
  ValidationIssue,
  ViewDefinition,
} from './model-types.js'

export * from './model-types.js'

export class ChxValidationError extends Error {
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super(
      `Schema validation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}`
    )
    this.name = 'ChxValidationError'
    this.issues = issues
  }
}

export function defineConfig<T extends ChxUserConfig>(config: T): T
export function defineConfig<T extends ChxUserConfig>(config: ChxConfigFn<T>): ChxConfigFn<T>
export function defineConfig<T extends ChxUserConfig>(config: ChxConfigInput<T>): ChxConfigInput<T> {
  return config
}

// A cluster name is interpolated into `ON CLUSTER '<name>'`, so constrain it to
// the characters legal in a `remote_servers` key (an XML element name: letters,
// digits, `_`, `-`, `.`) or a `{macro}` — injection-safe inside the single
// quotes, while still failing fast on typos like quotes or whitespace.
const CLUSTER_NAME_PATTERN = /^([A-Za-z_][A-Za-z0-9_.-]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/

function assertValidClusterName(name: string): string {
  if (!CLUSTER_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid clickhouse.cluster "${name}". Expected a cluster name (e.g. "my_cluster", "prod-eu-1") or a macro (e.g. "{cluster}").`,
    )
  }
  return name
}

export function resolveConfig(config: ChxUserConfig): ChxResolvedConfig {
  const outDir = config.outDir ?? './chkit'
  const migrationsDir = config.migrationsDir ?? join(outDir, 'migrations')
  const metaDir = config.metaDir ?? join(outDir, 'meta')

  const schemaGlobs = config.schema === undefined ? [] : Array.isArray(config.schema) ? config.schema : [config.schema]
  if (config.entry !== undefined && schemaGlobs.length > 0) {
    throw new Error('Config fields "entry" and "schema" are mutually exclusive. Use one project entry module or schema globs, not both.')
  }

  return {
    // In entry mode the entry module is the only schema source: its exported
    // definitions are collected exactly like any other schema file.
    schema: config.entry !== undefined ? [config.entry] : schemaGlobs,
    entry: config.entry,
    outDir,
    migrationsDir,
    metaDir,
    plugins: config.plugins ?? [],
    check: {
      failOnPending: config.check?.failOnPending ?? true,
      failOnChecksumMismatch: config.check?.failOnChecksumMismatch ?? true,
      failOnDrift: config.check?.failOnDrift ?? true,
      failOnExtraObjects: config.check?.failOnExtraObjects ?? false,
    },
    safety: {
      allowDestructive: config.safety?.allowDestructive ?? false,
    },
    clickhouse: config.clickhouse
      ? {
          url: config.clickhouse.url,
          username: config.clickhouse.username ?? 'default',
          password: config.clickhouse.password ?? '',
          database: config.clickhouse.database ?? 'default',
          secure: resolveSecure(config.clickhouse),
          cluster: config.clickhouse.cluster
            ? assertValidClusterName(config.clickhouse.cluster)
            : undefined,
        }
      : undefined,
  }
}

// The client takes the protocol, and without a port the scheme's default port,
// from the URL, so `secure` can only confirm the scheme. A contradicting value is
// an error instead of a silent downgrade to plain HTTP or an ignored setting.
function resolveSecure(clickhouse: ChxUserClickHouseConfig): boolean {
  const scheme = /^(https?):/i.exec(clickhouse.url)?.[1]?.toLowerCase()
  if (scheme === undefined) return clickhouse.secure ?? false
  const fromUrl = scheme === 'https'
  if (clickhouse.secure !== undefined && clickhouse.secure !== fromUrl) {
    throw new Error(
      `clickhouse.secure is ${clickhouse.secure} but clickhouse.url uses ${scheme}://. The URL scheme sets the protocol: remove secure or change the URL to ${clickhouse.secure ? 'https' : 'http'}://.`,
    )
  }
  return fromUrl
}

/** Defines a table. A column's `t` type renders as its ClickHouse type string. */
export function table<const C extends ColumnInput>(input: KafkaTableInput<C>): TableDefinition & TableColumns<C>
export function table<const C extends ColumnInput>(input: KeylessTableInput<C>): TableDefinition & TableColumns<C>
export function table<const C extends ColumnInput>(input: TableInput<C>): TableDefinition & TableColumns<C>
export function table(input: KafkaTableInput | KeylessTableInput | TableInput): TableDefinition & TableColumns {
  const definition: TableDefinition = {
    ...input,
    columns: input.columns.map((column) => ({
      ...column,
      type: typeof column.type === 'string' ? column.type : clickhouseType(column.type),
    })),
    primaryKey: input.primaryKey ?? input.orderBy ?? [],
    orderBy: input.orderBy ?? [],
    kind: 'table',
  }
  const column = (name: string) => {
    const type = input.columns.find((candidate) => candidate.name === name)?.type
    if (type === undefined || typeof type === 'string') {
      throw new Error(`${input.database}.${input.name} has no column "${name}" with a t type`)
    }
    return type
  }
  return Object.defineProperty(definition, 'column', { value: column }) as TableDefinition & TableColumns
}

export function view(input: Omit<ViewDefinition, 'kind'>): ViewDefinition {
  return { ...input, kind: 'view' }
}

export function materializedView(
  input: Omit<MaterializedViewDefinition, 'kind'>
): MaterializedViewDefinition {
  return { ...input, kind: 'materialized_view' }
}

export function dictionary(
  input: Omit<DictionaryDefinition, 'kind'>
): DictionaryDefinition {
  return { ...input, kind: 'dictionary' }
}

export function schema(...definitions: SchemaDefinition[]): SchemaDefinition[] {
  return definitions
}

export function isSchemaDefinition(value: unknown): value is SchemaDefinition {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: string }).kind
  return (
    kind === 'table' || kind === 'view' || kind === 'materialized_view' || kind === 'dictionary'
  )
}
