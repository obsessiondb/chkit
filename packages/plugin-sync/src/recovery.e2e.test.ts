import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor, ClickHouseSettings } from '@chkit/clickhouse'
import { createPrefix, createStatelessLiveExecutor, getLiveEnv, quoteIdent, waitForTable } from '@chkit/clickhouse/e2e-testkit'

import { rawTable } from './destination.js'
import { runIngestion } from './executor.js'
import { cursorState } from './incremental.js'
import { validateJournalHistory } from './journal-history.js'
import { canonicalJson, createClickHouseJournal, emptyCheckpoint, journalTableSql, toJournalRow, type JournalRow } from './journal.js'
import { doctorJournal, planJournalRepair, repairJournal } from './recovery.js'
import { definePipeline, defineStream, selectStreams } from './registry.js'
import type { CommittedCheckpoint, JournalEvent } from './types.js'

describe('journal recovery live env e2e', () => {
  const liveEnv = getLiveEnv()
  const prefix = createPrefix('recovery')
  const database = liveEnv.clickhouseDatabase
  const targetId = `e2e/${prefix}`
  let executor: ClickHouseExecutor

  beforeAll(() => {
    executor = createStatelessLiveExecutor(liveEnv)
  })

  afterAll(async () => {
    const tables = await executor.query<{ name: string }>(`SELECT name FROM system.tables WHERE database = '${database}'`)
    for (const { name } of tables.filter((entry) => entry.name.startsWith(prefix))) {
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(name)}`)
    }
    await executor.close()
  }, 60_000)

  test('valid overlapping histories need no repair or recovery tables', async () => {
    const namespaceId = `${prefix}overlap`
    const table = `${prefix}overlap_journal`
    const rows = [...branch(namespaceId, 'first', 1), ...branch(namespaceId, 'second', 2)]
    await createJournal(table, rows)
    const recorded = recording(executor)
    const options = { executor: recorded.executor, database, targetId, table }
    const report = await doctorJournal(namespaceId, options)
    expect(report).toMatchObject({ healthy: true, runs: 2, retainedFacts: 6 })
    const result = await repairJournal(namespaceId, report.fingerprint, options)
    expect(result).toMatchObject({ applied: false, activated: false })
    expect(recorded.writes).toEqual([])
    expect(await count(table)).toBe(6)
    expect(await recoveryTables(table)).toEqual([])
  }, 120_000)

  test('doctor and repair review read uncached snapshots without writing', async () => {
    const namespaceId = `${prefix}review`
    const table = `${prefix}review_journal`
    await createJournal(table, damagedBranch(namespaceId))
    expect(executor.queryBatches).toBeDefined()
    const recorded = recording(executor)
    const options = { executor: recorded.executor, database, targetId, table }
    const report = await doctorJournal(namespaceId, options)
    const review = await repairJournal(namespaceId, undefined, options)
    expect(review).toMatchObject({ applied: false, activated: false, plan: { healthy: false, fingerprint: report.fingerprint } })
    expect(recorded.writes).toEqual([])
    expect(recorded.reads.length).toBeGreaterThan(0)
    expect(recorded.reads.every((settings) => settings?.use_query_cache === 0)).toBe(true)
    expect(await recoveryTables(table)).toEqual([])
  }, 120_000)

  test('materializes valid evidence, preserves other streams, and resumes only after explicit configuration activation', async () => {
    const namespaceId = `${prefix}damaged`
    const otherNamespace = `${prefix}other`
    const table = `${prefix}damaged_journal`
    const rows = [
      ...branch(namespaceId, 'first', 1),
      fact(namespaceId, 'first', 3, { eventKind: 'work_finished', workState: 'failed' }),
      ...branch(otherNamespace, 'other', 7),
    ]
    await createJournal(table, rows)
    const recorded = recording(executor)
    const options = { executor: recorded.executor, database, targetId, table }
    const review = await repairJournal(namespaceId, undefined, options)
    expect(review.plan).toMatchObject({ healthy: false, evidenceRows: 7, retainedFacts: 5 })
    const copied = await repairJournal(namespaceId, review.plan.fingerprint, options)
    expect(copied).toMatchObject({ applied: true, activated: false })
    expect(recorded.writes.some((sql) => /\b(DELETE|DROP|TRUNCATE|ALTER)\b/.test(sql))).toBe(false)
    expect(await count(table)).toBe(7)
    expect(await canonicalRows(copied.plan.archiveTable)).toEqual(await canonicalRows(table))
    expect(await canonicalRows(copied.plan.replacementTable)).toEqual(canonical([...await rowsOf(table)].filter((row) => row.namespace_id === otherNamespace || Number(row.event_seq) < 3)))
    expect(copied.plan.activation).toContain(`journalTable: '${copied.plan.replacementTable}'`)
    expect((await doctorJournal(namespaceId, options)).healthy).toBe(false)
    expect((await doctorJournal(namespaceId, { ...options, table: copied.plan.replacementTable })).healthy).toBe(true)
    expect((await createClickHouseJournal({ ...options, table: copied.plan.replacementTable }).readCheckpoint(otherNamespace)).envelope?.state).toBe(7)

    // Choosing the returned table models the documented explicit config change.
    const journal = createClickHouseJournal({ ...options, table: copied.plan.replacementTable })
    const selections: unknown[] = []
    const stream = defineStream({
      id: namespaceId,
      destination: rawTable({ database, name: `${prefix}unused_destination` }),
      incremental: cursorState({ id: 'e2e.recovery', version: 1, parse: (value) => Number(value) }),
      async *read({ selection }) {
        selections.push(selection)
        yield { rows: [], state: 2 }
      },
    })
    const selected = selectStreams([definePipeline({ id: `${prefix}pipeline`, streams: [stream] })], [])
    const result = await runIngestion({ selected, backfill: undefined }, {
      journal,
      destination: { async insert() { throw new Error('Empty recovery batch must not insert rows') } },
    })
    expect(result.ok).toBe(true)
    expect(selections).toEqual([1])
    expect((await journal.readCheckpoint(namespaceId)).envelope?.state).toBe(2)
    expect(await count(table)).toBe(7)
    expect(await count(copied.plan.archiveTable)).toBe(7)
  }, 120_000)

  test('evidence that changed since review is rejected before recovery tables exist', async () => {
    const namespaceId = `${prefix}changed`
    const table = `${prefix}changed_journal`
    await createJournal(table, damagedBranch(namespaceId))
    const recorded = recording(executor)
    const options = { executor: recorded.executor, database, targetId, table }
    const review = await repairJournal(namespaceId, undefined, options)
    await executor.insert({ table: `${database}.${table}`, values: [fact(`${prefix}late`, 'late', 1)], settings: { async_insert: 0 } })
    await expect(repairJournal(namespaceId, review.plan.fingerprint, options)).rejects.toThrow('changed since review')
    expect(recorded.writes).toEqual([])
    expect(await recoveryTables(table)).toEqual([])
  }, 120_000)

  test('a lost archive acknowledgement keeps the original active and a retry retains safe progress', async () => {
    const namespaceId = `${prefix}lost_ack`
    const table = `${prefix}lost_ack_journal`
    await createJournal(table, damagedBranch(namespaceId))
    const options = { executor, database, targetId, table }
    const review = await repairJournal(namespaceId, undefined, options)
    const lossy = afterArchiveCopy(table, async () => {
      throw new Error('archive acknowledgement lost')
    })
    await expect(repairJournal(namespaceId, review.plan.fingerprint, { ...options, executor: lossy })).rejects.toThrow('archive acknowledgement lost')
    expect(await count(table)).toBe(4)
    const [archiveTable, ...others] = await recoveryTables(table)
    expect(others).toEqual([])
    expect(await count(archiveTable ?? '')).toBe(4)
    expect((await createClickHouseJournal(options).readCheckpoint(namespaceId)).envelope?.state).toBe(1)
    const retry = await repairJournal(namespaceId, review.plan.fingerprint, options)
    expect(retry).toMatchObject({ applied: true, activated: false, plan: { checkpoint: { version: 1 } } })
    expect(await count(table)).toBe(4)
    expect(await count(retry.plan.archiveTable)).toBe(4)
    expect(await count(retry.plan.replacementTable)).toBe(2)
  }, 120_000)

  test('an archive that does not match the reviewed evidence yields no replacement', async () => {
    const namespaceId = `${prefix}bad_archive`
    const table = `${prefix}bad_archive_journal`
    await createJournal(table, damagedBranch(namespaceId))
    const options = { executor, database, targetId, table }
    const review = await repairJournal(namespaceId, undefined, options)
    const corrupting = afterArchiveCopy(table, async (archive) => {
      await executor.insert({ table: `${database}.${archive}`, values: [fact(`${prefix}stray`, 'stray', 1)], settings: { async_insert: 0 } })
    })
    await expect(repairJournal(namespaceId, review.plan.fingerprint, { ...options, executor: corrupting })).rejects.toThrow('Evidence verification failed')
    expect(await count(table)).toBe(4)
    expect((await recoveryTables(table)).some((name) => name.includes('_repair_'))).toBe(false)
  }, 120_000)

  test('a source change during materialization returns no replacement', async () => {
    const namespaceId = `${prefix}moving`
    const table = `${prefix}moving_journal`
    await createJournal(table, damagedBranch(namespaceId))
    const options = { executor, database, targetId, table }
    const review = await repairJournal(namespaceId, undefined, options)
    const moving = afterArchiveCopy(table, async () => {
      await executor.insert({ table: `${database}.${table}`, values: [fact(`${prefix}late`, 'late', 1)], settings: { async_insert: 0 } })
    })
    await expect(repairJournal(namespaceId, review.plan.fingerprint, { ...options, executor: moving })).rejects.toThrow('Journal changed while copying')
    expect(await count(table)).toBe(5)
  }, 120_000)

  test('doctor diagnoses a missing journal without creating a replacement', async () => {
    const namespaceId = `${prefix}missing`
    const table = `${prefix}missing_journal`
    const recorded = recording(executor)
    const options = { executor: recorded.executor, database, targetId, table }
    const report = await doctorJournal(namespaceId, options)
    expect(report).toMatchObject({ healthy: false, repairable: false, evidenceRows: 0 })
    expect(report.problems.join(' ')).toContain('source table')
    await expect(repairJournal(namespaceId, report.fingerprint, options)).rejects.toThrow('source table')
    expect(recorded.writes).toEqual([])
  }, 120_000)

  test('a large multi-stream journal reviews and repairs exactly like its single-snapshot plan', async () => {
    const namespaceId = `${prefix}large`
    const otherNamespace = `${prefix}large_other`
    const table = `${prefix}large_journal`
    const selected = chain(namespaceId, 800, 48)
    const rows = [
      ...selected,
      fact(namespaceId, 'run-0799', 50, { eventKind: 'work_finished', workState: 'failed' }),
      ...selected.slice(0, 500).map((row) => ({ ...row, event_at: '2026-10-08 00:00:00.000000' })),
      ...chain(otherNamespace, 100, 48),
      ...selected.slice(0, 1000).map((row) => ({ ...row, target_id: `${targetId}_other` })),
    ]
    await createJournal(table, rows)
    const options = { executor, database, targetId, table }
    const snapshot = await rowsOf(table)
    expect(snapshot).toHaveLength(rows.length)
    const expected = planJournalRepair(snapshot, namespaceId, table, targetId)
    expect(expected).toMatchObject({ healthy: false, repairable: true, evidenceRows: rows.length, retainedFacts: rows.length - 502 })

    expect(await doctorJournal(namespaceId, options)).toEqual(expected)
    const repaired = await repairJournal(namespaceId, expected.fingerprint, options)
    expect(repaired).toMatchObject({ applied: true, activated: false })
    expect(repaired.plan).toEqual({
      ...expected,
      archiveTable: expect.stringContaining(expected.archiveTable),
      replacementTable: expect.stringContaining(expected.replacementTable),
      activation: expect.stringContaining(repaired.plan.replacementTable),
    })
    expect(await canonicalRows(repaired.plan.archiveTable)).toEqual(canonical(snapshot))
    const retained = [
      ...snapshot.filter((row) => row.namespace_id !== namespaceId || row.target_id !== targetId),
      ...validateJournalHistory(snapshot.filter((row) => row.namespace_id === namespaceId && row.target_id === targetId), namespaceId).rows,
    ]
    expect(await canonicalRows(repaired.plan.replacementTable)).toEqual(canonical(retained))
    expect(await doctorJournal(namespaceId, { ...options, table: repaired.plan.replacementTable })).toMatchObject({ healthy: true, checkpoint: expected.checkpoint })
  }, 300_000)

  async function createJournal(table: string, rows: JournalRow[]) {
    await executor.command(journalTableSql(`${quoteIdent(database)}.${quoteIdent(table)}`))
    await waitForTable(executor, database, table)
    await executor.insert({ table: `${database}.${table}`, values: rows, settings: { async_insert: 0 } })
  }

  async function count(table: string): Promise<number> {
    const rows = await executor.query<{ rows: string }>(`SELECT count() AS rows FROM ${quoteIdent(database)}.${quoteIdent(table)}`)
    return Number(rows[0]?.rows)
  }

  async function rowsOf(table: string): Promise<JournalRow[]> {
    return executor.query<JournalRow>(
      `SELECT * FROM ${quoteIdent(database)}.${quoteIdent(table)} ORDER BY target_id, namespace_id, run_id, event_seq, event_id, payload_hash, event_at`,
      { select_sequential_consistency: '1', use_query_cache: 0, output_format_json_quote_64bit_integers: 1 },
    )
  }

  async function canonicalRows(table: string): Promise<string[]> {
    return canonical(await rowsOf(table))
  }

  async function recoveryTables(table: string): Promise<string[]> {
    const rows = await executor.query<{ name: string }>(
      `SELECT name FROM system.tables WHERE database = '${database}' AND (startsWith(name, '${table}_archive_') OR startsWith(name, '${table}_repair_')) ORDER BY name`,
    )
    return rows.map((row) => row.name)
  }

  /** Runs `fault` right after repair copies `table` into its archive. */
  function afterArchiveCopy(table: string, fault: (archive: string) => Promise<void>): ClickHouseExecutor {
    return {
      ...executor,
      async command(sql, settings) {
        await executor.command(sql, settings)
        if (!/^INSERT INTO \S*_archive_/.test(sql)) return
        const [archive] = (await recoveryTables(table)).filter((name) => name.includes('_archive_'))
        expect(archive).toBeDefined()
        await fault(archive ?? '')
      },
    }
  }

  function chain(namespaceId: string, runs: number, commits: number): JournalRow[] {
    const rows: JournalRow[] = []
    let base: CommittedCheckpoint = emptyCheckpoint()
    for (let run = 0; run < runs; run += 1) {
      const runId = `run-${String(run).padStart(4, '0')}`
      const startedAt = new Date(Date.UTC(2026, 9, 1) + run * 1000).toISOString()
      rows.push(fact(namespaceId, runId, 1, { detail: { journal: { version: 2, startedAt, base } } }))
      let version = base.version
      for (let seq = 2; seq <= commits + 1; seq += 1) {
        rows.push(fact(namespaceId, runId, seq, {
          eventKind: 'batch_committed', batchId: `batch-${seq}`, expectedCheckpointVersion: version, checkpointVersion: version + 1,
          checkpoint: { strategy: 'e2e.recovery', version: 1, state: version + 1 }, sinkEvidence: 'clickhouse_ack',
        }))
        version += 1
      }
      const finished = commits + 2
      rows.push(fact(namespaceId, runId, finished, { eventKind: 'work_finished', workState: 'succeeded' }))
      base = {
        version, envelope: { strategy: 'e2e.recovery', version: 1, state: version },
        checkpointId: `${runId}:${finished - 1}`, successId: `${runId}:${finished}`, headSeq: finished, lastSuccessSeq: finished,
      }
    }
    return rows
  }

  function damagedBranch(namespaceId: string): JournalRow[] {
    return [...branch(namespaceId, 'first', 1), fact(namespaceId, 'first', 3, { eventKind: 'work_finished', workState: 'failed' })]
  }

  function branch(namespaceId: string, runId: string, state: number): JournalRow[] {
    return [
      fact(namespaceId, runId, 1, { detail: { journal: { version: 2, startedAt: '2026-10-01T00:00:00.000Z', base: emptyCheckpoint() } } }),
      fact(namespaceId, runId, 2, {
        eventKind: 'batch_committed', expectedCheckpointVersion: 0, checkpointVersion: 1,
        checkpoint: { strategy: 'e2e.recovery', version: 1, state }, sinkEvidence: 'clickhouse_ack',
      }),
      fact(namespaceId, runId, 3, { eventKind: 'work_finished', workState: 'succeeded' }),
    ]
  }

  function fact(namespaceId: string, runId: string, eventSeq: number, fields: Partial<JournalEvent> = {}): JournalRow {
    return toJournalRow({
      namespaceId, eventSeq, eventKind: 'run_started', runId, workId: '', attemptNo: 0, batchId: '',
      expectedCheckpointVersion: 0, checkpointVersion: 0, checkpoint: undefined, workState: '', sinkEvidence: '',
      retryAt: undefined, errorClass: '', detail: {}, ...fields,
    }, targetId, new Date('2026-10-01T00:00:00Z'))
  }
})

function canonical(rows: readonly JournalRow[]): string[] {
  return rows.map((row) => canonicalJson(row)).sort()
}

/** Records every write and every read's settings, delegating to `base`. */
function recording(base: ClickHouseExecutor) {
  const writes: string[] = []
  const reads: Array<ClickHouseSettings | undefined> = []
  const { queryBatches } = base
  const executor: ClickHouseExecutor = {
    ...base,
    async command(sql, settings) {
      writes.push(sql)
      await base.command(sql, settings)
    },
    async insert(params) {
      writes.push(`INSERT INTO ${params.table}`)
      await base.insert(params)
    },
    async query(sql, settings) {
      reads.push(settings)
      return base.query(sql, settings)
    },
    ...(queryBatches ? {
      queryBatches<T>(sql: string, settings?: ClickHouseSettings) {
        reads.push(settings)
        return queryBatches<T>(sql, settings)
      },
    } : {}),
  }
  return { executor, writes, reads }
}
