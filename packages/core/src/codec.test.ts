import { describe, expect, test } from 'bun:test'

import {
  canonicalizeCodec,
  codec,
  codecsEqual,
  parseCodec,
  renderCodec,
} from './codec.js'

describe('renderCodec', () => {
  test('renders single general codec without level', () => {
    expect(renderCodec({ kind: 'LZ4' })).toBe('CODEC(LZ4)')
  })

  test('renders ZSTD with explicit level', () => {
    expect(renderCodec({ kind: 'ZSTD', level: 3 })).toBe('CODEC(ZSTD(3))')
  })

  test('renders ZSTD without level (bare name)', () => {
    expect(renderCodec({ kind: 'ZSTD' })).toBe('CODEC(ZSTD)')
  })

  test('renders LZ4HC with level', () => {
    expect(renderCodec({ kind: 'LZ4HC', level: 9 })).toBe('CODEC(LZ4HC(9))')
  })

  test('renders chain [Delta, ZSTD]', () => {
    expect(renderCodec([{ kind: 'Delta', size: 4 }, { kind: 'ZSTD', level: 3 }])).toBe(
      'CODEC(Delta(4), ZSTD(3))'
    )
  })

  test('renders FPC with both args', () => {
    expect(renderCodec({ kind: 'FPC', level: 10, floatSize: 4 })).toBe('CODEC(FPC(10, 4))')
  })

  test('renders NONE / T64 / GCD / ALP bare', () => {
    expect(renderCodec({ kind: 'NONE' })).toBe('CODEC(NONE)')
    expect(renderCodec({ kind: 'T64' })).toBe('CODEC(T64)')
    expect(renderCodec({ kind: 'GCD' })).toBe('CODEC(GCD)')
    expect(renderCodec({ kind: 'ALP' })).toBe('CODEC(ALP)')
  })

  test('renders raw verbatim', () => {
    expect(renderCodec(codec.raw('SomeNewCodec(42)'))).toBe('CODEC(SomeNewCodec(42))')
  })

  test('renders raw embedded in chain', () => {
    expect(
      renderCodec([{ kind: 'Delta', size: 4 }, codec.raw('SomeNewCodec(42)')])
    ).toBe('CODEC(Delta(4), SomeNewCodec(42))')
  })
})

describe('parseCodec', () => {
  test('parses empty / undefined / null to undefined', () => {
    expect(parseCodec('')).toBeUndefined()
    expect(parseCodec(undefined)).toBeUndefined()
    expect(parseCodec(null)).toBeUndefined()
  })

  test('parses bare ZSTD', () => {
    expect(parseCodec('CODEC(ZSTD)')).toEqual([{ kind: 'ZSTD' }])
  })

  test('parses ZSTD with level', () => {
    expect(parseCodec('CODEC(ZSTD(3))')).toEqual([{ kind: 'ZSTD', level: 3 }])
  })

  test('parses LZ4HC with level', () => {
    expect(parseCodec('CODEC(LZ4HC(9))')).toEqual([{ kind: 'LZ4HC', level: 9 }])
  })

  test('parses Delta, ZSTD chain', () => {
    expect(parseCodec('CODEC(Delta(4), ZSTD(1))')).toEqual([
      { kind: 'Delta', size: 4 },
      { kind: 'ZSTD', level: 1 },
    ])
  })

  test('parses FPC with both args', () => {
    expect(parseCodec('CODEC(FPC(10, 4))')).toEqual([
      { kind: 'FPC', level: 10, floatSize: 4 },
    ])
  })

  test('parses general codecs NONE/T64/GCD/ALP bare', () => {
    expect(parseCodec('CODEC(NONE)')).toEqual([{ kind: 'NONE' }])
    expect(parseCodec('CODEC(T64)')).toEqual([{ kind: 'T64' }])
    expect(parseCodec('CODEC(GCD)')).toEqual([{ kind: 'GCD' }])
    expect(parseCodec('CODEC(ALP)')).toEqual([{ kind: 'ALP' }])
  })

  test('falls back to raw for unknown codec tokens', () => {
    expect(parseCodec('CODEC(SomeNewCodec(42))')).toEqual([
      { kind: 'raw', expression: 'SomeNewCodec(42)' },
    ])
  })

  test('raw fallback round-trips through renderCodec', () => {
    const parsed = parseCodec('CODEC(SomeNewCodec(42))')
    expect(parsed).toBeDefined()
    expect(renderCodec(parsed!)).toBe('CODEC(SomeNewCodec(42))')
  })

  test('falls back to raw when known codec has unexpected extra args', () => {
    expect(parseCodec('CODEC(ZSTD(3, 1))')).toEqual([
      { kind: 'raw', expression: 'ZSTD(3, 1)' },
    ])
    expect(parseCodec('CODEC(LZ4HC(9, 1))')).toEqual([
      { kind: 'raw', expression: 'LZ4HC(9, 1)' },
    ])
    expect(parseCodec('CODEC(Delta(4, 2))')).toEqual([
      { kind: 'raw', expression: 'Delta(4, 2)' },
    ])
    expect(parseCodec('CODEC(LZ4(1))')).toEqual([
      { kind: 'raw', expression: 'LZ4(1)' },
    ])
  })
})

describe('canonicalizeCodec', () => {
  test('fills in ZSTD default level', () => {
    expect(canonicalizeCodec({ kind: 'ZSTD' })).toEqual([{ kind: 'ZSTD', level: 1 }])
  })

  test('fills in LZ4HC default level', () => {
    expect(canonicalizeCodec({ kind: 'LZ4HC' })).toEqual([{ kind: 'LZ4HC', level: 9 }])
  })

  test('fills in Delta/DoubleDelta/Gorilla default size', () => {
    expect(canonicalizeCodec({ kind: 'Delta' })).toEqual([{ kind: 'Delta', size: 1 }])
    expect(canonicalizeCodec({ kind: 'DoubleDelta' })).toEqual([
      { kind: 'DoubleDelta', size: 1 },
    ])
    expect(canonicalizeCodec({ kind: 'Gorilla' })).toEqual([{ kind: 'Gorilla', size: 1 }])
  })

  test('trims raw expression whitespace', () => {
    expect(canonicalizeCodec(codec.raw('  SomeNewCodec(42)  '))).toEqual([
      { kind: 'raw', expression: 'SomeNewCodec(42)' },
    ])
  })

  test('normalizes single-step to array form', () => {
    expect(canonicalizeCodec({ kind: 'LZ4' })).toEqual([{ kind: 'LZ4' }])
  })

  test('preserves chain order', () => {
    expect(
      canonicalizeCodec([{ kind: 'Delta', size: 4 }, { kind: 'ZSTD', level: 3 }])
    ).toEqual([
      { kind: 'Delta', size: 4 },
      { kind: 'ZSTD', level: 3 },
    ])
  })
})

describe('codecsEqual', () => {
  test('both undefined → equal', () => {
    expect(codecsEqual(undefined, undefined)).toBe(true)
  })

  test('one undefined → not equal', () => {
    expect(codecsEqual(undefined, { kind: 'LZ4' })).toBe(false)
    expect(codecsEqual({ kind: 'LZ4' }, undefined)).toBe(false)
  })

  test('ZSTD vs ZSTD(1) compare equal after canonicalization', () => {
    expect(codecsEqual({ kind: 'ZSTD' }, { kind: 'ZSTD', level: 1 })).toBe(true)
  })

  test('ZSTD vs ZSTD(3) not equal', () => {
    expect(codecsEqual({ kind: 'ZSTD' }, { kind: 'ZSTD', level: 3 })).toBe(false)
  })

  test('single-step vs array form with same content are equal', () => {
    expect(codecsEqual({ kind: 'LZ4' }, [{ kind: 'LZ4' }])).toBe(true)
  })

  test('chain order matters', () => {
    expect(
      codecsEqual(
        [{ kind: 'Delta', size: 4 }, { kind: 'ZSTD' }],
        [{ kind: 'ZSTD' }, { kind: 'Delta', size: 4 }]
      )
    ).toBe(false)
  })
})
