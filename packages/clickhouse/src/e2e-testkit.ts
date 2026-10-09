/**
 * Shared E2E test utilities for live ClickHouse tests.
 *
 * Targets the local test stack (test/infra) unless CLICKHOUSE_* points elsewhere.
 * Never skips: an unreachable server fails the test.
 * Uses ClickHouseExecutor so any package that depends on @chkit/clickhouse can import this.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { quoteIdentifier } from '@chkit/core'

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

/** The ClickHouse in test/infra/docker-compose.yml, which `infra:up` starts. */
export const LOCAL_STACK_ENV: LiveEnv = {
  clickhouseUrl: 'http://localhost:8123',
  clickhouseUser: 'default',
  clickhousePassword: 'chkit-ci',
  clickhouseDatabase: 'default',
}

/**
 * Reads the ClickHouse target from env vars. Without CLICKHOUSE_URL or
 * CLICKHOUSE_HOST, tests run against the local test stack. A remote target
 * must also set CLICKHOUSE_PASSWORD.
 */
export function getLiveEnv(): LiveEnv {
  const clickhouseHost = process.env.CLICKHOUSE_HOST?.trim()
  const clickhouseUrl =
    process.env.CLICKHOUSE_URL?.trim() || (clickhouseHost ? `https://${clickhouseHost}` : '')
  if (!clickhouseUrl) return LOCAL_STACK_ENV

  const clickhouseUser = process.env.CLICKHOUSE_USER?.trim() || 'default'
  const clickhousePassword = process.env.CLICKHOUSE_PASSWORD?.trim() || ''
  const clickhouseDatabase = process.env.CLICKHOUSE_DB?.trim() || 'default'

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
  return quoteIdentifier(value)
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
// State-based polling
// ---------------------------------------------------------------------------

export interface PollUntilOptions {
  timeoutMs?: number
  intervalMs?: number
}

/**
 * Re-reads `read()` until `predicate` accepts its value or `timeoutMs` elapses.
 * Unlike `waitForRows`, running out of time returns the last observed value
 * instead of throwing, so the caller's own `expect` reports the real diff.
 * A read that keeps throwing until the deadline rethrows its last error.
 *
 * Put the whole observation inside `read` (e.g. `SYSTEM RELOAD DICTIONARY`
 * followed by `dictGet`): on multi-replica services each attempt may land on a
 * different replica, so a one-off preparation step can't be relied on.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: PollUntilOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value: T
    try {
      value = await read()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await sleep(intervalMs)
      continue
    }
    if (predicate(value) || Date.now() >= deadline) return value
    await sleep(intervalMs)
  }
}

// Re-exported from ddl-propagation for test convenience.

export {
  waitForTable,
  waitForView,
  waitForColumn,
  waitForDictionary,
  waitForRows,
} from './ddl-propagation.js'
