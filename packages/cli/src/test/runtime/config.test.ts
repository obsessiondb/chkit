import { describe, expect, test } from 'bun:test'

import { parseMissingModule } from '../../runtime/config.js'

describe('parseMissingModule', () => {
  test('extracts the package from a jiti / Node CJS error', () => {
    expect(parseMissingModule("Cannot find module '@chkit/core'")).toBe('@chkit/core')
  })

  test('extracts the package from a Node ESM error', () => {
    expect(parseMissingModule("Cannot find package 'zod' imported from /app/clickhouse.config.ts")).toBe('zod')
  })

  test('extracts the package from a Bun-style error', () => {
    expect(parseMissingModule(`Cannot find package "@chkit/plugin-codegen" from "/app"`)).toBe(
      '@chkit/plugin-codegen',
    )
  })

  test('returns undefined for unrelated errors', () => {
    expect(parseMissingModule('SyntaxError: Unexpected token')).toBeUndefined()
  })
})
