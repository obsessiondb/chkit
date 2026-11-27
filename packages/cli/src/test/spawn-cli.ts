/**
 * Bounded synchronous process runner for CLI tests.
 *
 * `Bun.spawnSync` blocks the test worker's event loop, so bun's per-test
 * timeout cannot fire while a child is running. Without a spawn-level timeout a
 * stalled child (e.g. a CLI waiting on a slow ClickHouse) hangs the whole test
 * run silently. Every CLI invocation from tests goes through here, and each one
 * gets an empty user config dir (see {@link createIsolatedCliEnv}).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_CLI_TIMEOUT_MS = 120_000

export interface SpawnResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SpawnOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Kill the child and throw after this many ms. Defaults to {@link DEFAULT_CLI_TIMEOUT_MS}. */
  timeoutMs?: number
}

export class SpawnTimeoutError extends Error {
  constructor(
    readonly cmd: string[],
    readonly timeoutMs: number,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(
      [
        `Command timed out after ${timeoutMs}ms and was killed: ${cmd.join(' ')}`,
        `--- stdout (partial) ---\n${stdout || '(empty)'}`,
        `--- stderr (partial) ---\n${stderr || '(empty)'}`,
      ].join('\n')
    )
    this.name = 'SpawnTimeoutError'
  }
}

/**
 * Creates the environment for a CLI a test spawns: the test's own environment,
 * with XDG_CONFIG_HOME set to a fresh empty directory, then `env` on top.
 *
 * The developer's `~/.config/chkit` must not reach a test: with a
 * `chkit obsessiondb login` there, every config gets the obsessiondb plugin,
 * whose hooks call the console API and reject a `--service` the account does
 * not have. A test that needs a user config dir passes its own XDG_CONFIG_HOME,
 * which wins. Call `cleanup` once the child has exited.
 */
export function createIsolatedCliEnv(env?: Record<string, string | undefined>): {
  env: Record<string, string | undefined>
  cleanup: () => void
} {
  const configHome = mkdtempSync(join(tmpdir(), 'chkit-test-xdg-'))
  return {
    env: { ...process.env, XDG_CONFIG_HOME: configHome, ...env },
    cleanup: () => rmSync(configHome, { recursive: true, force: true }),
  }
}

export function spawnWithTimeout(cmd: string[], options: SpawnOptions): SpawnResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
  const isolated = createIsolatedCliEnv(options.env)
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync({
      cmd,
      cwd: options.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: isolated.env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
  } finally {
    isolated.cleanup()
  }
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)

  if (result.exitedDueToTimeout) {
    throw new SpawnTimeoutError(cmd, timeoutMs, stdout, stderr)
  }

  return { exitCode: result.exitCode ?? 1, stdout, stderr }
}
