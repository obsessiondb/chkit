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
      // ClickHouse keeps the low 32 bits of an LZ4HC level (observed on 26.3).
      ['String', { kind: 'LZ4HC', level: 4294967297 }, parseCodec('CODEC(LZ4HC(1))') ?? []],
      ['String', codec.raw('LZ4HC(2147483648)'), parseCodec('CODEC(LZ4HC(18446744071562067968))') ?? []],
    ]
    for (const [type, a, b] of same) expect(codecFingerprint(a, type)).toBe(codecFingerprint(b, type))
  })

  test('tells apart a ZSTD window and a T64 bit mode', () => {
    expect(codecFingerprint({ kind: 'ZSTD', level: 3, windowLog: 24 })).not.toBe(codecFingerprint({ kind: 'ZSTD', level: 3 }))
    expect(codecFingerprint({ kind: 'T64', mode: 'bit' })).not.toBe(codecFingerprint({ kind: 'T64' }))
  })

  test('leaves a decimal argument too long for a number unparsed', () => {
    expect(codecFingerprint(codec.raw(`ZSTD(-${'9'.repeat(4301)})`))).toBe(`ZSTD(-${'9'.repeat(4301)})`)
  })

  test('keeps whitespace inside a quoted argument: ClickHouse rejects T64(\'b it\')', () => {
    expect(codecFingerprint(codec.raw("T64('b it')"))).toBe("T64('b it')")
  })
})

// Schema and compression_codec pairs observed on ClickHouse 26.3.
const MATRIX_STORED: Array<[string, ColumnCodecSpec, string]> = [
  ["SimpleAggregateFunction(sum, UInt64)", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta(8), LZ4)"],
  ["SimpleAggregateFunction(max, DateTime)", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta(4), LZ4)"],
  ["SimpleAggregateFunction(max, Float64)", {"kind": "Gorilla"}, "CODEC(Gorilla(8))"],
  ["SimpleAggregateFunction(max, Float32)", {"kind": "FPC"}, "CODEC(FPC(12))"],
  ["SimpleAggregateFunction(sum, UInt64)", {"kind": "T64"}, "CODEC(T64)"],
  ["SimpleAggregateFunction(sum, UInt64)", {"kind": "DoubleDelta"}, "CODEC(DoubleDelta)"],
  ["SimpleAggregateFunction(max, Nullable(UInt16))", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta(2), LZ4)"],
  ["SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32))", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta(4), LZ4)"],
  ["Enum('a' = 1, 'b' = 2)", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta(1), LZ4)"],
  ["Enum('a' = 1, 'b' = 1000)", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta(2), LZ4)"],
  ["Enum16('a' = 1)", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta(2), LZ4)"],
  ["Tuple(Float32, Float64)", [{"kind": "Gorilla"}, {"kind": "FPC", "level": 12, "floatSize": 4}], "CODEC(Gorilla, FPC(12, 4))"],
  ["Tuple(Float32, Float64)", {"kind": "FPC", "level": 12, "floatSize": 4}, "CODEC(FPC(12))"],
  ["Tuple(Float32, Float64)", {"kind": "FPC", "level": 12}, "CODEC(FPC(12))"],
  ["Tuple(Float32, Float64)", {"kind": "FPC"}, "CODEC(FPC(12))"],
  ["Tuple(Float32, Float64)", [{"kind": "FPC", "level": 12, "floatSize": 4}, {"kind": "ZSTD"}], "CODEC(FPC(12), ZSTD(1))"],
  ["Tuple(Float32, Float64)", {"kind": "Gorilla"}, "CODEC(Gorilla)"],
  ["Tuple(Float32, Float64)", {"kind": "Gorilla", "size": 4}, "CODEC(Gorilla(4))"],
  ["Tuple(Float32, Float64)", [{"kind": "Gorilla"}, {"kind": "ZSTD"}], "CODEC(Gorilla, ZSTD)"],
  ["Tuple(Float64, Float64)", [{"kind": "Gorilla"}, {"kind": "FPC", "level": 12, "floatSize": 4}], "CODEC(Gorilla(8), FPC(12))"],
  ["Tuple(Float64, Float64)", {"kind": "FPC", "level": 12, "floatSize": 4}, "CODEC(FPC(12))"],
  ["Tuple(UInt32, UInt64)", [{"kind": "Delta"}, {"kind": "ZSTD"}], "CODEC(Delta, ZSTD)"],
  ["Tuple(UInt32, UInt64)", [{"kind": "Delta", "size": 2}, {"kind": "ZSTD"}], "CODEC(Delta(2), ZSTD(1))"],
  ["Array(Tuple(Float32, Float64))", [{"kind": "Gorilla"}, {"kind": "FPC", "level": 12, "floatSize": 4}], "CODEC(Gorilla, FPC(12, 4))"],
  ["Tuple(Float32, Float64)", [{"kind": "DoubleDelta"}, {"kind": "ZSTD"}], "CODEC(DoubleDelta, ZSTD)"],
  ["Tuple(Float32, Float64)", {"kind": "ALP"}, "CODEC(ALP)"],
  ["String", [{"kind": "Delta", "size": 4}, {"kind": "LZ4"}], "CODEC(Delta(4), LZ4)"],
  ["String", [{"kind": "Delta", "size": 1}, {"kind": "LZ4"}], "CODEC(Delta(1), LZ4)"],
  ["FixedString(4)", [{"kind": "Delta", "size": 4}, {"kind": "LZ4"}], "CODEC(Delta(4), LZ4)"],
  ["Array(String)", [{"kind": "Delta", "size": 4}, {"kind": "LZ4"}], "CODEC(Delta(4), LZ4)"],
  ["Nullable(String)", [{"kind": "Delta", "size": 4}, {"kind": "LZ4"}], "CODEC(Delta(4), LZ4)"],
  ["LowCardinality(String)", [{"kind": "Delta", "size": 4}, {"kind": "LZ4"}], "CODEC(Delta(4), LZ4)"],
  ["UUID", [{"kind": "Delta", "size": 8}, {"kind": "LZ4"}], "CODEC(Delta(8), LZ4)"],
  ["Decimal(18, 4)", [{"kind": "Delta", "size": 8}, {"kind": "LZ4"}], "CODEC(Delta(8), LZ4)"],
  ["Float64", [{"kind": "Delta", "size": 8}, {"kind": "LZ4"}], "CODEC(Delta(8), LZ4)"],
  ["Tuple(UInt64, Float64)", {"kind": "Gorilla"}, "CODEC(Gorilla(8))"],
  ["Tuple(UInt64, Float64)", {"kind": "Gorilla", "size": 8}, "CODEC(Gorilla(8))"],
  ["Array(Tuple(UInt64, Float64))", {"kind": "Gorilla"}, "CODEC(Gorilla(8))"],
  ["UInt64", {"kind": "ZSTD", "level": 3, "windowLog": 0}, "CODEC(ZSTD(3, 0))"],
  ["UInt64", {"kind": "ZSTD", "level": 3, "windowLog": 10}, "CODEC(ZSTD(3, 10))"],
  ["UInt64", {"kind": "ZSTD", "level": 3, "windowLog": 31}, "CODEC(ZSTD(3, 31))"],
  ["UInt64", {"kind": "ZSTD", "level": 1, "windowLog": 0}, "CODEC(ZSTD(1, 0))"],
  ["UInt64", {"kind": "ZSTD", "level": -1, "windowLog": 0}, "CODEC(ZSTD(18446744073709551615, 0))"],
  ["UInt64", {"kind": "ZSTD", "level": 0, "windowLog": 0}, "CODEC(ZSTD(0, 0))"],
  ["Tuple(Float32, Float64)", [{"kind": "Gorilla", "size": 4}, {"kind": "FPC", "level": 12, "floatSize": 4}], "CODEC(Gorilla(4), FPC(12))"],
  ["Tuple(Float32, Float64)", [{"kind": "Gorilla"}, {"kind": "FPC"}], "CODEC(Gorilla, FPC)"],
  ["Tuple(Float32, Float64)", [{"kind": "Gorilla"}, {"kind": "FPC", "level": 12, "floatSize": 4}, {"kind": "ZSTD"}], "CODEC(Gorilla, FPC(12, 4), ZSTD)"],
  ["Tuple(Float32, Float64)", [{"kind": "Gorilla"}, {"kind": "LZ4HC"}], "CODEC(Gorilla, LZ4HC)"],
  ["Tuple(Float32, Float64)", [{"kind": "Gorilla"}, {"kind": "ZSTD", "level": 3, "windowLog": 24}], "CODEC(Gorilla, ZSTD(3, 24))"],
  ["Tuple(UInt32, UInt64)", [{"kind": "Delta"}, {"kind": "LZ4HC"}], "CODEC(Delta, LZ4HC)"],
  ["Tuple(UInt32, UInt64)", [{"kind": "Delta"}, {"kind": "T64"}], "CODEC(Delta, T64)"],
  ["Tuple(UInt32, UInt64)", [{"kind": "DoubleDelta"}, {"kind": "Delta"}, {"kind": "ZSTD"}], "CODEC(DoubleDelta, Delta, ZSTD)"],
  ["Tuple(UInt32, UInt64)", {"kind": "raw", "expression": "Delta, DoubleDelta(4)"}, "CODEC(Delta, DoubleDelta(4))"],
  ["Tuple(Float32, Float64)", [{"kind": "FPC", "level": 12, "floatSize": 4}, {"kind": "Gorilla"}], "CODEC(FPC(12, 4), Gorilla)"],
  ["Map(UInt32, UInt64)", [{"kind": "Delta"}, {"kind": "ZSTD"}], "CODEC(Delta, ZSTD)"],
  ["Tuple(UInt32, Float32)", [{"kind": "Delta"}, {"kind": "ZSTD"}], "CODEC(Delta(4), ZSTD(1))"],
  ["Tuple(UInt64, Float64)", [{"kind": "Gorilla"}, {"kind": "ZSTD"}], "CODEC(Gorilla(8), ZSTD(1))"],
  ["Nullable(Float64)", [{"kind": "Gorilla"}, {"kind": "FPC", "level": 12, "floatSize": 4}], "CODEC(Gorilla(8), FPC(12))"],
  ["Array(Float32)", [{"kind": "Gorilla"}, {"kind": "FPC", "level": 12, "floatSize": 8}], "CODEC(Gorilla(4), FPC(12))"],
]

describe('server matrix stored forms (#465)', () => {
  for (const [type, spec, stored] of MATRIX_STORED) {
    test(`${type} ${JSON.stringify(spec)} stores ${stored}`, () => {
      const expected = codecFingerprint(parseCodec(stored), type)
      expect(codecFingerprint(spec, type)).toBe(expected)
      expect(codecFingerprint(codec.raw(renderCodec(spec).slice(6, -1)), type)).toBe(expected)
    })
  }
  test('mixed widths retain FPC arguments while unknown types keep their old comparison', () => {
    const before = [{ kind: 'Gorilla' }, { kind: 'FPC', level: 12, floatSize: 4 }] satisfies ColumnCodecSpec
    const after = [{ kind: 'Gorilla' }, { kind: 'FPC', level: 12, floatSize: 8 }] satisfies ColumnCodecSpec
    expect(codecFingerprint(before, 'Tuple(Float32, Float64)')).toBe('Gorilla,FPC(12,4)')
    expect(codecsEqual(before, after, 'Tuple(Float32, Float64)')).toBe(false)
    expect(codecsEqual(before, after, 'JSON')).toBe(true)
    expect(codecsEqual(before, after, 'Dynamic')).toBe(true)
  })
  test('a zero ZSTD window remains distinct from an omitted window', () => {
    expect(codecFingerprint({ kind: 'ZSTD', level: 3, windowLog: 0 })).toBe('ZSTD(3,0)')
    expect(codecsEqual({ kind: 'ZSTD', level: 3, windowLog: 0 }, { kind: 'ZSTD', level: 3 })).toBe(false)
  })
})

// Parser coverage beyond the server matrix; these are not server verdicts.
describe('Enum value parsing parity', () => {
  const cases: Array<[string, string]> = [
    ["Enum('can\\'t' = 1000, 'b' = 1)", 'Delta(2),LZ4'],
    ["Enum('a\\', b' = 1, 'c' = 2)", 'Delta(1),LZ4'],
    ["Enum('a' = ١)", 'Delta,LZ4'],
    ["Enum('a' = 1\u0085)", 'Delta,LZ4'],
    ["Enum('a' = 0x1)", 'Delta(1),LZ4'],
    [`Enum('a' = ${'9'.repeat(4301)})`, 'Delta,LZ4'],
  ]
  for (const [type, expected] of cases) {
    test(`parses Enum values: ${type.slice(0, 80)}`, () => {
      expect(codecFingerprint([{ kind: 'Delta' }, { kind: 'LZ4' }], type)).toBe(expected)
    })
  }
})

// STORED rows from both additional ClickHouse 26.3 server matrices.
const TYPE_MATRIX_STORED: Array<[string, string, string, string]> = [
  ["Tuple(LowCardinality(UInt64), Float64)", "Gorilla", "Tuple(LowCardinality(UInt64), Float64)", "CODEC(Gorilla(8))"],
  ["Tuple(LowCardinality(Float64), Float64)", "FPC", "Tuple(LowCardinality(Float64), Float64)", "CODEC(FPC(12))"],
  ["Tuple(LowCardinality(Float64), Float64)", "ALP", "Tuple(LowCardinality(Float64), Float64)", "CODEC(ALP)"],
  ["Tuple(a LowCardinality(Float32), b Float32)", "Gorilla", "Tuple(a LowCardinality(Float32), b Float32)", "CODEC(Gorilla(4))"],
  ["Array(Tuple(LowCardinality(Float64), Float64))", "Gorilla", "Array(Tuple(LowCardinality(Float64), Float64))", "CODEC(Gorilla(8))"],
  ["Tuple(Array(LowCardinality(Float64)), Float64)", "Gorilla", "Tuple(Array(LowCardinality(Float64)), Float64)", "CODEC(Gorilla(8))"],
  ["Tuple(Map(UInt64, Float64), Float64)", "Gorilla", "Tuple(Map(UInt64, Float64), Float64)", "CODEC(Gorilla(8))"],
  ["Nullable(Float64)", "Gorilla", "Nullable(Float64)", "CODEC(Gorilla(8))"],
  ["Array(Nullable(Float64))", "Gorilla", "Array(Nullable(Float64))", "CODEC(Gorilla(8))"],
  ["Tuple(Nullable(Float64), Float64)", "Gorilla", "Tuple(Nullable(Float64), Float64)", "CODEC(Gorilla(8))"],
  ["Array(Float64)", "Gorilla", "Array(Float64)", "CODEC(Gorilla(8))"],
  ["Tuple(Float64, Float64)", "ALP", "Tuple(Float64, Float64)", "CODEC(ALP)"],
  ["Map(UInt64, UInt64)", "T64", "Map(UInt64, UInt64)", "CODEC(T64)"],
  ["Map(UInt64, UInt64)", "Delta, LZ4", "Map(UInt64, UInt64)", "CODEC(Delta(8), LZ4)"],
  ["Map(UInt64, UInt64)", "DoubleDelta", "Map(UInt64, UInt64)", "CODEC(DoubleDelta)"],
  ["Map(UInt64, Float64)", "DoubleDelta", "Map(UInt64, Float64)", "CODEC(DoubleDelta)"],
  ["Tuple (Float32, Float64)", "Gorilla, FPC(12, 4)", "Tuple(Float32, Float64)", "CODEC(Gorilla, FPC(12, 4))"],
  ["Tuple (Float64, Float64)", "Gorilla, FPC(12, 4)", "Tuple(Float64, Float64)", "CODEC(Gorilla(8), FPC(12))"],
  ["Nullable (Float64)", "Gorilla", "Nullable(Float64)", "CODEC(Gorilla(8))"],
  ["Array (UInt32)", "Delta, LZ4", "Array(UInt32)", "CODEC(Delta(4), LZ4)"],
  ["Enum ('a' = 1, 'b' = 1000)", "Delta, LZ4", "Enum16('a' = 1, 'b' = 1000)", "CODEC(Delta(2), LZ4)"],
  ["SimpleAggregateFunction (sum, UInt64)", "Delta, LZ4", "SimpleAggregateFunction(sum, UInt64)", "CODEC(Delta(8), LZ4)"],
  ["Tuple(`a\\`x` Float32, b Float64)", "Gorilla, FPC(12, 4)", "Tuple(`a\\`x` Float32, b Float64)", "CODEC(Gorilla, FPC(12, 4))"],
  ["Tuple(`a b` Float32, b Float64)", "Gorilla, FPC(12, 4)", "Tuple(`a b` Float32, b Float64)", "CODEC(Gorilla, FPC(12, 4))"],
  ["Tuple(\"a\" Float32, b Float64)", "Gorilla, FPC(12, 4)", "Tuple(a Float32, b Float64)", "CODEC(Gorilla, FPC(12, 4))"],
  ["Enum('a', 'b')", "Delta, LZ4", "Enum8('a' = 1, 'b' = 2)", "CODEC(Delta(1), LZ4)"],
  ["Enum('a' = 127, 'b')", "Delta, LZ4", "Enum16('a' = 127, 'b' = 128)", "CODEC(Delta(2), LZ4)"],
  ["Enum('a', 'b' = 1000)", "Delta, LZ4", "Enum16('a' = 1, 'b' = 1000)", "CODEC(Delta(2), LZ4)"],
  ["Enum8('a', 'b')", "Delta, LZ4", "Enum8('a' = 1, 'b' = 2)", "CODEC(Delta(1), LZ4)"],
  ["Enum('a' = -129)", "Delta, LZ4", "Enum16('a' = -129)", "CODEC(Delta(2), LZ4)"],
  ["Enum('a' = -128, 'b' = 127)", "Delta, LZ4", "Enum8('a' = -128, 'b' = 127)", "CODEC(Delta(1), LZ4)"],
  ["Tuple(FixedString(8), Float64)", "Gorilla", "Tuple(FixedString(8), Float64)", "CODEC(Gorilla(8))"],
  ["Tuple(UInt128, Float64)", "Gorilla(8)", "Tuple(UInt128, Float64)", "CODEC(Gorilla(8))"],
  ["Tuple(Date32, Float64)", "Gorilla", "Tuple(Date32, Float64)", "CODEC(Gorilla)"],
]

for (const [type, expression, storedType, storedCodec] of TYPE_MATRIX_STORED) {
  test(`additional server matrix fingerprint: ${type} ${expression}`, () => {
    const spec = parseCodec(expression)
    const parsedStored = parseCodec(storedCodec)
    expect(spec).toBeDefined()
    expect(parsedStored).toBeDefined()
    expect(codecFingerprint(spec, type)).toBe(codecFingerprint(parsedStored, type))
    expect(codecFingerprint(spec, type)).toBe(codecFingerprint(parsedStored, storedType))
  })
}

// Parser parity includes JS whitespace that Python's built-in \s treats differently.
const JS_TYPE_WHITESPACE = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
for (const space of JS_TYPE_WHITESPACE) {
  test(`type parser recognizes JS whitespace U+${space.codePointAt(0)?.toString(16)}`, () => {
    const mixed = `Tuple${space}(a${space}Float32, b${space}Float64)`
    const before: ColumnCodecSpec = [{ kind: 'Gorilla' }, { kind: 'FPC', level: 12, floatSize: 4 }]
    const after: ColumnCodecSpec = [{ kind: 'Gorilla' }, { kind: 'FPC', level: 12, floatSize: 8 }]
    expect(codecFingerprint(before, mixed)).toBe('Gorilla,FPC(12,4)')
    expect(codecsEqual(before, after, mixed)).toBe(false)
    for (const type of [
      `Array${space}(UInt64)`, `Nullable${space}(UInt64)`, `LowCardinality${space}(UInt64)`,
      `SimpleAggregateFunction${space}(max, UInt64)`, `Map${space}(UInt64, UInt64)`,
      `FixedString${space}(${space}8${space})`, `Decimal${space}(${space}18, 4)`,
      `Decimal64${space}(4)`, `DateTime64${space}(3)`, `Time64${space}(3)`,
    ]) {
      expect(codecFingerprint([{ kind: 'Delta' }, { kind: 'LZ4' }], type)).toBe('Delta(8),LZ4')
    }
    expect(codecFingerprint([{ kind: 'Delta' }, { kind: 'LZ4' }], `Enum${space}('a'${space}=${space}1${space})`)).toBe('Delta(1),LZ4')
  })
}
for (const space of ['\u001c', '\u001d', '\u001e', '\u001f', '\u0085']) {
  test(`type parser leaves non-JS whitespace U+${space.codePointAt(0)?.toString(16)} unknown`, () => {
    for (const type of [`Tuple(a${space}Float32, b Float64)`, `Tuple${space}(Float32, Float64)`]) {
      expect(codecFingerprint([{ kind: 'Gorilla' }, { kind: 'FPC', floatSize: 4 }], type)).toBe('Gorilla,FPC(12)')
    }
    expect(codecFingerprint([{ kind: 'Delta' }, { kind: 'LZ4' }], `Enum('a' = 1${space})`)).toBe('Delta,LZ4')
  })
}

test.each([
  ["Enum('has=1000', 'b')", 'Delta(1),LZ4'],
  ["Enum('can\\'t', 'b' = 128)", 'Delta(2),LZ4'],
  ["Enum('a,b' = -129, 'c')", 'Delta(2),LZ4'],
  ["Enum('a''b', 'c')", 'Delta(1),LZ4'],
])('implicit Enum values with quoted names: %s', (type, expected) => {
  expect(codecFingerprint([{ kind: 'Delta' }, { kind: 'LZ4' }], type)).toBe(expected)
})


const OPUS_STORED: Array<[string, string, string]> = [
  ["Tuple(Float32, Float64)", "FPC(12, 4), DoubleDelta", "CODEC(FPC(12, 4), DoubleDelta)"],
  ["Tuple(Float32, Float64)", "FPC(12, 4), DoubleDelta, ZSTD", "CODEC(FPC(12, 4), DoubleDelta, ZSTD)"],
  ["Tuple(Float32, Float64)", "FPC(12, 8), DoubleDelta", "CODEC(FPC(12, 8), DoubleDelta)"],
  ["Tuple(Float32, Float64)", "FPC(12, 8), DoubleDelta, ZSTD", "CODEC(FPC(12, 8), DoubleDelta, ZSTD)"],
  ["Tuple(Float32, Float64)", "DoubleDelta, ZSTD", "CODEC(DoubleDelta, ZSTD)"],
  ["Tuple(Float32, Float64)", "DoubleDelta(4), ZSTD", "CODEC(DoubleDelta, ZSTD(1))"],
  ["Tuple(UInt32, UInt64)", "DoubleDelta, ZSTD", "CODEC(DoubleDelta, ZSTD)"],
  ["Tuple(UInt32, UInt64)", "DoubleDelta(4), ZSTD", "CODEC(DoubleDelta, ZSTD(1))"],
  ["Tuple(UInt32, UInt64)", "T64, ZSTD", "CODEC(T64, ZSTD)"],
  ["Tuple(UInt32, UInt64)", "T64('byte'), ZSTD", "CODEC(T64('byte'), ZSTD)"],
  ["Tuple(UInt32, UInt64)", "GCD, ZSTD", "CODEC(GCD, ZSTD(1))"],
  ["Tuple(Float32, Float64)", "FPC(12, 4), ZSTD", "CODEC(FPC(12), ZSTD(1))"],
  ["Float64", "FPC(12, 4), DoubleDelta, ZSTD", "CODEC(FPC(12), DoubleDelta, ZSTD(1))"],
  ["Tuple(UInt32, UInt64)", "Delta, DoubleDelta(4)", "CODEC(Delta, DoubleDelta(4))"],
  ["Tuple(UInt32, UInt64)", "Delta, DoubleDelta(8)", "CODEC(Delta, DoubleDelta(8))"],
  ["Enum('a' = 0x10)", "Delta, LZ4", "CODEC(Delta(1), LZ4)"],
  ["Enum('a' = 0x7f, 'b')", "Delta, LZ4", "CODEC(Delta(2), LZ4)"],
  ["Enum('a' = -0x80, 'b')", "Delta, LZ4", "CODEC(Delta(1), LZ4)"],
  ["Enum('a' = 1_0, 'b')", "Delta, LZ4", "CODEC(Delta(1), LZ4)"],
  ["Enum('a' = +0b1111111, 'b')", "Delta, LZ4", "CODEC(Delta(2), LZ4)"],
  ["Enum('a' = 0x0_7f, 'b')", "Delta, LZ4", "CODEC(Delta(2), LZ4)"],
  ["Enum('a' = -1_2_8, 'b')", "Delta, LZ4", "CODEC(Delta(1), LZ4)"],
  ["Tuple(Enum('a' = 0x10), Float64)", "Gorilla", "CODEC(Gorilla)"],
  ["Tuple(String, Float64)", "Gorilla(8)", "CODEC(Gorilla(8))"],
  ["Tuple(UUID, Float64)", "Gorilla(8)", "CODEC(Gorilla(8))"],
]
for (const [type, expression, stored] of OPUS_STORED) {
  test(`Opus server fingerprint: ${type} ${expression}`, () => {
    expect(codecFingerprint(codec.raw(expression), type)).toBe(codecFingerprint(parseCodec(stored), type))
  })
}

test('DoubleDelta retains a raw size only in verbatim chains', () => {
  const type = 'Tuple(UInt32, UInt64)'
  expect(codecFingerprint(codec.raw('Delta, DoubleDelta(4)'), type)).toBe('Delta,DoubleDelta(4)')
  expect(codecsEqual(codec.raw('Delta, DoubleDelta(4)'), codec.raw('Delta, DoubleDelta(8)'), type)).toBe(false)
  expect(codecsEqual(codec.raw('DoubleDelta(4), ZSTD'), codec.raw('DoubleDelta(8), ZSTD'), type)).toBe(true)
  expect(codecsEqual(codec.raw('Delta, DoubleDelta(4)'), codec.raw('Delta, DoubleDelta(8)'), 'UInt64')).toBe(true)
  const typed: ColumnCodecSpec = [{ kind: 'FPC', level: 12, floatSize: 4 }, { kind: 'DoubleDelta', size: 8 }]
  expect(renderCodec(typed)).toBe('CODEC(FPC(12, 4), DoubleDelta)')
  expect(codecFingerprint(canonicalizeCodec(typed), 'Tuple(Float32, Float64)')).toBe('FPC(12,4),DoubleDelta')
})
