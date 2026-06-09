import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'

import { createFixture, runCli } from './testkit.test'

describe('@chkit/cli status e2e', () => {
  test('status requires clickhouse config', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['status', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for status')
      // #4: --json emits a parseable error envelope to stdout.
      const envelope = JSON.parse(result.stdout) as { ok: boolean; command: string; error: { message: string } }
      expect(envelope.ok).toBe(false)
      expect(envelope.command).toBe('status')
      expect(envelope.error.message).toContain('clickhouse config is required for status')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
