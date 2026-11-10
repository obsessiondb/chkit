import { describe, expect, test } from 'bun:test'

import fixture from '../../../test/fixtures/statement-fingerprint.json'
import { statementFingerprint } from './sql-fingerprint.js'

// test/fixtures/statement-fingerprint.json is shared with chkit-py
// (tests/test_sql_fingerprint.py): both ports must give the same values.
describe('statementFingerprint', () => {
  for (const item of fixture.cases) {
    test(`fixture value: ${item.name}`, () => {
      expect(statementFingerprint(item.sql)).toBe(item.fingerprint)
    })
  }

  for (const group of fixture.same) {
    test(`same fingerprint: ${group.name}`, () => {
      const fingerprints = new Set(group.sql.map(statementFingerprint))
      expect(fingerprints.size).toBe(1)
    })
  }

  for (const group of fixture.different) {
    test(`different fingerprints: ${group.name}`, () => {
      const fingerprints = new Set(group.sql.map(statementFingerprint))
      expect(fingerprints.size).toBe(group.sql.length)
    })
  }
})
