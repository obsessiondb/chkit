import { rm } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

import { createFixture, runCli } from './testkit.test'

type Envelope = { ok: boolean; command: string; error: { code: string; message: string } }

describe('@chkit/cli usage-error --json envelopes (#4)', () => {
  test('unknown command emits a JSON envelope on stdout (not help text)', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['definitely-not-a-command', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      // A clean parse proves stdout holds ONLY the envelope — no help dump that
      // would break a `jq` consumer.
      const envelope = JSON.parse(result.stdout) as Envelope
      expect(envelope.ok).toBe(false)
      expect(envelope.command).toBe('definitely-not-a-command')
      expect(envelope.error.code).toBe('unknown_command')
      expect(envelope.error.message).toContain('Unknown command')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('unknown command without --json still prints help to stdout (human path intact)', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['definitely-not-a-command', '--config', fixture.configPath])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unknown command')
      // Non-JSON keeps the helpful global help on stdout.
      expect(result.stdout.length).toBeGreaterThan(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('well-known plugin command without the plugin emits a JSON envelope', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['codegen', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      const envelope = JSON.parse(result.stdout) as Envelope
      expect(envelope.ok).toBe(false)
      expect(envelope.error.code).toBe('plugin_not_configured')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
