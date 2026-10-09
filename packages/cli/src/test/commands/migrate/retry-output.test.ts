import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, spyOn, test as bunTest } from 'bun:test'

import {
  emitApplySummaryJson,
  emitNoPending,
  emitNoScopeMatch,
  renderPlanText,
} from '../../../commands/migrate/output.js'
import type { RetryNoop, RetryResolution, RetryResume } from '../../../commands/migrate/retry.js'
import { resolveTableScope } from '../../../runtime/table-scope.js'

// These tests spy on the global console.log across an await. Keep them serial
// even when the package test script runs with --concurrent.
const test = bunTest.serial

const RESUME: RetryResume = {
  action: 'resume',
  migration: 'm.sql',
  previousChecksum: 'old',
  checksum: 'new',
  totalStatements: 3,
  completedStatements: 1,
  resumeAtStatement: 2,
  unmarkedCompletedStatements: 0,
}

const SCOPE = resolveTableScope(undefined, [])
const NO_MATCH_SCOPE = resolveTableScope('db.nomatch', [])
const APPLIED = [{ name: 'm.sql', appliedAt: '2026-09-30T12:00:00.000', checksum: 'new' }]
const ALREADY_APPLIED: RetryNoop = { action: 'none', migration: 'm.sql', reason: 'already_applied' }

describe('emitApplySummaryJson', () => {
  test('the execute payload carries the --retry resolution', () => {
    const lines = captureLines(() =>
      emitApplySummaryJson({ scope: SCOPE, applied: APPLIED, undeterminedScope: [], retry: RESUME }),
    )

    expect(JSON.parse(lines.join('\n'))).toEqual({
      command: 'migrate',
      schemaVersion: 1,
      mode: 'execute',
      scope: SCOPE,
      applied: APPLIED,
      retry: RESUME,
    })
  })

  test('has no retry key without --retry', () => {
    const lines = captureLines(() =>
      emitApplySummaryJson({ scope: SCOPE, applied: APPLIED, undeterminedScope: [], retry: undefined }),
    )

    expect(Object.keys(JSON.parse(lines.join('\n')))).not.toContain('retry')
  })
})

describe('renderPlanText with --retry', () => {
  test('prints where the edited migration resumes', async () => {
    const lines = await planLines(RESUME)

    expect(lines).toContain(
      'Retry m.sql: the file changed after a failed apply. 1 completed statement(s) will be skipped; resuming at statement 2 of 3.',
    )
    expect(lines.some((line) => line.includes('matched by position only'))).toBe(false)
  })

  test('warns about completed statements matched by position only', async () => {
    const lines = await planLines({ ...RESUME, unmarkedCompletedStatements: 1 })

    expect(lines).toContain(
      '⚠ 1 completed statement(s) have no "-- operation:" marker and were matched by position only. ' +
        'Do not add, remove, or reorder statements above the first statement that did not complete.',
    )
  })

  test('says when every statement already completed', async () => {
    const lines = await planLines({ ...RESUME, completedStatements: 3, resumeAtStatement: null })

    expect(lines).toContain(
      'Retry m.sql: the file changed after a failed apply. All 3 statements already completed; the migration will be recorded as applied.',
    )
  })

  test('says why --retry has no effect', async () => {
    expect(await planLines({ action: 'none', migration: 'm.sql', reason: 'checksum_unchanged' })).toContain(
      'Retry m.sql: unchanged since it failed; it resumes without --retry.',
    )
    expect(await planLines({ action: 'none', migration: 'm.sql', reason: 'not_in_scope' })).toContain(
      'Retry m.sql: outside the --table scope; --retry has no effect.',
    )
    expect(await planLines({ action: 'none', migration: 'm.sql', reason: 'empty_migration' })).toContain(
      'Retry m.sql: no executable statements; --retry has no effect.',
    )
  })
})

// With nothing to apply, the run still says what --retry did, so the same
// command can run against every environment.
describe('--retry when nothing is pending', () => {
  test('the no-pending payload and text carry the --retry resolution', () => {
    const json = captureLines(() =>
      emitNoPending({ jsonMode: true, mode: 'execute', scope: SCOPE, retry: ALREADY_APPLIED }),
    )
    expect(JSON.parse(json.join('\n'))).toEqual({
      command: 'migrate',
      schemaVersion: 1,
      mode: 'execute',
      scope: SCOPE,
      pending: [],
      applied: [],
      retry: ALREADY_APPLIED,
    })

    const text = captureLines(() => emitNoPending({ jsonMode: false, mode: 'plan', scope: SCOPE, retry: ALREADY_APPLIED }))
    expect(text).toEqual(['No pending migrations.', 'Retry m.sql: already applied; --retry has no effect.'])
  })

  test('the no-scope-match payload and text carry the --retry resolution', () => {
    const notInScope: RetryNoop = { action: 'none', migration: 'm.sql', reason: 'not_in_scope' }
    const json = captureLines(() =>
      emitNoScopeMatch({ jsonMode: true, mode: 'plan', scope: NO_MATCH_SCOPE, retry: notInScope }),
    )
    expect(JSON.parse(json.join('\n'))).toMatchObject({
      pending: [],
      applied: [],
      warning: 'No tables matched selector "db.nomatch".',
      retry: notInScope,
    })

    const text = captureLines(() =>
      emitNoScopeMatch({ jsonMode: false, mode: 'plan', scope: NO_MATCH_SCOPE, retry: notInScope }),
    )
    expect(text).toEqual([
      'No tables matched selector "db.nomatch". No migrations selected.',
      'Retry m.sql: outside the --table scope; --retry has no effect.',
    ])
  })

  test('has no retry key or line without --retry', () => {
    const json = captureLines(() => emitNoPending({ jsonMode: true, mode: 'plan', scope: SCOPE, retry: undefined }))
    expect(Object.keys(JSON.parse(json.join('\n')))).not.toContain('retry')
    expect(captureLines(() => emitNoPending({ jsonMode: false, mode: 'plan', scope: SCOPE, retry: undefined }))).toEqual([
      'No pending migrations.',
    ])
  })
})

function captureLines(run: () => void): string[] {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  run()
  const lines = log.mock.calls.map((call) => String(call[0]))
  log.mockRestore()
  return lines
}

async function planLines(retry: RetryResolution): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'chkit-retry-output-'))
  writeFileSync(join(dir, 'm.sql'), 'ALTER TABLE t ADD COLUMN a UInt64;\n')
  const log = spyOn(console, 'log').mockImplementation(() => {})
  await renderPlanText({
    migrationsDir: dir,
    scope: SCOPE,
    undeterminedScope: [],
    pending: ['m.sql'],
    emptyMigrations: [],
    retry,
  })
  const lines = log.mock.calls.map((call) => String(call[0]))
  log.mockRestore()
  rmSync(dir, { recursive: true, force: true })
  return lines
}
