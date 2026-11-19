import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor, QueryStatus } from '@chkit/clickhouse'
import { statementFingerprint } from '@chkit/core'

import { markStoppedStatement, readStoppedStatement } from '../../../commands/migrate/mark-outcome.js'
import type { JournalStore, MigrationRowState, OperationState } from '../../../runtime/journal-store.js'
import { CLI_VERSION } from '../../../runtime/version.js'

// --mark-applied / --mark-not-applied act only on a statement whose outcome
// chkit cannot tell itself, and never while its attempt runs (#824).

const INSERT = 'INSERT INTO events SELECT number FROM numbers(8)'
const ALTER = 'ALTER TABLE events UPDATE x = 1 WHERE 1'

function op(index: number, overrides: Partial<OperationState> = {}): OperationState {
  return {
    operationIndex: index,
    operationKey: `table:db.t${index}`,
    operationType: 'load_table_data',
    queryId: '',
    status: 'completed',
    startedAt: '2026-11-19 10:00:00.000',
    finishedAt: '2026-11-19 10:00:01.000',
    lastError: '',
    fingerprint: `fp${index}`,
    ...overrides,
  }
}

function stopped(sql: string): OperationState {
  return op(1, {
    queryId: 'q-1',
    status: 'started',
    finishedAt: null,
    lastError: 'submitted under its own query id; a retry reads its outcome from system.query_log',
    fingerprint: statementFingerprint(sql),
    attemptFenced: true,
  })
}

function stateWith(operations: OperationState[], chkitVersion = CLI_VERSION): MigrationRowState {
  return { name: 'm.sql', appliedAt: '2026-11-19 10:00:02.000', checksum: 'c', chkitVersion, migrationCompleted: false, operations }
}

function fakes(state: MigrationRowState, status: QueryStatus) {
  const writes: MigrationRowState[] = []
  const statusCalls: string[] = []
  const journalStore = {
    readMigrationState: async () => state,
    writeMigrationState: async (written: MigrationRowState) => {
      writes.push(written)
    },
  } as unknown as JournalStore
  const db = {
    queryStatus: async (queryId: string) => {
      statusCalls.push(queryId)
      return status
    },
  } as unknown as ClickHouseExecutor
  return { deps: { db, journalStore, log: () => {}, sleep: async () => {} }, writes, statusCalls }
}

function input(sql: string | undefined) {
  return {
    migration: 'm.sql',
    appliedNames: new Set<string>(),
    flag: 'mark-applied',
    sqlByFingerprint: new Map(sql === undefined ? [] : [[statementFingerprint(sql), sql]]),
  }
}

const REJECTED: QueryStatus = { status: 'failed', beforeStart: true, error: 'Code: 60. UNKNOWN_TABLE' }

describe('readStoppedStatement', () => {
  test('returns the one statement whose attempt failed while it ran', async () => {
    const { deps } = fakes(stateWith([op(0), stopped(INSERT)]), { status: 'failed', error: 'boom' })

    const { op: found } = await readStoppedStatement(input(INSERT), deps)

    expect(found.operationIndex).toBe(1)
  })

  test('refuses while the attempt still runs, and writes nothing', async () => {
    const { deps, writes } = fakes(stateWith([op(0), stopped(INSERT)]), { status: 'running' })

    await expect(readStoppedStatement(input(INSERT), deps)).rejects.toMatchObject({ code: 'async_outcome_unknown' })
    expect(writes).toEqual([])
  })

  test('refuses an INSERT the server rejected before it started: apply retries it itself', async () => {
    const { deps } = fakes(stateWith([op(0), stopped(INSERT)]), REJECTED)

    await expect(readStoppedStatement(input(INSERT), deps)).rejects.toMatchObject({
      code: 'mark_refused',
      message: expect.stringContaining('no statement of it stopped with async_outcome_unknown'),
    })
  })

  test('refuses a rejection before the start when the file does not have the statement', async () => {
    const { deps } = fakes(stateWith([op(0), stopped(INSERT)]), REJECTED)

    await expect(readStoppedStatement(input(undefined), deps)).rejects.toMatchObject({
      code: 'mark_refused',
      message: expect.stringContaining('rejected statement 2 (query_id q-1) before it started'),
    })
  })

  test('accepts a rejection before the start of an ALTER, which can apply effects before it', async () => {
    const { deps } = fakes(stateWith([op(0), stopped(ALTER)]), REJECTED)

    const { op: found } = await readStoppedStatement(input(ALTER), deps)

    expect(found.queryId).toBe('q-1')
  })

  test('refuses a state another release recorded without fingerprints, before it reads the server', async () => {
    const { deps, statusCalls } = fakes(stateWith([op(0, { fingerprint: '' }), stopped(INSERT)], '0.1.0'), { status: 'failed', error: 'boom' })

    await expect(readStoppedStatement(input(INSERT), deps)).rejects.toMatchObject({
      code: 'mark_refused',
      message: expect.stringContaining('chkit 0.1.0 recorded its statements without their SQL fingerprints'),
    })
    expect(statusCalls).toEqual([])
  })

  test('refuses a failed record another release wrote without a fingerprint, which a mark could make completed', async () => {
    const legacy = op(1, { queryId: 'q-1', status: 'failed', lastError: 'retried', fingerprint: '' })
    const { deps, statusCalls } = fakes(stateWith([op(0), legacy], '0.1.0'), { status: 'unknown' })

    await expect(readStoppedStatement(input(INSERT), deps)).rejects.toMatchObject({ code: 'mark_refused' })
    expect(statusCalls).toEqual([])
  })
})

describe('markStoppedStatement', () => {
  for (const [outcome, status, lastError] of [
    ['applied', 'completed', ''],
    ['not-applied', 'failed', 'abandoned via chkit migrate --abandon (was started)'],
  ] as const) {
    test(`${outcome} rewrites only the stopped statement`, async () => {
      const state = stateWith([op(0), stopped(INSERT)])
      const { deps, writes } = fakes(state, { status: 'unknown' })

      await markStoppedStatement(state, stopped(INSERT), outcome, { journalStore: deps.journalStore, now: () => Date.parse('2026-11-19T11:00:00Z') })

      expect(writes).toHaveLength(1)
      expect(writes[0]?.operations[0]).toEqual(op(0))
      expect(writes[0]?.operations[1]).toMatchObject({ status, lastError, queryId: 'q-1' })
      expect(writes[0]?.migrationCompleted).toBe(false)
    })
  }
})
