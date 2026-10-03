import { join } from 'node:path'

import { describe, expect, spyOn, test as bunTest } from 'bun:test'

import { runAbandon } from '../../../commands/migrate/command.js'
import type { JournalStore, MigrationRowState, OperationState } from '../../../runtime/journal-store.js'
import { resolveTableScope } from '../../../runtime/table-scope.js'

// These tests spy on the global console.log across an await. Keep them serial
// even when the package test script runs with --concurrent.
const test = bunTest.serial

// --abandon without --apply changes the journal only after an interactive
// confirmation, like a plain migrate.

function op(index: number, status: OperationState['status']): OperationState {
  return {
    operationIndex: index,
    operationKey: `table:db.t${index}`,
    operationType: 'create_table',
    queryId: '',
    status,
    startedAt: '2026-09-29 00:11:10.000',
    finishedAt: '2026-09-29 00:11:11.000',
    lastError: status === 'failed' ? 'Code: 60. Unknown table' : '',
  }
}

const STATE: MigrationRowState = {
  name: 'm.sql',
  appliedAt: '2026-09-29 00:11:11.000',
  checksum: 'c',
  chkitVersion: '0.2.0-test',
  migrationCompleted: false,
  operations: [op(0, 'completed'), op(1, 'failed')],
}

describe('runAbandon', () => {
  test('outside an interactive terminal it previews and asks nothing', async () => {
    const { store, writes } = fakeStore()
    const prompt = fakePrompt({ interactive: false, answer: true })

    const { exit, lines } = await run(() => runAbandon(context(store), 'm.sql', prompt))

    expect(exit).toBe(0)
    expect(prompt.asked).toEqual([])
    expect(writes).toEqual([])
    expect(lines[0]).toContain('Nothing has changed yet.')
    expect(lines).toContain('\nPlan only. Re-run with --apply to abandon the in-progress state.')
  })

  test('in an interactive terminal, declining the confirmation changes nothing', async () => {
    const { store, writes } = fakeStore()
    const prompt = fakePrompt({ interactive: true, answer: false })

    const { exit, lines } = await run(() => runAbandon(context(store), 'm.sql', prompt))

    expect(exit).toBe(0)
    expect(prompt.asked).toEqual(['m.sql'])
    expect(writes).toEqual([])
    expect(lines).toContain('Abandon cancelled by user.')
  })

  test('in an interactive terminal, a confirmation writes one version with every statement failed', async () => {
    const { store, writes } = fakeStore()
    const prompt = fakePrompt({ interactive: true, answer: true })

    const { exit, lines } = await run(() => runAbandon(context(store), 'm.sql', prompt))

    expect(exit).toBe(0)
    expect(prompt.asked).toEqual(['m.sql'])
    expect(writes).toHaveLength(1)
    expect(writes[0]?.operations.map((operation) => operation.status)).toEqual(['failed', 'failed'])
    expect(lines.at(-1)).toBe('Abandoned in-progress migration m.sql.')
  })

  test('with --apply it abandons without asking', async () => {
    const { store, writes } = fakeStore()
    const prompt = fakePrompt({ interactive: true, answer: false })

    const { exit, lines } = await run(() =>
      runAbandon(context(store, { executeRequested: true }), 'm.sql', prompt),
    )

    expect(exit).toBe(0)
    expect(prompt.asked).toEqual([])
    expect(writes).toHaveLength(1)
    expect(lines[0]).toBe('Abandoned in-progress migration m.sql: every recorded statement is now marked failed.')
  })
})

function fakeStore() {
  const writes: MigrationRowState[] = []
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState() {
      return STATE
    },
    async writeMigrationState(next) {
      writes.push(next)
    },
    async appendEntry() {
      throw new Error('abandon must not complete a migration')
    },
  }
  return { store, writes }
}

function fakePrompt(input: { interactive: boolean; answer: boolean }) {
  const asked: string[] = []
  return {
    asked,
    isInteractive: () => input.interactive,
    async confirm(migration: string) {
      asked.push(migration)
      return input.answer
    },
  }
}

function context(journalStore: JournalStore, overrides: { executeRequested?: boolean } = {}) {
  return {
    jsonMode: false,
    executeRequested: overrides.executeRequested ?? false,
    journalStore,
    tableScope: resolveTableScope(undefined, []),
    appliedNames: new Set<string>(),
    files: ['m.sql'],
    metaDir: join(process.cwd(), 'chkit/meta'),
  }
}

async function run(fn: () => Promise<number>): Promise<{ exit: number; lines: string[] }> {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const exit = await fn()
  const lines = log.mock.calls.map((call) => String(call[0]))
  log.mockRestore()
  return { exit, lines }
}
