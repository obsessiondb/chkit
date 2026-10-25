import { describe, expect, test } from 'bun:test'

import { resolveConfig } from './model.js'

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
