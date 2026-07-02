/**
 * Shared E2E test utilities for live ClickHouse tests.
 *
 * Hard-fails on missing env — never skips.
 * Uses ClickHouseExecutor so any package that depends on @chkit/clickhouse can import this.
 */

import {
  createClickHouseExecutor,
  createStatelessClickHouseExecutor,
  type ClickHouseExecutor,
} from './index.js'

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

/**
 * Use only for live tests that intentionally issue parallel queries through one
 * executor. The default live executor is session-bound and should be used for
 * normal sequential DDL workflows.
 */
export function createStatelessLiveExecutor(env: LiveEnv): ClickHouseExecutor {
  return createStatelessClickHouseExecutor({
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
// State-based polling (re-exported from ddl-propagation for test convenience)
// ---------------------------------------------------------------------------

export {
  waitForTable,
  waitForView,
  waitForColumn,
  waitForRows,
} from './ddl-propagation.js'
