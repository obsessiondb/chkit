import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'

import { applyAsyncStatement } from '../commands/migrate/async-apply'
import type { JournalStore, MigrationRowState } from '../runtime/journal-store'

/** Minimal in-memory journal store: applyAsyncStatement only reads/writes migration state. */
function makeJournalStore(): JournalStore {
  let state: MigrationRowState | null = null
  return {
    async readMigrationState() {
      return state
    },
    async writeMigrationState(next: MigrationRowState) {
      state = next
    },
  } as unknown as JournalStore
}

/** A db whose queryStatus follows a scripted sequence; `throw524` simulates a gateway timeout. */
function makeDb(sequence: Array<QueryStatus | 'throw524'>): ClickHouseExecutor {
  let i = 0
  return {
    async submit() {
      return 'submitted'
    },
    async command() {},
    async queryStatus(): Promise<QueryStatus> {
      const step = sequence[Math.min(i, sequence.length - 1)]
      i += 1
      if (step === 'throw524') throw new Error('ClickHouse request failed: error code: 524')
      return step as QueryStatus
    },
  } as unknown as ClickHouseExecutor
}

const base = {
  sql: 'INSERT INTO x SELECT 1',
  migrationName: '20260101_load',
  migrationChecksum: 'abc',
  statementIndex: 1,
  operationType: 'load_table_data',
  operationKey: 'table:default.x',
  beforeRetry: null,
  log: () => {},
  sleep: async () => {},
  now: () => 0,
}

describe('applyAsyncStatement — transient poll errors', () => {
  test('tolerates a burst of 524s during polling, then completes', async () => {
    const db = makeDb([
      { status: 'unknown' }, // in-flight check before submit
      'throw524',
      'throw524',
      'throw524',
      { status: 'finished', writtenRows: 100, writtenBytes: 1000, durationMs: 1000 },
    ])

    const result = await applyAsyncStatement({ ...base, db, journalStore: makeJournalStore() })

    expect(result.kind).toBe('completed')
  })

  test('gives up after the budget with a re-run/re-attach hint, not a silent abort', async () => {
    const db = makeDb([{ status: 'unknown' }, 'throw524']) // unknown once, then 524 forever

    await expect(
      applyAsyncStatement({ ...base, db, journalStore: makeJournalStore() }),
    ).rejects.toThrow('re-attach')
  })
})
