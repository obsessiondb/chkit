import { afterEach, describe, expect, test } from 'bun:test'

import { noEmailEnvelope } from '../json-envelope'
import { deriveOrgName, runSignup, signupEmailRunbook, slugifyOrgName, verifyStepHint } from './signup'

describe('deriveOrgName', () => {
  test('uses the lowercased email local-part', () => {
    expect(deriveOrgName('Marc@Co.com')).toBe('marc')
  })

  test('falls back to playground for an empty local-part', () => {
    expect(deriveOrgName('@co.com')).toBe('playground')
  })

  test('strips the +subaddress from a plus-addressed email', () => {
    expect(deriveOrgName('marc+clisignup@numia.xyz')).toBe('marc')
  })

  test('keeps dots in a dotted local-part', () => {
    expect(deriveOrgName('marc.hoeffl@numia.xyz')).toBe('marc.hoeffl')
  })

  test('falls back to playground for an all-symbol local-part', () => {
    expect(deriveOrgName('+++@x.com')).toBe('playground')
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

  test('collapses separator runs and strips leading/trailing dashes', () => {
    expect(slugifyOrgName('--a..b--')).toMatch(/^a-b-[a-z0-9]{1,6}$/)
  })

  test('handles a long run of separators without leaving dashes', () => {
    expect(slugifyOrgName(`${'-'.repeat(50)}x`)).toMatch(/^x-[a-z0-9]{1,6}$/)
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

// The no-email, non-interactive branch returns before any network call, so it is the one
// runSignup state we can exercise without a live API. Force non-TTY to make the path deterministic.
describe('runSignup with no email (non-interactive)', () => {
  const originalIsTTY = process.stdin.isTTY

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY
  })

  test('jsonMode emits a single no_email envelope and exits non-zero', async () => {
    process.stdin.isTTY = false
    const emitted: unknown[] = []
    const code = await runSignup('https://api.test.com', (v) => emitted.push(v), { jsonMode: true })

    expect(code).toBe(1)
    expect(emitted).toEqual([noEmailEnvelope()])
  })

  test('prose mode prints the two-step runbook and exits non-zero', async () => {
    process.stdin.isTTY = false
    const emitted: unknown[] = []
    const code = await runSignup('https://api.test.com', (v) => emitted.push(v))

    expect(code).toBe(1)
    expect(emitted).toHaveLength(1)
    expect(String(emitted[0])).toContain('chkit obsessiondb signup --email <you@example.com>')
  })
})
