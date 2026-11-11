import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ClickHouseExecutor, ClickHouseSettings, ReplicaFanout } from '@chkit/clickhouse'

import { MigrateError } from './errors.js'
import { debug } from '../../runtime/debug.js'
import { CLI_VERSION } from '../../runtime/version.js'

/**
 * The migrate lock (#716): one `migrate --apply` (or `--abandon --apply`) at
 * a time per journal. ClickHouse has no row locks, so each run writes a claim
 * row of its own into the journal and reads every claim back:
 *
 * - A claim is a journal row named `LOCK_ROW_PREFIX<uuid>`, with
 *   `migration_completed = false`, so every release reads past it as it reads
 *   past an in-progress migration. Its `applied_at` is the server time of its
 *   last heartbeat; a released claim gets `RELEASED_AT`, which wins over every
 *   heartbeat in `ReplacingMergeTree(applied_at)` and in the argMax read.
 * - A run holds the lock when, after its claim is acknowledged, it reads no
 *   other live claim (not released, last heartbeat younger than the lease).
 *   Otherwise it releases its claim, waits and tries again, and gives up with
 *   the holder's details. Of two runs that claim at once, at least one reads
 *   the other's acknowledged claim, so at most one proceeds; both may back off.
 * - The read must see every acknowledged claim: on several replicas it reads
 *   every replica (`clusterAllReplicas`), where the replica that took an
 *   INSERT has it once acknowledged; on one, it reads with
 *   `select_sequential_consistency`, after quorum inserts. A run that cannot
 *   read its own claim back stops, rather than take a lock it cannot check.
 * - The holder renews its claim every `heartbeatMs`. A crashed holder's claim
 *   expires `leaseMs` after its last heartbeat. A holder stops before its next
 *   request when no renewal was acknowledged for `validMs` (half the lease),
 *   or when its claim reads released (--break-lock), so it never runs on
 *   while another run may take its expired claim.
 */

export const LOCK_ROW_PREFIX = '__chkit_migrate_lock__/'
/** The version of a released claim: newer than any heartbeat. */
export const RELEASED_AT = '2299-12-31 23:59:59.000'
const RELEASED_FROM = "toDateTime64('2299-01-01 00:00:00', 3, 'UTC')"

export const LOCK_TIMINGS = {
  leaseMs: 120_000,
  validMs: 60_000,
  heartbeatMs: 10_000,
  attempts: 5,
  backoffMinMs: 500,
  backoffMaxMs: 2_000,
}

export type LockTimings = typeof LOCK_TIMINGS

/** Where the claims go: the journal, named in its database. */
export interface LockTarget {
  database: string
  journalTable: string
  fanout: ReplicaFanout | undefined
}

/** Who holds a claim, stored as JSON in the claim row's `checksum`. */
export interface LockHolder {
  host: string
  pid: number
  chkitVersion: string
  startedAt: string
}

export interface LockClaim {
  name: string
  holder: LockHolder | null
  /** The holder JSON as stored, for a claim chkit cannot parse. */
  rawHolder: string
  released: boolean
  /** Milliseconds since the last heartbeat, by the server's clock. */
  ageMs: number
}

export interface MigrateLock {
  /** Throws when the lock may no longer be held. */
  assertHeld(): void
  release(): Promise<void>
}

export interface LockDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
  newId: () => string
  log: (line: string) => void
  timings: LockTimings
}

const DEFAULT_DEPS: Omit<LockDeps, 'log'> = {
  now: () => performance.now(),
  sleep: (ms) => sleep(ms),
  random: Math.random,
  newId: randomUUID,
  timings: LOCK_TIMINGS,
}

/** Whether CHKIT_MIGRATE_LOCK turns the lock off. */
export function migrateLockDisabled(): boolean {
  const value = process.env.CHKIT_MIGRATE_LOCK?.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false'
}

function escapeSqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function quoteName(value: string): string {
  return `\`${value.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``
}

export function claimInsertSql(target: LockTarget, name: string, holderJson: string, released: boolean): string {
  const version = released ? `toDateTime64('${RELEASED_AT}', 3, 'UTC')` : 'now64(3)'
  return (
    `INSERT INTO ${quoteName(target.database)}.${target.journalTable} ` +
    '(name, applied_at, checksum, chkit_version, migration_completed, operations) ' +
    `SELECT '${escapeSqlString(name)}', ${version}, '${escapeSqlString(holderJson)}', '${escapeSqlString(CLI_VERSION)}', false, []`
  )
}

/** Every claim not released, plus `own` whatever its state, newest version per claim. */
export function claimsSelectSql(target: LockTarget, own: string): string {
  const source = target.fanout
    ? `clusterAllReplicas('${escapeSqlString(target.fanout.cluster)}', '${escapeSqlString(target.database)}', '${target.journalTable}')`
    : `${quoteName(target.database)}.${target.journalTable}`
  return (
    'SELECT name, latest.2 AS holder, latest.1 >= ' + RELEASED_FROM + ' AS released, ' +
    'toString(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(latest.1)) AS age_ms ' +
    `FROM (SELECT name, argMax(tuple(applied_at, checksum), applied_at) AS latest FROM ${source} ` +
    `WHERE startsWith(name, '${LOCK_ROW_PREFIX}') GROUP BY name) ` +
    `WHERE NOT released OR name = '${escapeSqlString(own)}' ORDER BY name`
  )
}

/**
 * Settings of a claim write. On one replica the read cannot fan out, so a
 * claim is acknowledged once a majority of replicas has it, which a read
 * with select_sequential_consistency then sees (ReplicatedMergeTree). Plain
 * MergeTree ignores both.
 */
function writeSettings(target: LockTarget): ClickHouseSettings | undefined {
  return target.fanout ? undefined : { insert_quorum: 'auto', insert_quorum_parallel: 0 }
}

function readSettings(target: LockTarget): ClickHouseSettings | undefined {
  return target.fanout ? undefined : { select_sequential_consistency: '1' }
}

function parseBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function parseHolder(raw: string): LockHolder | null {
  try {
    const value = JSON.parse(raw) as Partial<LockHolder>
    if (typeof value.host !== 'string' || typeof value.pid !== 'number') return null
    return {
      host: value.host,
      pid: value.pid,
      chkitVersion: String(value.chkitVersion ?? ''),
      startedAt: String(value.startedAt ?? ''),
    }
  } catch {
    return null
  }
}

async function readClaims(db: ClickHouseExecutor, target: LockTarget, own: string): Promise<LockClaim[]> {
  const rows = await db.query<{ name: string; holder: string; released: unknown; age_ms: string | number }>(
    claimsSelectSql(target, own),
    readSettings(target),
  )
  return rows.map((row) => ({
    name: row.name,
    holder: parseHolder(row.holder),
    rawHolder: row.holder,
    released: parseBool(row.released),
    ageMs: Number(row.age_ms),
  }))
}

export function describeHolder(claim: LockClaim): string {
  const { holder } = claim
  if (!holder) return `claim ${claim.name} (${claim.rawHolder || 'no holder details'})`
  return `pid ${holder.pid} on host ${holder.host} (chkit ${holder.chkitVersion}), started ${holder.startedAt}`
}

function lockedError(target: LockTarget, others: LockClaim[], timings: LockTimings): MigrateError {
  if (others.length === 0) {
    return new MigrateError(
      'migrate_locked',
      `Could not take the migrate lock on ${target.database}.${target.journalTable} in ${timings.attempts} attempts: ` +
        'reading the claim back took too long. Run again.',
    )
  }
  const lines = others.map((claim) => {
    const ago = Math.max(0, Math.round(claim.ageMs / 1000))
    const left = Math.max(0, Math.round((timings.leaseMs - claim.ageMs) / 1000))
    return `  ${describeHolder(claim)}; last heartbeat ${ago}s ago, expires in ${left}s unless renewed`
  })
  return new MigrateError(
    'migrate_locked',
    `Another chkit migrate run holds the migrate lock on ${target.database}.${target.journalTable}:\n${lines.join('\n')}\n` +
      'Wait for it to finish and run again. A run that stopped without releasing the lock (killed, crashed) ' +
      `loses it ${timings.leaseMs / 1000}s after its last heartbeat. If you are sure that run is no longer running, ` +
      're-run with --break-lock.',
  )
}

function unverifiableError(target: LockTarget): MigrateError {
  return new MigrateError(
    'migrate_lock_unverifiable',
    `Cannot take the migrate lock on ${target.database}.${target.journalTable}: a read right after this run wrote its claim did not return it, ` +
      'so this target does not give the read-after-write consistency the lock relies on. Make sure no other migrate runs, ' +
      'then set CHKIT_MIGRATE_LOCK=off to migrate without the lock.',
  )
}

/**
 * Releases every claim that is not released and has not expired, for
 * --break-lock. Returns the claims it released.
 */
async function breakClaims(db: ClickHouseExecutor, target: LockTarget, deps: LockDeps): Promise<LockClaim[]> {
  const claims = (await readClaims(db, target, '')).filter(
    (claim) => !claim.released && claim.ageMs < deps.timings.leaseMs,
  )
  for (const claim of claims) {
    await db.command(claimInsertSql(target, claim.name, claim.rawHolder, true), writeSettings(target))
    deps.log(`Broke the migrate lock held by ${describeHolder(claim)}.`)
  }
  return claims
}

export async function acquireMigrateLock(
  db: ClickHouseExecutor,
  target: LockTarget,
  options: {
    breakLock: boolean
    log: (line: string) => void
    /**
     * Renews the claim while the run's own requests are in flight: an
     * executor with an HTTP session takes one query at a time. Defaults to `db`.
     */
    heartbeatDb?: ClickHouseExecutor
  },
  overrides: Partial<Omit<LockDeps, 'log'>> = {},
): Promise<MigrateLock> {
  const deps: LockDeps = { ...DEFAULT_DEPS, ...overrides, log: options.log }
  const { timings } = deps
  const holder: LockHolder = {
    host: hostname(),
    pid: process.pid,
    chkitVersion: CLI_VERSION,
    startedAt: new Date().toISOString(),
  }
  const holderJson = JSON.stringify(holder)
  if (options.breakLock) await breakClaims(db, target, deps)

  for (let attempt = 1; ; attempt++) {
    const name = `${LOCK_ROW_PREFIX}${deps.newId()}`
    const sentAt = deps.now()
    await db.command(claimInsertSql(target, name, holderJson, false), writeSettings(target))
    const claims = await readClaims(db, target, name)
    const own = claims.find((claim) => claim.name === name)
    const others = claims.filter(
      (claim) => claim.name !== name && !claim.released && claim.ageMs < timings.leaseMs,
    )
    if (own && !own.released && others.length === 0 && deps.now() - sentAt <= timings.validMs) {
      debug('migrate-lock', `acquired ${name} (attempt ${attempt})`)
      return startHolding({ db, heartbeatDb: options.heartbeatDb ?? db }, target, { name, holderJson, confirmedAt: sentAt }, deps)
    }
    await db.command(claimInsertSql(target, name, holderJson, true), writeSettings(target))
    if (!own) throw unverifiableError(target)
    if (attempt >= timings.attempts) throw lockedError(target, others, timings)
    debug('migrate-lock', `lock taken (attempt ${attempt}) by ${others.map(describeHolder).join('; ')} — retrying`)
    const { backoffMinMs, backoffMaxMs } = timings
    await deps.sleep(backoffMinMs + deps.random() * (backoffMaxMs - backoffMinMs))
  }
}

function startHolding(
  { db, heartbeatDb }: { db: ClickHouseExecutor; heartbeatDb: ClickHouseExecutor },
  target: LockTarget,
  claim: { name: string; holderJson: string; confirmedAt: number },
  deps: LockDeps,
): MigrateLock {
  const { timings } = deps
  let confirmedAt = claim.confirmedAt
  let lost: string | undefined
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()

  function lapsed(at: number): boolean {
    return at - confirmedAt > timings.validMs
  }

  // A renewal counts only when it was acknowledged within the validity of the
  // previous one, so two heartbeats are never further apart on the server
  // than validMs, and no reader takes a claim this run still acts on for
  // expired.
  async function heartbeat(): Promise<void> {
    const sentAt = deps.now()
    if (lapsed(sentAt)) {
      lost ??= `no heartbeat was acknowledged for ${Math.round((sentAt - confirmedAt) / 1000)}s`
      return
    }
    try {
      await heartbeatDb.command(claimInsertSql(target, claim.name, claim.holderJson, false), writeSettings(target))
      const own = (await readClaims(heartbeatDb, target, claim.name)).find((item) => item.name === claim.name)
      if (stopped) return
      if (own?.released) {
        lost ??= 'another run released it (--break-lock)'
        return
      }
      if (!own) return
      if (lapsed(deps.now())) {
        lost ??= `no heartbeat was acknowledged for ${Math.round((deps.now() - confirmedAt) / 1000)}s`
        return
      }
      confirmedAt = sentAt
    } catch (error) {
      debug('migrate-lock', `heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function schedule(): void {
    if (stopped || lost !== undefined) return
    timer = setTimeout(() => {
      inFlight = heartbeat().finally(schedule)
    }, timings.heartbeatMs)
    timer.unref?.()
  }
  schedule()

  return {
    assertHeld() {
      if (lost === undefined && lapsed(deps.now())) {
        lost = `no heartbeat was acknowledged for ${Math.round((deps.now() - confirmedAt) / 1000)}s`
      }
      if (lost === undefined) return
      throw new MigrateError(
        'migrate_lock_lost',
        `This run lost the migrate lock on ${target.database}.${target.journalTable} (${lost}), so it stopped before its next request: ` +
          'another run may have taken the lock. Check the journal with chkit status, then run migrate again.',
      )
    },
    async release() {
      stopped = true
      if (timer) clearTimeout(timer)
      // A heartbeat still in flight would race the release write.
      await inFlight.catch(() => undefined)
      try {
        await db.command(claimInsertSql(target, claim.name, claim.holderJson, true), writeSettings(target))
        debug('migrate-lock', `released ${claim.name}`)
      } catch (error) {
        deps.log(
          `⚠ Could not release the migrate lock (${error instanceof Error ? error.message : String(error)}); ` +
            `other runs can take it ${timings.leaseMs / 1000}s after this run's last heartbeat.`,
        )
      }
    },
  }
}

/** Calls `check` before every request of `db` but `close`. */
export function guardExecutor(db: ClickHouseExecutor, check: () => void): ClickHouseExecutor {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || property === 'close') return value
      return (...args: unknown[]) => {
        check()
        return value.apply(target, args)
      }
    },
  })
}
