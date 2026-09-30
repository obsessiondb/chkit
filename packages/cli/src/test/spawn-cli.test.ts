import { describe, expect, test } from 'bun:test'

import { SpawnTimeoutError, spawnWithTimeout } from './spawn-cli.js'

describe('spawnWithTimeout', () => {
  test('returns exit code and output of a command that finishes in time', () => {
    const result = spawnWithTimeout(['sh', '-c', 'echo out; echo err >&2; exit 3'], {
      cwd: process.cwd(),
    })
    expect(result).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
  })

  test('kills a command that exceeds the timeout and throws with its partial output', () => {
    const started = Date.now()
    expect(() =>
      spawnWithTimeout(['sh', '-c', 'echo started; exec sleep 30'], {
        cwd: process.cwd(),
        timeoutMs: 300,
      })
    ).toThrow(SpawnTimeoutError)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('timeout error names the command and includes captured output', () => {
    expect(() =>
      spawnWithTimeout(['sh', '-c', 'echo partial; exec sleep 30'], {
        cwd: process.cwd(),
        timeoutMs: 300,
      })
    ).toThrow(/timed out after 300ms[\s\S]*sh -c[\s\S]*partial/)
  })
})
