import { describe, expect, test } from 'bun:test'

import { getCandidateDimensions } from './strategy-policy.js'

describe('getCandidateDimensions', () => {
  test('preserves declared sort-key order regardless of type', () => {
    expect(getCandidateDimensions([
      { name: 'event_time', type: 'DateTime', category: 'datetime', boundaryEncoding: 'literal' },
      { name: 'account_id', type: 'String', category: 'string', boundaryEncoding: 'hex-latin1' },
      { name: 'seq', type: 'UInt64', category: 'numeric', boundaryEncoding: 'literal' },
    ])).toEqual([0, 1, 2])
  })
})
