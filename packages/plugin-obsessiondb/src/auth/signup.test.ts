import { describe, expect, test } from 'bun:test'

import { deriveOrgName, signupEmailRunbook, slugifyOrgName, verifyStepHint } from './signup'

describe('deriveOrgName', () => {
  test('uses the lowercased email local-part', () => {
    expect(deriveOrgName('Marc@Co.com')).toBe('marc')
  })

  test('falls back to playground for an empty local-part', () => {
    expect(deriveOrgName('@co.com')).toBe('playground')
  })
})

describe('slugifyOrgName', () => {
  test('produces a hyphenated slug with a random suffix', () => {
    const slug = slugifyOrgName('Marc Test')
    expect(slug).toMatch(/^marc-test-[a-z0-9]{1,6}$/)
  })

  test('falls back to playground when the name has no usable characters', () => {
    expect(slugifyOrgName('***')).toMatch(/^playground-[a-z0-9]{1,6}$/)
  })

  test('produces distinct slugs across calls', () => {
    expect(slugifyOrgName('marc')).not.toBe(slugifyOrgName('marc'))
  })
})

describe('signupEmailRunbook', () => {
  test('describes both steps of the non-interactive flow', () => {
    const text = signupEmailRunbook().join('\n')
    expect(text).toContain('chkit obsessiondb signup --email <you@example.com>')
    expect(text).toContain('--code <CODE>')
    expect(text).toContain('chkit obsessiondb service claim')
  })
})

describe('verifyStepHint', () => {
  test('embeds the email in the verify command so the caller can paste the code', () => {
    const text = verifyStepHint('me@x.com').join('\n')
    expect(text).toContain('chkit obsessiondb signup --email me@x.com --code <CODE>')
    expect(text).toContain('chkit obsessiondb service claim')
  })
})
