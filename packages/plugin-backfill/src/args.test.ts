import { describe, expect, test } from 'bun:test'

import { parseByteSize, parsePlanArgs } from './args.js'

describe('parseByteSize', () => {
  test('parses gigabytes', () => {
    expect(parseByteSize('10G')).toBe(10 * 1024 ** 3)
  })

  test('parses megabytes', () => {
    expect(parseByteSize('500M')).toBe(500 * 1024 ** 2)
  })

  test('parses terabytes', () => {
    expect(parseByteSize('1T')).toBe(1024 ** 4)
  })

  test('parses kilobytes', () => {
    expect(parseByteSize('256K')).toBe(256 * 1024)
  })

  test('parses plain number as bytes', () => {
    expect(parseByteSize('1048576')).toBe(1048576)
  })

  test('parses decimal values', () => {
    expect(parseByteSize('1.5G')).toBe(1.5 * 1024 ** 3)
  })

  test('is case-insensitive', () => {
    expect(parseByteSize('10g')).toBe(10 * 1024 ** 3)
    expect(parseByteSize('500m')).toBe(500 * 1024 ** 2)
  })

  test('trims whitespace', () => {
    expect(parseByteSize('  10G  ')).toBe(10 * 1024 ** 3)
  })

  test('throws on invalid input', () => {
    expect(() => parseByteSize('abc')).toThrow('Invalid byte size')
    expect(() => parseByteSize('')).toThrow('Invalid byte size')
    expect(() => parseByteSize('10X')).toThrow('Invalid byte size')
  })
})

describe('parsePlanArgs', () => {
  test('parses without --from and --to', () => {
    const result = parsePlanArgs({
      '--target': 'default.events',
    })
    expect(result.target).toBe('default.events')
    expect(result.from).toBeUndefined()
    expect(result.to).toBeUndefined()
  })

  test('parses --max-chunk-bytes', () => {
    const result = parsePlanArgs({
      '--target': 'default.events',
      '--max-chunk-bytes': '20G',
    })
    expect(result.maxChunkBytes).toBe(20 * 1024 ** 3)
  })

  test('parses with --from and --to', () => {
    const result = parsePlanArgs({
      '--target': 'default.events',
      '--from': '2025-01-01',
      '--to': '2025-02-01',
    })
    expect(result.from).toBeDefined()
    expect(result.to).toBeDefined()
  })

  test('throws on missing --target', () => {
    expect(() => parsePlanArgs({})).toThrow('Missing required --target')
  })

})
