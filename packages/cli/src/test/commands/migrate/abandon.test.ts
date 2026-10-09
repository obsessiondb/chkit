import { describe, expect, test } from 'bun:test'

import {
  abandonMigrationState,
  abandonReport,
  readAbandonableState,
  statusBeforeAbandon,
} from '../../../commands/migrate/abandon.js'
import type { JournalStore, MigrationRowState, OperationState } from '../../../runtime/journal-store.js'

function op(
  index: number,
  status: OperationState['status'],
  extra: Partial<OperationState> = {},
): OperationState {
  return {
    operationIndex: index,
    operationKey: `table:db.t${index}`,
    operationType: 'create_table',
    queryId: '',
    status,
    startedAt: '2026-09-29 00:11:10.000',
    finishedAt: status === 'started' ? null : '2026-09-29 00:11:11.000',
    lastError: status === 'failed' ? 'Code: 60. Unknown table' : '',
    ...extra,
  }
}

function inProgress(operations: OperationState[], extra: Partial<MigrationRowState> = {}): MigrationRowState {
  return {
    name: 'm.sql',
    appliedAt: '2026-09-29 00:11:11.000',
    checksum: 'c',
    chkitVersion: '0.2.0-test',
    migrationCompleted: false,
    operations,
    ...extra,
  }
}

function fakeStore(state: MigrationRowState | null) {
  const reads: string[] = []
  const writes: MigrationRowState[] = []
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState(name) {
      reads.push(name)
      return state
    },
    async writeMigrationState(next) {
      writes.push(next)
    },
    async appendEntry() {
      throw new Error('abandon must not complete a migration')
    },
  }
  return { store, reads, writes }
}

describe('readAbandonableState', () => {
  test('refuses an applied migration without reading the journal state', async () => {
    const { store, reads } = fakeStore(null)
    await expect(
      readAbandonableState({ migration: 'm.sql', appliedNames: new Set(['m.sql']) }, { journalStore: store }),
    ).rejects.toMatchObject({ code: 'migration_already_applied' })
    expect(reads).toEqual([])
  })

  test('refuses a migration without in-progress state', async () => {
    const { store } = fakeStore(null)
    await expect(
      readAbandonableState({ migration: 'm.sql', appliedNames: new Set() }, { journalStore: store }),
    ).rejects.toMatchObject({
      code: 'migration_not_in_progress',
      message: 'Cannot abandon m.sql: the journal has no in-progress state for it.',
    })
  })

  test('refuses a completed state', async () => {
    const { store } = fakeStore(inProgress([op(0, 'completed')], { migrationCompleted: true }))
    await expect(
      readAbandonableState({ migration: 'm.sql', appliedNames: new Set() }, { journalStore: store }),
    ).rejects.toMatchObject({ code: 'migration_already_applied' })
  })

  test('returns the in-progress state', async () => {
    const state = inProgress([op(0, 'completed'), op(1, 'failed')])
    const { store, writes } = fakeStore(state)
    expect(
      await readAbandonableState({ migration: 'm.sql', appliedNames: new Set() }, { journalStore: store }),
    ).toEqual(state)
    expect(writes).toEqual([])
  })
})

describe('abandonMigrationState', () => {
  test('writes a newer version with every recorded statement failed, keeping checksum and query ids', async () => {
    const state = inProgress([
      op(0, 'completed', { operationType: 'load_table_data', queryId: 'q-0' }),
      op(1, 'failed'),
      op(2, 'started', { queryId: 'q-2' }),
    ])
    const { store, writes } = fakeStore(state)

    await abandonMigrationState(state, { journalStore: store, now: () => Date.UTC(2026, 8, 30, 12, 0, 0) })

    expect(writes).toEqual([
      {
        ...state,
        appliedAt: '2026-09-30T12:00:00.000',
        migrationCompleted: false,
        operations: [
          {
            ...op(0, 'completed', { operationType: 'load_table_data', queryId: 'q-0' }),
            status: 'failed',
            lastError: 'abandoned via chkit migrate --abandon (was completed)',
          },
          { ...op(1, 'failed'), lastError: 'abandoned via chkit migrate --abandon (was failed)' },
          {
            ...op(2, 'started', { queryId: 'q-2' }),
            status: 'failed',
            finishedAt: '2026-09-30T12:00:00.000',
            lastError: 'abandoned via chkit migrate --abandon (was started)',
          },
        ],
      },
    ])
  })

  test('abandoning again keeps the record of the statements an earlier abandon marked failed', async () => {
    const earlier = [
      op(0, 'failed', { lastError: 'abandoned via chkit migrate --abandon (was completed)' }),
      op(1, 'failed', { lastError: 'abandoned via chkit migrate --abandon (was started)', queryId: 'q-1' }),
    ]
    // Statement 3 completed and statement 4 failed in a run after that abandon.
    const state = inProgress([...earlier, op(2, 'completed'), op(3, 'failed')])
    const { store, writes } = fakeStore(state)

    await abandonMigrationState(state, { journalStore: store, now: () => Date.UTC(2026, 8, 30, 12, 0, 0) })

    expect(writes[0]?.operations).toEqual([
      ...earlier,
      { ...op(2, 'completed'), status: 'failed', lastError: 'abandoned via chkit migrate --abandon (was completed)' },
      { ...op(3, 'failed'), lastError: 'abandoned via chkit migrate --abandon (was failed)' },
    ])
  })
})

describe('abandonReport', () => {
  test('sorts the recorded statements and counts the completed ones', () => {
    const report = abandonReport(inProgress([op(1, 'failed'), op(0, 'completed')]))
    expect(report).toEqual({
      migration: 'm.sql',
      checksum: 'c',
      completedStatements: 1,
      operations: [op(0, 'completed'), op(1, 'failed')],
    })
  })

  test('counts statements that completed before an earlier abandon: they stay applied', () => {
    const report = abandonReport(
      inProgress([
        op(0, 'failed', { lastError: 'abandoned via chkit migrate --abandon (was completed)' }),
        op(1, 'failed', { lastError: 'abandoned via chkit migrate --abandon (was failed)' }),
      ]),
    )
    expect(report.completedStatements).toBe(1)
  })
})

describe('statusBeforeAbandon', () => {
  test('returns the status a statement had before --abandon marked it failed', () => {
    expect(
      statusBeforeAbandon(op(0, 'failed', { lastError: 'abandoned via chkit migrate --abandon (was completed)' })),
    ).toBe('completed')
    expect(
      statusBeforeAbandon(op(0, 'failed', { lastError: 'abandoned via chkit migrate --abandon (was started)' })),
    ).toBe('started')
  })

  test('returns the recorded status of a statement no abandon touched', () => {
    expect(statusBeforeAbandon(op(0, 'failed'))).toBe('failed')
    expect(statusBeforeAbandon(op(0, 'completed'))).toBe('completed')
    expect(
      statusBeforeAbandon(op(0, 'failed', { lastError: 'Code: 62. abandoned via chkit migrate --abandon (was completed)' })),
    ).toBe('failed')
  })
})
