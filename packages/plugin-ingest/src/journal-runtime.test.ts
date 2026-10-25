import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { IngestConfigError } from './errors.js'
import { createClickHouseJournal, digest, emptyCheckpoint, toJournalRow } from './journal.js'
import { doctorJournal, repairJournal } from './recovery.js'
import type { JournalEvent } from './types.js'

describe('journal Promise boundaries', () => {
  test('waits for DDL acknowledgement before checking table visibility', async () => {
    const ddl = gate()
    const calls: string[] = []
    const journal = createClickHouseJournal({
      ...options(),
      executor: executor({
        async command() { calls.push('command'); await ddl.promise },
        async query<T>(sql: string): Promise<T[]> {
          calls.push(sql.includes('system.one') ? 'replicas' : 'visible')
          return sql.includes('system.one') ? [] : [{ x: 1 }] as T[]
        },
      }),
    })
    const pending = journal.ensure()
    expect(calls).toEqual(['command'])
    ddl.resolve()
    await pending
    expect(calls).toEqual(['command', 'replicas', 'visible'])
  })

  test('does not read the clock or perform IO for an empty append', async () => {
    const journal = createClickHouseJournal({
      ...options(),
      now() { throw new Error('Unexpected clock call') },
      executor: executor({ insert() { throw new Error('Unexpected insert') } }),
    })
    await expect(journal.append([])).resolves.toBeUndefined()
  })

  test('keeps insert tokens stable across retried facts and physical timestamps', async () => {
    const inserts: Parameters<ClickHouseExecutor['insert']>[0][] = []
    let at = new Date('2026-10-01T00:00:00Z')
    const journal = createClickHouseJournal({
      ...options(), now: () => at,
      executor: executor({ async insert(input) { inserts.push(input) } }),
    })
    const event = started()
    const row = toJournalRow(event, 'target', at)
    await journal.append([event])
    at = new Date('2026-10-03T00:00:00Z')
    await journal.append([event])
    expect(inserts[0]).toEqual({
      table: 'test.ingest_journal', values: [row],
      settings: { async_insert: 0, insert_deduplication_token: digest([row.event_id, row.payload_hash]) },
    })
    expect(inserts[1]?.settings).toEqual(inserts[0]?.settings)
    expect(inserts[1]?.values).toEqual([{ ...row, event_at: '2026-10-03 00:00:00.000' }])
  })

  test('preserves synchronous callback errors and rejected IO values', async () => {
    const clockError = new Error('clock failed')
    const commandError = new Error('command failed')
    const insertError = { code: 'lost_ack' }
    const readError = new IngestConfigError('invalid snapshot')
    const journal = createClickHouseJournal({
      ...options(), executor: executor({
        command() { throw commandError },
        async insert() { throw insertError },
        query() { throw readError },
      }),
    })
    await expect(journal.ensure()).rejects.toBe(commandError)
    await expect(journal.append([started()])).rejects.toBe(insertError)
    await expect(journal.readCheckpoint('test.rows')).rejects.toBe(readError)
    await expect(createClickHouseJournal({ ...options(), now() { throw clockError } }).append([started()])).rejects.toBe(clockError)
  })

  test('reads one target-filtered uncached snapshot and leaves projection pure', async () => {
    const queries: Array<{ sql: string; settings: unknown }> = []
    const journal = createClickHouseJournal({
      ...options(), executor: executor({
        async query<T>(sql: string, settings?: Parameters<ClickHouseExecutor['query']>[1]): Promise<T[]> {
          queries.push({ sql, settings })
          return []
        },
      }),
    })
    await expect(journal.readCheckpoint("test.row's")).resolves.toEqual(emptyCheckpoint())
    expect(queries).toHaveLength(1)
    expect(queries[0]?.sql).toContain("target_id = 'target' AND namespace_id = 'test.row\\'s'")
    expect(queries[0]?.settings).toEqual({
      select_sequential_consistency: '1', use_query_cache: 0, output_format_json_quote_64bit_integers: 1,
    })
  })
})

describe('recovery Promise boundaries', () => {
  test('rejects invalid identifiers asynchronously with the existing config error', async () => {
    const input = { ...options(), table: 'invalid-table' }
    await expect(doctorJournal('test.rows', input)).rejects.toBeInstanceOf(IngestConfigError)
    await expect(repairJournal('test.rows', undefined, input)).rejects.toBeInstanceOf(IngestConfigError)
  })

  test('does not turn synchronous query exceptions into runtime-specific failures', async () => {
    const error = new Error('snapshot unavailable')
    const input = { ...options(), executor: executor({ query() { throw error } }) }
    await expect(doctorJournal('test.rows', input)).rejects.toBe(error)
    await expect(repairJournal('test.rows', undefined, input)).rejects.toBe(error)
  })
})

function options() {
  return { executor: executor(), database: 'test', targetId: 'target', table: 'ingest_journal' }
}

function executor(overrides: Partial<ClickHouseExecutor> = {}): ClickHouseExecutor {
  return {
    async command() {},
    async query() { return [] },
    async insert() {},
    async listSchemaObjects() { return [] },
    async listTableDetails() { return [] },
    async submit() { throw new Error('Unexpected submit') },
    async queryStatus() { throw new Error('Unexpected queryStatus') },
    async close() {},
    ...overrides,
  }
}

function started(): JournalEvent {
  return {
    namespaceId: 'test.rows', eventSeq: 1, eventKind: 'run_started', runId: 'run', workId: '', attemptNo: 0, batchId: '',
    expectedCheckpointVersion: 0, checkpointVersion: 0, checkpoint: undefined, workState: '', sinkEvidence: '',
    retryAt: undefined, errorClass: '',
    detail: { journal: { version: 2, startedAt: '2026-10-01T00:00:00Z', base: emptyCheckpoint() } },
  }
}

function gate() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
