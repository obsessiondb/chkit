import { describe, expect, test } from 'bun:test'

import { settingValueFingerprint } from './table-settings.js'

// chkit-py's tests/test_table_settings.py holds the same table: both ports
// must give the same text.
const FINGERPRINTS: Array<[string | number | boolean, string]> = [
  ['8192', '8192'],
  [8192, '8192'],
  ['8192.', '8192'],
  ['1e6', '1000000'],
  ['1000000.', '1000000'],
  ['1E+6', '1000000'],
  ['2.0', '2'],
  ['2.', '2'],
  ['2', '2'],
  ['-2.50', '-2.5'],
  ['+7', '7'],
  ['.5', '0.5'],
  ['007', '7'],
  ['-0', '0'],
  ['0.0', '0'],
  ['1e-7', '0.0000001'],
  ['0.00001', '0.00001'],
  [0.00001, '0.00001'],
  ['1e21', '1000000000000000000000'],
  [1e21, '1000000000000000000000'],
  ['123.456', '123.456'],
  ['9007199254740993', '9007199254740993'],
  ['18446744073709551615', '18446744073709551615'],
  // A `.`, an exponent, or an integer outside Int64/UInt64 makes ClickHouse read a Float64.
  ['18446744073709551615.', '18446744073709551616'],
  ['9007199254740993.', '9007199254740992'],
  ['18446744073709552000', '18446744073709551616'],
  ['-9223372036854775808', '-9223372036854775808'],
  ['-9223372036854775809', '-9223372036854775808'],
  ['1e500', '1e500'],
  ['1.5e-500', '0'],
  [true, '1'],
  [false, '0'],
  ['true', '1'],
  ['FALSE', '0'],
  ['s3', 's3'],
  ['e5', 'e5'],
  ['', ''],
]

describe('settingValueFingerprint', () => {
  test('gives one exact decimal form for every spelling of a number, and 1/0 for booleans', () => {
    expect(FINGERPRINTS.map(([value]) => settingValueFingerprint(value))).toEqual(FINGERPRINTS.map(([, expected]) => expected))
  })

  test('tells apart integers a float cannot (#466)', () => {
    expect(settingValueFingerprint('9007199254740992')).not.toBe(settingValueFingerprint('9007199254740993'))
    expect(settingValueFingerprint('18446744073709551615')).not.toBe(settingValueFingerprint('18446744073709551614'))
    // ClickHouse reads `9007199254740993.` as the Float64 9007199254740992, so it is another default.
    expect(settingValueFingerprint('9007199254740993.')).not.toBe(settingValueFingerprint('9007199254740993'))
  })
})
