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
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
