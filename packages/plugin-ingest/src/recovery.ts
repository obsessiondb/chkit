import { randomUUID } from 'node:crypto'

import { waitForTable, type ClickHouseExecutor, type ClickHouseSettings } from '@chkit/clickhouse'
import * as Effect from 'effect/Effect'

import { IngestConfigError } from './errors.js'
import { validateJournalHistory } from './journal-history.js'
import { canonicalJson, DEFAULT_JOURNAL_TABLE, digest, journalTableSql, type JournalRow } from './journal.js'
import { foreign, runPublic, sync } from './runtime.js'
import type { CommittedCheckpoint } from './types.js'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const READ_SETTINGS = {
  select_sequential_consistency: '1', use_query_cache: 0, output_format_json_quote_64bit_integers: 1,
} satisfies ClickHouseSettings

export interface JournalRepairPlan {
  namespaceId: string
  sourceTable: string
  fingerprint: string
  healthy: boolean
  repairable: boolean
  problems: string[]
  /** All physical rows in the source table, preserved in the archive. */
  evidenceRows: number
  selectedEvidenceRows: number
  /** Valid selected facts plus all untouched rows from other namespaces. */
  retainedFacts: number
  runs: number
  checkpoint: CommittedCheckpoint
  archiveTable: string
  replacementTable: string
  activation: string
  replayWarning: string
}

export interface JournalRecoveryOptions {
  executor: ClickHouseExecutor
  database: string
  targetId: string
  table?: string
}

export interface JournalRepairResult {
  applied: boolean
  /** Materializing a repair never changes the active journal configuration. */
  activated: false
  plan: JournalRepairPlan
}

/** Inspect valid run histories; overlapping runs are normal journal evidence. */
export function planJournalRepair(
  snapshot: readonly JournalRow[],
  namespaceId: string,
  sourceTable: string,
  targetId?: string
): JournalRepairPlan {
  const selected = selectedRows(snapshot, namespaceId, targetId)
  const validated = validateJournalHistory(selected, namespaceId)
  const fingerprint = repairFingerprint(snapshot, namespaceId, sourceTable, targetId)
  const suffix = fingerprint.slice(0, 24)
  const replacementTable = `${sourceTable}_repair_${suffix}`
  return {
    namespaceId,
    sourceTable,
    fingerprint,
    healthy: validated.problems.length === 0,
    repairable: true,
    problems: validated.problems,
    evidenceRows: snapshot.length,
    selectedEvidenceRows: selected.length,
    retainedFacts: snapshot.length - selected.length + validated.rows.length,
    runs: new Set(selected.map((row) => row.run_id)).size,
    checkpoint: validated.checkpoint,
    archiveTable: `${sourceTable}_archive_${suffix}`,
    replacementTable,
    activation: `Stop all ingestion writers, materialize the reviewed repair, then configure ingest({ journalTable: '${replacementTable}' }) before restarting them.`,
    replayWarning: 'The next run resumes from the selected valid checkpoint. Uncertain destination writes may be loaded again (at least once).',
  }
}

/** Diagnose one complete source-table snapshot without modifying it. */
export function doctorJournal(namespaceId: string, options: JournalRecoveryOptions): Promise<JournalRepairPlan> {
  return runPublic(Effect.gen(function* () {
    const table = yield* sync(() => recoveryTable(options))
    const snapshot = yield* inspectSource(table, options)
    return sourcePlan(snapshot, namespaceId, table, options.targetId)
  }))
}

/** Materialize a reviewed repair; activation is an explicit configuration change. */
export function repairJournal(
  namespaceId: string,
  fingerprint: string | undefined,
  options: JournalRecoveryOptions
): Promise<JournalRepairResult> {
  return runPublic(Effect.gen(function* () {
    const table = yield* sync(() => recoveryTable(options))
    const source = yield* inspectSource(table, options)
    const plan = sourcePlan(source, namespaceId, table, options.targetId)
    if (fingerprint === undefined) return { applied: false, activated: false, plan }
    if (fingerprint !== plan.fingerprint) return yield* Effect.fail(new IngestConfigError('Journal changed since review. Stop all writers, run ingest repair again, and review the new fingerprint.'))
    if (!plan.repairable) return yield* Effect.fail(new IngestConfigError(plan.problems.join(' ')))
    if (plan.healthy) return { applied: false, activated: false, plan }

    // Each attempt writes its own tables. Concurrent or interrupted repairs cannot
    // change another attempt's verified output; none of them routes active writers.
    const copyId = randomUUID().replaceAll('-', '').slice(0, 12)
    const replacementTable = `${plan.replacementTable}_${copyId}`
    const materializedPlan = {
      ...plan,
      archiveTable: `${plan.archiveTable}_${copyId}`,
      replacementTable,
      activation: `Keep all ingestion writers stopped. Configure ingest({ journalTable: '${replacementTable}' }), then restart them. The active journal has not been changed.`,
    }
    yield* preserveSnapshot(materializedPlan.archiveTable, source.rows, options)
    const selected = selectedRows(source.rows, namespaceId, options.targetId)
    const validated = validateJournalHistory(selected, namespaceId)
    const retained = [
      ...source.rows.filter((row) => !isSelected(row, namespaceId, options.targetId)),
      ...validated.rows,
    ]
    yield* preserveSnapshot(replacementTable, retained, options)
    const copied = validateJournalHistory(selectedRows(yield* readSnapshot(replacementTable, options), namespaceId, options.targetId), namespaceId)
    if (copied.problems.length > 0 || canonicalJson(copied.checkpoint) !== canonicalJson(plan.checkpoint)) {
      return yield* Effect.fail(new Error('Replacement journal verification failed; the active journal remains unchanged.'))
    }
    const finalSnapshot = yield* readSnapshot(table, options)
    if (repairFingerprint(finalSnapshot, namespaceId, table, options.targetId) !== fingerprint) {
      return yield* Effect.fail(new IngestConfigError('Journal changed while copying. Keep the original journal active, stop all writers, and review a new repair plan.'))
    }
    return { applied: true, activated: false, plan: materializedPlan }
  }))
}

function recoveryTable(options: JournalRecoveryOptions): string {
  const table = options.table ?? DEFAULT_JOURNAL_TABLE
  identifier(options.database)
  identifier(table)
  return table
}

function inspectSource(table: string, options: JournalRecoveryOptions): Effect.Effect<{ rows: JournalRow[]; missing: boolean }, unknown> {
  return Effect.gen(function* () {
    const exists = yield* foreign(() => options.executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.tables WHERE database = ${sqlString(options.database)} AND name = ${sqlString(table)}`,
      READ_SETTINGS
    ))
    if (exists.length === 0) return { rows: [], missing: true }
    return { rows: yield* readSnapshot(table, options), missing: false }
  })
}

function sourcePlan(snapshot: { rows: JournalRow[]; missing: boolean }, namespaceId: string, table: string, targetId: string): JournalRepairPlan {
  const plan = planJournalRepair(snapshot.rows, namespaceId, table, targetId)
  if (!snapshot.missing) return plan
  return {
    ...plan, healthy: false, repairable: false,
    problems: [...plan.problems, `Journal source table ${table} is missing. Restore its evidence before repairing, or run ingest on a fresh target.`],
  }
}

function readSnapshot(table: string, options: JournalRecoveryOptions): Effect.Effect<JournalRow[], unknown> {
  return foreign(() => options.executor.query<JournalRow>(
    `SELECT * FROM ${qualified(options.database, table)} ORDER BY target_id, namespace_id, run_id, event_seq, event_id, payload_hash, event_at`,
    READ_SETTINGS
  ))
}

function preserveSnapshot(table: string, rows: readonly JournalRow[], options: JournalRecoveryOptions): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* foreign(() => options.executor.command(journalTableSql(qualified(options.database, table))))
    yield* foreign(() => waitForTable(options.executor, options.database, table))
    if (rows.length > 0) {
      yield* foreign(() => options.executor.insert({
        table: `${options.database}.${table}`,
        values: [...rows],
        settings: { async_insert: 0, insert_deduplication_token: snapshotFingerprint(rows) },
      }))
    }
    const archived = yield* readSnapshot(table, options)
    if (snapshotFingerprint(archived) !== snapshotFingerprint(rows)) {
      return yield* Effect.fail(new Error(`Evidence verification failed for ${table}; the active journal remains unchanged.`))
    }
  })
}

function selectedRows(rows: readonly JournalRow[], namespaceId: string, targetId: string | undefined): JournalRow[] {
  return rows.filter((row) => isSelected(row, namespaceId, targetId))
}

function isSelected(row: JournalRow, namespaceId: string, targetId: string | undefined): boolean {
  return row.namespace_id === namespaceId && (targetId === undefined || row.target_id === targetId)
}

function repairFingerprint(rows: readonly JournalRow[], namespaceId: string, table: string, targetId: string | undefined): string {
  return digest([namespaceId, table, targetId ?? '', snapshotFingerprint(rows)])
}

function snapshotFingerprint(rows: readonly JournalRow[]): string {
  return digest(rows.map((row) => canonicalJson(row)).sort())
}

function qualified(database: string, table: string): string {
  identifier(database)
  identifier(table)
  return `\`${database}\`.\`${table}\``
}

function identifier(value: string): void {
  if (!IDENTIFIER.test(value)) throw new IngestConfigError(`Invalid journal identifier "${value}".`)
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
