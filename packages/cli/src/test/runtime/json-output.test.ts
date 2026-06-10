import { describe, expect, test } from 'bun:test'

import { buildJsonErrorEnvelope, emitJson, hasEmittedJson } from '../../runtime/json-output.js'

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

describe('hasEmittedJson (no-double-emit guard)', () => {
  // The top-level catch only emits an error envelope when `!hasEmittedJson()`.
  // So once a command has written its own JSON payload, the flag must be set —
  // otherwise a command that emits JSON and then throws would print two JSON
  // objects to stdout, breaking the consumer.
  test('a successful JSON emit marks output as emitted', () => {
    const original = console.log
    console.log = () => {}
    try {
      emitJson('migrate', { mode: 'execute', applied: [] })
    } finally {
      console.log = original
    }
    expect(hasEmittedJson()).toBe(true)
  })
})
