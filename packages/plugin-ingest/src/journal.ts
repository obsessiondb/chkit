import { createHash } from 'node:crypto'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { IngestConfigError } from './errors.js'
import type { CheckpointEnvelope, CommittedCheckpoint, Journal, JournalEvent } from './types.js'

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
  executor: ClickHouseExecutor
  database: string
  targetId: string
  table?: string
  now?: () => Date
}

/**
 * Append-only, target-linked journal. It is the sole authority for durable
 * ingestion control state: checkpoints are read as a projection over
 * `batch_committed` facts and never stored anywhere else.
 */
export function createClickHouseJournal(options: ClickHouseJournalOptions): Journal {
  const table = options.table ?? DEFAULT_JOURNAL_TABLE
  if (!TABLE_NAME_PATTERN.test(table)) throw new IngestConfigError(`Invalid journal table name "${table}".`)
  if (!TABLE_NAME_PATTERN.test(options.database)) {
    throw new IngestConfigError(`Invalid journal database name "${options.database}".`)
  }
  const qualified = `\`${options.database}\`.\`${table}\``
  const now = options.now ?? (() => new Date())

  return {
    async ensure() {
      await options.executor.command(journalTableSql(qualified))
    },

    async append(event) {
      const row = toJournalRow(event, options.targetId, now())
      await options.executor.insert({
        table: `${options.database}.${table}`,
        values: [row],
        // A retried append of the same deterministic fact is suppressed while
        // the deduplication window lasts; readers canonicalize by event_id anyway.
        settings: { insert_deduplication_token: row.event_id, async_insert: 0 },
      })
    },

    async readCheckpoint(namespaceId) {
      // Physical retry duplicates are allowed; canonicalize by event_id and
      // refuse to continue when one deterministic id carries different payloads.
      const rows = await options.executor.query<{
        head_seq: string
        drifted: string
        checkpoint_version: string
        checkpoint_json: string
      }>(
        `SELECT
  max(event_seq) AS head_seq,
  countIf(distinct_payloads > 1) AS drifted,
  argMaxIf(fact_version, (fact_version, event_seq, event_id), fact_kind = 'batch_committed') AS checkpoint_version,
  argMaxIf(fact_checkpoint, (fact_version, event_seq, event_id), fact_kind = 'batch_committed') AS checkpoint_json
FROM (
  SELECT
    event_seq,
    event_id,
    any(event_kind) AS fact_kind,
    any(checkpoint_version) AS fact_version,
    any(checkpoint_json) AS fact_checkpoint,
    uniqExact(payload_hash) AS distinct_payloads
  FROM ${qualified}
  WHERE target_id = ${sqlString(options.targetId)} AND namespace_id = ${sqlString(namespaceId)}
  GROUP BY event_seq, event_id
)`,
        { select_sequential_consistency: '1' }
      )
      const row = rows[0]
      if (!row) return { version: 0, envelope: undefined, headSeq: 0 }
      if (Number(row.drifted) > 0) {
        throw new Error(
          `Ingestion journal payload drift detected for namespace "${namespaceId}": a deterministic event id has conflicting payloads. Refusing to continue.`
        )
      }
      return {
        version: Number(row.checkpoint_version),
        envelope: parseEnvelope(row.checkpoint_json),
        headSeq: Number(row.head_seq),
      }
    },
  }
}

export function toJournalRow(event: JournalEvent, targetId: string, at: Date): JournalRow {
  const checkpointJson = event.checkpoint ? canonicalJson(event.checkpoint) : ''
  const detailJson = canonicalJson(event.detail)
  // Identity covers what makes the fact unique; the payload hash covers what a
  // replay of that same fact must reproduce. Timestamps are excluded from both.
  const eventId = digest([targetId, event.namespaceId, String(event.eventSeq), event.eventKind, event.workId, event.batchId, String(event.attemptNo)])
  const payload = digest([
    eventId,
    String(event.expectedCheckpointVersion),
    String(event.checkpointVersion),
    checkpointJson,
    event.workState,
    event.sinkEvidence,
    event.errorClass,
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

export function parseEnvelope(json: string): CheckpointEnvelope | undefined {
  if (json === '') return undefined
  const parsed: unknown = JSON.parse(json)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('strategy' in parsed) ||
    typeof parsed.strategy !== 'string' ||
    !('version' in parsed) ||
    typeof parsed.version !== 'number'
  ) {
    throw new Error('Committed checkpoint is not a valid ChKit checkpoint envelope.')
  }
  return { strategy: parsed.strategy, version: parsed.version, state: 'state' in parsed ? parsed.state : undefined }
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
  return { version: 0, envelope: undefined, headSeq: 0 }
}

function journalTableSql(qualified: string): string {
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
