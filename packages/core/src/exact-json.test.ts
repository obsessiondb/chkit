import { describe, expect, test } from 'bun:test'

import { parseJsonEachRowLine } from './exact-json.js'

describe('parseJsonEachRowLine (#415)', () => {
  test('returns a number a double would round as the digits ClickHouse wrote', () => {
    // The line ClickHouse 26.3 writes for toUInt64(18446744073709551615),
    // toInt128 max and toDecimal128('123456789012345678.91', 2).
    const row = parseJsonEachRowLine(
      '{"u64":18446744073709551615,"i128":170141183460469231731687303715884105727,"d":123456789012345678.91,"i64":-9223372036854775808,"unsafe":9007199254740993,"d_point":12345678.9012345678}',
    )

    expect(row).toEqual({
      u64: '18446744073709551615',
      i128: '170141183460469231731687303715884105727',
      d: '123456789012345678.91',
      i64: '-9223372036854775808',
      unsafe: '9007199254740993',
      d_point: '12345678.9012345678',
    })
  })

  test('keeps every number a double holds exactly as a number, Float64 included', () => {
    // Float64 as ClickHouse writes it: shortest round-trip digits, zero-padded
    // integers up to 1e20 and exponents beyond.
    const row = parseJsonEachRowLine(
      '{"small":42,"zero":0,"max_safe":9007199254740991,"two_53":9007199254740992,"f":0.1,"f_big":100000000000000000000,"f_round":123456789012345680,"f_digits":123456789.12345679,"f_exp":1e300,"f_tiny":-2.5e-300,"d":1.5,"d15":1234567890123.45}',
    )

    expect(row).toEqual({
      small: 42,
      zero: 0,
      max_safe: 9007199254740991,
      two_53: 9007199254740992,
      f: 0.1,
      f_big: 1e20,
      f_round: 123456789012345680,
      f_digits: 123456789.12345679,
      f_exp: 1e300,
      f_tiny: -2.5e-300,
      d: 1.5,
      d15: 1234567890123.45,
    })
  })

  test('keeps the digits inside arrays, tuples and maps, and leaves strings alone', () => {
    const row = parseJsonEachRowLine(
      '{"arr":[18446744073709551615,1],"tuple":{"a":12345678901234567890.5,"b":"x"},"map":{"k":[0.25]},"s":"18446744073709551615","n":null}',
    )

    expect(row).toEqual({
      arr: ['18446744073709551615', 1],
      tuple: { a: '12345678901234567890.5', b: 'x' },
      map: { k: [0.25] },
      s: '18446744073709551615',
      n: null,
    })
  })
})
