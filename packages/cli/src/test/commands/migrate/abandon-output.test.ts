import { describe, expect, spyOn, test } from 'bun:test'

import type { AbandonReport } from '../../../commands/migrate/abandon.js'
import { renderAbandonText } from '../../../commands/migrate/output.js'
import type { OperationState } from '../../../runtime/journal-store.js'

function op(index: number, status: OperationState['status'], extra: Partial<OperationState> = {}): OperationState {
  return {
    operationIndex: index,
    operationKey: `table:analytics.t${index}`,
    operationType: 'create_table',
    queryId: '',
    status,
    startedAt: '2026-09-29 00:11:10.000',
    finishedAt: status === 'started' ? null : '2026-09-29 00:11:11.000',
    lastError: '',
    ...extra,
  }
}

const REPORT: AbandonReport = {
  migration: '20260929001110_funnel-model.sql',
  checksum: 'c',
  completedStatements: 1,
  operations: [
    op(0, 'completed', { operationType: 'alter_table_add_column', operationKey: 'table:analytics.events' }),
    op(1, 'failed', { lastError: "Code: 60. Unknown table 'analytics.steps'\nStack trace:\n0. DB::Exception" }),
    op(2, 'started', { operationType: 'load_table_data', queryId: 'q-2' }),
  ],
}

function captureLines(run: () => void): string[] {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  run()
  const lines = log.mock.calls.map((call) => String(call[0]))
  log.mockRestore()
  return lines
}

describe('renderAbandonText', () => {
  test('previews what stays applied, why statements stopped, and the next steps', () => {
    const lines = captureLines(() =>
      renderAbandonText(REPORT, { performed: false, fileExists: true, snapshotFile: 'chkit/meta/snapshot.json' }),
    )

    expect(lines[0]).toBe(
      'Abandoning in-progress migration 20260929001110_funnel-model.sql marks every recorded statement failed. Nothing has changed yet.',
    )
    expect(lines).toContain('1 completed statement(s) remain applied in ClickHouse:')
    expect(lines).toContain('  1. alter_table_add_column table:analytics.events')
    // Only the first line of the ClickHouse error.
    expect(lines).toContain("Statement 2 failed: Code: 60. Unknown table 'analytics.steps'")
    expect(lines).toContain('Statement 3 was interrupted (query_id q-2).')
    expect(lines.some((line) => line.includes("KILL QUERY WHERE query_id = 'q-2'"))).toBe(true)
    expect(lines.some((line) => line.startsWith('Next: edit 20260929001110_funnel-model.sql'))).toBe(true)
    expect(lines.some((line) => line.includes('restore chkit/meta/snapshot.json from git'))).toBe(true)
  })

  // The sync path never runs -- before-retry:, so the advice names mode=async.
  test('says that only an async load runs its -- before-retry: line', () => {
    const lines = captureLines(() =>
      renderAbandonText(REPORT, { performed: true, fileExists: true, snapshotFile: 'chkit/meta/snapshot.json' }),
    )

    const next = lines.find((line) => line.startsWith('Next: edit'))
    expect(next).toContain('so they must be safe to run twice (for example CREATE ... IF NOT EXISTS)')
    expect(next).not.toContain('before-retry')
    // ClickHouse rejects a REMOVE once the column has no such expression.
    expect(next).toContain(
      "A column's MODIFY COLUMN ... REMOVE DEFAULT or REMOVE MATERIALIZED is not safe: it fails once the column has no such expression.",
    )
    expect(lines.find((line) => line.startsWith('Or regenerate it:'))).toContain(
      'The new migration may repeat statements that completed; remove those that cannot run twice, such as a REMOVE DEFAULT or REMOVE MATERIALIZED, before you apply it.',
    )
    expect(lines).toContain(
      'A data load adds its rows again unless it is marked mode=async with a -- before-retry: line that undoes it. That line runs only for an async statement that keeps its position, operation type and key.',
    )
  })

  test('reports statements an earlier abandon marked failed by the status they had before', () => {
    const lines = captureLines(() =>
      renderAbandonText(
        {
          ...REPORT,
          operations: [
            op(0, 'failed', {
              operationType: 'alter_table_add_column',
              operationKey: 'table:analytics.events',
              lastError: 'abandoned via chkit migrate --abandon (was completed)',
            }),
            op(1, 'failed', { lastError: 'abandoned via chkit migrate --abandon (was failed)' }),
            op(2, 'failed', {
              operationType: 'load_table_data',
              queryId: 'q-2',
              lastError: 'abandoned via chkit migrate --abandon (was started)',
            }),
          ],
        },
        { performed: false, fileExists: true, snapshotFile: 'chkit/meta/snapshot.json' },
      ),
    )

    expect(lines).not.toContain('No statement had completed.')
    expect(lines).toContain('1 completed statement(s) remain applied in ClickHouse:')
    expect(lines).toContain('  1. alter_table_add_column table:analytics.events')
    expect(lines).toContain('Statement 2 failed: abandoned via chkit migrate --abandon (was failed)')
    expect(lines).toContain('Statement 3 was interrupted (query_id q-2).')
    expect(lines.some((line) => line.includes("KILL QUERY WHERE query_id = 'q-2'"))).toBe(true)
    expect(lines.some((line) => line.startsWith('Statement 1'))).toBe(false)
  })

  test('reports a performed reset of a migration whose file is gone', () => {
    const lines = captureLines(() =>
      renderAbandonText(
        { ...REPORT, completedStatements: 0, operations: [op(0, 'failed')] },
        { performed: true, fileExists: false, snapshotFile: 'chkit/meta/snapshot.json' },
      ),
    )

    expect(lines[0]).toBe(
      'Abandoned in-progress migration 20260929001110_funnel-model.sql: every recorded statement is now marked failed.',
    )
    expect(lines).toContain('No statement had completed.')
    expect(lines).toContain('Statement 1 failed.')
    expect(lines.at(-1)).toContain('20260929001110_funnel-model.sql is no longer in the migrations directory')
    expect(lines.at(-1)).toContain('The new migration may repeat statements that completed')
  })
})
