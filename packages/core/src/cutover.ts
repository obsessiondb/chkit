import { canonicalizeDefinition, definitionKey } from './canonical.js'
import { engineName } from './engine.js'
import { renderQualifiedName } from './identifier.js'
import { isKafkaEngine } from './kafka.js'
import {
  ChxValidationError,
  type ColumnDefinition,
  type MigrationOperation,
  type SchemaDefinition,
  type TableDefinition,
} from './model.js'
import { renderColumnType, toCreateSQL } from './sql.js'

/**
 * Zero-downtime cutover of a structural table change (`chkit generate
 * --cutover`). Writers keep inserting into the table the whole time.
 *
 * 1. Create a shadow table with the new definition and a mirror materialized
 *    view `FROM <table> TO <shadow>`, so every INSERT that starts from now on
 *    is written to both tables.
 * 2. Wait until every INSERT that was already running has finished: those
 *    built their pipeline before the mirror existed and are not mirrored.
 * 3. Snapshot the table's parts into a frozen copy (`ATTACH PARTITION ALL`,
 *    hard links) and wait for the INSERTs running at that moment, so every
 *    mirrored row of the snapshot has reached the shadow.
 * 4. Copy the snapshot rows whose unique key is not in the shadow yet. Rows
 *    inserted before the mirror are copied, mirrored rows are skipped, and a
 *    retried copy skips what an earlier attempt wrote.
 * 5. Verify per key that the shadow holds exactly the snapshot's rows.
 * 6. `EXCHANGE TABLES` the table and the shadow, then drop the mirror.
 * 7. Reconcile: an INSERT builds its pipeline a few names at a time, so one
 *    that starts at the instant of the swap can resolve the table before it
 *    and the rest after it. It then writes its rows only to the old table:
 *    once, without running any view (the old table no longer has the name the
 *    views read from), or twice, with the views having run (the mirror wrote
 *    the second copy back to the old table). Once no INSERT runs that could
 *    still do that, the rows of the old table whose key the new one lacks are
 *    added to it: rows the old table holds once by an INSERT, which runs the
 *    table's materialized views; rows it holds twice by ATTACH PARTITION from
 *    a staging table, which does not run them a second time.
 * 8. The old table is kept as `<table>_previous` or dropped; the snapshot is
 *    dropped.
 *
 * The unique key is the boundary between mirrored and copied rows, so the
 * cutover requires it: no INSERT may reuse a key that already exists.
 */

export type CutoverCopyMode = 'migration' | 'backfill'
export type CutoverOldTableMode = 'keep' | 'drop'

export const CUTOVER_COPY_MODES: readonly CutoverCopyMode[] = ['migration', 'backfill']
export const CUTOVER_OLD_TABLE_MODES: readonly CutoverOldTableMode[] = ['keep', 'drop']

export interface CutoverRequest {
  database: string
  table: string
  /** Columns that identify a row; no two rows ever share them. */
  key: string[]
}

export interface CutoverOptions {
  copy: CutoverCopyMode
  oldTable: CutoverOldTableMode
  /** `clickhouse.cluster`: DDL runs ON CLUSTER and data steps run on every shard. */
  cluster?: string
  /** `YYYYMMDDHHMMSS`, makes the temporary object names unique per cutover. */
  stamp: string
}

export interface CutoverNames {
  /** Created with the new definition; after the swap it holds the old table. */
  shadow: string
  mirror: string
  snapshot: string
  /** Holds the rows the swap left behind in the old table, until they are attached to the new one. */
  reconcile: string
  /** Final name of the old table with `--cutover-old keep`. */
  previous: string
}

/** Stored as the snapshot table's comment; `plugin backfill --cutover` reads it. */
export interface CutoverMetadata {
  chkitCutover: 1
  database: string
  table: string
  shadow: string
  snapshot: string
  key: string[]
  columns: string[]
}

export interface PlannedCutover {
  request: CutoverRequest
  options: CutoverOptions
  names: CutoverNames
  /** Columns copied and mirrored: stored in the old table, insertable in the new one. */
  columns: string[]
  operations: MigrationOperation[]
  /** With `--cutover-old keep`, the old definition as `<table>_previous`. */
  retained?: TableDefinition
}

const PLAIN_MERGE_TREE_ENGINES = new Set(['MergeTree', 'ReplicatedMergeTree', 'SharedMergeTree'])

// Engines whose writers stream batches from a background thread, not from a
// query in system.processes, so the insert barrier cannot see them.
const STREAMING_ENGINES = new Set([
  'Kafka',
  'RabbitMQ',
  'NATS',
  'FileLog',
  'S3Queue',
  'AzureQueue',
  'ObjectStorageQueue',
  'Redis',
])

const COMMENT_PREFIX = 'chkit cutover '

export function cutoverNames(table: string, stamp: string): CutoverNames {
  const shadow = `${table}__cutover_${stamp}`
  return {
    shadow,
    mirror: `${shadow}_mirror`,
    snapshot: `${shadow}_snapshot`,
    reconcile: `${shadow}_reconcile`,
    previous: `${table}_previous`,
  }
}

/** Parses `db.table=col[,col...]` from `--cutover`. */
export function parseCutoverRequest(value: string): CutoverRequest {
  const eq = value.indexOf('=')
  const target = (eq === -1 ? value : value.slice(0, eq)).trim()
  const keyPart = eq === -1 ? '' : value.slice(eq + 1)
  const dot = target.indexOf('.')
  const database = dot === -1 ? '' : target.slice(0, dot).trim()
  const table = dot === -1 ? '' : target.slice(dot + 1).trim()
  if (!database || !table) {
    throw new Error(`Invalid --cutover "${value}". Expected <database>.<table>=<key column>[,<key column>...].`)
  }
  const key = keyPart.split(',').map((column) => column.trim()).filter((column) => column.length > 0)
  if (key.length === 0) {
    throw new Error(
      `--cutover ${target} needs the columns that identify a row: --cutover ${target}=<column>[,<column>...]. ` +
        'A zero-downtime cutover tells copied rows from mirrored rows by that key, so no two rows may share it.'
    )
  }
  return { database, table, key }
}

export function formatCutoverMetadata(metadata: CutoverMetadata): string {
  return `${COMMENT_PREFIX}${JSON.stringify(metadata)}`
}

/** Reads the metadata a cutover stores as its snapshot table's comment, if it is one. */
export function parseCutoverMetadata(comment: string): CutoverMetadata | undefined {
  if (!comment.startsWith(COMMENT_PREFIX)) return undefined
  try {
    const parsed = JSON.parse(comment.slice(COMMENT_PREFIX.length)) as Partial<CutoverMetadata>
    if (
      parsed.chkitCutover !== 1 ||
      typeof parsed.database !== 'string' ||
      typeof parsed.table !== 'string' ||
      typeof parsed.shadow !== 'string' ||
      typeof parsed.snapshot !== 'string' ||
      !Array.isArray(parsed.key) ||
      !Array.isArray(parsed.columns)
    ) {
      return undefined
    }
    return parsed as CutoverMetadata
  } catch {
    return undefined
  }
}

/**
 * Plans the cutover of `request` from `oldDef` to `newDef`. `definitions` is
 * the full new schema, read for writers of the table that the cutover cannot
 * cover. Throws `ChxValidationError` (`cutover_unsupported`) when the change
 * cannot be cut over safely.
 */
export function planCutover(input: {
  oldDef: TableDefinition
  newDef: TableDefinition
  request: CutoverRequest
  options: CutoverOptions
  definitions: SchemaDefinition[]
}): PlannedCutover {
  const oldDef = canonicalTable(input.oldDef)
  const newDef = canonicalTable(input.newDef)
  const { request, options } = input
  const names = cutoverNames(request.table, options.stamp)
  const columns = assertCutoverSupported({ oldDef, newDef, request, options, definitions: input.definitions, names })
  const sql = createCutoverSql({ database: request.database, table: request.table, names, columns, key: request.key, cluster: options.cluster })
  const metadata: CutoverMetadata = {
    chkitCutover: 1,
    database: request.database,
    table: request.table,
    shadow: names.shadow,
    snapshot: names.snapshot,
    key: request.key,
    columns,
  }

  const operations = buildOperations({ oldDef, newDef, request, options, names, sql, metadata })
  const retained = options.oldTable === 'keep'
    ? { ...withoutRename(input.oldDef), name: names.previous, retainedBy: { cutover: `${request.database}.${request.table}` } }
    : undefined
  return { request, options, names, columns, operations, retained }
}

function buildOperations(input: {
  oldDef: TableDefinition
  newDef: TableDefinition
  request: CutoverRequest
  options: CutoverOptions
  names: CutoverNames
  sql: CutoverSql
  metadata: CutoverMetadata
}): MigrationOperation[] {
  const { oldDef, newDef, request, options, names, sql, metadata } = input
  const { database } = request
  const tableKey = `table:${database}.${request.table}`
  const stepKey = (step: string) => `${tableKey}:cutover:${step}`
  const operations: MigrationOperation[] = [
    {
      type: 'cutover_validate',
      key: stepKey('start'),
      risk: 'caution',
      sql: sql.validateStart,
    },
    {
      type: 'create_table',
      key: `table:${database}.${names.shadow}`,
      risk: 'safe',
      sql: toCreateSQL({ ...withoutRename(newDef), name: names.shadow }),
    },
    {
      type: 'create_materialized_view',
      key: `materialized_view:${database}.${names.mirror}`,
      risk: 'caution',
      sql: sql.createMirror,
      warning: `From here on every INSERT into ${database}.${request.table} is also written to ${database}.${names.shadow}. No INSERT may reuse a key (${request.key.join(', ')}) that already exists, and no mutation (ALTER UPDATE/DELETE, lightweight DELETE, TRUNCATE, partition operations) may run on ${database}.${request.table} until the cutover migration completes.`,
    },
    {
      type: 'cutover_wait_for_inserts',
      key: stepKey('mirror_barrier'),
      risk: 'safe',
      sql: sql.insertBarrier,
      mode: 'barrier',
    },
    {
      type: 'create_table',
      key: `table:${database}.${names.snapshot}`,
      risk: 'safe',
      sql: toCreateSQL({ ...withoutRename(oldDef), name: names.snapshot, comment: formatCutoverMetadata(metadata) }),
    },
    {
      type: 'cutover_snapshot',
      key: stepKey('snapshot'),
      risk: 'caution',
      sql: sql.attachSnapshot,
      beforeRetry: sql.truncateSnapshot,
    },
    {
      type: 'cutover_wait_for_inserts',
      key: stepKey('snapshot_barrier'),
      risk: 'safe',
      sql: sql.insertBarrier,
      mode: 'barrier',
    },
  ]
  // Replicated tables apply parts asynchronously on the other replicas: the
  // copy and the verification read whichever replica cluster() picks.
  const syncReplicas = (step: string): MigrationOperation[] =>
    sql.syncReplicas.map((statement, index): MigrationOperation => ({
      type: 'cutover_sync_replicas',
      key: stepKey(`${step}_${index === 0 ? 'snapshot' : 'shadow'}`),
      risk: 'safe',
      sql: statement,
    }))
  operations.push(...syncReplicas('sync_before_copy'))
  if (options.copy === 'migration') {
    operations.push({
      type: 'cutover_copy',
      key: stepKey('copy'),
      risk: 'caution',
      sql: sql.copy,
      mode: 'async',
    })
    operations.push(...syncReplicas('sync_before_verify'))
  }
  operations.push(
    {
      type: 'cutover_verify',
      key: stepKey('verify'),
      risk: 'caution',
      sql: options.copy === 'migration' ? sql.verifyAfterCopy : sql.verifyBackfill,
    },
    {
      type: 'cutover_validate',
      key: stepKey('before_exchange'),
      risk: 'caution',
      sql: sql.validateBeforeExchange,
    },
    {
      type: 'exchange_tables',
      key: tableKey,
      risk: 'caution',
      sql: `EXCHANGE TABLES ${renderQualifiedName(database, request.table)} AND ${renderQualifiedName(database, names.shadow)};`,
      beforeRetry: sql.unswappedGuard,
    },
    {
      type: 'drop_materialized_view',
      key: `materialized_view:${database}.${names.mirror}`,
      risk: 'caution',
      sql: `DROP TABLE IF EXISTS ${renderQualifiedName(database, names.mirror)} SYNC;`,
    },
    {
      type: 'cutover_validate',
      key: stepKey('after_exchange'),
      risk: 'caution',
      sql: sql.validateAfterExchange,
    },
    {
      type: 'cutover_wait_for_inserts',
      key: stepKey('exchange_barrier'),
      risk: 'safe',
      sql: sql.insertBarrier,
      mode: 'barrier',
    },
    ...sql.syncAfterExchange.map((statement, index): MigrationOperation => ({
      type: 'cutover_sync_replicas',
      key: stepKey(`sync_before_reconcile_${index === 0 ? 'old' : 'new'}`),
      risk: 'safe',
      sql: statement,
    })),
    {
      type: 'cutover_reconcile',
      key: stepKey('reconcile_unmirrored'),
      risk: 'caution',
      sql: sql.reconcileUnmirrored,
      mode: 'async',
    },
    {
      type: 'create_table',
      key: `table:${database}.${names.reconcile}`,
      risk: 'safe',
      sql: toCreateSQL({ ...withoutRename(newDef), name: names.reconcile }),
    },
    {
      type: 'cutover_reconcile',
      key: stepKey('reconcile'),
      risk: 'caution',
      sql: sql.reconcile,
      mode: 'async',
      beforeRetry: sql.truncateReconcile,
    },
    {
      type: 'cutover_attach',
      key: stepKey('attach_reconciled'),
      risk: 'caution',
      sql: sql.attachReconciled,
      beforeRetry: sql.notAttachedGuard,
    },
    {
      type: 'drop_table',
      key: `table:${database}.${names.reconcile}`,
      risk: 'caution',
      sql: `DROP TABLE IF EXISTS ${renderQualifiedName(database, names.reconcile)} SYNC;`,
    },
  )
  if (options.oldTable === 'keep') {
    operations.push({
      type: 'alter_table_rename_table',
      key: `table:${database}.${names.previous}:rename_table`,
      risk: 'caution',
      sql: `RENAME TABLE IF EXISTS ${renderQualifiedName(database, names.shadow)} TO ${renderQualifiedName(database, names.previous)};`,
    })
  } else {
    operations.push({
      type: 'drop_table',
      key: `table:${database}.${names.shadow}`,
      risk: 'danger',
      sql: `DROP TABLE IF EXISTS ${renderQualifiedName(database, names.shadow)} SYNC;`,
      beforeRetry: sql.swappedGuard,
      warning: `Drops the pre-cutover table ${database}.${names.shadow} (the old ${database}.${request.table}). Use --cutover-old keep to retain it as ${database}.${names.previous}.`,
    })
  }
  operations.push({
    type: 'drop_table',
    key: `table:${database}.${names.snapshot}`,
    risk: 'caution',
    sql: `DROP TABLE IF EXISTS ${renderQualifiedName(database, names.snapshot)} SYNC;`,
  })
  return operations
}

interface CutoverSql {
  validateStart: string
  createMirror: string
  insertBarrier: string
  attachSnapshot: string
  truncateSnapshot: string
  /** Empty without a cluster. */
  syncReplicas: string[]
  /** Empty without a cluster. */
  syncAfterExchange: string[]
  copy: string
  reconcile: string
  reconcileUnmirrored: string
  truncateReconcile: string
  attachReconciled: string
  notAttachedGuard: string
  verifyAfterCopy: string
  verifyBackfill: string
  validateBeforeExchange: string
  unswappedGuard: string
  validateAfterExchange: string
  swappedGuard: string
}

function createCutoverSql(input: {
  database: string
  table: string
  names: CutoverNames
  columns: string[]
  key: string[]
  cluster?: string
}): CutoverSql {
  const { database, table, names, columns, key, cluster } = input
  const q = (name: string) => renderQualifiedName(database, name)
  const target = `${database}.${table}`
  const columnList = columns.map(quoteColumn).join(', ')
  const keyList = key.map(quoteColumn).join(', ')
  const everyReplica = (query: string) => (cluster ? `clusterAllReplicas(${stringLiteral(cluster)}, view(${query}))` : `(${query})`)
  const tableCount = (name: string) => `(SELECT count() FROM system.tables WHERE database = ${stringLiteral(database)} AND name = ${stringLiteral(name)})`
  const layout = (name: string) =>
    `(SELECT any(tuple(engine, sorting_key, primary_key, partition_key)) FROM system.tables WHERE database = ${stringLiteral(database)} AND name = ${stringLiteral(name)})`
  // Per replica: 1 when the condition holds. A guard throws unless every replica reports 1.
  const guard = (condition: string, message: string) =>
    `SELECT throwIf(countIf(ok = 0) > 0 OR count() = 0, ${stringLiteral(message)}) FROM ${everyReplica(`SELECT toUInt8(${condition}) AS ok`)}`
  const unswapped = `${tableCount(table)} = 1 AND ${tableCount(names.snapshot)} = 1 AND ${tableCount(names.shadow)} = 1 AND ${layout(table)} = ${layout(names.snapshot)} AND ${layout(names.shadow)} != ${layout(names.snapshot)}`
  const swapped = `${tableCount(names.shadow)} = 0 OR (${tableCount(names.snapshot)} = 1 AND ${layout(names.shadow)} = ${layout(names.snapshot)} AND ${layout(table)} != ${layout(names.snapshot)})`
  const unswappedGuard = guard(
    unswapped,
    `${target} no longer has its original layout next to ${names.snapshot}: the EXCHANGE may already have run. Compare both tables in system.tables before you retry; never exchange them again blindly.`
  )
  const pendingMutations = `(SELECT count() FROM system.mutations WHERE database = ${stringLiteral(database)} AND table = ${stringLiteral(table)} AND NOT is_done)`

  const settings = cluster ? '' : ' SETTINGS select_sequential_consistency = 1'
  // Hash a tuple: cityHash64 returns NULL when one of its arguments is NULL,
  // and sumIf skips NULLs, so a row with a NULL column would not be compared.
  const verifyQuery = [
    'SELECT count() AS bad FROM (',
    `SELECT ${keyList}, sum(src) AS snapshot_rows, sum(1 - src) AS shadow_rows, sumIf(h, src = 1) AS snapshot_hash, sumIf(h, src = 0) AS shadow_hash`,
    `FROM (SELECT ${keyList}, toUInt8(1) AS src, cityHash64(tuple(${columnList})) AS h FROM ${q(names.snapshot)}`,
    `UNION ALL SELECT ${keyList}, toUInt8(0) AS src, cityHash64(tuple(${columnList})) AS h FROM ${q(names.shadow)})`,
    `GROUP BY ${keyList} HAVING snapshot_rows > 0 AND (snapshot_rows != shadow_rows OR snapshot_hash != shadow_hash))`,
  ].join(' ')
  const verify = (message: string) =>
    cluster
      ? `SELECT throwIf(sum(bad) > 0, ${stringLiteral(message)}) FROM cluster(${stringLiteral(cluster)}, view(${verifyQuery}));`
      : `SELECT throwIf(bad > 0, ${stringLiteral(message)}) FROM (${verifyQuery})${settings};`

  const copy = cluster
    ? [
        `INSERT INTO FUNCTION cluster(${stringLiteral(cluster)}, ${stringLiteral(database)}, ${stringLiteral(names.shadow)}) (${columnList})`,
        `SELECT ${columnList} FROM cluster(${stringLiteral(cluster)}, ${stringLiteral(database)}, ${stringLiteral(names.snapshot)})`,
        `WHERE (${keyList}) NOT IN (SELECT ${keyList} FROM ${q(names.shadow)})`,
        'SETTINGS parallel_distributed_insert_select = 2, insert_deduplicate = 0;',
      ].join('\n')
    : [
        `INSERT INTO ${q(names.shadow)} (${columnList})`,
        `SELECT ${columnList} FROM ${q(names.snapshot)}`,
        `WHERE (${keyList}) NOT IN (SELECT ${keyList} FROM ${q(names.shadow)})`,
        'SETTINGS insert_deduplicate = 0, select_sequential_consistency = 1;',
      ].join('\n')

  // Keys of the old table that the new one lacks, held once or more than once
  // by the old table. GROUP BY spills to disk on a large table; the IN set
  // only holds the few rows left behind.
  const missingKeys = (copies: '= 1' | '> 1') =>
    `SELECT ${keyList} FROM (SELECT ${keyList}, toUInt8(1) AS old FROM ${q(names.shadow)} UNION ALL SELECT ${keyList}, toUInt8(0) AS old FROM ${q(table)}) GROUP BY ${keyList} HAVING min(old) = 1 AND sum(old) ${copies}`
  const copyMissing = (into: string, copies: '= 1' | '> 1') =>
    cluster
      ? [
          `INSERT INTO FUNCTION cluster(${stringLiteral(cluster)}, ${stringLiteral(database)}, ${stringLiteral(into)}) (${columnList})`,
          `SELECT ${columnList} FROM cluster(${stringLiteral(cluster)}, ${stringLiteral(database)}, ${stringLiteral(names.shadow)})`,
          `WHERE (${keyList}) IN (${missingKeys(copies)})`,
          `LIMIT 1 BY ${keyList}`,
          'SETTINGS parallel_distributed_insert_select = 2, insert_deduplicate = 0;',
        ].join('\n')
      : [
          `INSERT INTO ${q(into)} (${columnList})`,
          `SELECT ${columnList} FROM ${q(names.shadow)}`,
          `WHERE (${keyList}) IN (${missingKeys(copies)})`,
          `LIMIT 1 BY ${keyList}`,
          'SETTINGS insert_deduplicate = 0, select_sequential_consistency = 1;',
        ].join('\n')
  const reconcile = copyMissing(names.reconcile, '> 1')
  const reconcileUnmirrored = copyMissing(table, '= 1')
  const attachedKeys = `SELECT count() AS attached FROM ${q(table)} WHERE (${keyList}) IN (SELECT ${keyList} FROM ${q(names.reconcile)})`
  const notAttachedGuard = cluster
    ? `SELECT throwIf(sum(attached) > 0, ${stringLiteral(`Rows of ${names.reconcile} are already in ${target}: the ATTACH may already have run. Inspect before you retry.`)}) FROM cluster(${stringLiteral(cluster)}, view(${attachedKeys}))`
    : `SELECT throwIf(attached > 0, ${stringLiteral(`Rows of ${names.reconcile} are already in ${target}: the ATTACH may already have run. Inspect before you retry.`)}) FROM (${attachedKeys}) SETTINGS select_sequential_consistency = 1`

  return {
    validateStart: [
      'SELECT',
      `  throwIf(min(atomic) = 0, ${stringLiteral(`Database ${database} must use the Atomic or Replicated engine: EXCHANGE TABLES needs it.`)}),`,
      `  throwIf(min(present) = 0, ${stringLiteral(`Table ${target} does not exist.`)}),`,
      `  throwIf(max(leftovers) > 0, ${stringLiteral(`Objects of an earlier attempt of this cutover exist (${names.shadow}, ${names.mirror}, ${names.snapshot} or ${names.reconcile}). If the tables were already swapped, ${names.shadow} is the pre-cutover table and may hold rows not yet reconciled into ${table}: do not drop it. Inspect them before you run the migration again.`)}),`,
      `  throwIf(max(mutations) > 0, ${stringLiteral(`${target} has unfinished mutations. Wait for them to finish: rows they change would not reach the new table.`)})`,
      `FROM ${everyReplica(
        [
          `SELECT (SELECT count() FROM system.databases WHERE name = ${stringLiteral(database)} AND engine IN ('Atomic', 'Replicated')) AS atomic,`,
          `${tableCount(table)} AS present,`,
          `${tableCount(names.shadow)} + ${tableCount(names.mirror)} + ${tableCount(names.snapshot)} + ${tableCount(names.reconcile)} AS leftovers,`,
          `${pendingMutations} AS mutations`,
        ].join(' ')
      )};`,
    ].join('\n'),
    createMirror: `CREATE MATERIALIZED VIEW IF NOT EXISTS ${q(names.mirror)} TO ${q(names.shadow)} AS\nSELECT ${columnList} FROM ${q(table)};`,
    insertBarrier: "SELECT query_id FROM system.processes WHERE query_kind IN ('Insert', 'AsyncInsertFlush');",
    attachSnapshot: `ALTER TABLE ${q(names.snapshot)} ATTACH PARTITION ALL FROM ${q(table)};`,
    truncateSnapshot: `TRUNCATE TABLE IF EXISTS ${q(names.snapshot)} SYNC`,
    reconcile,
    reconcileUnmirrored,
    truncateReconcile: `TRUNCATE TABLE IF EXISTS ${q(names.reconcile)} SYNC`,
    attachReconciled: `ALTER TABLE ${q(table)} ATTACH PARTITION ALL FROM ${q(names.reconcile)};`,
    notAttachedGuard,
    syncAfterExchange: cluster
      ? [names.shadow, table].map((name) => `SYSTEM SYNC REPLICA ON CLUSTER ${stringLiteral(cluster)} ${q(name)} LIGHTWEIGHT;`)
      : [],
    syncReplicas: cluster
      ? [names.snapshot, names.shadow].map((name) => `SYSTEM SYNC REPLICA ON CLUSTER ${stringLiteral(cluster)} ${q(name)} LIGHTWEIGHT;`)
      : [],
    copy,
    verifyAfterCopy: verify(`The copy into ${database}.${names.shadow} does not match ${names.snapshot}: a key was inserted again or the table was mutated during the cutover. The table was not swapped.`),
    verifyBackfill: verify(
      `${database}.${names.shadow} does not hold the rows of ${names.snapshot} yet. Copy them with: chkit plugin backfill plan --cutover ${target} (then run or submit the plan), and run chkit migrate --apply again.`
    ),
    validateBeforeExchange: `${unswappedGuard};`,
    unswappedGuard,
    validateAfterExchange: `${guard(
      `${tableCount(names.shadow)} = 1 AND ${tableCount(names.snapshot)} = 1 AND ${layout(names.shadow)} = ${layout(names.snapshot)} AND ${layout(table)} != ${layout(names.snapshot)}`,
      `${target} does not have its new layout on every replica after the EXCHANGE. Inspect both tables before you continue.`
    )};`,
    swappedGuard: guard(
      swapped,
      `${database}.${names.shadow} is not the pre-cutover table on every replica, so it is not dropped. Inspect both tables before you retry.`
    ),
  }
}

function assertCutoverSupported(input: {
  oldDef: TableDefinition
  newDef: TableDefinition
  request: CutoverRequest
  options: CutoverOptions
  definitions: SchemaDefinition[]
  names: CutoverNames
}): string[] {
  const { oldDef, newDef, request, options, definitions, names } = input
  const target = `${request.database}.${request.table}`
  const problems: string[] = []

  for (const def of [oldDef, newDef]) {
    const engine = engineName(def.engine)
    if (!PLAIN_MERGE_TREE_ENGINES.has(engine)) {
      problems.push(
        `engine ${def.engine} is not supported: a cutover covers MergeTree, ReplicatedMergeTree and SharedMergeTree tables, whose rows are never merged away, so the copy can be verified row by row.`
      )
    } else if (options.cluster && engine === 'MergeTree') {
      problems.push(
        `engine ${def.engine} with clickhouse.cluster: each node would hold its own data. Use ReplicatedMergeTree so one replica per shard can copy it.`
      )
    }
    const path = replicatedPath(def.engine)
    if (path !== undefined && !path.includes('{uuid}') && !path.includes('{table}')) {
      problems.push(
        `the replication path ${path} names no {table} or {uuid} macro, so the shadow table would register at the same path as ${target}.`
      )
    }
    if (def.uniqueKey && def.uniqueKey.length > 0) problems.push('a UNIQUE KEY table cannot be cut over.')
    if (!options.cluster && engine.startsWith('Replicated')) {
      problems.push(
        `engine ${def.engine} without clickhouse.cluster: the shadow table would exist on one replica only. Set clickhouse.cluster so every statement runs ON CLUSTER.`
      )
    }
    if (def.ttl) {
      problems.push(
        `TTL ${def.ttl} deletes rows in the background, at different times in the old and the new table, so the copy cannot be verified and the reconcile would insert expired rows again. Remove the TTL for the cutover and add it back in a separate migration.`
      )
    }
  }

  if (newDef.renamedFrom) {
    problems.push('the table is also renamed. Rename it in a separate migration.')
  }
  for (const column of newDef.columns) {
    if (column.renamedFrom) {
      problems.push(
        `column ${column.renamedFrom} is renamed to ${column.name}: the copy matches columns by name and would leave ${column.name} empty. Rename the column in a separate migration.`
      )
    }
  }
  const oldChecks = new Set((oldDef.constraints ?? []).flatMap((constraint) => (constraint.check ? [`${constraint.name}:${constraint.check}`] : [])))
  for (const constraint of newDef.constraints ?? []) {
    if (constraint.check && !oldChecks.has(`${constraint.name}:${constraint.check}`)) {
      problems.push(
        `CHECK constraint ${constraint.name} is new: rows the old table accepts would fail the mirror, and with it the writers' INSERTs. Add the constraint in a separate migration.`
      )
    }
  }

  const layoutChanged =
    engineName(oldDef.engine) !== engineName(newDef.engine) ||
    oldDef.orderBy.join(',') !== newDef.orderBy.join(',') ||
    oldDef.primaryKey.join(',') !== newDef.primaryKey.join(',') ||
    (oldDef.partitionBy ?? '') !== (newDef.partitionBy ?? '')
  if (!layoutChanged) {
    problems.push(
      'only the engine arguments change. The cutover tells the old table from the new one by engine name, sorting key, primary key and partition key, so at least one of them must change.'
    )
  }

  const columns = copiedColumns(oldDef, newDef, problems)
  const oldColumns = new Map(oldDef.columns.map((column) => [column.name, column]))
  for (const name of request.key) {
    const column = oldColumns.get(name)
    if (!column) {
      problems.push(`key column ${name} does not exist in ${target}.`)
      continue
    }
    if (!columns.includes(name)) {
      problems.push(`key column ${name} must be a stored column of both the old and the new table.`)
      continue
    }
    if (column.nullable || /^\s*Nullable\s*\(/.test(column.type)) {
      problems.push(`key column ${name} is Nullable; NOT IN never matches NULL, so such rows could not be told apart.`)
    }
  }

  for (const def of definitions) {
    if (options.oldTable === 'keep' && def.kind === 'table' && def.database === request.database && def.name === names.previous) {
      problems.push(
        `${request.database}.${names.previous} already exists in the schema; the old table is kept under that name. Drop it first (chkit generate --drop-retained ${request.database}.${names.previous}) or use --cutover-old drop.`
      )
    }
    if (def.kind === 'table' && isBufferInto(def.engine, request)) {
      problems.push(
        `Buffer table ${def.database}.${def.name} flushes into ${target} from a background thread, which the insert barrier cannot see. Drop it for the cutover and recreate it afterwards.`
      )
    }
    if (def.kind !== 'materialized_view' || def.to.database !== request.database || def.to.name !== request.table) continue
    if (def.refresh) {
      problems.push(
        `refreshable materialized view ${def.database}.${def.name} writes into ${target} outside any INSERT query, which the cutover cannot follow. Drop it for the cutover and recreate it afterwards.`
      )
      continue
    }
    const source = streamingSource(def.as, definitions, def.database)
    if (source) {
      problems.push(
        `materialized view ${def.database}.${def.name} feeds ${target} from the ${source} table, whose consumer is invisible to the insert barrier. Detach the consumer view for the cutover and attach it afterwards.`
      )
    }
  }

  if (options.copy === 'backfill' && options.cluster) {
    problems.push(
      '--cutover-copy backfill is not supported with clickhouse.cluster: the backfill plugin plans chunks from one node. Use --cutover-copy migration, which copies on every shard.'
    )
  }

  if (problems.length > 0) {
    throw new ChxValidationError(
      problems.map((problem) => ({
        code: 'cutover_unsupported' as const,
        kind: 'table' as const,
        database: request.database,
        name: request.table,
        message: `Cannot cut over ${target}: ${problem}`,
      }))
    )
  }
  return columns
}

/**
 * The columns the mirror and the copy write: stored in the old table
 * (ordinary, DEFAULT or MATERIALIZED) and insertable in the new one (ordinary
 * or DEFAULT). A column in both with a different type is refused; change it in
 * a separate migration.
 */
function copiedColumns(oldDef: TableDefinition, newDef: TableDefinition, problems: string[]): string[] {
  const newColumns = new Map(newDef.columns.map((column) => [column.name, column]))
  const columns: string[] = []
  for (const oldColumn of oldDef.columns) {
    const newColumn = newColumns.get(oldColumn.name)
    if (!newColumn) continue
    if (!isStored(oldColumn) || !isInsertable(newColumn)) continue
    if (renderColumnType(oldColumn) !== renderColumnType(newColumn)) {
      problems.push(
        `column ${oldColumn.name} changes type (${renderColumnType(oldColumn)} to ${renderColumnType(newColumn)}). Change column types in a separate migration.`
      )
      continue
    }
    columns.push(oldColumn.name)
  }
  return columns
}

function isStored(column: ColumnDefinition): boolean {
  return column.defaultKind !== 'ALIAS' && column.defaultKind !== 'EPHEMERAL'
}

function isInsertable(column: ColumnDefinition): boolean {
  return column.defaultKind === undefined || column.defaultKind === 'DEFAULT'
}

/** The first argument of a Replicated*MergeTree engine with explicit arguments. */
function replicatedPath(engine: string): string | undefined {
  if (!engineName(engine).startsWith('Replicated')) return undefined
  const match = /^\s*\w+\s*\(\s*'((?:[^'\\]|\\.)*)'/.exec(engine)
  return match?.[1]
}

/**
 * The streaming table a materialized view's query reads, directly or through
 * tables that other materialized views fill from one (Kafka -> Null -> view).
 */
function streamingSource(
  query: string,
  definitions: SchemaDefinition[],
  defaultDatabase: string,
  visited: Set<string> = new Set(),
): string | undefined {
  for (const def of definitions) {
    if (def.kind !== 'table' || !readsTable(query, def, defaultDatabase)) continue
    if (STREAMING_ENGINES.has(engineName(def.engine)) || isKafkaEngine(def.engine)) {
      return `${def.database}.${def.name} (${engineName(def.engine)})`
    }
    const key = `${def.database}.${def.name}`
    if (visited.has(key)) continue
    visited.add(key)
    for (const feeder of definitions) {
      if (feeder.kind !== 'materialized_view' || feeder.to.database !== def.database || feeder.to.name !== def.name) continue
      const source = streamingSource(feeder.as, definitions, feeder.database, visited)
      if (source) return source
    }
  }
  return undefined
}

/** Whether a view's query reads `table`, qualified or (in its own database) bare. */
export function readsTable(query: string, table: { database: string; name: string }, defaultDatabase: string): boolean {
  const def = table
  const qualified = new RegExp(`\\b${escapeRegex(def.database)}\\s*\\.\\s*\`?${escapeRegex(def.name)}\\b`)
  const bare = def.database === defaultDatabase ? new RegExp(`\\bFROM\\s+\`?${escapeRegex(def.name)}\\b`, 'i') : undefined
  return qualified.test(query) || (bare?.test(query) ?? false)
}

/** A `Buffer(database, table, ...)` engine that flushes into the cutover table. */
function isBufferInto(engine: string, request: CutoverRequest): boolean {
  if (engineName(engine) !== 'Buffer') return false
  // Split instead of matching with a regex: the arguments are user input.
  const args = engine.slice(engine.indexOf('(') + 1).split(',')
  // database, table, then the flush settings
  if (args.length < 3) return false
  return unquoteArgument(args[0] ?? '') === request.database && unquoteArgument(args[1] ?? '') === request.table
}

function unquoteArgument(value: string): string {
  return value.trim().replace(/^['"`]|['"`]$/g, '')
}

function canonicalTable(def: TableDefinition): TableDefinition {
  const canonical = canonicalizeDefinition(def)
  if (canonical.kind !== 'table') throw new Error(`Expected a table definition for ${definitionKey(def)}.`)
  return canonical
}

function withoutRename(def: TableDefinition): TableDefinition {
  const { renamedFrom: _renamedFrom, retainedBy: _retainedBy, ...rest } = def
  return rest
}

function quoteColumn(name: string): string {
  return `\`${name.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``
}

function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
