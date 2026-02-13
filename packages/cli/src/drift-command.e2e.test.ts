import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'

import { renderScopedSchema } from './commands.e2e-helpers'
import { createFixture, runCli } from './testkit.test'

describe('@chx/cli drift command e2e', () => {
  test('drift --json fails with actionable error when clickhouse config is missing', async () => {
    const fixture = await createFixture()
    try {
      const generated = runCli(['generate', '--config', fixture.configPath, '--json'])
      expect(generated.exitCode).toBe(0)

      const result = runCli(['drift', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('clickhouse config is required for drift checks')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('drift --json --table returns warning no-op for zero matches without clickhouse config', async () => {
    const fixture = await createFixture(renderScopedSchema())
    try {
      runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json'])
      const result = runCli(['drift', '--config', fixture.configPath, '--table', 'missing_*', '--json'])
      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        drifted: boolean
        warning: string
        scope: { enabled: boolean; matchCount: number }
      }
      expect(payload.scope.enabled).toBe(true)
      expect(payload.scope.matchCount).toBe(0)
      expect(payload.drifted).toBe(false)
      expect(payload.warning).toContain('No tables matched selector')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
