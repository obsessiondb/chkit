import { describe, expect, test } from 'bun:test'

import { queryLogOutcome, type QueryLogRow } from './index.js'

const row = (type: string, overrides: Partial<QueryLogRow> = {}): QueryLogRow => ({
  type,
  written_rows: '1',
  written_bytes: '8',
  query_duration_ms: '10',
  exception: '',
  exception_code: '0',
  ...overrides,
})
const duplicate = row('ExceptionBeforeStart', { exception: 'Code: 216. QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING', exception_code: '216' })

// #767 (Opus review): every entry of the id decides its outcome, newest first.
describe('queryLogOutcome', () => {
  test('a QueryFinish outranks a newer ExceptionBeforeStart', () => {
    expect(queryLogOutcome([duplicate, row('QueryFinish')])).toEqual({ status: 'finished', writtenRows: 1, writtenBytes: 8, durationMs: 10 })
    expect(queryLogOutcome([row('ExceptionBeforeStart', { exception: 'Code: 60' }), row('QueryFinish')]).status).toBe('finished')
  })

  test('an ExceptionWhileProcessing outranks an ExceptionBeforeStart', () => {
    expect(queryLogOutcome([row('ExceptionBeforeStart', { exception: 'Code: 60' }), row('ExceptionWhileProcessing', { exception: 'Code: 241' })])).toEqual({
      status: 'failed',
      durationMs: 10,
      error: 'Code: 241',
    })
  })

  test('a duplicate delivery is no failure of the query', () => {
    expect(queryLogOutcome([duplicate])).toEqual({ status: 'unknown' })
    expect(queryLogOutcome([duplicate, row('ExceptionBeforeStart', { exception: 'Code: 60' })])).toMatchObject({ status: 'failed', error: 'Code: 60', beforeStart: true })
  })

  test('no entry is unknown', () => {
    expect(queryLogOutcome([])).toEqual({ status: 'unknown' })
  })
})
