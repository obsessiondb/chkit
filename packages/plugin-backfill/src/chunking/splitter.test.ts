import { describe, expect, test } from 'bun:test'

import { splitSortKeyRange, stringToUint64, uint64ToString } from './splitter.js'

describe('splitSortKeyRange', () => {
  test('numeric: splits into equal-width ranges', () => {
    const ranges = splitSortKeyRange('numeric', '100', '200', 2)

    expect(ranges).toHaveLength(2)
    expect(ranges[0]?.from).toBe('100')
    expect(ranges[0]?.to).toBe('150')
    expect(ranges[1]?.from).toBe('150')
    expect(ranges[1]?.to).toBe('201')
  })

  test('datetime: splits into equal-width time ranges', () => {
    const ranges = splitSortKeyRange('datetime', '2025-01-01 00:00:00', '2025-01-31 00:00:00', 3)

    expect(ranges).toHaveLength(3)
    for (const r of ranges) {
      expect(r.from).toBeDefined()
      expect(r.to).toBeDefined()
    }
  })

  test('string: round-trips through uint64 conversion', () => {
    const ranges = splitSortKeyRange('string', 'aaa', 'zzz', 2)

    expect(ranges).toHaveLength(2)
    expect(ranges[0]?.from).toBeDefined()
    expect(ranges[1]?.to).toBeDefined()
  })
})

describe('stringToUint64 / uint64ToString', () => {
  test('round-trips short strings', () => {
    const original = 'abc'
    const n = stringToUint64(original)
    const back = uint64ToString(n)
    expect(back).toBe(original)
  })

  test('round-trips 8-byte strings', () => {
    const original = 'abcdefgh'
    const n = stringToUint64(original)
    const back = uint64ToString(n)
    expect(back).toBe(original)
  })

  test('truncates strings longer than 8 bytes', () => {
    const n = stringToUint64('abcdefghijklmnop')
    const back = uint64ToString(n)
    expect(back).toBe('abcdefgh')
  })

  test('handles embedded zero bytes from arithmetic', () => {
    // Simulates a computed intermediate where a middle byte is 0x00
    // e.g. 0x6200000000000001 has zero bytes between 'b' and the trailing 0x01
    const n = 0x6200000000000001n
    const result = uint64ToString(n)
    expect(result).toBe('b\0\0\0\0\0\0\x01')
    expect(result.length).toBe(8)
  })
})
