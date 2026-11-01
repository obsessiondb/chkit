import { describe, expect, test } from 'bun:test'

import { createLiveExecutor, getLiveEnv } from './e2e-testkit.js'

describe('@chkit/clickhouse executor.query numbers e2e (#415)', () => {
  test('returns 64-bit and wider integers and Decimals with every digit, and other numbers as numbers', async () => {
    const executor = createLiveExecutor(getLiveEnv())
    const rows = await executor.query<Record<string, unknown>>(
      `SELECT
  toUInt64(18446744073709551615) AS u64_max,
  toInt128('170141183460469231731687303715884105727') AS i128_max,
  toDecimal128('123456789012345678.91', 2) AS d128,
  [toUInt64(9007199254740993)] AS u64_array,
  toFloat64(0.1) AS f64,
  toFloat64(1e20) AS f64_big,
  toUInt64(42) AS u64_small
SETTINGS output_format_json_quote_64bit_integers = 0, output_format_json_quote_decimals = 0`,
    )
    await executor.close()

    expect(rows).toEqual([
      {
        u64_max: '18446744073709551615',
        i128_max: '170141183460469231731687303715884105727',
        d128: '123456789012345678.91',
        u64_array: ['9007199254740993'],
        f64: 0.1,
        f64_big: 1e20,
        u64_small: 42,
      },
    ])
  })
})
