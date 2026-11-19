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
  test('a QueryFinish outranks a newer duplicate-delivery rejection', () => {
    expect(queryLogOutcome([duplicate, row('QueryFinish')])).toEqual({ status: 'finished', writtenRows: 1, writtenBytes: 8, durationMs: 10 })
  })

  test('a duplicate delivery is no failure of the query', () => {
    expect(queryLogOutcome([duplicate])).toEqual({ status: 'unknown' })
    expect(queryLogOutcome([duplicate, row('ExceptionBeforeStart', { exception: 'Code: 60' })])).toMatchObject({ status: 'failed', error: 'Code: 60', beforeStart: true })
  })

  // #767 (Opus re-review): a redelivered request that ran twice logs two
  // terminal entries; a partial ExceptionWhileProcessing beside a QueryFinish
  // says some writes may have been applied twice, so neither decides.
  // #767 (Opus re-review): a fan-out that lists one node twice returns its
  // entry twice; that is one run.
  test('one entry returned twice by a node listed twice is one entry', () => {
    const once = row('QueryFinish', { server: 'uuid-a', event_at: '2026-11-19 00:00:00.000001' })
    expect(queryLogOutcome([once, { ...once }]).status).toBe('finished')
    expect(queryLogOutcome([once, { ...once, server: 'uuid-b' }])).toEqual({ status: 'unknown' })
  })

  test('two terminal entries of one id are unknown', () => {
    expect(queryLogOutcome([row('QueryFinish'), row('ExceptionWhileProcessing', { exception: 'Code: 241' })])).toEqual({ status: 'unknown' })
    expect(queryLogOutcome([row('ExceptionBeforeStart', { exception: 'Code: 60' }), row('QueryFinish')])).toEqual({ status: 'unknown' })
    expect(queryLogOutcome([duplicate, row('QueryFinish', { event_at: '1' }), row('QueryFinish', { event_at: '2' })])).toEqual({ status: 'unknown' })
  })

  test('no entry is unknown', () => {
    expect(queryLogOutcome([])).toEqual({ status: 'unknown' })
  })
})
