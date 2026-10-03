/**
 * CLI-specific E2E test utilities.
 *
 * Re-exports shared ClickHouse utilities from @chkit/clickhouse/e2e-testkit
 * and adds CLI runner helpers (Bun-specific).
 */

import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { spawnWithTimeout } from './spawn-cli.js'

// Re-export all shared utilities so CLI tests only need one import
export {
  getLiveEnv,
  createLiveExecutor,
  createStatelessLiveExecutor,
  quoteIdent,
  createPrefix,
  createJournalTableName,
  waitForTable,
  waitForView,
  waitForColumn,
  waitForDictionary,
  waitForRows,
  pollUntil,
} from '@chkit/clickhouse/e2e-testkit'

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../../..')
const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')
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
  extraEnv: Record<string, string> = {},
  { timeoutMs }: { timeoutMs?: number } = {}
): CliResult {
  return spawnWithTimeout(['bun', CLI_ENTRY, ...args], { cwd, env: extraEnv, timeoutMs })
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
    timeoutMs,
  }: {
    maxAttempts?: number
    delayMs?: number
    extraEnv?: Record<string, string>
    timeoutMs?: number
  } = {}
): Promise<CliResult> {
  const expectJson = args.includes('--json')
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = runCli(cwd, args, extraEnv, { timeoutMs })
    if (result.exitCode === 0 && (!expectJson || isValidJson(result.stdout))) return result
    if (attempt === maxAttempts) return result
    await sleep(delayMs)
  }
  return runCli(cwd, args, extraEnv, { timeoutMs })
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

/**
 * Polls a CLI command until a predicate on the parsed JSON output passes.
 * Useful for waiting on managed-ClickHouse (e.g. ObsessionDB) replication lag after writes.
 */
export async function waitForCliJson<T>(
  cwd: string,
  args: string[],
  predicate: (payload: T) => boolean,
  {
    maxAttempts = 10,
    delayMs = 1000,
    extraEnv = {},
    timeoutMs,
  }: {
    maxAttempts?: number
    delayMs?: number
    extraEnv?: Record<string, string>
    timeoutMs?: number
  } = {}
): Promise<{ result: CliResult; payload: T }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = runCli(cwd, args, extraEnv, { timeoutMs })
    if (result.exitCode === 0 && isValidJson(result.stdout)) {
      const payload = JSON.parse(result.stdout) as T
      if (predicate(payload)) return { result, payload }
    }
    if (attempt === maxAttempts) {
      throw new Error(
        `waitForCliJson: predicate not satisfied after ${maxAttempts} attempts.\n` +
          formatTestDiagnostic('last attempt', result)
      )
    }
    await sleep(delayMs)
  }
  throw new Error('waitForCliJson: unreachable')
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
