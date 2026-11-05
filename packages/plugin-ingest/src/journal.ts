import { setTimeout as sleep } from 'node:timers/promises'

import { isUnknownDatabaseError, waitForTable, type ClickHouseExecutor, type ClickHouseSettings } from '@chkit/clickhouse'
import { onClusterClause } from '@chkit/core'

import { validateJournalHistory } from './journal-history.js'
import { digest, toJournalRow, type JournalRow } from './journal-records.js'
import type { Journal } from './types.js'

export { canonicalJson, digest, emptyCheckpoint, toJournalRow, type JournalRow } from './journal-records.js'

export const DEFAULT_JOURNAL_TABLE = '_chkit_ingestion_journal'
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const READ_SETTINGS: ClickHouseSettings = { select_sequential_consistency: '1', use_query_cache: 0, output_format_json_quote_64bit_integers: 1 }
// Without output_format_json_quote_64bit_integers, ClickHouse sends UInt64 as
// JSON numbers, which lose precision, so the query casts them itself.
const UINT64_AS_STRINGS = `* REPLACE (${['event_seq', 'payload_hash', 'expected_checkpoint_version', 'checkpoint_version'].map((column) => `toString(${column}) AS ${column}`).join(', ')})`
// As the migration journal: one Keeper path without {shard}, so every replica of
// every shard shares one journal, and a replica name that is unique cluster-wide.
const REPLICATED_ENGINE = "ReplicatedMergeTree('/clickhouse/tables/{uuid}/chkit_ingestion_journal', '{shard}_{replica}')"
const REPLICA_CHECKS = 20
const REPLICA_CHECK_INTERVAL_MS = 500
const NO_CONVERSION = 'chkit does not convert an existing journal. Stop ingestion, copy the rows of every replica\'s journal into a new ReplicatedMergeTree table created ON CLUSTER, and set ingest({ journalTable }) to it.'

export interface ClickHouseJournalOptions {
  /** Must allow concurrent queries: use a stateless executor, not a session-bound one. */
  executor: ClickHouseExecutor
  database: string
  targetId: string
  table?: string
  /** `clickhouse.cluster`: the journal is one ReplicatedMergeTree table on every replica of the cluster. */
  cluster?: string
  now?: () => Date
}

/** Immutable run-scoped facts are projected from one ClickHouse snapshot. */
export function createClickHouseJournal(options: ClickHouseJournalOptions): Journal {
  const table = options.table ?? DEFAULT_JOURNAL_TABLE
  validateTableName(table)
  validateTableName(options.database)
  const now = options.now ?? (() => new Date())
  const qualified = `\`${options.database}\`.\`${table}\``

  return {
    async ensure() {
      if (options.cluster) return ensureReplicatedJournal(options.executor, options.database, table, options.cluster)
      await options.executor.command(journalTableSql(qualified))
      await waitForTable(options.executor, options.database, table)
    },
    async append(events) {
      if (events.length === 0) return
      const at = now()
      const rows = events.map((event) => toJournalRow(event, options.targetId, at))
      await options.executor.insert({
        table: `${options.database}.${table}`, values: rows,
        settings: { insert_deduplication_token: digest(rows.flatMap((row) => [row.event_id, row.payload_hash])), async_insert: 0 },
      })
    },
    async readCheckpoint(namespaceId) {
      // A readonly = 1 user cannot change any setting, so only status, which
      // does not write, can run as one (#414). It reads without the settings:
      // its checkpoint may lag a write to a replicated journal.
      const changeable = await options.executor.canChangeSettings?.() ?? true
      const rows = await options.executor.query<JournalRow>(
        `SELECT ${changeable ? '*' : UINT64_AS_STRINGS} FROM ${qualified} WHERE target_id = ${sqlString(options.targetId)} AND namespace_id = ${sqlString(namespaceId)} ORDER BY run_id, event_seq, event_id, payload_hash`,
        changeable ? READ_SETTINGS : undefined)
      // A stale snapshot can cause replay, but its runs cannot overwrite the
      // identities or checkpoint lineage of another run.
      return validateJournalHistory(rows, namespaceId).checkpoint
    },
  }
}

interface ReplicaJournal {
  host: string
  engine: string | undefined
  keeperPath: string | undefined
}

/**
 * A local journal on a cluster node keeps that node's checkpoints only, so runs
 * through a load balancer diverge. The journal is created ON CLUSTER only when
 * no replica has it, and is not used until every replica holds it in one
 * replicated table; an existing journal is never converted.
 */
async function ensureReplicatedJournal(executor: ClickHouseExecutor, database: string, table: string, cluster: string): Promise<void> {
  const name = `${database}.${table}`
  let created = false
  for (let check = 1; ; check += 1) {
    const replicas = await inspectReplicas(executor, database, table, cluster)
    const local = replicas.filter((replica) => replica.engine !== undefined && !/^(Replicated|Shared)/.test(replica.engine))
    if (local.length > 0) {
      throw new Error(`Ingest journal ${name} is not replicated on cluster '${cluster}': it is a local table on ${local.map((replica) => `${replica.host} (${replica.engine})`).join(', ')}, which keeps its own checkpoints. ${NO_CONVERSION}`)
    }
    const keeperPaths = new Set(replicas.flatMap((replica) => (replica.keeperPath ? [replica.keeperPath] : [])))
    if (keeperPaths.size > 1) {
      throw new Error(`Ingest journal ${name} is not one table on cluster '${cluster}': its replicas use ${keeperPaths.size} Keeper paths (${replicas.filter((replica) => replica.keeperPath).map((replica) => `${replica.host}: ${replica.keeperPath}`).join(', ')}), each with its own checkpoints. ${NO_CONVERSION}`)
    }
    const missing = replicas.filter((replica) => replica.engine === undefined)
    if (missing.length === 0) return
    if (missing.length === replicas.length && !created) {
      await executor.command(journalTableSql(`\`${database}\`.\`${table}\``, cluster))
      created = true
      continue
    }
    if (check >= REPLICA_CHECKS) {
      const [keeperPath] = keeperPaths
      throw new Error(`Ingest journal ${name} is missing on ${missing.map((replica) => replica.host).join(', ')} of cluster '${cluster}' after ${check} checks. Wait until those replicas apply the ON CLUSTER DDL, or create it there with the Keeper path of the other replicas${keeperPath ? ` (${keeperPath})` : ''}, then run again.`)
    }
    await sleep(REPLICA_CHECK_INTERVAL_MS)
  }
}

/** The journal as each replica of the cluster sees it; a replica without it has no engine. */
async function inspectReplicas(executor: ClickHouseExecutor, database: string, table: string, cluster: string): Promise<ReplicaJournal[]> {
  const everyReplica = (source: string) => `clusterAllReplicas(${sqlString(cluster)}, ${source})`
  const [hosts, tables, replicated] = await Promise.all([
    executor.query<{ host: string }>(`SELECT DISTINCT hostName() AS host FROM ${everyReplica('system.one')}`),
    executor.query<{ host: string; engine: string }>(
      `SELECT hostName() AS host, engine FROM ${everyReplica('system.tables')} WHERE database = ${sqlString(database)} AND name = ${sqlString(table)}`),
    executor.query<{ host: string; keeper_path: string }>(
      `SELECT hostName() AS host, zookeeper_path AS keeper_path FROM ${everyReplica('system.replicas')} WHERE database = ${sqlString(database)} AND table = ${sqlString(table)}`),
  ])
  return hosts.map(({ host }) => ({
    host,
    engine: tables.find((row) => row.host === host)?.engine,
    keeperPath: replicated.find((row) => row.host === host)?.keeper_path,
  }))
}

/** A missing journal table (or database) means no stream has run on the target. */
export function isMissingJournalError(error: unknown): boolean {
  if (isUnknownDatabaseError(error)) return true
  return error instanceof Error && 'code' in error && String(error.code) === '60'
}

function validateTableName(name: string): void {
  if (!TABLE_NAME_PATTERN.test(name)) throw new Error(`Invalid journal table or database name "${name}".`)
}

export function journalTableSql(qualified: string, cluster?: string): string {
  return `CREATE TABLE IF NOT EXISTS ${qualified}${onClusterClause(cluster)}
(
    target_id LowCardinality(String),
    namespace_id String,
    event_seq UInt64,
    event_id String,
    payload_hash UInt64,
    event_at DateTime64(6, 'UTC'),
    event_kind LowCardinality(String),
    run_id String,
    work_id String,
    attempt_no UInt32,
    batch_id String,
    expected_checkpoint_version UInt64,
    checkpoint_version UInt64,
    checkpoint_json String,
    work_state LowCardinality(String),
    sink_evidence LowCardinality(String),
    retry_at Nullable(DateTime64(6, 'UTC')),
    error_class LowCardinality(String),
    detail_json String
)
ENGINE = ${cluster ? REPLICATED_ENGINE : 'MergeTree'}
PARTITION BY toYYYYMM(event_at)
ORDER BY (target_id, namespace_id, event_seq, event_id)`
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
