import { describe, expect, test } from 'bun:test'

import {
  canonicalizeCodec,
  codec,
  codecFingerprint,
  codecsEqual,
  isGeneralCodec,
  isPreprocessorCodec,
  parseCodec,
  renderCodec,
} from './codec.js'
import type { ColumnCodecSpec } from './model-types.js'

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

  test('renders GCD as a preprocessor before the general codec (#408)', () => {
    expect(isPreprocessorCodec({ kind: 'GCD' })).toBe(true)
    expect(isGeneralCodec({ kind: 'GCD' })).toBe(false)
    expect(renderCodec([{ kind: 'GCD' }, { kind: 'LZ4' }])).toBe('CODEC(GCD, LZ4)')
  })

  test('renders T64 as a preprocessor before the general codec (#434)', () => {
    expect(isPreprocessorCodec({ kind: 'T64' })).toBe(true)
    expect(isGeneralCodec({ kind: 'T64' })).toBe(false)
    expect(renderCodec([{ kind: 'T64' }, { kind: 'ZSTD', level: 3 }])).toBe('CODEC(T64, ZSTD(3))')
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

  test('parses bare NONE/T64/GCD/ALP', () => {
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
    if (!parsed) throw new Error('expected parsed codec')
    expect(renderCodec(parsed)).toBe('CODEC(SomeNewCodec(42))')
  })

  test('falls back to raw when known codec has unexpected extra args', () => {
    expect(parseCodec('CODEC(ZSTD(3, 24, 1))')).toEqual([
      { kind: 'raw', expression: 'ZSTD(3, 24, 1)' },
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

  test('reads a negative level back from the unsigned form ClickHouse prints', () => {
    expect(parseCodec('CODEC(ZSTD(18446744073709551615))')).toEqual([{ kind: 'ZSTD', level: -1 }])
    expect(parseCodec('CODEC(LZ4HC(18446744073709551614))')).toEqual([{ kind: 'LZ4HC', level: -2 }])
  })
})

describe('canonicalizeCodec', () => {
  test('fills in ZSTD default level', () => {
    expect(canonicalizeCodec({ kind: 'ZSTD' })).toEqual([{ kind: 'ZSTD', level: 1 }])
  })

  test('fills in LZ4HC default level', () => {
    expect(canonicalizeCodec({ kind: 'LZ4HC' })).toEqual([{ kind: 'LZ4HC', level: 9 }])
  })

  test('keeps a bare Delta/Gorilla bare and drops the DoubleDelta size ClickHouse ignores (#465)', () => {
    expect(canonicalizeCodec({ kind: 'Delta' })).toEqual([{ kind: 'Delta' }])
    expect(canonicalizeCodec({ kind: 'Delta', size: 1 })).toEqual([{ kind: 'Delta', size: 1 }])
    expect(canonicalizeCodec({ kind: 'DoubleDelta', size: 4 })).toEqual([{ kind: 'DoubleDelta' }])
    expect(canonicalizeCodec({ kind: 'Gorilla' })).toEqual([{ kind: 'Gorilla' }])
  })

  test('keeps a malformed atom as written, for validation to report', () => {
    expect(canonicalizeCodec({ kind: 'ZSTD', level: 1.5 })).toEqual([{ kind: 'ZSTD', level: 1.5 }])
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

describe('codecFingerprint', () => {
  // Each schema codec beside the compression_codec ClickHouse 26.3 and
  // ObsessionDB 26.8 store for the CREATE TABLE chkit renders from it (#383).
  const stored: Array<[ColumnCodecSpec, string]> = [
    [{ kind: 'NONE' }, 'CODEC(NONE)'],
    [{ kind: 'LZ4' }, 'CODEC(LZ4)'],
    [{ kind: 'T64' }, 'CODEC(T64)'],
    [[{ kind: 'GCD' }, { kind: 'LZ4' }], 'CODEC(GCD, LZ4)'],
    [{ kind: 'ALP' }, 'CODEC(ALP)'],
    [{ kind: 'ZSTD' }, 'CODEC(ZSTD(1))'],
    [{ kind: 'ZSTD', level: 3 }, 'CODEC(ZSTD(3))'],
    [{ kind: 'ZSTD', level: -1 }, 'CODEC(ZSTD(18446744073709551615))'],
    [{ kind: 'LZ4HC' }, 'CODEC(LZ4HC(9))'],
    [{ kind: 'LZ4HC' }, 'CODEC(LZ4HC(0))'],
    [{ kind: 'LZ4HC', level: 0 }, 'CODEC(LZ4HC(0))'],
    [{ kind: 'LZ4HC', level: -1 }, 'CODEC(LZ4HC(18446744073709551615))'],
    [{ kind: 'LZ4HC', level: 12 }, 'CODEC(LZ4HC(12))'],
    [[{ kind: 'Delta', size: 8 }, { kind: 'LZ4' }], 'CODEC(Delta(8), LZ4)'],
    [[{ kind: 'DoubleDelta' }, { kind: 'LZ4' }], 'CODEC(DoubleDelta, LZ4)'],
    [[{ kind: 'DoubleDelta', size: 4 }, { kind: 'LZ4' }], 'CODEC(DoubleDelta, LZ4)'],
    [[{ kind: 'Gorilla', size: 8 }, { kind: 'ZSTD', level: 2 }], 'CODEC(Gorilla(8), ZSTD(2))'],
    [[{ kind: 'FPC', level: 12, floatSize: 8 }, { kind: 'LZ4' }], 'CODEC(FPC(12), LZ4)'],
    [[{ kind: 'Delta', size: 8 }, { kind: 'T64' }, { kind: 'ZSTD' }], 'CODEC(Delta(8), T64, ZSTD(1))'],
    [[{ kind: 'T64' }, { kind: 'LZ4' }], 'CODEC(T64, LZ4)'],
    [[{ kind: 'T64' }, { kind: 'ZSTD', level: 3 }], 'CODEC(T64, ZSTD(3))'],
    [[{ kind: 'Delta', size: 8 }, { kind: 'T64' }, { kind: 'LZ4' }], 'CODEC(Delta(8), T64, LZ4)'],
    [[{ kind: 'Delta', size: 8 }, { kind: 'GCD' }, { kind: 'ZSTD' }], 'CODEC(Delta(8), GCD, ZSTD(1))'],
    [codec.raw('ZSTD'), 'CODEC(ZSTD(1))'],
    [codec.raw('Delta(4),ZSTD(3)'), 'CODEC(Delta(4), ZSTD(3))'],
    [codec.raw('FPC, LZ4'), 'CODEC(FPC(12), LZ4)'],
    [codec.raw('FPC(5, 4), LZ4HC'), 'CODEC(FPC(5), LZ4HC(0))'],
    [codec.raw('AES_128_GCM_SIV'), 'CODEC(AES_128_GCM_SIV)'],
    [[{ kind: 'Delta', size: 4 }, codec.raw('ZSTD(3)')], 'CODEC(Delta(4), ZSTD(3))'],
  ]

  for (const [spec, compressionCodec] of stored) {
    test(`${JSON.stringify(spec)} matches the stored ${compressionCodec}`, () => {
      expect(codecFingerprint(spec)).toBe(codecFingerprint(parseCodec(compressionCodec)))
    })
  }

  test('no codec matches an empty compression_codec', () => {
    expect(codecFingerprint(undefined)).toBe('')
    expect(codecFingerprint(parseCodec(''))).toBe('')
  })

  test('tells apart codecs ClickHouse stores differently', () => {
    const distinct: ColumnCodecSpec[] = [
      { kind: 'LZ4' },
      { kind: 'NONE' },
      { kind: 'ZSTD' },
      { kind: 'ZSTD', level: 3 },
      { kind: 'ZSTD', level: 0 },
      { kind: 'LZ4HC' },
      { kind: 'LZ4HC', level: 12 },
      [{ kind: 'Delta', size: 1 }, { kind: 'LZ4' }],
      [{ kind: 'Delta', size: 8 }, { kind: 'LZ4' }],
      [{ kind: 'DoubleDelta' }, { kind: 'LZ4' }],
      [{ kind: 'Gorilla', size: 8 }, { kind: 'LZ4' }],
      [{ kind: 'FPC', level: 12, floatSize: 8 }, { kind: 'LZ4' }],
      [{ kind: 'FPC', level: 5, floatSize: 8 }, { kind: 'LZ4' }],
      [{ kind: 'T64' }, { kind: 'LZ4' }],
      [{ kind: 'LZ4' }, { kind: 'T64' }],
    ]
    const fingerprints = distinct.map((spec) => codecFingerprint(spec))
    expect(new Set([...fingerprints, '']).size).toBe(distinct.length + 1)
  })

  test('matches the strings chkit-py produces', () => {
    expect(codecFingerprint({ kind: 'LZ4HC' })).toBe('LZ4HC(9)')
    expect(codecFingerprint(parseCodec('CODEC(ZSTD(18446744073709551615))'))).toBe('ZSTD(-1)')
    expect(codecFingerprint(parseCodec('CODEC(Delta(8), DoubleDelta, FPC(12), ZSTD(1))'))).toBe(
      'Delta(8),DoubleDelta,FPC(12),ZSTD(1)'
    )
  })
})

describe('codec forms ClickHouse stores (#465)', () => {
  test('renders a bare Delta/Gorilla and never a DoubleDelta size', () => {
    expect(renderCodec([{ kind: 'Delta' }, { kind: 'ZSTD' }])).toBe('CODEC(Delta, ZSTD)')
    expect(renderCodec({ kind: 'Gorilla' })).toBe('CODEC(Gorilla)')
    expect(renderCodec({ kind: 'DoubleDelta', size: 8 })).toBe('CODEC(DoubleDelta)')
  })

  test('renders and parses ZSTD windowLog, T64 mode, FPC level and Default', () => {
    const forms: Array<[ColumnCodecSpec, string]> = [
      [{ kind: 'ZSTD', level: 3, windowLog: 24 }, 'CODEC(ZSTD(3, 24))'],
      [{ kind: 'T64', mode: 'bit' }, "CODEC(T64('bit'))"],
      [{ kind: 'FPC' }, 'CODEC(FPC)'],
      [{ kind: 'FPC', level: 12 }, 'CODEC(FPC(12))'],
      [[{ kind: 'Delta' }, { kind: 'Default' }], 'CODEC(Delta, Default)'],
    ]
    for (const [spec, sql] of forms) {
      expect(renderCodec(spec)).toBe(sql)
      expect(parseCodec(sql)).toEqual(Array.isArray(spec) ? spec : [spec])
    }
    expect(parseCodec("CODEC(T64('byte'))")).toEqual([{ kind: 'T64', mode: 'byte' }])
  })

  test('fills in the value width ClickHouse uses for a bare Delta or Gorilla', () => {
    const widths: Array<[string, ColumnCodecSpec, string]> = [
      ['UInt64', [{ kind: 'Delta' }, { kind: 'ZSTD' }], 'CODEC(Delta(8), ZSTD(1))'],
      ['UInt32', [{ kind: 'Delta' }, { kind: 'ZSTD' }], 'CODEC(Delta(4), ZSTD(1))'],
      ['Date', [{ kind: 'Delta' }, { kind: 'ZSTD' }], 'CODEC(Delta(2), ZSTD(1))'],
      ["DateTime64(3, 'UTC')", [{ kind: 'Delta' }, { kind: 'ZSTD' }], 'CODEC(Delta(8), ZSTD(1))'],
      ['Nullable(UInt64)', [{ kind: 'Delta' }, { kind: 'LZ4' }], 'CODEC(Delta(8), LZ4)'],
      ['Array(Float64)', { kind: 'Gorilla' }, 'CODEC(Gorilla(8))'],
      ['Float32', { kind: 'Gorilla' }, 'CODEC(Gorilla(4))'],
      ['Tuple(a UInt8, b UInt64)', [{ kind: 'Delta' }, { kind: 'LZ4' }], 'CODEC(Delta, LZ4)'],
      ['Map(UInt32, UInt32)', [{ kind: 'Delta' }, { kind: 'LZ4' }], 'CODEC(Delta(4), LZ4)'],
      ['UInt64', codec.raw('Delta, Default'), 'CODEC(Delta(8), Default)'],
      ['UInt64', [{ kind: 'Delta', size: 4 }, { kind: 'ZSTD' }], 'CODEC(Delta(4), ZSTD(1))'],
    ]
    for (const [type, spec, stored] of widths) {
      expect(codecFingerprint(spec, type)).toBe(codecFingerprint(parseCodec(stored), type))
    }
    // An explicit size is compared as written: no equivalence with the bare form.
    expect(codecsEqual({ kind: 'Delta', size: 1 }, { kind: 'Delta' }, 'UInt64')).toBe(false)
    expect(codecsEqual({ kind: 'Delta', size: 8 }, { kind: 'Delta' }, 'UInt64')).toBe(true)
  })

  test('compares respelled codecs equal', () => {
    const same: Array<[string, ColumnCodecSpec, ColumnCodecSpec]> = [
      ['String', { kind: 'ZSTD' }, { kind: 'ZSTD', level: 1 }],
      ['String', { kind: 'LZ4HC' }, { kind: 'LZ4HC', level: 9 }],
      ['UInt64', { kind: 'DoubleDelta', size: 8 }, { kind: 'DoubleDelta' }],
      ['Float64', { kind: 'FPC', level: 12, floatSize: 8 }, { kind: 'FPC', level: 12, floatSize: 4 }],
      ['Float64', { kind: 'FPC', level: 12, floatSize: 4 }, { kind: 'FPC' }],
      ['String', [{ kind: 'LZ4' }], { kind: 'LZ4' }],
      ['String', codec.raw('NONE'), { kind: 'NONE' }],
      ['String', codec.raw('ZSTD'), { kind: 'ZSTD', level: 1 }],
      ['String', codec.raw('ZSTD, AES_128_GCM_SIV'), codec.raw('ZSTD(1), AES_128_GCM_SIV')],
      ['UInt64', { kind: 'T64', mode: 'byte' }, { kind: 'T64' }],
      // Integer literals ClickHouse reads: hex, binary, underscores.
      ['String', codec.raw('ZSTD(0x1)'), { kind: 'ZSTD', level: 1 }],
      ['String', codec.raw('ZSTD(1_0)'), { kind: 'ZSTD', level: 10 }],
      ['String', codec.raw('ZSTD(3, 0x18)'), { kind: 'ZSTD', level: 3, windowLog: 24 }],
      ['String', codec.raw('LZ4HC(0b1_0)'), { kind: 'LZ4HC', level: 2 }],
      ['UInt64', codec.raw("T64( 'bit' )"), { kind: 'T64', mode: 'bit' }],
    ]
    for (const [type, a, b] of same) expect(codecFingerprint(a, type)).toBe(codecFingerprint(b, type))
  })

  test('tells apart a ZSTD window and a T64 bit mode', () => {
    expect(codecFingerprint({ kind: 'ZSTD', level: 3, windowLog: 24 })).not.toBe(codecFingerprint({ kind: 'ZSTD', level: 3 }))
    expect(codecFingerprint({ kind: 'T64', mode: 'bit' })).not.toBe(codecFingerprint({ kind: 'T64' }))
  })

  test('keeps whitespace inside a quoted argument: ClickHouse rejects T64(\'b it\')', () => {
    expect(codecFingerprint(codec.raw("T64('b it')"))).toBe("T64('b it')")
  })
})
