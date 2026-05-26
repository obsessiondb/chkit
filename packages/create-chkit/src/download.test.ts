import { describe, expect, test } from 'bun:test'

import { resolveExampleSource } from './download.js'
import { CREATE_CHKIT_VERSION } from './version.js'

describe('resolveExampleSource', () => {
  test('pins bare example name to the create-chkit release tag for reproducibility', () => {
    expect(resolveExampleSource('clickbench')).toBe(
      `github:obsessiondb/chkit/examples/clickbench#create-chkit@${CREATE_CHKIT_VERSION}`,
    )
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
