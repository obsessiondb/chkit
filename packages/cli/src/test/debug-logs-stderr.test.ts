import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'

import { spawnWithTimeout } from './spawn-cli.js'
import { WORKSPACE_ROOT, createFixture } from './testkit.test'

// Bun runs the sources; Node runs the published entry, which `test` builds
// first (packages/cli/turbo.json). Both print `console.debug` and
// `console.info` to stdout, so a logtape console sink must not use them.
// The chkit-py twin is chkit_python/tests/test_debug_logs_stderr.py.
const ENTRIES = [
  { runtime: 'bun', cmd: ['bun', './packages/cli/src/bin/chkit.ts'] },
  { runtime: 'node', cmd: ['node', './packages/cli/dist/bin/chkit.js'] },
] as const

describe('CHKIT_DEBUG=1 with --json', () => {
  for (const { runtime, cmd } of ENTRIES) {
    test(`${runtime}: a successful command prints one JSON document; debug lines go to stderr`, async () => {
      const fixture = await createFixture()
      try {
        const result = spawnWithTimeout(
          [...cmd, 'generate', '--config', fixture.configPath, '--dryrun', '--json'],
          { cwd: WORKSPACE_ROOT, env: { CHKIT_DEBUG: '1' } }
        )

        expect(result.exitCode).toBe(0)
        const payload = JSON.parse(result.stdout) as { command: string }
        expect(payload.command).toBe('generate')
        expect(result.stderr).toContain('[DBG] chkit·cli: ')
        expect(result.stderr).not.toContain('LogTape loggers are configured')
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    })

    test(`${runtime}: a failing command prints one JSON error envelope; debug lines go to stderr`, async () => {
      const fixture = await createFixture()
      try {
        await writeFile(fixture.configPath, "throw new Error('boom')\n", 'utf8')
        const result = spawnWithTimeout(
          [...cmd, 'status', '--config', fixture.configPath, '--json'],
          { cwd: WORKSPACE_ROOT, env: { CHKIT_DEBUG: '1' } }
        )

        expect(result.exitCode).toBe(1)
        const payload = JSON.parse(result.stdout) as { command: string; error: { message: string } }
        expect(payload.command).toBe('status')
        expect(payload.error.message).toContain('boom')
        expect(result.stderr).toContain('[DBG] chkit·')
      } finally {
        await rm(fixture.dir, { recursive: true, force: true })
      }
    })
  }
})
