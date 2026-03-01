/**
 * CLI-specific E2E test utilities.
 *
 * Re-exports shared ClickHouse utilities from @chkit/clickhouse/e2e-testkit
 * and adds CLI runner helpers (Bun-specific).
 */

import { join, resolve } from 'node:path'

// Re-export all shared utilities so CLI tests only need one import
export {
  type LiveEnv,
  getRequiredEnv,
  createLiveExecutor,
  quoteIdent,
  createRunTag,
  createPrefix,
  createJournalTableName,
  waitForTable,
  waitForView,
  waitForColumn,
} from '@chkit/clickhouse/e2e-testkit'

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
export const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')
export const CORE_ENTRY = join(WORKSPACE_ROOT, 'packages/core/src/index.ts')

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): CliResult {
  const result = Bun.spawnSync({
    cmd: ['bun', CLI_ENTRY, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...extraEnv },
  })

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

function isValidJson(str: string): boolean {
  try {
    JSON.parse(str)
    return true
  } catch {
    return false
  }
}

export async function runCliWithRetry(
  cwd: string,
  args: string[],
  {
    maxAttempts = 5,
    delayMs = 2000,
    extraEnv = {},
  }: { maxAttempts?: number; delayMs?: number; extraEnv?: Record<string, string> } = {}
): Promise<CliResult> {
  const expectJson = args.includes('--json')
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = runCli(cwd, args, extraEnv)
    if (result.exitCode === 0 && (!expectJson || isValidJson(result.stdout))) return result
    if (attempt === maxAttempts) return result
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return runCli(cwd, args, extraEnv)
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Formats a structured diagnostic for test failures involving CLI results.
 */
export function formatTestDiagnostic(
  label: string,
  result: CliResult,
  extra?: Record<string, unknown>
): string {
  const parts = [
    `--- ${label} ---`,
    `exitCode: ${result.exitCode}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ]
  if (extra) {
    parts.push(`extra: ${JSON.stringify(extra, null, 2)}`)
  }
  return parts.join('\n')
}
