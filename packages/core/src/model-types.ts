export type PrimitiveColumnType =
  | 'String'
  | 'UInt8'
  | 'UInt16'
  | 'UInt32'
  | 'UInt64'
  | 'UInt128'
  | 'UInt256'
  | 'Int8'
  | 'Int16'
  | 'Int32'
  | 'Int64'
  | 'Int128'
  | 'Int256'
  | 'Float32'
  | 'Float64'
  | 'Bool'
  | 'Boolean'
  | 'Date'
  | 'DateTime'
  | 'DateTime64'

/**
 * General-purpose compression codecs. Exactly one ends a codec chain.
 * Level ranges: LZ4HC 1–12 (default 9), ZSTD 1–22 (default 1).
 */
export type GeneralColumnCodec =
  | { kind: 'NONE' | 'LZ4' | 'T64' | 'GCD' | 'ALP' }
  | { kind: 'LZ4HC'; level?: number }
  | { kind: 'ZSTD'; level?: number }

/**
 * Preprocessing codecs (zero or more) placed before the general codec.
 * `size` (bytes) defaults to 1 in ClickHouse for Delta / DoubleDelta / Gorilla.
 */
export type PreprocessingColumnCodec =
  | { kind: 'Delta' | 'DoubleDelta' | 'Gorilla'; size?: 1 | 2 | 4 | 8 }
  | { kind: 'FPC'; level: number; floatSize: 4 | 8 }

/**
 * Escape hatch — passes the raw expression through unchanged. Useful for
 * codecs we haven't typed (new CH versions, experimental codecs) or unusual
 * arg shapes. Canonicalization is whitespace-only; round-trip may be noisy.
 */
export interface RawColumnCodec {
  kind: 'raw'
  expression: string
}

export type ColumnCodec = GeneralColumnCodec | PreprocessingColumnCodec | RawColumnCodec

/** Single codec or a chain (preprocessors then exactly one general codec). */
export type ColumnCodecSpec = ColumnCodec | ColumnCodec[]

export interface ColumnDefinition {
  name: string
  type: PrimitiveColumnType | string
  renamedFrom?: string
  nullable?: boolean
  default?: string | number | boolean
  comment?: string
  codec?: ColumnCodecSpec
}

interface SkipIndexBase {
  name: string
  expression: string
  granularity: number
}

/**
 * Skip index with structured, discriminated args per type. Arg signatures
 * come from ClickHouse MergeTree docs:
 * - `minmax` — no args
 * - `set(max_rows)` — required int, 0 = store all unique values
 * - `bloom_filter([false_positive_rate])` — optional float, default 0.025
 * - `tokenbf_v1(size_bytes, n_hash, seed)` — 3 required ints
 * - `ngrambf_v1(n, size_bytes, n_hash, seed)` — 4 required ints
 *
 * ClickHouse 26+ requires `set(0)` not bare `set`; `maxRows` is required
 * so this is encoded naturally.
 */
export type SkipIndexDefinition = SkipIndexBase &
  (
    | { type: 'minmax' }
    | { type: 'set'; maxRows: number }
    | { type: 'bloom_filter'; falsePositiveRate?: number }
    | {
        type: 'tokenbf_v1'
        sizeBytes: number
        hashFunctions: number
        randomSeed: number
      }
    | {
        type: 'ngrambf_v1'
        ngramSize: number
        sizeBytes: number
        hashFunctions: number
        randomSeed: number
      }
  )

export interface SelectProjectionDefinition {
  name: string
  query: string
}

/**
 * An index-only projection (`PROJECTION p INDEX (a, b) TYPE basic`) has no
 * SELECT body: it only reorders parts to prune on a secondary key. ClickHouse
 * currently accepts `basic` as the only index type, but `type` stays a string
 * so new types work without a DSL change.
 */
export interface IndexProjectionDefinition {
  name: string
  /** Expression list, e.g. `receiver, sender`. Parenthesized on render. */
  index: string
  type: string
}

export type ProjectionDefinition = SelectProjectionDefinition | IndexProjectionDefinition

// biome-ignore lint/suspicious/noEmptyInterface: must be an interface for declaration merging by plugins
export interface TablePlugins {}

export interface TableDefinition {
  kind: 'table'
  database: string
  name: string
  renamedFrom?: { database?: string; name: string }
  columns: ColumnDefinition[]
  engine: string
  primaryKey: string[]
  orderBy: string[]
  uniqueKey?: string[]
  partitionBy?: string
  ttl?: string
  settings?: Record<string, string | number | boolean>
  indexes?: SkipIndexDefinition[]
  projections?: ProjectionDefinition[]
  comment?: string
  plugins?: TablePlugins
}

export interface ViewDefinition {
  kind: 'view'
  database: string
  name: string
  as: string
  comment?: string
}

export interface MaterializedViewRefresh {
  every?: string
  after?: string
  offset?: string
  randomize?: string
  dependsOn?: Array<{ database: string; name: string }>
  settings?: Record<string, string | number>
  append?: boolean
  empty?: boolean
}

export interface MaterializedViewDefinition {
  kind: 'materialized_view'
  database: string
  name: string
  to: { database: string; name: string }
  refresh?: MaterializedViewRefresh
  as: string
  comment?: string
}

export interface DictionaryAttribute {
  name: string
  type: PrimitiveColumnType | string
  /** DEFAULT / null_value for missing keys. */
  default?: string | number | boolean
  /** EXPRESSION — computed from source columns. Mutually exclusive with default. */
  expression?: string
  hierarchical?: boolean
  /** Enables bidirectional parent/child lookups. Only valid alongside hierarchical. */
  bidirectional?: boolean
  injective?: boolean
  isObjectId?: boolean
}

export interface DictionaryDefinition {
  kind: 'dictionary'
  database: string
  name: string
  renamedFrom?: { database?: string; name: string }
  attributes: DictionaryAttribute[]
  primaryKey: string[]
  /** Raw SOURCE(...) body, e.g. `MYSQL(host '...' password '${env}' ...)`. */
  source: string
  /** Raw LAYOUT(...) body, e.g. `HASHED()` / `COMPLEX_KEY_HASHED()`. */
  layout: string
  /** Raw LIFETIME(...) body, e.g. `300` / `MIN 300 MAX 360`. */
  lifetime: string
  /** RANGE(MIN ... MAX ...) — required by RANGE_HASHED / COMPLEX_KEY_RANGE_HASHED layouts. */
  range?: { min: string; max: string }
  /** Raw SETTINGS(...) key/value pairs. */
  settings?: Record<string, string | number>
  comment?: string
}

export type SchemaDefinition =
  | TableDefinition
  | ViewDefinition
  | MaterializedViewDefinition
  | DictionaryDefinition

export interface ChxCheckConfig {
  failOnPending?: boolean
  failOnChecksumMismatch?: boolean
  failOnDrift?: boolean
  /**
   * Treat objects that exist in ClickHouse but are not in your schema
   * (`extra_object`) as drift. Defaults to `false` so chkit coexists with
   * unmanaged tables on a shared database — only opt in when chkit is expected
   * to own the entire database.
   */
  failOnExtraObjects?: boolean
}

export interface ChxSafetyConfig {
  allowDestructive?: boolean
}

export interface ChxUserClickHouseConfig {
  url: string
  username?: string
  password?: string
  database?: string
  secure?: boolean
  /**
   * Cluster name for self-managed multi-node clusters. When set, chkit emits
   * `ON CLUSTER <name>` on generated DDL and stores its migration journal in a
   * replicated engine. Leave unset for single-node, ClickHouse Cloud, or
   * ObsessionDB (SharedMergeTree auto-replicates — `ON CLUSTER` is unnecessary).
   * Accepts an identifier (e.g. `"my_cluster"`) or a macro (e.g. `"{cluster}"`).
   */
  cluster?: string
}

export interface ChxResolvedClickHouseConfig {
  url: string
  username: string
  password: string
  database: string
  secure: boolean
  cluster?: string
}

export interface ChxInlinePluginRegistration<
  TPlugin = unknown,
  TOptions extends object = Record<string, unknown>,
> {
  plugin: TPlugin
  name?: string
  enabled?: boolean
  options?: TOptions
}

export type ChxPluginRegistration = ChxInlinePluginRegistration

export interface ChxUserConfig {
  schema: string | string[]
  outDir?: string
  migrationsDir?: string
  metaDir?: string
  plugins?: ChxPluginRegistration[]
  check?: ChxCheckConfig
  safety?: ChxSafetyConfig
  clickhouse?: ChxUserClickHouseConfig
}

export interface ChxResolvedConfig {
  schema: string[]
  outDir: string
  migrationsDir: string
  metaDir: string
  plugins: ChxPluginRegistration[]
  check: Required<ChxCheckConfig>
  safety: Required<ChxSafetyConfig>
  clickhouse?: ChxResolvedClickHouseConfig
}

export interface ChxConfigEnv {
  command?: string
  mode?: string
}

export type ChxConfigFn<T extends ChxUserConfig = ChxUserConfig> = (
  env: ChxConfigEnv
) => T | Promise<T>

export type ChxConfigInput<T extends ChxUserConfig = ChxUserConfig> = T | ChxConfigFn<T>
export type ChxConfig = ChxUserConfig
export type ResolvedChxConfig = ChxResolvedConfig

export interface SnapshotV1 {
  version: 1
  generatedAt: string
  definitions: SchemaDefinition[]
}

export type Snapshot = SnapshotV1

export type RiskLevel = 'safe' | 'caution' | 'danger'

export type MigrationOperationType =
  | 'create_database'
  | 'create_table'
  | 'drop_table'
  | 'create_view'
  | 'drop_view'
  | 'create_materialized_view'
  | 'drop_materialized_view'
  | 'alter_materialized_view_modify_refresh'
  | 'alter_table_add_column'
  | 'alter_table_modify_column'
  | 'alter_table_drop_column'
  | 'alter_table_rename_column'
  | 'alter_table_rename_table'
  | 'alter_table_add_index'
  | 'alter_table_add_projection'
  | 'alter_table_modify_setting'
  | 'alter_table_drop_index'
  | 'alter_table_drop_projection'
  | 'alter_table_reset_setting'
  | 'alter_table_modify_ttl'
  | 'create_dictionary'
  | 'drop_dictionary'
  | 'rename_dictionary'

export interface MigrationOperation {
  type: MigrationOperationType
  key: string
  risk: RiskLevel
  sql: string
}

export interface ColumnRenameSuggestion {
  kind: 'column'
  database: string
  table: string
  from: string
  to: string
  confidence: 'high'
  reason: string
  dropOperationKey: string
  addOperationKey: string
  confirmationSQL: string
}

export interface MigrationPlan {
  operations: MigrationOperation[]
  riskSummary: Record<RiskLevel, number>
  renameSuggestions: ColumnRenameSuggestion[]
}

export type ValidationIssueCode =
  | 'duplicate_object_name'
  | 'duplicate_column_name'
  | 'duplicate_index_name'
  | 'duplicate_projection_name'
  | 'projection_ambiguous_kind'
  | 'projection_empty_index'
  | 'primary_key_missing_column'
  | 'order_by_missing_column'
  | 'refresh_requires_every_or_after'
  | 'refresh_every_after_mutually_exclusive'
  | 'refresh_interval_format'
  | 'refresh_append_required_for_replicated_target'
  | 'refresh_depends_on_requires_every'
  | 'codec_chain_must_end_with_general'
  | 'codec_chain_multiple_general'
  | 'codec_chain_empty'
  | 'dictionary_missing_primary_key'
  | 'dictionary_primary_key_missing_attribute'
  | 'dictionary_missing_source'
  | 'dictionary_missing_layout'
  | 'dictionary_missing_lifetime'
  | 'dictionary_attribute_default_expression_exclusive'
  | 'dictionary_range_missing_attribute'
  | 'dictionary_bidirectional_requires_hierarchical'

export interface ValidationIssue {
  code: ValidationIssueCode
  kind: SchemaDefinition['kind']
  database: string
  name: string
  message: string
}
