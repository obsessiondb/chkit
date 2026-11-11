import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import {
  acquireMigrateLock,
  claimInsertSql,
  claimsSelectSql,
  guardExecutor,
  LOCK_ROW_PREFIX,
  LOCK_TIMINGS,
  type LockTarget,
  type LockTimings,
} from '../../../commands/migrate/lock.js'
import { MigrateError } from '../../../commands/migrate/errors.js'
import { CLI_VERSION } from '../../../runtime/version.js'

// #716: the migrate lock, against a fake server that keeps the claim rows.

const TARGET: LockTarget = { database: 'app', journalTable: '_chkit_migrations', fanout: undefined }
const RELEASED = Number.POSITIVE_INFINITY

interface Row {
  name: string
  version: number
  holder: string
}

interface FakeServer {
  db: ClickHouseExecutor
  rows: Row[]
  /** The server clock, in ms. */
  clock: { now: number }
  /** Names of the claims a read leaves out, as a lagging replica would. */
  hidden: Set<string>
  sql: string[]
}

const UNQUOTE = (value: string) => value.replace(/\\(.)/g, '$1')

function fakeServer(): FakeServer {
  const server: FakeServer = { rows: [], clock: { now: 1_000_000 }, hidden: new Set(), sql: [], db: undefined as never }
  const command = async (sql: string) => {
    server.sql.push(sql)
    const match = /SELECT '((?:[^'\\]|\\.)*)', (now64\(3\)|toDateTime64\([^)]*\)), '((?:[^'\\]|\\.)*)'/.exec(sql)
    if (!match) throw new Error(`unexpected command: ${sql}`)
    server.rows.push({
      name: UNQUOTE(match[1] as string),
      version: match[2] === 'now64(3)' ? server.clock.now : RELEASED,
      holder: UNQUOTE(match[3] as string),
    })
  }
  const query = async (sql: string) => {
    server.sql.push(sql)
    const own = /OR name = '((?:[^'\\]|\\.)*)'/.exec(sql)?.[1] ?? ''
    const latest = new Map<string, Row>()
    for (const row of server.rows) {
      if (server.hidden.has(row.name)) continue
      const seen = latest.get(row.name)
      if (!seen || row.version >= seen.version) latest.set(row.name, row)
    }
    return [...latest.values()]
      .filter((row) => row.version !== RELEASED || row.name === UNQUOTE(own))
      .map((row) => ({
        name: row.name,
        holder: row.holder,
        released: row.version === RELEASED ? 1 : 0,
        age_ms: String(row.version === RELEASED ? -1 : server.clock.now - row.version),
      }))
  }
  server.db = { command, query } as unknown as ClickHouseExecutor
  return server
}

const OTHER_HOLDER = JSON.stringify({ host: 'ci-runner-7', pid: 4242, chkitVersion: '0.9.0', startedAt: '2026-11-11T08:00:00.000Z' })

function liveClaim(server: FakeServer, ageMs: number, name = `${LOCK_ROW_PREFIX}other`): void {
  server.rows.push({ name, version: server.clock.now - ageMs, holder: OTHER_HOLDER })
}

function deps(overrides: Partial<LockTimings> = {}) {
  let id = 0
  const local = { now: 0 }
  const sleeps: number[] = []
  return {
    local,
    sleeps,
    overrides: {
      now: () => local.now,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      random: () => 0.5,
      newId: () => `run-${++id}`,
      timings: { ...LOCK_TIMINGS, heartbeatMs: 60_000, ...overrides },
    },
  }
}

function claimsOf(server: FakeServer, name: string): Row[] {
  return server.rows.filter((row) => row.name === name)
}

async function rejection(promise: Promise<unknown>): Promise<MigrateError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(MigrateError)
  return error as MigrateError
}

describe('acquireMigrateLock', () => {
  test('takes a free lock and releases it', async () => {
    const server = fakeServer()
    const { overrides } = deps()
    const lock = await acquireMigrateLock(server.db, TARGET, { breakLock: false, log: () => {} }, overrides)
    const name = `${LOCK_ROW_PREFIX}run-1`
    expect(claimsOf(server, name).map((row) => row.version)).toEqual([server.clock.now])
    lock.assertHeld()
    await lock.release()
    expect(claimsOf(server, name).at(-1)?.version).toBe(RELEASED)
  })

  test('a live claim of another run stops it after every attempt, naming the holder', async () => {
    const server = fakeServer()
    liveClaim(server, 5_000)
    const { overrides, sleeps } = deps()
    const error = await rejection(acquireMigrateLock(server.db, TARGET, { breakLock: false, log: () => {} }, overrides))
    expect(error.code).toBe('migrate_locked')
    expect(error.message).toContain('pid 4242 on host ci-runner-7 (chkit 0.9.0), started 2026-11-11T08:00:00.000Z')
    expect(error.message).toContain('last heartbeat 5s ago, expires in 115s unless renewed')
    expect(error.message).toContain('--break-lock')
    expect(sleeps).toHaveLength(LOCK_TIMINGS.attempts - 1)
    // Each attempt released its own claim.
    for (let attempt = 1; attempt <= LOCK_TIMINGS.attempts; attempt++) {
      expect(claimsOf(server, `${LOCK_ROW_PREFIX}run-${attempt}`).at(-1)?.version).toBe(RELEASED)
    }
  })

  test('a claim whose last heartbeat is older than the lease has expired', async () => {
    const server = fakeServer()
    liveClaim(server, LOCK_TIMINGS.leaseMs)
    const { overrides } = deps()
    const lock = await acquireMigrateLock(server.db, TARGET, { breakLock: false, log: () => {} }, overrides)
    lock.assertHeld()
    await lock.release()
  })

  test('a released claim does not hold the lock', async () => {
    const server = fakeServer()
    liveClaim(server, 1_000)
    server.rows.push({ name: `${LOCK_ROW_PREFIX}other`, version: RELEASED, holder: OTHER_HOLDER })
    const { overrides } = deps()
    const lock = await acquireMigrateLock(server.db, TARGET, { breakLock: false, log: () => {} }, overrides)
    await lock.release()
  })

  test('--break-lock releases the live claims, says whose, and takes the lock', async () => {
    const server = fakeServer()
    liveClaim(server, 1_000)
    const lines: string[] = []
    const { overrides } = deps()
    const lock = await acquireMigrateLock(server.db, TARGET, { breakLock: true, log: (line) => lines.push(line) }, overrides)
    expect(lines).toEqual(['Broke the migrate lock held by pid 4242 on host ci-runner-7 (chkit 0.9.0), started 2026-11-11T08:00:00.000Z.'])
    expect(claimsOf(server, `${LOCK_ROW_PREFIX}other`).at(-1)?.version).toBe(RELEASED)
    await lock.release()
  })

  test('a run that cannot read its own claim back stops instead of taking the lock', async () => {
    const server = fakeServer()
    server.hidden.add(`${LOCK_ROW_PREFIX}run-1`)
    const { overrides } = deps()
    const error = await rejection(acquireMigrateLock(server.db, TARGET, { breakLock: false, log: () => {} }, overrides))
    expect(error.code).toBe('migrate_lock_unverifiable')
    expect(error.message).toContain('CHKIT_MIGRATE_LOCK=off')
  })
})

describe('holding the migrate lock', () => {
  test('stops once no heartbeat was acknowledged for validMs', async () => {
    const server = fakeServer()
    const { overrides, local } = deps()
    const lock = await acquireMigrateLock(server.db, TARGET, { breakLock: false, log: () => {} }, overrides)
    local.now = LOCK_TIMINGS.validMs
    lock.assertHeld()
    local.now = LOCK_TIMINGS.validMs + 1
    expect(() => lock.assertHeld()).toThrow('lost the migrate lock')
    await lock.release()
  })

  test('a heartbeat renews the claim and keeps the lock held', async () => {
    const server = fakeServer()
    const { overrides, local } = deps({ heartbeatMs: 1 })
    const lock = await acquireMigrateLock(server.db, TARGET, { breakLock: false, log: () => {} }, overrides)
    local.now = 50_000
    server.clock.now += 50_000
    // A third row means the heartbeat that wrote the second one finished.
    await waitFor(() => claimsOf(server, `${LOCK_ROW_PREFIX}run-1`).length >= 3)
    local.now = 50_000 + LOCK_TIMINGS.validMs
    lock.assertHeld()
    await lock.release()
  })

  test('a heartbeat sent after the claim lapsed does not renew it', async () => {
    const server = fakeServer()
    const { overrides, local } = deps({ heartbeatMs: 20 })
    const lock = await acquireMigrateLock(server.db, TARGET, { breakLock: false, log: () => {} }, overrides)
    // The process was paused past the validity: another run may hold the lock now.
    local.now = LOCK_TIMINGS.validMs + 1
    await Bun.sleep(60)
    expect(claimsOf(server, `${LOCK_ROW_PREFIX}run-1`)).toHaveLength(1)
    expect(() => lock.assertHeld()).toThrow('no heartbeat was acknowledged for 60s')
    await lock.release()
  })

  test('a claim another run released (--break-lock) is lost at the next heartbeat', async () => {
    const server = fakeServer()
    const { overrides } = deps({ heartbeatMs: 1 })
    const lock = await acquireMigrateLock(server.db, TARGET, { breakLock: false, log: () => {} }, overrides)
    server.rows.push({ name: `${LOCK_ROW_PREFIX}run-1`, version: RELEASED, holder: OTHER_HOLDER })
    await waitFor(() => {
      try {
        lock.assertHeld()
        return false
      } catch {
        return true
      }
    })
    expect(() => lock.assertHeld()).toThrow('another run released it (--break-lock)')
    await lock.release()
  })
})

describe('claim SQL', () => {
  // The Python port writes and reads the same rows, so a TS and a chkit-py run exclude each other.
  test('claims are journal rows the migration reads skip', () => {
    expect(claimInsertSql(TARGET, `${LOCK_ROW_PREFIX}x`, '{"pid":1}', false)).toBe(
      'INSERT INTO `app`._chkit_migrations (name, applied_at, checksum, chkit_version, migration_completed, operations) ' +
        `SELECT '__chkit_migrate_lock__/x', now64(3), '{"pid":1}', '${CLI_VERSION}', false, []`,
    )
    expect(claimInsertSql(TARGET, `${LOCK_ROW_PREFIX}x`, "it's", true)).toBe(
      'INSERT INTO `app`._chkit_migrations (name, applied_at, checksum, chkit_version, migration_completed, operations) ' +
        `SELECT '__chkit_migrate_lock__/x', toDateTime64('2299-12-31 23:59:59.000', 3, 'UTC'), 'it\\'s', '${CLI_VERSION}', false, []`,
    )
  })

  test('the read keeps the newest version of each claim, on every replica', () => {
    expect(claimsSelectSql({ ...TARGET, fanout: { cluster: 'default', replicas: 2 } }, `${LOCK_ROW_PREFIX}x`)).toBe(
      "SELECT name, latest.2 AS holder, latest.1 >= toDateTime64('2299-01-01 00:00:00', 3, 'UTC') AS released, " +
        'toString(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(latest.1)) AS age_ms ' +
        "FROM (SELECT name, argMax(tuple(applied_at, checksum), applied_at) AS latest FROM clusterAllReplicas('default', 'app', '_chkit_migrations') " +
        "WHERE startsWith(name, '__chkit_migrate_lock__/') GROUP BY name) " +
        "WHERE NOT released OR name = '__chkit_migrate_lock__/x' ORDER BY name",
    )
  })
})

describe('guardExecutor', () => {
  test('checks before every request but close', async () => {
    const calls: string[] = []
    const db = {
      query: async () => {
        calls.push('query')
        return []
      },
      close: async () => {
        calls.push('close')
      },
    } as unknown as ClickHouseExecutor
    let held = true
    const guarded = guardExecutor(db, () => {
      calls.push('check')
      if (!held) throw new Error('lost')
    })
    await guarded.query('SELECT 1')
    held = false
    expect(() => guarded.query('SELECT 1')).toThrow('lost')
    await guarded.close()
    expect(calls).toEqual(['check', 'query', 'check', 'close'])
  })
})

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5)
  expect(condition()).toBe(true)
}
