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
import { allReplicas, resolveReplicaFanoutOrThrow, stringLiteral } from './replicas.js'

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
 * The ClickHouse in test/infra/docker-compose.yml, which `infra:up` starts on
 * CHKIT_TEST_PORT (default 8123).
 */
export const LOCAL_STACK_ENV: LiveEnv = {
  clickhouseUrl: `http://localhost:${process.env.CHKIT_TEST_PORT?.trim() || '8123'}`,
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

/**
 * Drops a test database, re-running the DROP while it fails with
 * `DATABASE_NOT_EMPTY`.
 *
 * DROP DATABASE drops the tables the serving replica lists, then fails if a
 * table appeared meanwhile. On a multi-replica service (ObsessionDB) that
 * happens when the replica applies an earlier CREATE during the drop; the
 * server answers "Try again". Any other error throws at once. `timeoutMs`
 * stops the re-runs; it does not cut short a DROP that is still running.
 * chkit-py's twin is `drop_database`.
 */
export async function dropDatabase(
  executor: Pick<ClickHouseExecutor, 'command'>,
  database: string,
  options: PollUntilOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
      return
    } catch (error) {
      const text = `${(error as { type?: unknown }).type ?? ''} ${error instanceof Error ? error.message : String(error)}`
      if (Date.now() >= deadline || !text.includes('DATABASE_NOT_EMPTY')) throw error
    }
    await sleep(intervalMs)
  }
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
  // The CI run id alone is not unique: the TS and Python suites run at the same
  // time against one server and share labels, so a random suffix always follows.
  const runTag = process.env.GITHUB_RUN_ID?.trim() || `${Date.now()}`
  return `_chkit_migrations_${label}_${runTag}_${Math.floor(Math.random() * 100000)}`
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

// Errors a replica that has not applied an earlier CREATE answers with.
const NOT_YET_VISIBLE_ERRORS = ['UNKNOWN_TABLE', 'UNKNOWN_DATABASE']

/**
 * Runs a statement that needs an object an earlier DDL created.
 *
 * On a multi-replica service (ObsessionDB) each request may land on a
 * different replica, and one that hasn't applied the CREATE yet answers
 * `UNKNOWN_TABLE` or `UNKNOWN_DATABASE`. Such a failure changes nothing, so
 * the statement is re-run until the replica serving it sees the object; any
 * other error throws at once. chkit-py's twin is `run_once_visible`.
 */
export async function runOnceVisible<T>(run: () => Promise<T>, options: PollUntilOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await run()
    } catch (error) {
      const text = `${(error as { type?: unknown }).type ?? ''} ${error instanceof Error ? error.message : String(error)}`
      if (Date.now() >= deadline || !NOT_YET_VISIBLE_ERRORS.some((code) => text.includes(code))) throw error
    }
    await sleep(intervalMs)
  }
}

// ---------------------------------------------------------------------------
// Replica-local statements
// ---------------------------------------------------------------------------

/**
 * Runs a replica-local statement, such as `SYSTEM STOP MERGES db.t`, on every
 * replica of the target, and returns once each replica's `system.query_log`
 * shows it finished there.
 *
 * On a multi-replica service (ObsessionDB) a SYSTEM statement acts only on the
 * replica that serves it, and ON CLUSTER is refused. The load balancer picks
 * the replica per connection, and a client's keep-alive connection stays on
 * one, so the statement is sent on a new connection each time, tagged with a
 * `log_comment`, until every replica `clusterAllReplicas` reaches has logged
 * it. The statement must be safe to repeat. On a single node it runs once,
 * through `executor`. chkit-py's twin is `run_on_every_replica`.
 */
export async function runOnEveryReplica(
  executor: ClickHouseExecutor,
  env: LiveEnv,
  statement: string,
  options: PollUntilOptions = {},
): Promise<void> {
  const fanout = await resolveReplicaFanoutOrThrow(executor)
  if (!fanout) {
    await executor.command(statement)
    return
  }
  const tag = `chkit_e2e_every_replica_${createRunTag()}`
  const coverage =
    `SELECT (SELECT count(DISTINCT hostName()) FROM ${allReplicas(fanout, 'system.one')}) AS replicas, ` +
    `(SELECT count(DISTINCT hostName()) FROM ${allReplicas(fanout, 'system.query_log')} ` +
    `WHERE event_date >= yesterday() AND type = 'QueryFinish' AND log_comment = ${stringLiteral(tag)}) AS ran ` +
    'SETTINGS skip_unavailable_shards = 0'
  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await sendOnNewConnection(env, statement, { log_comment: tag })
    // A replica writes its query_log every few seconds; a flush writes it now.
    await sendOnNewConnection(env, 'SYSTEM FLUSH LOGS')
    const [row] = await executor.query<{ replicas: number | string; ran: number | string }>(coverage)
    const replicas = Number(row?.replicas ?? 0)
    const ran = Number(row?.ran ?? 0)
    if (replicas > 0 && ran >= replicas) return
    if (Date.now() >= deadline) {
      throw new Error(`runOnEveryReplica: ${statement} ran on ${ran} of ${replicas} replicas after ${timeoutMs} ms`)
    }
    await sleep(intervalMs)
  }
}

// One HTTP request on a connection of its own, which the load balancer may
// send to any replica.
async function sendOnNewConnection(env: LiveEnv, sql: string, settings: Record<string, string> = {}): Promise<void> {
  const credentials = Buffer.from(`${env.clickhouseUser}:${env.clickhousePassword}`).toString('base64')
  const response = await fetch(`${env.clickhouseUrl.replace(/\/+$/, '')}/?${new URLSearchParams(settings)}`, {
    method: 'POST',
    body: sql,
    keepalive: false,
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Basic ${credentials}`, Connection: 'close' },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${sql}: HTTP ${response.status}: ${text}`)
}

// Re-exported from ddl-propagation for test convenience.

export {
  waitForTable,
  waitForTableAbsent,
  waitForView,
  waitForColumn,
  waitForDictionary,
  waitForRows,
} from './ddl-propagation.js'
