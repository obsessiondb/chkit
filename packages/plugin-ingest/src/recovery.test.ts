import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { emptyCheckpoint, toJournalRow, type JournalRow } from './journal.js'
import { doctorJournal, planJournalRepair, repairJournal } from './recovery.js'
import type { CommittedCheckpoint, JournalEvent } from './types.js'

const namespaceId = 'app.rows'
const sourceTable = 'ingest_journal'

describe('journal recovery plans', () => {
  test('overlapping valid runs are healthy and need no repair', () => {
    const rows = [...branch('first', 1), ...branch('second', 2, '2026-10-02T00:00:00.000Z')]
    const plan = planJournalRepair(rows, namespaceId, sourceTable)
    const reversed = planJournalRepair([...rows].reverse(), namespaceId, sourceTable)
    expect(plan.healthy).toBe(true)
    expect(plan.problems).toEqual([])
    expect(plan.runs).toBe(2)
    expect(plan.retainedFacts).toBe(6)
    expect(plan.fingerprint).toBe(reversed.fingerprint)
    expect(plan.checkpoint).toEqual(reversed.checkpoint)
  })

  test('preserves physical retry evidence while retaining one logical fact', () => {
    const rows = branch('first', 1)
    const duplicate = { ...fact('first', 1, { detail: { journal: { version: 2, startedAt: '2026-10-01T00:00:00.000Z', base: emptyCheckpoint() } } }), event_at: '2026-10-08 00:00:00.000000' }
    const plan = planJournalRepair([...rows, duplicate], namespaceId, sourceTable)
    expect(plan.healthy).toBe(true)
    expect(plan.evidenceRows).toBe(4)
    expect(plan.retainedFacts).toBe(3)
    expect(plan.checkpoint.envelope?.state).toBe(1)
  })

  test('retains acknowledged progress before an invalid same-run tail', () => {
    const rows = damagedBranch()
    const plan = planJournalRepair(rows, namespaceId, sourceTable)
    expect(plan.healthy).toBe(false)
    expect(plan.repairable).toBe(true)
    expect(plan.retainedFacts).toBe(2)
    expect(plan.checkpoint).toMatchObject({ version: 1, checkpointId: 'first:2', envelope: { state: 1 } })
    expect(plan.activation).toContain('Stop all ingestion writers')
  })

  test('does not discard evidence from another namespace or target', () => {
    const unrelated = fact('other', 1, { namespaceId: 'app.other' })
    const anotherTarget = { ...unrelated, target_id: 'unrelated-target' }
    const plan = planJournalRepair([...damagedBranch(), unrelated, anotherTarget], namespaceId, sourceTable, 'target')
    expect(plan.evidenceRows).toBe(6)
    expect(plan.selectedEvidenceRows).toBe(4)
    expect(plan.retainedFacts).toBe(4)
  })
})

describe('reviewed repair materialization', () => {
  test('doctor and default repair produce a plan without mutations', async () => {
    const fixture = recoveryFixture(branch('first', 1))
    const report = await doctorJournal(namespaceId, fixture.options)
    const result = await repairJournal(namespaceId, undefined, fixture.options)
    expect(report.fingerprint).toBe(result.plan.fingerprint)
    expect(result).toMatchObject({ applied: false, activated: false })
    expect(fixture.mutations).toEqual([])
    expect(fixture.queries.every((query) => query.settings?.use_query_cache === 0)).toBe(true)
  })

  test('applying healthy overlap leaves the active journal untouched', async () => {
    const fixture = recoveryFixture([...branch('first', 1), ...branch('second', 2)])
    const review = await repairJournal(namespaceId, undefined, fixture.options)
    const result = await repairJournal(namespaceId, review.plan.fingerprint, fixture.options)
    expect(result).toMatchObject({ applied: false, activated: false })
    expect(fixture.mutations).toEqual([])
  })

  test('archives all evidence and materializes valid facts without activating a journal', async () => {
    const other = fact('other', 1, { namespaceId: 'app.other' })
    const rows = [...damagedBranch(), other]
    const fixture = recoveryFixture(rows)
    const review = await repairJournal(namespaceId, undefined, fixture.options)
    const copied = await repairJournal(namespaceId, review.plan.fingerprint, fixture.options)
    expect(copied).toMatchObject({ applied: true, activated: false })
    expect(fixture.tables.get(sourceTable)).toEqual(rows)
    expect(fixture.tables.get(copied.plan.archiveTable)).toEqual(rows)
    expect(fixture.tables.get(copied.plan.replacementTable)).toEqual([other, ...rows.slice(0, 2)])
    expect(copied.plan.activation).toContain(`journalTable: '${copied.plan.replacementTable}'`)
    expect(fixture.mutations.some((entry) => /DELETE|DROP|TRUNCATE|ALTER/.test(entry))).toBe(false)
  })

  test('rejects changed evidence before creating recovery artifacts', async () => {
    const fixture = recoveryFixture(damagedBranch())
    const review = await repairJournal(namespaceId, undefined, fixture.options)
    fixture.tables.get(sourceTable)?.push(fact('other', 1, { namespaceId: 'app.other' }))
    await expect(repairJournal(namespaceId, review.plan.fingerprint, fixture.options)).rejects.toThrow('changed since review')
    expect(fixture.mutations).toEqual([])
  })

  test('does not return an activatable replacement if archive verification fails', async () => {
    const rows = damagedBranch()
    const fixture = recoveryFixture(rows, { corruptArchive: true })
    const review = await repairJournal(namespaceId, undefined, fixture.options)
    await expect(repairJournal(namespaceId, review.plan.fingerprint, fixture.options)).rejects.toThrow('Evidence verification failed')
    expect(fixture.tables.get(sourceTable)).toEqual(rows)
    expect([...fixture.tables.keys()].some((table) => table.includes('_repair_'))).toBe(false)
  })

  test('rejects source changes during materialization', async () => {
    const rows = damagedBranch()
    const fixture = recoveryFixture(rows, { changeSourceDuringArchive: true })
    const review = await repairJournal(namespaceId, undefined, fixture.options)
    await expect(repairJournal(namespaceId, review.plan.fingerprint, fixture.options)).rejects.toThrow('Journal changed while copying')
    expect(fixture.tables.get(sourceTable)).toHaveLength(rows.length + 1)
  })

  test('diagnoses a missing source table without creating one', async () => {
    const fixture = recoveryFixture([])
    fixture.tables.delete(sourceTable)
    const report = await doctorJournal(namespaceId, fixture.options)
    expect(report).toMatchObject({ healthy: false, repairable: false, checkpoint: emptyCheckpoint() })
    expect(report.problems.join(' ')).toContain('source table')
    await expect(repairJournal(namespaceId, report.fingerprint, fixture.options)).rejects.toThrow('source table')
    expect(fixture.mutations).toEqual([])
  })
})

function branch(runId: string, state: number, startedAt = '2026-10-01T00:00:00.000Z', base: CommittedCheckpoint = emptyCheckpoint()): JournalRow[] {
  return [
    fact(runId, 1, { detail: { journal: { version: 2, startedAt, base } } }),
    fact(runId, 2, {
      eventKind: 'batch_committed', expectedCheckpointVersion: base.version, checkpointVersion: base.version + 1,
      checkpoint: { strategy: 'cursor', version: 1, state }, sinkEvidence: 'clickhouse_ack',
    }),
    fact(runId, 3, { eventKind: 'work_finished', workState: 'succeeded' }),
  ]
}

function damagedBranch(): JournalRow[] {
  const rows = branch('first', 1)
  return [...rows, fact('first', 3, { eventKind: 'work_finished', workState: 'failed' })]
}

function fact(runId: string, eventSeq: number, fields: Partial<JournalEvent> = {}): JournalRow {
  return toJournalRow({
    namespaceId, eventSeq, eventKind: 'run_started', runId, workId: '', attemptNo: 0, batchId: '',
    expectedCheckpointVersion: 0, checkpointVersion: 0, checkpoint: undefined, workState: '', sinkEvidence: '',
    retryAt: undefined, errorClass: '', detail: {}, ...fields,
  }, 'target', new Date('2026-10-01T00:00:00Z'))
}

function recoveryFixture(rows: JournalRow[], faults: { corruptArchive?: boolean; changeSourceDuringArchive?: boolean } = {}) {
  const tables = new Map<string, JournalRow[]>([[sourceTable, structuredClone(rows)]])
  const mutations: string[] = []
  const queries: Array<{ sql: string; settings: Record<string, unknown> | undefined }> = []
  const executor: ClickHouseExecutor = {
    async command(sql) {
      mutations.push(sql)
      const table = sql.match(/CREATE TABLE IF NOT EXISTS `test`\.`([^`]+)`/)?.[1]
      if (!table) throw new Error(`Unexpected SQL: ${sql}`)
      tables.set(table, [])
    },
    async query<T>(sql, settings) {
      queries.push({ sql, settings })
      if (sql.includes('system.tables')) {
        const name = sql.match(/name = '([^']+)'/)?.[1]
        return (name && tables.has(name) ? [{ x: 1 }] : []) as T[]
      }
      const table = sql.match(/FROM `test`\.`([^`]+)`/)?.[1]
      if (!table) throw new Error(`Unexpected SQL: ${sql}`)
      return structuredClone(tables.get(table) ?? []) as T[]
    },
    async insert({ table, values }) {
      mutations.push(`insert:${table}`)
      const name = table.replace('test.', '')
      const inserted = values.map((value) => {
        const row = rows.find((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
        if (!row) throw new Error('Unexpected inserted journal row')
        return structuredClone(row)
      })
      tables.set(name, faults.corruptArchive && name.includes('_archive_') ? inserted.slice(1) : inserted)
      if (faults.changeSourceDuringArchive && name.includes('_archive_')) tables.get(sourceTable)?.push(fact('new', 1, { namespaceId: 'app.other' }))
    },
    async listSchemaObjects() { return [] },
    async listTableDetails() { return [] },
    async submit() { throw new Error('Unexpected submit') },
    async queryStatus() { throw new Error('Unexpected queryStatus') },
    async close() {},
  }
  return { tables, mutations, queries, options: { executor, database: 'test', targetId: 'target', table: sourceTable } }
}
