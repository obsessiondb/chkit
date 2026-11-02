import { describe, expect, spyOn, test } from 'bun:test'

import { type CheckInputs, renderCheckText } from '../../../commands/check/output.js'

const INPUTS: CheckInputs = {
  strict: false,
  policy: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
  pending: [],
  checksumMismatches: [],
  drift: null,
  pluginResults: [],
  tableScope: { enabled: false, matchedTables: [], matchCount: 0 },
  databaseMissing: true,
  database: undefined,
}

describe('renderCheckText', () => {
  test('a missing database without a configured name prints an empty name, as status does (#452)', () => {
    const spy = spyOn(console, 'log').mockImplementation(() => {})
    renderCheckText(INPUTS, { ok: true, failedChecks: [] })
    const lines = spy.mock.calls.map((call) => call[0])
    spy.mockRestore()

    expect(lines[0]).toBe('⚠ Database "" does not exist on the target server.')
  })
})
