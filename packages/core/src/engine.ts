import { splitTopLevelComma } from './key-clause.js'

/**
 * Engines outside the MergeTree family that ClickHouse registers with
 * `supports_sort_order` (StorageFactory), so they accept PARTITION BY,
 * PRIMARY KEY, ORDER BY and SAMPLE BY. Every `*MergeTree` engine (plain,
 * Replicated*, Shared*) supports them too. ClickHouse lists the supporting
 * engines in its error when a CREATE uses them on any other engine.
 */
const NON_MERGE_TREE_SORT_ORDER_ENGINES = new Set([
  'AzureBlobStorage',
  'COSN',
  'EmbeddedRocksDB',
  'GCS',
  'HDFS',
  'Hive',
  'Iceberg',
  'IcebergAzure',
  'IcebergHDFS',
  'IcebergLocal',
  'IcebergS3',
  'KeeperMap',
  'MaterializedPostgreSQL',
  'OSS',
  'Redis',
  'S3',
])

/** The engine name without arguments: `Distributed(c, db, t)` -> `Distributed`. */
export function engineName(engine: string): string {
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(engine)?.[1] ?? ''
}

export function isMergeTreeEngine(engine: string): boolean {
  return engineName(engine).endsWith('MergeTree')
}

/**
 * Whether the engine accepts PARTITION BY / PRIMARY KEY / ORDER BY. Memory,
 * Log, Null, Buffer, Merge, Distributed, Kafka and other engines reject them.
 */
export function supportsSortOrder(engine: string): boolean {
  return isMergeTreeEngine(engine) || NON_MERGE_TREE_SORT_ORDER_ENGINES.has(engineName(engine))
}

const REPLICATED_ENGINE_NAME = /^\s*Replicated([A-Za-z0-9_]*MergeTree)/
// A Keeper path or replica name that the server drops: a string literal or a
// heredoc. ObsessionDB keeps an expression path such as concat(...) as written.
const REPLICATION_ARGUMENT = /^(?:'(?:[^'\\]|\\[\s\S]|'')*'|\$([A-Za-z0-9_]*)\$[\s\S]*\$\1\$)$/

/**
 * The engine a `Replicated*MergeTree` table has on a shared-storage server
 * (ObsessionDB, ClickHouse Cloud), without the `Shared` prefix: the server
 * drops the Keeper path and replica name and keeps the other arguments, so
 * `ReplicatedReplacingMergeTree('/p', '{replica}', ver)` is stored as
 * `SharedReplacingMergeTree(ver)`. Undefined for any other engine.
 */
export function replicatedEngineAsShared(engine: string): string | undefined {
  const match = REPLICATED_ENGINE_NAME.exec(engine)
  if (!match) return undefined
  const rest = engine.slice(match[0].length).trim()
  if (rest !== '' && !(rest.startsWith('(') && rest.endsWith(')'))) return undefined
  const inner = rest.slice(1, -1)
  const args = inner.trim() ? splitTopLevelComma(inner) : []
  const [path, replica] = args
  const kept = path !== undefined && replica !== undefined && REPLICATION_ARGUMENT.test(path) && REPLICATION_ARGUMENT.test(replica)
    ? args.slice(2)
    : args
  return `${match[1]}(${kept.join(', ')})`
}

export function isDistributedEngine(engine: string): boolean {
  return engineName(engine) === 'Distributed'
}

/**
 * ClickHouse stores the cluster, database and table arguments of Distributed
 * as string literals (`Distributed(c, db, t)` reads back as
 * `Distributed('c', 'db', 't')`). Quote bare or quoted identifiers the same
 * way so the schema and the live table compare equal. Expressions such as
 * `currentDatabase()` and the sharding key are kept as written.
 */
export function normalizeDistributedEngine(engine: string): string {
  const args = /^\s*Distributed\s*\(([\s\S]*)\)\s*$/.exec(engine)?.[1]
  if (args === undefined) return engine.trim()
  // Cluster, database and table name objects; the sharding key and policy are expressions.
  const normalized = splitTopLevelComma(args).map((arg, index) =>
    index < 3 ? quoteIdentifierArgument(arg) : arg
  )
  return `Distributed(${normalized.join(', ')})`
}

function quoteIdentifierArgument(arg: string): string {
  const quoted = /^(`|")((?:(?!\1).|\1\1)*)\1$/.exec(arg)
  let name: string
  if (quoted) {
    const quote = quoted[1] ?? ''
    name = (quoted[2] ?? '').replaceAll(quote + quote, quote)
  } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
    name = arg
  } else {
    return arg
  }
  return `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
