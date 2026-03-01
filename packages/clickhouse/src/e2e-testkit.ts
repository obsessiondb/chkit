/**
 * Shared E2E test utilities for live ClickHouse tests.
 *
 * Hard-fails on missing env — never skips.
 * Uses ClickHouseExecutor so any package that depends on @chkit/clickhouse can import this.
 */

import { createClickHouseExecutor, type ClickHouseExecutor } from './index.js'

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
// ClickHouse executor helpers
// ---------------------------------------------------------------------------

/**
 * Creates a ClickHouseExecutor configured for E2E tests from env vars.
 */
export function createLiveExecutor(env: LiveEnv): ClickHouseExecutor {
  return createClickHouseExecutor({
    url: env.clickhouseUrl,
    username: env.clickhouseUser,
    password: env.clickhousePassword,
    database: env.clickhouseDatabase,
  })
}

export function quoteIdent(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``
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
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  { timeoutMs = 15_000, intervalMs = 500 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.tables WHERE database = '${database}' AND name = '${tableName}'`
    )
    if (rows.length > 0) return
    await sleep(intervalMs)
  }
  throw new Error(`waitForTable: ${database}.${tableName} did not appear within ${timeoutMs}ms`)
}

/**
 * Polls ClickHouse until a view exists. Throws after timeout.
 */
export async function waitForView(
  executor: ClickHouseExecutor,
  database: string,
  viewName: string,
  { timeoutMs = 15_000, intervalMs = 500 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.tables WHERE database = '${database}' AND name = '${viewName}' AND engine LIKE '%View%'`
    )
    if (rows.length > 0) return
    await sleep(intervalMs)
  }
  throw new Error(`waitForView: ${database}.${viewName} did not appear within ${timeoutMs}ms`)
}

/**
 * Polls ClickHouse until a column exists on a table. Throws after timeout.
 */
export async function waitForColumn(
  executor: ClickHouseExecutor,
  database: string,
  tableName: string,
  columnName: string,
  { timeoutMs = 15_000, intervalMs = 500 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await executor.query<{ x: number }>(
      `SELECT 1 AS x FROM system.columns WHERE database = '${database}' AND table = '${tableName}' AND name = '${columnName}'`
    )
    if (rows.length > 0) return
    await sleep(intervalMs)
  }
  throw new Error(
    `waitForColumn: ${database}.${tableName}.${columnName} did not appear within ${timeoutMs}ms`
  )
}
