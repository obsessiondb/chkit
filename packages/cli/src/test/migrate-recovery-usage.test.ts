import { rm } from 'node:fs/promises'

import { describe, expect, test as bunTest } from 'bun:test'

import { createFixture, runCli } from './testkit.test'

// These tests shell out to the CLI several times. Keep them serial even when the
// package test script runs with --concurrent.
const test = bunTest.serial

type Envelope = { ok: boolean; command: string; error: { code: string; message: string } }

// The fixture config has no clickhouse block: a usage error must surface
// before the "clickhouse config is required" check, so no connection is needed.
async function runMigrate(args: string[]): Promise<{ exitCode: number; envelope: Envelope }> {
  const fixture = await createFixture()
  const result = runCli(['migrate', '--config', fixture.configPath, '--json', ...args])
  await rm(fixture.dir, { recursive: true, force: true })
  return { exitCode: result.exitCode, envelope: JSON.parse(result.stdout) as Envelope }
}

describe('@chkit/cli migrate --retry / --abandon usage (#233)', () => {
  test('--abandon rejects flags that mean nothing for a journal reset', async () => {
    for (const [extra, flag] of [
      [['--retry', 'y'], '--retry'],
      [['--table', 'app.users'], '--table'],
      [['--allow-destructive'], '--allow-destructive'],
    ] as const) {
      const { exitCode, envelope } = await runMigrate(['--abandon', 'x', ...extra])
      expect(exitCode).toBe(1)
      expect(envelope.ok).toBe(false)
      expect(envelope.command).toBe('migrate')
      expect(envelope.error.code).toBe('invalid_usage')
      expect(envelope.error.message).toContain(`--abandon cannot be combined with ${flag}`)
    }
  })

  test('an empty migration name is a usage error', async () => {
    const retry = await runMigrate(['--retry='])
    expect(retry.exitCode).toBe(1)
    expect(retry.envelope.error.code).toBe('invalid_usage')
    expect(retry.envelope.error.message).toContain('--retry requires a migration file name')

    const abandon = await runMigrate(['--abandon=chkit/migrations/'])
    expect(abandon.envelope.error.code).toBe('invalid_usage')
    expect(abandon.envelope.error.message).toContain('--abandon requires a migration file name')
  })

  test('valid --retry and --abandon --apply get as far as the connection check', async () => {
    for (const args of [['--retry', 'x'], ['--abandon', 'x', '--apply']]) {
      const { exitCode, envelope } = await runMigrate(args)
      expect(exitCode).toBe(1)
      expect(envelope.error.message).toContain('clickhouse config is required for migrate')
    }
  })
})
