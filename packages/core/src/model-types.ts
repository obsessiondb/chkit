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

export type ColumnDefaultKind = 'DEFAULT' | 'MATERIALIZED' | 'ALIAS' | 'EPHEMERAL'

/**
 * Raw ClickHouse SQL, rendered unquoted (trimmed, with SQL comments removed)
 * where chkit would otherwise render a literal: a column
 * `default: { expression: 'now64(3)' }` renders `DEFAULT now64(3)`.
 */
export interface SQLExpression {
  expression: string
}

/**
 * A column default: a literal (strings are single-quoted, numbers and booleans
 * render as written) or a {@link SQLExpression} rendered as SQL.
 */
export type ColumnDefaultValue = string | number | boolean | SQLExpression

export interface ColumnDefinition {
  name: string
  type: PrimitiveColumnType | string
  renamedFrom?: string
  nullable?: boolean
  /**
   * Value of the column's `defaultKind` clause (`DEFAULT` unless set).
   * - `'pending'` → `DEFAULT 'pending'` (a string is always a literal)
   * - `0` / `false` → `DEFAULT 0` / `DEFAULT false`
   * - `{ expression: 'now64(3)' }` → `DEFAULT now64(3)` (SQL; comments are
   *   dropped when rendered)
   *
   * `'fn:now64(3)'` is the legacy spelling of `{ expression: 'now64(3)' }`;
   * snapshots store both as the `fn:` string. `generate` rejects a plain string
   * that starts with a function call as the `DEFAULT` of a column that cannot
   * hold a string (`column_default_looks_like_expression`), and any plain
   * string on a `MATERIALIZED` or `ALIAS` column (`column_expression_requires_fn`).
   */
  default?: ColumnDefaultValue
  /**
   * How ClickHouse uses `default`: `DEFAULT` (the implicit kind),
   * `MATERIALIZED`, `ALIAS`, or `EPHEMERAL`. The literal and `{ expression }`
   * forms of `default` work for every kind:
   * `{ defaultKind: 'MATERIALIZED', default: { expression: 'toDate(ts)' } }`
   * renders `MATERIALIZED toDate(ts)`.
   */
  defaultKind?: ColumnDefaultKind
  comment?: string
  codec?: ColumnCodecSpec
}

interface SkipIndexBase {
  name: string
  expression: string
  granularity: number
}

/** Full-text index. ClickHouse ignores granularity and uses one index per part. */
export interface TextSkipIndex extends Omit<SkipIndexBase, 'granularity'> {
  type: 'text'
  /** SQL tokenizer, e.g. splitByNonAlpha or splitByString(['  ', ';']). */
  tokenizer: string
  granularity?: number
  preprocessor?: string
  /** Requires a ClickHouse version that supports postprocessing. */
  postprocessor?: string
  supportPhraseSearch?: boolean
  dictionaryBlockSize?: number
  dictionaryBlockFrontcodingCompression?: boolean
  postingListBlockSize?: number
  postingListCodec?: 'none' | 'bitpacking'
}

/**
 * Vector similarity (approximate nearest neighbour) index, rendered as
 * `vector_similarity(method, distanceFunction[, dimensions][, quantization,
 * hnswMaxConnectionsPerLayer, hnswCandidateListSizeForConstruction])`.
 * `dimensions` is required from ClickHouse 25.4 and rejected before it; the
 * three tuning fields are positional, so set all of them or none. Granularity
 * defaults to 100000000 (one index per part), as ClickHouse recommends.
 */
export interface VectorSimilaritySkipIndex extends Omit<SkipIndexBase, 'granularity'> {
  type: 'vector_similarity'
  method: 'hnsw'
  /** `dotProduct` requires ClickHouse 26.4+. */
  distanceFunction: 'L2Distance' | 'cosineDistance' | 'dotProduct'
  dimensions?: number
  /** `b1` (binary) requires ClickHouse 25.8+, `cosineDistance` and dimensions divisible by 8. */
  quantization?: 'f64' | 'f32' | 'f16' | 'bf16' | 'i8' | 'b1'
  hnswMaxConnectionsPerLayer?: number
  hnswCandidateListSizeForConstruction?: number
  granularity?: number
}

/**
 * Escape hatch for a skip index type chkit has no structured form for, such as
 * `sparse_grams(3, 100, 512, 1, 3, 0)`: `rawType` is rendered verbatim after
 * `TYPE`. `chkit pull` emits it for any type (or argument list) it cannot
 * express structurally, so nothing is lost on a round trip.
 */
export interface RawSkipIndex extends SkipIndexBase {
  type: 'raw'
  rawType: string
}

/**
 * Skip index with structured, discriminated args per type. Arg signatures
 * come from ClickHouse MergeTree docs:
 * - `minmax` — no args
 * - `set(max_rows)` — required int, 0 = store all unique values
 * - `bloom_filter([false_positive_rate])` — optional float, default 0.025
 * - `tokenbf_v1(size_bytes, n_hash, seed)` — 3 required ints
 * - `ngrambf_v1(n, size_bytes, n_hash, seed)` — 4 required ints
 * - `text(tokenizer = ..., ...)` — named parameters, automatic granularity
 * - `vector_similarity(...)` — see {@link VectorSimilaritySkipIndex}
 * - anything else — `type: 'raw'`, see {@link RawSkipIndex}
 *
 * ClickHouse 26+ requires `set(0)` not bare `set`; `maxRows` is required
 * so this is encoded naturally.
 */
export type SkipIndexDefinition = TextSkipIndex | VectorSimilaritySkipIndex | RawSkipIndex | SkipIndexBase &
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

/**
 * A table constraint. `check` renders `CONSTRAINT name CHECK expr`: ClickHouse
 * rejects INSERTs whose rows fail it, but does not validate existing rows when
 * the constraint is added. `assume` renders `CONSTRAINT name ASSUME expr`: never
 * validated, used by the optimizer (`optimize_using_constraints`) as a fact.
 */
export type TableConstraintDefinition =
  | { name: string; check: string; assume?: never }
  | { name: string; assume: string; check?: never }

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
  constraints?: TableConstraintDefinition[]
  comment?: string
  plugins?: TablePlugins
  /**
   * Set by `chkit generate --cutover` with `--cutover-old keep` on the table
   * that keeps the pre-cutover rows (`<table>_previous`). Only the snapshot
   * carries it: `generate` keeps planning the table as declared until
   * `--drop-retained` removes it, so it never reads as a pending drop.
   */
  retainedBy?: { cutover: string }
}

/** Omitted primary keys inherit ORDER BY, matching ClickHouse MergeTree semantics. */
export type TableInput = Omit<TableDefinition, 'kind' | 'primaryKey' | 'retainedBy'> & {
  primaryKey?: string[]
}

/** Kafka queues do not have MergeTree sorting/storage clauses. */
export type KafkaTableInput = Omit<TableDefinition,
  'kind' | 'retainedBy' | 'engine' | 'primaryKey' | 'orderBy' | 'partitionBy' | 'uniqueKey' | 'ttl' | 'indexes' | 'projections' | 'constraints'
> & {
  engine: 'Kafka' | `Kafka(${string})`
  primaryKey?: never
  orderBy?: never
  partitionBy?: never
  uniqueKey?: never
  ttl?: never
  indexes?: never
  projections?: never
  constraints?: never
}

/**
 * Common engines without sort order. ClickHouse rejects PARTITION BY, PRIMARY
 * KEY and ORDER BY on them, so their tables need no keys. Other engines without
 * sort order still validate through `TableInput` with `orderBy: []`.
 */
export type KeylessTableEngine =
  | `Distributed(${string})`
  | `Merge(${string})`
  | `Buffer(${string})`
  | 'Memory' | `Memory(${string})`
  | 'Null' | `Null(${string})`
  | 'Log' | `Log(${string})`
  | 'TinyLog' | `TinyLog(${string})`
  | 'StripeLog' | `StripeLog(${string})`
  | 'Set' | `Set(${string})`
  | `Join(${string})`

/** A table on a `KeylessTableEngine`, e.g. a Distributed table over a local table. */
export type KeylessTableInput = Omit<TableDefinition,
  'kind' | 'retainedBy' | 'engine' | 'primaryKey' | 'orderBy' | 'partitionBy'
> & {
  engine: KeylessTableEngine
  primaryKey?: []
  orderBy?: []
  partitionBy?: never
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
  /** DEFAULT / null_value for missing keys. A literal: ClickHouse accepts no expression here. */
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

export type ChxPluginRegistration = ChxInlinePluginRegistration<unknown, object>

export interface ChxUserConfig {
  /**
   * Glob patterns for schema files. Mutually exclusive with `entry`.
   */
  schema?: string | string[]
  /**
   * Single project entry module. It is imported once: exported schema
   * definitions are collected from it, and exported plugin-domain definitions
   * (for example ingestion pipelines) are collected by their plugins. Mutually
   * exclusive with `schema`.
   */
  entry?: string
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
  entry?: string
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
  | 'alter_table_add_constraint'
  | 'alter_table_drop_constraint'
  | 'create_dictionary'
  | 'drop_dictionary'
  | 'rename_dictionary'
  // Zero-downtime cutover of a structural table change (`generate --cutover`).
  | 'exchange_tables'
  | 'cutover_validate'
  | 'cutover_wait_for_inserts'
  | 'cutover_snapshot'
  | 'cutover_sync_replicas'
  | 'cutover_copy'
  | 'cutover_verify'
  | 'cutover_reconcile'
  | 'cutover_attach'

/**
 * How `migrate` runs a statement: `async` submits it and polls its query id
 * (long data loads); `barrier` reads the running INSERT query ids once and
 * waits until none of them is still running. Unset means synchronous.
 */
export type MigrationOperationMode = 'async' | 'barrier'

export interface MigrationOperation {
  type: MigrationOperationType
  key: string
  risk: RiskLevel
  sql: string
  warning?: string
  mode?: MigrationOperationMode
  /**
   * One line of SQL that `migrate` runs before it attempts the statement again
   * after an earlier attempt failed or was interrupted. A guard that throws
   * stops the retry, e.g. before an `EXCHANGE TABLES` that may already have run.
   */
  beforeRetry?: string
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
  | 'kafka_unsupported_clause'
  | 'engine_unsupported_clause'
  | 'kafka_column_default'
  | 'kafka_missing_setting'
  | 'kafka_invalid_setting'
  | 'kafka_change_requires_replacement'
  | 'column_kind_change_unsupported'
  | 'duplicate_object_name'
  | 'duplicate_column_name'
  | 'duplicate_index_name'
  | 'text_index_invalid_parameters'
  | 'vector_index_invalid_parameters'
  | 'raw_index_invalid_type'
  | 'duplicate_constraint_name'
  | 'constraint_invalid'
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
  | 'column_default_kind_invalid'
  | 'column_expression_required'
  | 'column_expression_requires_fn'
  | 'column_kind_not_stored'
  | 'column_ephemeral_in_projection'
  | 'column_kind_codec_unsupported'
  | 'column_default_looks_like_expression'
  | 'column_default_invalid'
  | 'dictionary_missing_primary_key'
  | 'dictionary_primary_key_missing_attribute'
  | 'dictionary_missing_source'
  | 'dictionary_missing_layout'
  | 'dictionary_missing_lifetime'
  | 'dictionary_attribute_default_expression_exclusive'
  | 'dictionary_range_missing_attribute'
  | 'dictionary_bidirectional_requires_hierarchical'
  | 'invalid_identifier'
  | 'cutover_unsupported'

export interface ValidationIssue {
  code: ValidationIssueCode
  kind: SchemaDefinition['kind']
  database: string
  name: string
  message: string
}
