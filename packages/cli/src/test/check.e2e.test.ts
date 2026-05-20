import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'

import { createFixture, runCli } from './testkit.test'

describe('@chkit/cli check e2e', () => {
  test('check requires clickhouse config', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['check', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for check')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
