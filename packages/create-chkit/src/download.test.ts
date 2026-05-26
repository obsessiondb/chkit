import { describe, expect, test } from 'bun:test'

import { resolveExampleSource } from './download.js'

describe('resolveExampleSource', () => {
  test('expands bare example name to github obsessiondb/chkit subdirectory', () => {
    expect(resolveExampleSource('clickbench')).toBe('github:obsessiondb/chkit/examples/clickbench#main')
  })

  test('passes through full https url', () => {
    const url = 'https://github.com/some-user/some-repo/tree/main/templates/foo'
    expect(resolveExampleSource(url)).toBe(url)
  })

  test('passes through giget provider shorthand', () => {
    expect(resolveExampleSource('gh:user/repo/path#dev')).toBe('gh:user/repo/path#dev')
    expect(resolveExampleSource('github:user/repo')).toBe('github:user/repo')
    expect(resolveExampleSource('gitlab:user/repo')).toBe('gitlab:user/repo')
  })
})
