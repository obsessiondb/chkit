import { describe, expect, test } from 'bun:test'

import { buildJsonErrorEnvelope } from '../../runtime/json-output.js'

describe('buildJsonErrorEnvelope', () => {
  test('produces the stable ok:false error envelope', () => {
    const envelope = buildJsonErrorEnvelope('migrate', {
      code: 'error',
      message: 'Authentication failed for user "default" at https://x.',
    })
    expect(envelope).toEqual({
      command: 'migrate',
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'error',
        message: 'Authentication failed for user "default" at https://x.',
      },
    })
  })

  test('preserves an optional hint', () => {
    const envelope = buildJsonErrorEnvelope('status', {
      code: 'MODULE_NOT_FOUND',
      message: 'cannot find "@chkit/core"',
      hint: 'Run bun install',
    })
    expect(envelope.ok).toBe(false)
    expect(envelope.error.hint).toBe('Run bun install')
  })
})
