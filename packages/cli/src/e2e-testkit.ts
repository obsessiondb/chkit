/**
 * Shared E2E test utilities for live ClickHouse tests.
 *
 * Hard-fails on missing env — never skips.
 */

import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { join, resolve } from 'node:path'

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
export const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')
export const CORE_ENTRY = join(WORKSPACE_ROOT, 'packages/core/src/index.ts')

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface LiveEnv {
  clickhouseUrl: string
  clickhouseUser: string
  clickhousePassword: string
  clickhouseDatabase: string
}

/**
 * Reads and validates required ClickHouse env vars.
 * Throws immediately if anything is missing — tests must not silently skip.
 */
export function getRequiredEnv(): LiveEnv {
  const clickhouseHost = process.env.CLICKHOUSE_HOST?.trim()
  const clickhouseUrl =
    process.env.CLICKHOUSE_URL?.trim() || (clickhouseHost ? `https://${clickhouseHost}` : '')
  const clickhouseUser = process.env.CLICKHOUSE_USER?.trim() || 'default'
  const clickhousePassword = process.env.CLICKHOUSE_PASSWORD?.trim() || ''
  const clickhouseDatabase = process.env.CLICKHOUSE_DB?.trim() || 'default'

  if (!clickhouseUrl) {
    throw new Error('Missing CLICKHOUSE_URL or CLICKHOUSE_HOST')
  }

  if (!clickhousePassword) {
    throw new Error('Missing CLICKHOUSE_PASSWORD')
  }

  return { clickhouseUrl, clickhouseUser, clickhousePassword, clickhouseDatabase }
}

// ---------------------------------------------------------------------------
// ClickHouse client helpers
// ---------------------------------------------------------------------------

export function createLiveClient(env: LiveEnv): ClickHouseClient {
  return createClient({
    url: env.clickhouseUrl,
    username: env.clickhouseUser,
    password: env.clickhousePassword,
    database: env.clickhouseDatabase,
    request_timeout: 10_000,
    clickhouse_settings: {
      wait_end_of_query: 1,
      async_insert: 0,
    },
  })
}

export async function runSql(client: ClickHouseClient, sql: string): Promise<void> {
  await client.command({ query: sql })
}

export function quoteIdent(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``
}

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
// Run tags & naming
// ---------------------------------------------------------------------------

export function createRunTag(): string {
  return `${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`
}

export function createPrefix(label: string): string {
  return `chkit_e2e_${label}_${Date.now()}_${Math.floor(Math.random() * 100000)}_`
}

export function createJournalTableName(label: string): string {
  const runTag =
    process.env.GITHUB_RUN_ID?.trim() ||
    `${Date.now()}_${Math.floor(Math.random() * 100000)}`
  return `_chkit_migrations_${label}_${runTag}`
}

// ---------------------------------------------------------------------------
// State-based polling (replaces blind retries)
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Polls ClickHouse until a table exists. Throws after timeout.
 */
export async function waitForTable(
  client: ClickHouseClient,
  database: string,
  tableName: string,
  { timeoutMs = 15_000, intervalMs = 500 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rs = await client.query({
      query: `SELECT 1 FROM system.tables WHERE database = {db:String} AND name = {table:String}`,
      query_params: { db: database, table: tableName },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<Array<Record<string, unknown>>>()
    if (rows.length > 0) return
    await sleep(intervalMs)
  }
  throw new Error(`waitForTable: ${database}.${tableName} did not appear within ${timeoutMs}ms`)
}

/**
 * Polls ClickHouse until a view exists. Throws after timeout.
 */
export async function waitForView(
  client: ClickHouseClient,
  database: string,
  viewName: string,
  { timeoutMs = 15_000, intervalMs = 500 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rs = await client.query({
      query: `SELECT 1 FROM system.tables WHERE database = {db:String} AND name = {view:String} AND engine LIKE '%View%'`,
      query_params: { db: database, view: viewName },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<Array<Record<string, unknown>>>()
    if (rows.length > 0) return
    await sleep(intervalMs)
  }
  throw new Error(`waitForView: ${database}.${viewName} did not appear within ${timeoutMs}ms`)
}

/**
 * Polls ClickHouse until a column exists on a table. Throws after timeout.
 */
export async function waitForColumn(
  client: ClickHouseClient,
  database: string,
  tableName: string,
  columnName: string,
  { timeoutMs = 15_000, intervalMs = 500 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rs = await client.query({
      query: `SELECT 1 FROM system.columns WHERE database = {db:String} AND table = {table:String} AND name = {col:String}`,
      query_params: { db: database, table: tableName, col: columnName },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<Array<Record<string, unknown>>>()
    if (rows.length > 0) return
    await sleep(intervalMs)
  }
  throw new Error(
    `waitForColumn: ${database}.${tableName}.${columnName} did not appear within ${timeoutMs}ms`
  )
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
