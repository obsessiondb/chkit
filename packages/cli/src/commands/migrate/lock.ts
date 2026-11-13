import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ClickHouseExecutor, ClickHouseSettings, ReplicaFanout } from '@chkit/clickhouse'

import { debug } from '../../runtime/debug.js'
import { CLI_VERSION } from '../../runtime/version.js'
import { MigrateError } from './errors.js'
import type { QueryIdentity } from './query-intents.js'

/**
 * The migrate lock (#716): one `migrate --apply` (or `--abandon --apply`) at
 * a time per journal. ClickHouse has no row locks, so each run writes a claim
 * row of its own into the journal and reads every claim back:
 *
 * - A claim is a journal row named `LOCK_ROW_PREFIX<uuid>`, with
 *   `migration_completed = false`, so every release reads past it as it reads
 *   past an in-progress migration. Its `applied_at` is its version: the server
 *   time of the claim, and of each heartbeat after it, but always above the
 *   version the holder last read back, so it grows whatever the replicas'
 *   clocks. A released claim gets `RELEASED_AT`, which wins over every
 *   heartbeat in `ReplacingMergeTree(applied_at)` and in the argMax read.
 * - A run holds the lock when, after its claim is acknowledged, it reads no
 *   other claim that is not released. Of two runs that claim at once, at
 *   least one reads the other's acknowledged claim, so at most one proceeds;
 *   both may back off, release their claim and try again.
 * - The read must see every acknowledged claim: on several replicas it reads
 *   every replica (`clusterAllReplicas`, failing when one does not answer),
 *   where the replica that took an INSERT has it once acknowledged; on one, it
 *   reads with `select_sequential_consistency`, after quorum inserts. A run
 *   that cannot read its own claim back stops, rather than take a lock it
 *   cannot check.
 * - The holder renews its claim every `heartbeatMs`, numbering each write in
 *   the holder JSON. A renewal counts from the heartbeat's send time once its
 *   row reads back as the claim's newest, within `validMs` of the previous
 *   renewal; a heartbeat that does not read back stops the run, since it may
 *   still reach the server later. Every request of the run
 *   first checks that the last counted renewal was sent less than `validMs`
 *   ago, and that the claim was not released by --break-lock.
 * - A claim whose last heartbeat the server dates more than `leaseMs` back
 *   may belong to a run that stopped. Server clocks of different replicas can
 *   disagree, so another run takes it for stopped only after it read the
 *   same version for `validMs + OBSERVE_MARGIN_MS` by its own clock: by then
 *   that run counts no renewal and makes no request. It then releases it.
 */

export const LOCK_ROW_PREFIX = '__chkit_migrate_lock__/'
/** The version of a released claim: newer than any heartbeat. */
const RELEASED_AT = '2299-12-31 23:59:59.000'
const RELEASED_FROM = "toDateTime64('2299-01-01 00:00:00', 3, 'UTC')"
/** How long release() waits for a heartbeat in flight. */
const RELEASE_WAIT_MS = 5_000
/** Reads of a heartbeat's row, and the wait between two. */
const READ_ATTEMPTS = 3
const READ_RETRY_MS = 1_000

export const LOCK_TIMINGS = {
  leaseMs: 120_000,
  validMs: 60_000,
  heartbeatMs: 10_000,
  /** Added to validMs while watching a claim that looks stopped. */
  observeMarginMs: 5_000,
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
interface LockHolder {
  host: string
  pid: number
  chkitVersion: string
  startedAt: string
  /** Which write of the holder the row is: 0 for the claim, then one per heartbeat. */
  beat: number
  queries?: QueryIdentity
  recoveryOf?: string
}

interface LockClaim {
  name: string
  holder: LockHolder | null
  /** The holder JSON as stored, for a claim chkit cannot parse. */
  rawHolder: string
  released: boolean
  /** The claim's newest `applied_at`, as `YYYY-MM-DD hh:mm:ss.sss`. */
  version: string
  /** Milliseconds since the last heartbeat, by the server's clocks. */
  ageMs: number
}

export interface MigrateLock {
  /** Owning claim, available for durable query associations. */
  readonly claimId?: string
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

/**
 * A claim row. `released` writes the release version; otherwise the version
 * is the server time, and above `after` (the version last read back) when set.
 */
export function claimInsertSql(
  target: LockTarget,
  name: string,
  holderJson: string,
  version: { released: true } | { released: false; after?: string },
): string {
  const expression = version.released
    ? `toDateTime64('${RELEASED_AT}', 3, 'UTC')`
    : version.after === undefined
      ? 'now64(3)'
      : `greatest(now64(3), toDateTime64('${escapeSqlString(version.after)}', 3, 'UTC') + toIntervalMillisecond(1))`
  return (
    `INSERT INTO ${quoteName(target.database)}.${target.journalTable} ` +
    '(name, applied_at, checksum, chkit_version, migration_completed, operations) ' +
    `SELECT '${escapeSqlString(name)}', ${expression}, '${escapeSqlString(holderJson)}', '${escapeSqlString(CLI_VERSION)}', false, []`
  )
}

/**
 * Every claim not released, plus `own` whatever its state: the newest row per
 * claim, and of rows with one version the one of the latest heartbeat, so
 * every read of the same rows picks the same one.
 */
export function claimsSelectSql(target: LockTarget, own: string): string {
  const source = target.fanout
    ? `clusterAllReplicas('${escapeSqlString(target.fanout.cluster)}', '${escapeSqlString(target.database)}', '${target.journalTable}')`
    : `${quoteName(target.database)}.${target.journalTable}`
  // A read that misses a replica could miss the claim on it, so a fanned-out
  // read fails instead of skipping an unavailable replica.
  const settings = target.fanout ? ' SETTINGS skip_unavailable_shards = 0' : ''
  return (
    `SELECT name, latest.2 AS holder, latest.1 >= ${RELEASED_FROM} AS released, toString(latest.1) AS version, ` +
    'toString(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(latest.1)) AS age_ms ' +
    `FROM (SELECT name, argMax(tuple(applied_at, checksum), tuple(applied_at, JSONExtractInt(checksum, 'beat'))) AS latest FROM ${source} ` +
    `WHERE startsWith(name, '${LOCK_ROW_PREFIX}') GROUP BY name) ` +
    `WHERE NOT released OR name = '${escapeSqlString(own)}' ORDER BY name${settings}`
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
      beat: typeof value.beat === 'number' ? value.beat : -1,
    }
  } catch {
    return null
  }
}

async function readClaims(db: ClickHouseExecutor, target: LockTarget, own: string): Promise<LockClaim[]> {
  const rows = await db.query<{ name: string; holder: string; released: unknown; version: string; age_ms: string | number }>(
    claimsSelectSql(target, own),
    readSettings(target),
  )
  return rows.map((row) => ({
    name: row.name,
    holder: parseHolder(row.holder),
    rawHolder: row.holder,
    released: parseBool(row.released),
    version: row.version,
    ageMs: Number(row.age_ms),
  }))
}

async function writeClaim(
  db: ClickHouseExecutor,
  target: LockTarget,
  name: string,
  holderJson: string,
  version: { released: true } | { released: false; after?: string },
): Promise<void> {
  await db.command(claimInsertSql(target, name, holderJson, version), writeSettings(target))
}

/** The id `--break-lock` takes: the claim name without its prefix. */
function claimId(claim: LockClaim): string {
  return claim.name.slice(LOCK_ROW_PREFIX.length)
}

function describeHolder(claim: LockClaim): string {
  const { holder } = claim
  const who = holder
    ? `pid ${holder.pid} on host ${holder.host} (chkit ${holder.chkitVersion}), started ${holder.startedAt}`
    : claim.rawHolder || 'no holder details'
  return `claim ${claimId(claim)}: ${who}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000))
}

function lockedError(target: LockTarget, others: LockClaim[], timings: LockTimings): MigrateError {
  if (others.length === 0) {
    return new MigrateError(
      'migrate_locked',
      `Could not take the migrate lock on ${target.database}.${target.journalTable} in ${timings.attempts} attempts: ` +
        'reading the claim back took too long. Run again.',
    )
  }
  const lines = others.map(
    (claim) =>
      `  ${describeHolder(claim)}; last heartbeat ${seconds(claim.ageMs)}s ago, free in ${seconds(timings.leaseMs - claim.ageMs)}s unless renewed`,
  )
  const first = others[0] as LockClaim
  return new MigrateError(
    'migrate_locked',
    `Another chkit migrate run holds the migrate lock on ${target.database}.${target.journalTable}:\n${lines.join('\n')}\n` +
      'Wait for it to finish and run again. A run that stopped without releasing the lock (killed, crashed) ' +
      `loses it ${timings.leaseMs / 1000}s after its last heartbeat. If you are sure that run is no longer running, ` +
      `re-run with --break-lock ${claimId(first)}.`,
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
 * --break-lock <claim>: releases that claim, which the user checked belongs
 * to a run that is no longer running. Any other claim still holds the lock.
 */
async function breakClaim(db: ClickHouseExecutor, target: LockTarget, id: string, deps: LockDeps): Promise<void> {
  const claim = (await readClaims(db, target, '')).find(
    (item) => !item.released && (claimId(item) === id || item.name === id),
  )
  if (!claim) {
    deps.log(`--break-lock: claim ${id} does not hold the migrate lock; taking the lock as usual.`)
    return
  }
  await writeClaim(db, target, claim.name, claim.rawHolder, { released: true })
  deps.log(`Broke the migrate lock of ${describeHolder(claim)}.`)
}

/**
 * Claims whose last heartbeat the server dates past the lease: reads them
 * again after `validMs + observeMarginMs` and releases each whose version did
 * not change. A run with such a claim counts no renewal any more, so it
 * makes no request. Returns the claims whose version changed: their run is
 * alive, with a server clock behind.
 */
async function releaseStoppedClaims(
  db: ClickHouseExecutor,
  target: LockTarget,
  stale: LockClaim[],
  deps: LockDeps,
): Promise<LockClaim[]> {
  const { validMs, observeMarginMs } = deps.timings
  deps.log(
    `The migrate lock is held by ${stale.map(describeHolder).join('; ')}, with no heartbeat for ${seconds(Math.min(...stale.map((claim) => claim.ageMs)))}s; ` +
      `checking for ${seconds(validMs + observeMarginMs)}s that it stopped.`,
  )
  await deps.sleep(validMs + observeMarginMs)
  const current = await readClaims(db, target, '')
  const alive: LockClaim[] = []
  for (const claim of stale) {
    const now = current.find((item) => item.name === claim.name)
    if (!now || now.released) continue
    if (now.version !== claim.version || now.rawHolder !== claim.rawHolder) {
      alive.push(now)
      continue
    }
    await writeClaim(db, target, claim.name, claim.rawHolder, { released: true })
    deps.log(`Released the migrate lock of ${describeHolder(claim)}, which stopped without releasing it.`)
  }
  return alive
}

export async function acquireMigrateLock(
  db: ClickHouseExecutor,
  target: LockTarget,
  options: {
    /** The claim id --break-lock names. */
    breakLock?: string
    log: (line: string) => void
    /**
     * Renews the claim while the run's own requests are in flight: an
     * executor with an HTTP session takes one query at a time. Defaults to `db`.
     */
    heartbeatDb?: ClickHouseExecutor
    /** Advertises durable per-physical-attempt query associations. */
    queryTracking?: QueryIdentity
    /** Validated predecessor snapshot for cancellation's reservation-before-release handoff. */
    takeover?: { claim: string; holder: string; beforeRelease?: () => Promise<void>; resumePending?: (reservations: readonly { claim: string; holder: string }[]) => Promise<void> }
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
    beat: 0,
    ...(options.queryTracking ? { queries: options.queryTracking } : {}),
    ...(options.takeover ? { recoveryOf: options.takeover.claim } : {}),
  }
  const holderJson = JSON.stringify(holder)
  if (options.takeover) {
    if (options.breakLock !== options.takeover.claim) throw new MigrateError('invalid_usage', 'Cancellation requires the same --break-lock claim.')
    const name = `${LOCK_ROW_PREFIX}${deps.newId()}`
    const sentAt = deps.now()
    try {
      await writeClaim(db, target, name, holderJson, { released: false })
      const predecessorName = `${LOCK_ROW_PREFIX}${options.takeover.claim}`
      const claims = await readClaims(db, target, predecessorName)
      const own = claims.find((claim) => claim.name === name)
      const predecessor = claims.find((claim) => claim.name === predecessorName)
      const others = claims.filter((claim) => !claim.released && claim.name !== name && claim.name !== predecessorName)
      if (!own || own.released || deps.now() - sentAt > timings.validMs) throw unverifiableError(target)
      if (!predecessor || predecessor.rawHolder !== options.takeover.holder) {
        throw new MigrateError('migrate_cancellation_failed', 'The predecessor claim changed or disappeared before takeover; no query was canceled.')
      }
      if (others.length > 0) {
        // Only an unresolved durable barrier proves these later cooperating
        // reservations could not have admitted migration work of their own.
        if (!options.takeover.resumePending) throw lockedError(target, others, timings)
        await options.takeover.resumePending(others.map((claim) => ({ claim: claim.name.slice(LOCK_ROW_PREFIX.length), holder: claim.rawHolder })))
        const live = others.filter((claim) => claim.ageMs < timings.leaseMs)
        if (live.length > 0) throw lockedError(target, live, timings)
        const alive = await releaseStoppedClaims(db, target, others, deps)
        if (alive.length > 0) throw lockedError(target, alive, timings)
        // The observation outlasts this reservation's validity. Start a new
        // reservation instead of releasing the predecessor under an old one.
        await writeClaim(db, target, name, holderJson, { released: true })
        return await acquireMigrateLock(db, target, options, overrides)
      }
      // The acknowledged reservation blocks a third cooperating run throughout
      // the handoff. Only now may the named predecessor be released.
      await options.takeover.beforeRelease?.()
      if (deps.now() - sentAt > timings.validMs) throw unverifiableError(target)
      if (!predecessor.released) await writeClaim(db, target, predecessorName, predecessor.rawHolder, { released: true })
      const current = await readClaims(db, target, name)
      const confirmed = current.find((claim) => claim.name === name)
      const remaining = current.filter((claim) => !claim.released && claim.name !== name)
      if (!confirmed || confirmed.released || deps.now() - sentAt > timings.validMs) throw unverifiableError(target)
      if (remaining.length > 0) throw lockedError(target, remaining, timings)
      return startHolding({ db, heartbeatDb: options.heartbeatDb ?? db }, target,
        { name, holder, confirmedAt: sentAt, version: confirmed.version }, deps)
    } catch (error) {
      await writeClaim(db, target, name, holderJson, { released: true }).catch(() => undefined)
      throw error
    }
  }
  if (options.breakLock !== undefined) await breakClaim(db, target, options.breakLock, deps)

  for (let attempt = 1; ; ) {
    const name = `${LOCK_ROW_PREFIX}${deps.newId()}`
    const sentAt = deps.now()
    await writeClaim(db, target, name, holderJson, { released: false })
    const claims = await readClaims(db, target, name)
    const own = claims.find((claim) => claim.name === name)
    const others = claims.filter((claim) => claim.name !== name && !claim.released)
    if (own && !own.released && others.length === 0 && deps.now() - sentAt <= timings.validMs) {
      debug('migrate-lock', `acquired ${name} (attempt ${attempt})`)
      return startHolding(
        { db, heartbeatDb: options.heartbeatDb ?? db },
        target,
        { name, holder, confirmedAt: sentAt, version: own.version },
        deps,
      )
    }
    await writeClaim(db, target, name, holderJson, { released: true })
    if (!own) throw unverifiableError(target)
    const live = others.filter((claim) => claim.ageMs < timings.leaseMs)
    if (live.length === 0 && others.length > 0) {
      const alive = await releaseStoppedClaims(db, target, others, deps)
      if (alive.length > 0) throw lockedError(target, alive, timings)
      continue
    }
    if (attempt >= timings.attempts) throw lockedError(target, live, timings)
    attempt++
    debug('migrate-lock', `lock taken by ${live.map(describeHolder).join('; ')} — retrying`)
    const { backoffMinMs, backoffMaxMs } = timings
    await deps.sleep(backoffMinMs + deps.random() * (backoffMaxMs - backoffMinMs))
  }
}

function startHolding(
  { db, heartbeatDb }: { db: ClickHouseExecutor; heartbeatDb: ClickHouseExecutor },
  target: LockTarget,
  claim: { name: string; holder: LockHolder; confirmedAt: number; version: string },
  deps: LockDeps,
): MigrateLock {
  const { timings } = deps
  let confirmedAt = claim.confirmedAt
  let version = claim.version
  let beat = 0
  const holderJson = (n: number) => JSON.stringify({ ...claim.holder, beat: n })
  let lost: string | undefined
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()

  function lapsed(at: number): boolean {
    return at - confirmedAt > timings.validMs
  }

  function lapsedReason(at: number): string {
    return `no heartbeat was acknowledged for ${seconds(at - confirmedAt)}s`
  }

  /** The claim as read back, retrying a failed read a few times. */
  async function readOwn(): Promise<LockClaim | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        return (await readClaims(heartbeatDb, target, claim.name)).find((item) => item.name === claim.name)
      } catch (error) {
        if (attempt >= READ_ATTEMPTS) throw error
        await deps.sleep(READ_RETRY_MS)
      }
    }
  }

  // Each heartbeat must read back as the claim's newest row before the next
  // one is sent, so the heartbeats' versions grow one after the other, and a
  // merge, which keeps the newest version, keeps the newest heartbeat. A
  // heartbeat whose row does not read back may still reach the server later,
  // with a version a later heartbeat could tie: the run stops instead. A
  // renewal counts from the heartbeat's send time, when it was acknowledged
  // within the validity of the previous one. Another run that reads the same
  // row for longer than validMs knows this run counts no renewal.
  async function heartbeat(): Promise<void> {
    const sentAt = deps.now()
    if (lapsed(sentAt)) {
      lost ??= lapsedReason(sentAt)
      return
    }
    beat += 1
    let writeError: unknown
    try {
      await writeClaim(heartbeatDb, target, claim.name, holderJson(beat), { released: false, after: version })
    } catch (error) {
      writeError = error
    }
    let own: LockClaim | undefined
    try {
      own = await readOwn()
    } catch (error) {
      lost ??= `cannot read its claim back (${errorText(error)})`
      return
    }
    if (stopped) return
    if (own?.released) {
      lost ??= 'another run released it (--break-lock)'
      return
    }
    if (own?.holder?.beat !== beat) {
      lost ??= writeError === undefined
        ? 'its heartbeat did not read back'
        : `a heartbeat failed (${errorText(writeError)}) and may still reach the server`
      return
    }
    const ackedAt = deps.now()
    if (lapsed(ackedAt)) {
      lost ??= lapsedReason(ackedAt)
      return
    }
    version = own.version
    confirmedAt = sentAt
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
    claimId: claim.name.slice(LOCK_ROW_PREFIX.length),
    assertHeld() {
      if (lost === undefined && lapsed(deps.now())) lost = lapsedReason(deps.now())
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
      // A heartbeat still in flight would race the release write. A hung one
      // is left behind: the release then goes first, and still wins.
      await Promise.race([inFlight.catch(() => undefined), sleep(RELEASE_WAIT_MS, undefined, { ref: false })])
      try {
        await writeClaim(db, target, claim.name, holderJson(beat), { released: true })
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
      if (property === 'command') {
        const commandGuarded = target.commandGuarded?.bind(target)
        if (commandGuarded) return (sql: string, settings?: ClickHouseSettings) => commandGuarded(sql, check, settings)
      }
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || property === 'close') return value
      return (...args: unknown[]) => {
        check()
        return value.apply(target, args)
      }
    },
  })
}
