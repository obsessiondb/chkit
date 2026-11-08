import { describe, expect, test } from 'bun:test'

import { configuredIndexGranularity, resolveConfig } from './model.js'

function resolveSecure(url: string, secure?: boolean): boolean | undefined {
  return resolveConfig({ schema: 's', clickhouse: { url, secure } }).clickhouse?.secure
}

describe('resolveConfig clickhouse.secure', () => {
  test('follows the URL scheme when secure is unset', () => {
    expect(resolveSecure('https://host')).toBe(true)
    expect(resolveSecure('HTTPS://host:443')).toBe(true)
    expect(resolveSecure('http://host')).toBe(false)
  })

  test('accepts a secure that agrees with the URL scheme', () => {
    expect(resolveSecure('https://host', true)).toBe(true)
    expect(resolveSecure('http://host:8123', false)).toBe(false)
  })

  test('rejects secure: true with an http:// URL', () => {
    expect(() => resolveSecure('http://host', true)).toThrow(
      'clickhouse.secure is true but clickhouse.url uses http://',
    )
  })

  test('rejects secure: false with an https:// URL', () => {
    expect(() => resolveSecure('https://host', false)).toThrow(
      'clickhouse.secure is false but clickhouse.url uses https://',
    )
  })
})

describe('resolveConfig clickhouse.indexGranularity', () => {
  const resolve = (indexGranularity?: number) =>
    resolveConfig({ schema: 's', clickhouse: { url: 'http://localhost:8123', indexGranularity } })

  test('defaults to 8192, the ClickHouse default', () => {
    expect(resolve().clickhouse?.indexGranularity).toBe(8192)
    expect(configuredIndexGranularity(resolveConfig({ schema: 's' }))).toBe(8192)
  })

  test('takes the server default the config names', () => {
    expect(configuredIndexGranularity(resolve(4096))).toBe(4096)
  })

  test('rejects a value that is not a positive integer', () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolve(value)).toThrow('Invalid clickhouse.indexGranularity')
    }
  })
})
