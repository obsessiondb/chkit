import { describe, expect, test } from 'bun:test'

import {
  emptyMigrationsError,
  inProgressChecksumMismatchError,
  MigrateError,
} from '../../../commands/migrate/errors.js'
import {
  hasStatementProgress,
  normalizeMigrationName,
  rebaseInProgressState,
  resolveRecoveryTargets,
  retryMismatchError,
  statementIdentities,
  statementIdentity,
  verifyRetryEdit,
  type StatementIdentity,
} from '../../../commands/migrate/recovery.js'
import type { MigrationRowState, OperationState } from '../../../runtime/journal-store.js'
import type { MigrationOperationSummary } from '../../../runtime/safety-markers.js'

function summary(type: string, key: string): MigrationOperationSummary {
  return { type, key, risk: 'safe', mode: 'sync', beforeRetry: null, summary: `${type} key=${key} risk=safe` }
}

function op(
  index: number,
  status: OperationState['status'],
  identity: { type: string; key: string },
  queryId = '',
): OperationState {
  return {
    operationIndex: index,
    operationKey: identity.key,
    operationType: identity.type,
    queryId,
    status,
    startedAt: '2026-09-29 00:11:10.000',
    finishedAt: status === 'started' ? null : '2026-09-29 00:11:11.000',
    lastError: status === 'failed' ? 'Code: 60. Unknown table' : '',
  }
}

const A = { type: 'create_table', key: 'table:db.a' }
const B = { type: 'create_table', key: 'table:db.b' }
const V = { type: 'create_view', key: 'view:db.v' }
const LOAD = { type: 'load_table_data', key: 'table:db.a' }
const MODIFY_F = { type: 'alter_table_modify_column', key: 'table:db.t:column:f' }

function identities(...items: Array<{ type: string; key: string }>): StatementIdentity[] {
  return items.map((item) => ({ ...item, marked: true }))
}

describe('normalizeMigrationName', () => {
  test('accepts a file name, a name without .sql, and a POSIX or Windows path', () => {
    expect(normalizeMigrationName('20260101000000_a.sql', '--retry')).toBe('20260101000000_a.sql')
    expect(normalizeMigrationName('20260101000000_a', '--retry')).toBe('20260101000000_a.sql')
    expect(normalizeMigrationName('chkit/migrations/20260101000000_a.sql', '--retry')).toBe(
      '20260101000000_a.sql',
    )
    expect(normalizeMigrationName('  C:\\p\\migrations\\x.sql  ', '--abandon')).toBe('x.sql')
  })

  test('rejects an empty name with a usage error', () => {
    for (const raw of ['', '  ', 'dir/', '.sql']) {
      expect(() => normalizeMigrationName(raw, '--retry')).toThrow('--retry requires a migration file name')
    }
    expect(() => normalizeMigrationName('', '--abandon')).toThrow(
      expect.objectContaining({ code: 'invalid_usage' }),
    )
  })
})

describe('resolveRecoveryTargets', () => {
  test('returns no targets without the flags', () => {
    expect(resolveRecoveryTargets({})).toEqual({ retryTarget: undefined, abandonTarget: undefined })
  })

  test('normalizes both targets', () => {
    expect(resolveRecoveryTargets({ '--retry': 'm' })).toEqual({ retryTarget: 'm.sql', abandonTarget: undefined })
    expect(resolveRecoveryTargets({ '--abandon': 'x', '--apply': true })).toEqual({
      retryTarget: undefined,
      abandonTarget: 'x.sql',
    })
  })

  test('rejects --abandon with flags that mean nothing for a journal reset', () => {
    expect(() =>
      resolveRecoveryTargets({
        '--abandon': 'x',
        '--retry': 'y',
        '--table': 'app.users',
        '--allow-destructive': true,
      }),
    ).toThrow('--abandon cannot be combined with --retry, --table, --allow-destructive')
    expect(() => resolveRecoveryTargets({ '--abandon': 'x', '--table': 'app.users' })).toThrow(
      expect.objectContaining({ code: 'invalid_usage' }),
    )
  })

  test('ignores a boolean flag that is explicitly false', () => {
    expect(resolveRecoveryTargets({ '--abandon': 'x', '--allow-destructive': false }).abandonTarget).toBe('x.sql')
  })
})

describe('statementIdentity', () => {
  test('uses the operation marker, or the statement position without one', () => {
    const operations = [summary('create_table', 'table:db.a')]
    expect(statementIdentity(operations, 0)).toEqual({ type: 'create_table', key: 'table:db.a', marked: true })
    expect(statementIdentity(operations, 1)).toEqual({ type: 'sql_statement', key: 'statement:1', marked: false })
    expect(statementIdentities(operations, 2)).toHaveLength(2)
  })
})

describe('verifyRetryEdit', () => {
  test('accepts an edit that keeps the completed prefix and reports where to resume', () => {
    const result = verifyRetryEdit(
      [op(0, 'completed', A), op(1, 'completed', B), op(2, 'failed', V)],
      identities(A, B, { type: 'create_view', key: 'view:db.w' }, V),
    )
    expect(result).toEqual({ ok: true, completed: 2, unmarkedCompleted: 0, resumeIndex: 2 })
  })

  test('rejects a completed statement whose marker changed', () => {
    const result = verifyRetryEdit([op(0, 'completed', A), op(1, 'failed', V)], identities(B, V))
    expect(result).toEqual({
      ok: false,
      mismatches: [{ statement: 1, status: 'completed', queryId: '', recorded: A, current: B }],
      sharedMarkers: [],
    })
  })

  test('rejects a completed statement that the edited file no longer has', () => {
    const result = verifyRetryEdit([op(3, 'completed', A)], identities(A, B, V))
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.mismatches).toEqual([
      { statement: 4, status: 'completed', queryId: '', recorded: A, current: null },
    ])
  })

  test('matches unmarked statements by position and counts them', () => {
    const unmarked = statementIdentities([], 3)
    const result = verifyRetryEdit(
      [
        op(0, 'completed', { type: 'sql_statement', key: 'statement:0' }),
        op(1, 'completed', { type: 'sql_statement', key: 'statement:1' }),
      ],
      unmarked,
    )
    expect(result).toEqual({ ok: true, completed: 2, unmarkedCompleted: 2, resumeIndex: 2 })
  })

  test('resumes at statement 1 when nothing completed, and returns null when everything did', () => {
    expect(verifyRetryEdit([op(0, 'failed', A)], identities(B))).toEqual({
      ok: true,
      completed: 0,
      unmarkedCompleted: 0,
      resumeIndex: 0,
    })
    expect(verifyRetryEdit([op(0, 'completed', A), op(1, 'completed', B)], identities(A, B))).toEqual({
      ok: true,
      completed: 2,
      unmarkedCompleted: 0,
      resumeIndex: null,
    })
  })

  test('ignores failed statements and started statements without a query id', () => {
    const result = verifyRetryEdit(
      [op(0, 'completed', A), op(1, 'failed', V), op(2, 'started', B)],
      identities(A, B, V),
    )
    expect(result).toEqual({ ok: true, completed: 1, unmarkedCompleted: 0, resumeIndex: 1 })
  })

  test('rejects an async statement that may still be running when its position changed', () => {
    const result = verifyRetryEdit([op(0, 'completed', A), op(1, 'started', LOAD, 'q-1')], identities(A, V))
    expect(result).toEqual({
      ok: false,
      mismatches: [{ statement: 2, status: 'started', queryId: 'q-1', recorded: LOAD, current: V }],
      sharedMarkers: [],
    })
    expect(verifyRetryEdit([op(1, 'started', LOAD, 'q-1')], identities(A, LOAD))).toEqual({
      ok: true,
      completed: 0,
      unmarkedCompleted: 0,
      resumeIndex: 0,
    })
  })

  // A column's REMOVE DEFAULT or REMOVE MATERIALIZED carries the marker of the
  // MODIFY COLUMN after it, so the position check alone cannot tell them apart.
  describe('statements that share a marker', () => {
    const REMOVE_THEN_MODIFY = [op(0, 'completed', MODIFY_F), op(1, 'failed', MODIFY_F)]
    const SHARED = {
      ...MODIFY_F,
      recorded: [
        { statement: 1, status: 'completed' },
        { statement: 2, status: 'failed' },
      ],
      currentCount: 1,
    }

    test('rejects deleting the completed REMOVE, which would slide its MODIFY COLUMN into the completed slot', () => {
      expect(verifyRetryEdit(REMOVE_THEN_MODIFY, identities(MODIFY_F))).toEqual({
        ok: false,
        mismatches: [],
        sharedMarkers: [SHARED],
      })
      // Statements that never ran do not change that.
      expect(verifyRetryEdit(REMOVE_THEN_MODIFY, identities(MODIFY_F, V))).toEqual({
        ok: false,
        mismatches: [],
        sharedMarkers: [SHARED],
      })
    })

    test('rejects deleting the failed MODIFY COLUMN too, since the two cannot be told apart', () => {
      const result = verifyRetryEdit(REMOVE_THEN_MODIFY, identities(MODIFY_F, A))
      expect(result).toEqual({ ok: false, mismatches: [], sharedMarkers: [SHARED] })
    })

    test('accepts an edit that keeps both statements, and inserted statements before the failed one', () => {
      expect(verifyRetryEdit(REMOVE_THEN_MODIFY, identities(MODIFY_F, MODIFY_F))).toEqual({
        ok: true,
        completed: 1,
        unmarkedCompleted: 0,
        resumeIndex: 1,
      })
      expect(verifyRetryEdit(REMOVE_THEN_MODIFY, identities(MODIFY_F, A, MODIFY_F))).toEqual({
        ok: true,
        completed: 1,
        unmarkedCompleted: 0,
        resumeIndex: 1,
      })
    })

    test('reports a marker once, as a moved statement, when a completed one lost its position', () => {
      const result = verifyRetryEdit(
        [op(0, 'completed', MODIFY_F), op(1, 'completed', MODIFY_F), op(2, 'failed', V)],
        identities(MODIFY_F, V),
      )
      expect(result).toEqual({
        ok: false,
        mismatches: [{ statement: 2, status: 'completed', queryId: '', recorded: MODIFY_F, current: V }],
        sharedMarkers: [],
      })
    })

    test('does not apply once an abandon marked every statement failed', () => {
      expect(
        verifyRetryEdit([op(0, 'failed', MODIFY_F), op(1, 'failed', MODIFY_F)], identities(MODIFY_F)),
      ).toEqual({ ok: true, completed: 0, unmarkedCompleted: 0, resumeIndex: 0 })
    })
  })
})

describe('retryMismatchError', () => {
  test('names each mismatch and the abandon command, with a KILL QUERY hint for a running query', () => {
    const error = retryMismatchError('m.sql', {
      mismatches: [
        { statement: 1, status: 'completed', queryId: '', recorded: A, current: B },
        { statement: 2, status: 'started', queryId: 'q-1', recorded: LOAD, current: null },
      ],
      sharedMarkers: [],
    })
    expect(error).toBeInstanceOf(MigrateError)
    expect(error.code).toBe('retry_mismatch')
    expect(error.message).toContain(
      'statement 1: completed as create_table table:db.a, but the edited file has create_table table:db.b there',
    )
    expect(error.message).toContain('statement 2: started as load_table_data table:db.a (async query_id q-1)')
    expect(error.message).toContain('the edited file has no statement 2')
    expect(error.message).toContain("KILL QUERY WHERE query_id = 'q-1'")
    expect(error.message).toContain('chkit migrate --apply --abandon m.sql')
    expect(error.message).not.toContain('share a marker')
  })

  test('names the statements that share a marker and says to keep each of them', () => {
    const error = retryMismatchError('m.sql', {
      mismatches: [],
      sharedMarkers: [
        {
          ...MODIFY_F,
          recorded: [
            { statement: 1, status: 'completed' },
            { statement: 2, status: 'completed' },
            { statement: 3, status: 'failed' },
          ],
          currentCount: 2,
        },
      ],
    })
    expect(error.code).toBe('retry_mismatch')
    expect(error.message).toContain(
      '  statements 1 (completed), 2 (completed) and 3 (failed) share alter_table_modify_column table:db.t:column:f, but the edited file has 2 statements with that marker',
    )
    expect(error.message).toContain(
      "Statements that share a marker, such as a column's REMOVE DEFAULT and the MODIFY COLUMN after it, are told apart only by position, so chkit cannot tell which one the edit removed. Keep each of them and edit only the one that failed.",
    )
    expect(error.message).toContain('chkit migrate --apply --abandon m.sql')
  })
})

describe('rebaseInProgressState', () => {
  test('keeps completed statements and unchanged failed or started ones, under the new checksum', () => {
    const state: MigrationRowState = {
      name: 'm.sql',
      appliedAt: '2026-09-29 00:11:11.000',
      checksum: 'old',
      chkitVersion: '0.2.0-test',
      migrationCompleted: false,
      operations: [op(0, 'completed', A), op(1, 'failed', B), op(2, 'started', LOAD, 'q-2'), op(5, 'failed', V)],
    }
    const rebased = rebaseInProgressState(state, {
      checksum: 'new',
      identities: identities(A, B, V),
      appliedAt: '2026-09-29T01:00:00.000',
    })
    expect(rebased).toEqual({
      ...state,
      checksum: 'new',
      appliedAt: '2026-09-29T01:00:00.000',
      operations: [op(0, 'completed', A), op(1, 'failed', B)],
    })
  })
})

describe('hasStatementProgress', () => {
  test('is true only when a statement completed or started', () => {
    const state = (operations: OperationState[]): MigrationRowState => ({
      name: 'm.sql',
      appliedAt: '',
      checksum: 'c',
      chkitVersion: '',
      migrationCompleted: false,
      operations,
    })
    expect(hasStatementProgress(state([]))).toBe(false)
    expect(hasStatementProgress(state([op(0, 'failed', A)]))).toBe(false)
    expect(hasStatementProgress(state([op(0, 'completed', A)]))).toBe(true)
    expect(hasStatementProgress(state([op(0, 'started', A)]))).toBe(true)
  })
})

describe('migrate recovery errors', () => {
  test('the in-progress checksum refusal names --retry and --abandon', () => {
    const error = inProgressChecksumMismatchError({
      migration: 'm.sql',
      journalChecksum: 'a',
      fileChecksum: 'b',
      async: false,
    })
    expect(error.code).toBe('in_progress_checksum_mismatch')
    expect(error.message).toContain('in-progress journal state for checksum a')
    expect(error.message).toContain('the current file checksum is b')
    expect(error.message).toContain('chkit migrate --apply --retry m.sql')
    expect(error.message).toContain('chkit migrate --apply --abandon m.sql')
    const asyncError = inProgressChecksumMismatchError({
      migration: 'm.sql',
      journalChecksum: 'a',
      fileChecksum: 'b',
      async: true,
    })
    expect(asyncError.message).toContain('in-progress async journal state')
  })

  test('the empty-migration refusal lists every file', () => {
    const error = emptyMigrationsError(['a.sql', 'b.sql'])
    expect(error.message).toContain('contain no executable statements')
    expect(error.message).toContain('  - a.sql\n  - b.sql')
  })
})
