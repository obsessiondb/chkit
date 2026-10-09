import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { createPrefix, createStatelessLiveExecutor, getLiveEnv, quoteIdent, waitForTable } from '@chkit/clickhouse/e2e-testkit'

import { rawTable } from './destination.js'
import { runIngestion } from './executor.js'
import { cursorState } from './incremental.js'
import { createClickHouseJournal, emptyCheckpoint, journalTableSql, toJournalRow, type JournalRow } from './journal.js'
import { doctorJournal, repairJournal } from './recovery.js'
import { definePipeline, defineStream, selectStreams } from './registry.js'
import type { JournalEvent } from './types.js'

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
    const options = { executor, database, targetId, table }
    const report = await doctorJournal(namespaceId, options)
    expect(report).toMatchObject({ healthy: true, runs: 2, retainedFacts: 6 })
    const result = await repairJournal(namespaceId, report.fingerprint, options)
    expect(result).toMatchObject({ applied: false, activated: false })
    expect(await count(table)).toBe(6)
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
    const options = { executor, database, targetId, table }
    const review = await repairJournal(namespaceId, undefined, options)
    expect(review.plan).toMatchObject({ healthy: false, evidenceRows: 7, retainedFacts: 5 })
    const copied = await repairJournal(namespaceId, review.plan.fingerprint, options)
    expect(copied).toMatchObject({ applied: true, activated: false })
    expect(await count(table)).toBe(7)
    expect(await count(copied.plan.archiveTable)).toBe(7)
    expect(await count(copied.plan.replacementTable)).toBe(5)
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

  test('a lost archive acknowledgement keeps the original active and a retry retains safe progress', async () => {
    const namespaceId = `${prefix}lost_ack`
    const table = `${prefix}lost_ack_journal`
    const rows = [...branch(namespaceId, 'first', 1), fact(namespaceId, 'first', 3, { eventKind: 'work_finished', workState: 'failed' })]
    await createJournal(table, rows)
    const options = { executor, database, targetId, table }
    const review = await repairJournal(namespaceId, undefined, options)
    let archiveTable: string | undefined
    const lossy: ClickHouseExecutor = {
      ...executor,
      async insert(input) {
        await executor.insert(input)
        if (input.table.includes('_archive_')) {
          archiveTable = input.table.replace(`${database}.`, '')
          throw new Error('archive acknowledgement lost')
        }
      },
    }
    await expect(repairJournal(namespaceId, review.plan.fingerprint, { ...options, executor: lossy })).rejects.toThrow('archive acknowledgement lost')
    expect(await count(table)).toBe(4)
    expect(archiveTable).toBeDefined()
    expect(await count(archiveTable ?? '')).toBe(4)
    expect((await createClickHouseJournal(options).readCheckpoint(namespaceId)).envelope?.state).toBe(1)
    const retry = await repairJournal(namespaceId, review.plan.fingerprint, options)
    expect(retry).toMatchObject({ applied: true, activated: false, plan: { checkpoint: { version: 1 } } })
    expect(await count(table)).toBe(4)
    expect(await count(retry.plan.archiveTable)).toBe(4)
    expect(await count(retry.plan.replacementTable)).toBe(2)
  }, 120_000)

  test('doctor diagnoses a missing journal without creating a replacement', async () => {
    const namespaceId = `${prefix}missing`
    const table = `${prefix}missing_journal`
    const options = { executor, database, targetId, table }
    const report = await doctorJournal(namespaceId, options)
    expect(report).toMatchObject({ healthy: false, repairable: false, evidenceRows: 0 })
    expect(report.problems.join(' ')).toContain('source table')
    await expect(repairJournal(namespaceId, report.fingerprint, options)).rejects.toThrow('source table')
  }, 120_000)

  async function createJournal(table: string, rows: JournalRow[]) {
    await executor.command(journalTableSql(`${quoteIdent(database)}.${quoteIdent(table)}`))
    await waitForTable(executor, database, table)
    await executor.insert({ table: `${database}.${table}`, values: rows, settings: { async_insert: 0 } })
  }

  async function count(table: string): Promise<number> {
    const rows = await executor.query<{ rows: string }>(`SELECT count() AS rows FROM ${quoteIdent(database)}.${quoteIdent(table)}`)
    return Number(rows[0]?.rows)
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
