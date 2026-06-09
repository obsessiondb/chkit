import { describe, expect, test } from 'bun:test'

import { computeDrifted } from '../../../commands/drift/payload.js'

const NONE = {
  missingCount: 0,
  kindMismatchCount: 0,
  tableDriftCount: 0,
  extraCount: 0,
  failOnExtraObjects: false,
}

describe('computeDrifted (#5)', () => {
  test('unmanaged extra objects are NOT drift by default', () => {
    expect(computeDrifted({ ...NONE, extraCount: 20 })).toBe(false)
  })

  test('extra objects ARE drift when failOnExtraObjects is opted in', () => {
    expect(computeDrifted({ ...NONE, extraCount: 20, failOnExtraObjects: true })).toBe(true)
  })

  test('missing managed objects always drift', () => {
    expect(computeDrifted({ ...NONE, missingCount: 1 })).toBe(true)
  })

  test('kind mismatches always drift', () => {
    expect(computeDrifted({ ...NONE, kindMismatchCount: 1 })).toBe(true)
  })

  test('table-shape drift on managed tables always drifts', () => {
    expect(computeDrifted({ ...NONE, tableDriftCount: 1 })).toBe(true)
  })

  test('a clean schema with no findings is not drifted', () => {
    expect(computeDrifted(NONE)).toBe(false)
  })
})
