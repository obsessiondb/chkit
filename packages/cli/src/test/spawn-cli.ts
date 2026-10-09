/**
 * Bounded synchronous process runner for CLI tests.
 *
 * `Bun.spawnSync` blocks the test worker's event loop, so bun's per-test
 * timeout cannot fire while a child is running. Without a spawn-level timeout a
 * stalled child (e.g. a CLI waiting on a slow ClickHouse) hangs the whole test
 * run silently. Every CLI invocation from tests goes through here.
 */

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

export function spawnWithTimeout(cmd: string[], options: SpawnOptions): SpawnResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
  const result = Bun.spawnSync({
    cmd,
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env },
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)

  if (result.exitedDueToTimeout) {
    throw new SpawnTimeoutError(cmd, timeoutMs, stdout, stderr)
  }

  return { exitCode: result.exitCode ?? 1, stdout, stderr }
}
