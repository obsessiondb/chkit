import { describe, expect, test } from 'bun:test'

import {
  alreadyClaimedEnvelope,
  CLAIM_COMMAND,
  claimedEnvelope,
  errorEnvelope,
  JSON_CONTRACT_VERSION,
  noEmailEnvelope,
  otpSentEnvelope,
  provisioningEnvelope,
  SERVICE_SELECT_COMMAND,
  serviceListEnvelope,
  SIGNUP_EMAIL_COMMAND,
  verifiedEnvelope,
  verifyCodeCommand,
  whoamiEnvelope,
} from './json-envelope'

describe('signup envelopes', () => {
  test('no_email points the caller at the request-a-code command', () => {
    expect(noEmailEnvelope()).toEqual({
      command: 'obsessiondb signup',
      schemaVersion: JSON_CONTRACT_VERSION,
      status: 'no_email',
      next: { needs: 'email', command: SIGNUP_EMAIL_COMMAND },
    })
  })

  test('otp_sent carries the email and the exact verify command', () => {
    expect(otpSentEnvelope('me@x.com')).toEqual({
      command: 'obsessiondb signup',
      schemaVersion: JSON_CONTRACT_VERSION,
      status: 'otp_sent',
      email: 'me@x.com',
      next: { needs: 'code', command: 'chkit obsessiondb signup --email me@x.com --code <CODE>' },
    })
  })

  test('verified points the caller at claim', () => {
    expect(verifiedEnvelope('me@x.com')).toEqual({
      command: 'obsessiondb signup',
      schemaVersion: JSON_CONTRACT_VERSION,
      status: 'verified',
      email: 'me@x.com',
      next: { needs: 'claim', command: CLAIM_COMMAND },
    })
  })
})

describe('claim envelopes', () => {
  test('claimed includes the selected service and is terminal (next null)', () => {
    expect(claimedEnvelope({ service_slug: 'free-abc', service_name: 'free-abc' })).toEqual({
      command: 'obsessiondb service claim',
      schemaVersion: JSON_CONTRACT_VERSION,
      status: 'claimed',
      service: { service_slug: 'free-abc', service_name: 'free-abc' },
      next: null,
    })
  })

  test('provisioning points the caller at service select', () => {
    expect(provisioningEnvelope()).toEqual({
      command: 'obsessiondb service claim',
      schemaVersion: JSON_CONTRACT_VERSION,
      status: 'provisioning',
      next: { needs: 'select', command: SERVICE_SELECT_COMMAND },
    })
  })

  test('already_claimed points the caller at service select', () => {
    expect(alreadyClaimedEnvelope()).toEqual({
      command: 'obsessiondb service claim',
      schemaVersion: JSON_CONTRACT_VERSION,
      status: 'already_claimed',
      next: { needs: 'select', command: SERVICE_SELECT_COMMAND },
    })
  })
})

describe('errorEnvelope', () => {
  test('emits a stable ok:false shape for failure states', () => {
    expect(errorEnvelope('obsessiondb service claim', 'none_available', 'No capacity.')).toEqual({
      command: 'obsessiondb service claim',
      schemaVersion: JSON_CONTRACT_VERSION,
      ok: false,
      error: { code: 'none_available', message: 'No capacity.' },
    })
  })
})

describe('command strings', () => {
  test('verifyCodeCommand embeds the email so the caller can paste the code', () => {
    expect(verifyCodeCommand('a@b.com')).toBe('chkit obsessiondb signup --email a@b.com --code <CODE>')
  })
})

describe('whoami / service list envelopes', () => {
  test('whoamiEnvelope reports a logged-in status (terminal, no next)', () => {
    expect(whoamiEnvelope({ email: 'me@x.com', name: 'Me' })).toEqual({
      command: 'obsessiondb whoami',
      schemaVersion: JSON_CONTRACT_VERSION,
      status: 'logged_in',
      email: 'me@x.com',
      next: null,
    })
  })

  test('serviceListEnvelope is a single object with a services array', () => {
    expect(
      serviceListEnvelope([
        { organization: 'Numia', slug: 'svc-1', name: 'dev-1', selected: true },
      ]),
    ).toEqual({
      command: 'obsessiondb service list',
      schemaVersion: JSON_CONTRACT_VERSION,
      status: 'ok',
      services: [{ organization: 'Numia', slug: 'svc-1', name: 'dev-1', selected: true }],
    })
  })
})
