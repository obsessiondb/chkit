import { createHash } from 'node:crypto'

import { waitForTable, type ClickHouseExecutor } from '@chkit/clickhouse'

import { IngestConfigError } from './errors.js'
import { validateJournalHistory } from './journal-history.js'
import type { CommittedCheckpoint, Journal, JournalEvent } from './types.js'

export const DEFAULT_JOURNAL_TABLE = '_chkit_ingestion_journal'
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// A type alias (not an interface) so it is assignable to the executor's Record-based insert values.
export type JournalRow = {
  target_id: string
  namespace_id: string
  event_seq: string
  event_id: string
  payload_hash: string
  event_at: string
  event_kind: string
  run_id: string
  work_id: string
  attempt_no: number
  batch_id: string
  expected_checkpoint_version: string
  checkpoint_version: string
  checkpoint_json: string
  work_state: string
  sink_evidence: string
  retry_at: string | null
  error_class: string
  detail_json: string
}

export interface ClickHouseJournalOptions {
  /** Must allow concurrent queries: use a stateless executor, not a session-bound one. */
  executor: ClickHouseExecutor
  database: string
  targetId: string
  table?: string
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
      const rows = await options.executor.query<JournalRow>(
        `SELECT * FROM ${qualified} WHERE target_id = ${sqlString(options.targetId)} AND namespace_id = ${sqlString(namespaceId)} ORDER BY run_id, event_seq, event_id, payload_hash`,
        { select_sequential_consistency: '1', use_query_cache: 0, output_format_json_quote_64bit_integers: 1 })
      // A stale snapshot can cause replay, but its runs cannot overwrite the
      // identities or checkpoint lineage of another run.
      return validateJournalHistory(rows, namespaceId).checkpoint
    },
  }
}

function validateTableName(name: string): void {
  if (!TABLE_NAME_PATTERN.test(name)) throw new IngestConfigError(`Invalid journal table or database name "${name}".`)
}

export function toJournalRow(event: JournalEvent, targetId: string, at: Date): JournalRow {
  const checkpointJson = event.checkpoint ? canonicalJson(event.checkpoint) : ''
  const detailJson = canonicalJson(event.detail)
  // Identity covers what makes the fact unique; the payload hash covers every
  // authoritative field a retry of that same fact must reproduce. Only the
  // physical append time (event_at) is excluded.
  const eventId = digest([targetId, event.namespaceId, event.runId, String(event.eventSeq), event.eventKind, event.workId, event.batchId, String(event.attemptNo)])
  const payload = digest([
    eventId,
    String(event.expectedCheckpointVersion),
    String(event.checkpointVersion),
    checkpointJson,
    event.workState,
    event.sinkEvidence,
    event.errorClass,
    event.runId,
    event.retryAt ? event.retryAt.toISOString() : '',
    detailJson,
  ])
  return {
    target_id: targetId,
    namespace_id: event.namespaceId,
    event_seq: String(event.eventSeq),
    event_id: eventId,
    payload_hash: BigInt(`0x${payload.slice(0, 16)}`).toString(),
    event_at: toClickHouseDateTime(at),
    event_kind: event.eventKind,
    run_id: event.runId,
    work_id: event.workId,
    attempt_no: event.attemptNo,
    batch_id: event.batchId,
    expected_checkpoint_version: String(event.expectedCheckpointVersion),
    checkpoint_version: String(event.checkpointVersion),
    checkpoint_json: checkpointJson,
    work_state: event.workState,
    sink_evidence: event.sinkEvidence,
    retry_at: event.retryAt ? toClickHouseDateTime(event.retryAt) : null,
    error_class: event.errorClass,
    detail_json: detailJson,
  }
}

/** Stable key order so equal values always serialize identically. */
export function canonicalJson(value: unknown): string {
  // JSON.stringify(undefined) is undefined, not a string.
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

export function digest(parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(part.length))
    hash.update(':')
    hash.update(part)
  }
  return hash.digest('hex')
}

export function emptyCheckpoint(): CommittedCheckpoint {
  return { version: 0, envelope: undefined, checkpointId: '', successId: '', headSeq: 0, lastSuccessSeq: 0 }
}

export function journalTableSql(qualified: string): string {
  return `CREATE TABLE IF NOT EXISTS ${qualified}
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
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_at)
ORDER BY (target_id, namespace_id, event_seq, event_id)`
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)])
    )
  }
  return value
}

function toClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
