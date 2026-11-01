import { isUnknownDatabaseError, waitForTable, type ClickHouseExecutor, type ClickHouseSettings } from '@chkit/clickhouse'

import { IngestConfigError } from './errors.js'
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

/** A missing journal table (or database) means no stream has run on the target. */
export function isMissingJournalError(error: unknown): boolean {
  if (isUnknownDatabaseError(error)) return true
  return error instanceof Error && 'code' in error && String(error.code) === '60'
}

function validateTableName(name: string): void {
  if (!TABLE_NAME_PATTERN.test(name)) throw new IngestConfigError(`Invalid journal table or database name "${name}".`)
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

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
