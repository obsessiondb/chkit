import { randomUUID } from 'node:crypto'

import { waitForTable, type ClickHouseExecutor, type ClickHouseSettings } from '@chkit/clickhouse'

import { validateJournalHistory, type ValidatedJournalHistory } from './journal-history.js'
import { canonicalJson, DEFAULT_JOURNAL_TABLE, digest, journalTableSql, type JournalRow } from './journal.js'
import { sortedDigest } from './sorted-digest.js'
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

/** One source-table snapshot: every row is counted and digested, only the selected namespace is kept. */
interface SourceSnapshot {
  rows: number
  digest: string
  selected: JournalRow[]
  missing: boolean
}

/** Inspect valid run histories; overlapping runs are normal journal evidence. */
export function planJournalRepair(
  snapshot: readonly JournalRow[],
  namespaceId: string,
  sourceTable: string,
  targetId?: string
): JournalRepairPlan {
  const selected = snapshot.filter((row) => isSelected(row, namespaceId, targetId))
  const source = { rows: snapshot.length, digest: snapshotFingerprint(snapshot), selected, missing: false }
  return sourcePlan(source, validateJournalHistory(selected, namespaceId), namespaceId, sourceTable, targetId)
}

/** Diagnose one complete source-table snapshot without modifying it. */
export async function doctorJournal(namespaceId: string, options: JournalRecoveryOptions): Promise<JournalRepairPlan> {
  const table = recoveryTable(options)
  const source = await inspectSource(table, namespaceId, options)
  return sourcePlan(source, validateJournalHistory(source.selected, namespaceId), namespaceId, table, options.targetId)
}

/** Materialize a reviewed repair; activation is an explicit configuration change. */
export async function repairJournal(
  namespaceId: string,
  fingerprint: string | undefined,
  options: JournalRecoveryOptions
): Promise<JournalRepairResult> {
  const table = recoveryTable(options)
  const source = await inspectSource(table, namespaceId, options)
  const validated = validateJournalHistory(source.selected, namespaceId)
  const plan = sourcePlan(source, validated, namespaceId, table, options.targetId)
  if (fingerprint === undefined) return { applied: false, activated: false, plan }
  if (fingerprint !== plan.fingerprint) throw new Error('Journal changed since review. Stop all writers, run ingest repair again, and review the new fingerprint.')
  if (!plan.repairable) throw new Error(plan.problems.join(' '))
  if (plan.healthy) return { applied: false, activated: false, plan }

  // Each attempt writes its own tables. Concurrent or interrupted repairs cannot
  // change another attempt's verified output; none of them routes active writers.
  const copyId = randomUUID().replaceAll('-', '').slice(0, 12)
  const archiveTable = `${plan.archiveTable}_${copyId}`
  const replacementTable = `${plan.replacementTable}_${copyId}`
  const materializedPlan = {
    ...plan,
    archiveTable,
    replacementTable,
    activation: `Keep all ingestion writers stopped. Configure ingest({ journalTable: '${replacementTable}' }), then restart them. The active journal has not been changed.`,
  }
  const assertSourceUnchanged = async () => {
    if (await tableDigest(table, options) !== source.digest) {
      throw new Error('Journal changed while copying. Keep the original journal active, stop all writers, and review a new repair plan.')
    }
  }
  const selection = `target_id = ${sqlString(options.targetId)} AND namespace_id = ${sqlString(namespaceId)}`

  await createTable(archiveTable, options)
  await copyRows(archiveTable, `SELECT * FROM ${qualified(options.database, table)}`, options)
  if (await tableDigest(archiveTable, options) !== source.digest) {
    await assertSourceUnchanged()
    throw new Error(`Evidence verification failed for ${archiveTable}; the active journal remains unchanged.`)
  }

  await createTable(replacementTable, options)
  await copyRows(replacementTable, `SELECT * FROM ${qualified(options.database, archiveTable)} WHERE NOT (${selection})`, options)
  if (validated.rows.length > 0) {
    await options.executor.insert({
      table: `${options.database}.${replacementTable}`,
      values: validated.rows,
      stream: true,
      settings: { async_insert: 0, insert_deduplication_token: `${replacementTable}:validated` },
    })
  }
  const retainedDigest = await sortedDigest(async (add) => {
    for await (const batch of readRows(archiveTable, options)) {
      for (const row of batch) if (!isSelected(row, namespaceId, options.targetId)) add(canonicalJson(row))
    }
    for (const row of validated.rows) add(canonicalJson(row))
  })
  if (await tableDigest(replacementTable, options) !== retainedDigest) {
    throw new Error(`Evidence verification failed for ${replacementTable}; the active journal remains unchanged.`)
  }
  const copied = validateJournalHistory(validated.rows, namespaceId)
  if (copied.problems.length > 0 || canonicalJson(copied.checkpoint) !== canonicalJson(plan.checkpoint)) {
    throw new Error('Replacement journal verification failed; the active journal remains unchanged.')
  }
  await assertSourceUnchanged()
  return { applied: true, activated: false, plan: materializedPlan }
}

function recoveryTable(options: JournalRecoveryOptions): string {
  const table = options.table ?? DEFAULT_JOURNAL_TABLE
  identifier(options.database)
  identifier(table)
  return table
}

async function inspectSource(table: string, namespaceId: string, options: JournalRecoveryOptions): Promise<SourceSnapshot> {
  const exists = await options.executor.query<{ x: number }>(
    `SELECT 1 AS x FROM system.tables WHERE database = ${sqlString(options.database)} AND name = ${sqlString(table)}`,
    READ_SETTINGS
  )
  if (exists.length === 0) return { rows: 0, digest: snapshotFingerprint([]), selected: [], missing: true }
  const selected: JournalRow[] = []
  let rows = 0
  const rowsDigest = await sortedDigest(async (add) => {
    for await (const batch of readRows(table, options)) {
      for (const row of batch) {
        rows += 1
        add(canonicalJson(row))
        if (isSelected(row, namespaceId, options.targetId)) selected.push(row)
      }
    }
  })
  return { rows, digest: rowsDigest, selected, missing: false }
}

function sourcePlan(
  source: SourceSnapshot, validated: ValidatedJournalHistory, namespaceId: string, sourceTable: string, targetId: string | undefined
): JournalRepairPlan {
  const fingerprint = digest([namespaceId, sourceTable, targetId ?? '', source.digest])
  const suffix = fingerprint.slice(0, 24)
  const replacementTable = `${sourceTable}_repair_${suffix}`
  const problems = source.missing
    ? [...validated.problems, `Journal source table ${sourceTable} is missing. Restore its evidence before repairing, or run ingest on a fresh target.`]
    : validated.problems
  return {
    namespaceId,
    sourceTable,
    fingerprint,
    healthy: !source.missing && validated.problems.length === 0,
    repairable: !source.missing,
    problems,
    evidenceRows: source.rows,
    selectedEvidenceRows: source.selected.length,
    retainedFacts: source.rows - source.selected.length + validated.rows.length,
    runs: new Set(source.selected.map((row) => row.run_id)).size,
    checkpoint: validated.checkpoint,
    archiveTable: `${sourceTable}_archive_${suffix}`,
    replacementTable,
    activation: `Stop all ingestion writers, materialize the reviewed repair, then configure ingest({ journalTable: '${replacementTable}' }) before restarting them.`,
    replayWarning: 'The next run resumes from the selected valid checkpoint. Uncertain destination writes may be loaded again (at least once).',
  }
}

/** Streams a snapshot in batches; executors without batched reads return it whole. */
async function* readRows(table: string, options: JournalRecoveryOptions): AsyncGenerator<JournalRow[]> {
  const sql = `SELECT * FROM ${qualified(options.database, table)} ORDER BY target_id, namespace_id, run_id, event_seq, event_id, payload_hash, event_at`
  if (options.executor.queryBatches) yield* options.executor.queryBatches<JournalRow>(sql, READ_SETTINGS)
  else yield await options.executor.query<JournalRow>(sql, READ_SETTINGS)
}

async function tableDigest(table: string, options: JournalRecoveryOptions): Promise<string> {
  return sortedDigest(async (add) => {
    for await (const batch of readRows(table, options)) for (const row of batch) add(canonicalJson(row))
  })
}

async function createTable(table: string, options: JournalRecoveryOptions): Promise<void> {
  await options.executor.command(journalTableSql(qualified(options.database, table)))
  await waitForTable(options.executor, options.database, table)
}

/** Copies rows inside ClickHouse; the token keeps identical source blocks from deduplicating. */
async function copyRows(table: string, select: string, options: JournalRecoveryOptions): Promise<void> {
  await options.executor.command(`INSERT INTO ${qualified(options.database, table)} ${select}`, {
    select_sequential_consistency: '1', insert_deduplication_token: table,
  })
}

function isSelected(row: JournalRow, namespaceId: string, targetId: string | undefined): boolean {
  return row.namespace_id === namespaceId && (targetId === undefined || row.target_id === targetId)
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
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid journal identifier "${value}".`)
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
