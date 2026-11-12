import { describe, expect, spyOn, test } from 'bun:test'

import { type ClickHouseExecutor, createExecutorWithClient, createStatelessClickHouseClient } from '@chkit/clickhouse'

import { MigrateError } from '../../../commands/migrate/errors.js'
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
  /** Names of the claims whose writes the server drops. */
  dropped: Set<string>
  /** When set, the next read fails, after calling it. */
  failNextRead?: () => void
  /**
   * Decides each heartbeat write by its beat: `hold` fails the request but
   * keeps the row in `held`, for the test to commit later.
   */
  onBeat?: (beat: number) => 'write' | 'drop' | 'hold'
  held: Row[]
}

const UNQUOTE = (value: string) => value.replace(/\\(.)/g, '$1')
const VERSION =
  /SELECT '((?:[^'\\]|\\.)*)', (now64\(3\)|toDateTime64\('([^']*)'[^)]*\)|greatest\(now64\(3\), toDateTime64\('([^']*)'.*?\)\)), '((?:[^'\\]|\\.)*)'/

/** A version as ClickHouse's toString(DateTime64(3)) prints it. */
function formatVersion(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 23)
}

function parseVersion(text: string): number {
  return Date.parse(`${text.replace(' ', 'T')}Z`)
}

function beatOf(row: Row): number {
  return (JSON.parse(row.holder) as { beat?: number }).beat ?? 0
}

function fakeServer(): FakeServer {
  const server: FakeServer = {
    rows: [],
    clock: { now: Date.parse('2026-11-11T08:00:00Z') },
    hidden: new Set(),
    dropped: new Set(),
    held: [],
    db: undefined as never,
  }
  const command = async (sql: string) => {
    const match = VERSION.exec(sql)
    if (!match) throw new Error(`unexpected command: ${sql}`)
    const name = UNQUOTE(match[1] as string)
    if (server.dropped.has(name)) return
    let version = server.clock.now
    if (match[3] !== undefined) version = RELEASED
    if (match[4] !== undefined) version = Math.max(server.clock.now, parseVersion(match[4]) + 1)
    const row = { name, version, holder: UNQUOTE(match[5] as string) }
    const beat = (JSON.parse(row.holder) as { beat?: number }).beat ?? -1
    const decision = version === RELEASED || beat < 1 ? 'write' : (server.onBeat?.(beat) ?? 'write')
    if (decision === 'drop') return
    if (decision === 'hold') {
      server.held.push(row)
      throw new Error('connection lost')
    }
    server.rows.push(row)
  }
  const query = async (sql: string) => {
    const fail = server.failNextRead
    if (fail) {
      server.failNextRead = undefined
      fail()
      throw new Error('read failed')
    }
    const own = /OR name = '((?:[^'\\]|\\.)*)'/.exec(sql)?.[1] ?? ''
    const latest = new Map<string, Row>()
    for (const row of server.rows) {
      if (server.hidden.has(row.name)) continue
      const seen = latest.get(row.name)
      // argMax by (version, beat), as the claim read does.
      if (!seen || row.version > seen.version || (row.version === seen.version && beatOf(row) >= beatOf(seen))) {
        latest.set(row.name, row)
      }
    }
    return [...latest.values()]
      .filter((row) => row.version !== RELEASED || row.name === UNQUOTE(own))
      .map((row) => ({
        name: row.name,
        holder: row.holder,
        released: row.version === RELEASED ? 1 : 0,
        version: row.version === RELEASED ? '2299-12-31 23:59:59.000' : formatVersion(row.version),
        age_ms: String(row.version === RELEASED ? -1 : server.clock.now - row.version),
      }))
  }
  server.db = { command, query } as unknown as ClickHouseExecutor
  return server
}

const OTHER_HOLDER = JSON.stringify({ host: 'ci-runner-7', pid: 4242, chkitVersion: '0.9.0', startedAt: '2026-11-11T08:00:00.000Z' })
const OTHER = `${LOCK_ROW_PREFIX}other`
const OTHER_DESCRIBED = 'claim other: pid 4242 on host ci-runner-7 (chkit 0.9.0), started 2026-11-11T08:00:00.000Z'

function otherClaim(server: FakeServer, ageMs: number): void {
  server.rows.push({ name: OTHER, version: server.clock.now - ageMs, holder: OTHER_HOLDER })
}

function deps(overrides: Partial<LockTimings> = {}, onSleep: (ms: number) => void = () => {}) {
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
        onSleep(ms)
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

const quiet = { log: () => {} }

describe('acquireMigrateLock', () => {
  test('takes a free lock and releases it', async () => {
    const server = fakeServer()
    const lock = await acquireMigrateLock(server.db, TARGET, quiet, deps().overrides)
    const name = `${LOCK_ROW_PREFIX}run-1`
    expect(claimsOf(server, name).map((row) => row.version)).toEqual([server.clock.now])
    lock.assertHeld()
    await lock.release()
    expect(claimsOf(server, name).at(-1)?.version).toBe(RELEASED)
  })

  test('a live claim of another run stops it after every attempt, naming the holder', async () => {
    const server = fakeServer()
    otherClaim(server, 5_000)
    const { overrides, sleeps } = deps()
    const error = await rejection(acquireMigrateLock(server.db, TARGET, quiet, overrides))
    expect(error.code).toBe('migrate_locked')
    expect(error.message).toContain(`${OTHER_DESCRIBED}; last heartbeat 5s ago, free in 115s unless renewed`)
    expect(error.message).toContain('re-run with --break-lock other.')
    expect(sleeps).toHaveLength(LOCK_TIMINGS.attempts - 1)
    // Each attempt released its own claim.
    for (let attempt = 1; attempt <= LOCK_TIMINGS.attempts; attempt++) {
      expect(claimsOf(server, `${LOCK_ROW_PREFIX}run-${attempt}`).at(-1)?.version).toBe(RELEASED)
    }
  })

  test('a released claim does not hold the lock', async () => {
    const server = fakeServer()
    otherClaim(server, 1_000)
    server.rows.push({ name: OTHER, version: RELEASED, holder: OTHER_HOLDER })
    const lock = await acquireMigrateLock(server.db, TARGET, quiet, deps().overrides)
    await lock.release()
  })

  test('a claim past the lease that does not change while watched is released, and the lock taken', async () => {
    const server = fakeServer()
    otherClaim(server, LOCK_TIMINGS.leaseMs)
    const lines: string[] = []
    const { overrides, sleeps } = deps()
    const lock = await acquireMigrateLock(server.db, TARGET, { log: (line) => lines.push(line) }, overrides)
    expect(sleeps).toEqual([LOCK_TIMINGS.validMs + LOCK_TIMINGS.observeMarginMs])
    expect(lines).toEqual([
      `The migrate lock is held by ${OTHER_DESCRIBED}, with no heartbeat for 120s; checking for 65s that it stopped.`,
      `Released the migrate lock of ${OTHER_DESCRIBED}, which stopped without releasing it.`,
    ])
    expect(claimsOf(server, OTHER).at(-1)?.version).toBe(RELEASED)
    lock.assertHeld()
    await lock.release()
  })

  test('a claim past the lease by a slow server clock whose version moves while watched still holds the lock', async () => {
    const server = fakeServer()
    otherClaim(server, LOCK_TIMINGS.leaseMs + 10_000)
    // The holder renews while this run watches, on a replica whose clock is behind.
    const { overrides } = deps({}, () => {
      server.rows.push({ name: OTHER, version: server.clock.now - LOCK_TIMINGS.leaseMs - 1_000, holder: OTHER_HOLDER })
    })
    const error = await rejection(acquireMigrateLock(server.db, TARGET, quiet, overrides))
    expect(error.code).toBe('migrate_locked')
    expect(error.message).toContain(OTHER_DESCRIBED)
    expect(claimsOf(server, OTHER).at(-1)?.version).not.toBe(RELEASED)
  })

  test('a claim past the lease whose heartbeat writes the same version while watched still holds the lock', async () => {
    const server = fakeServer()
    const version = server.clock.now - LOCK_TIMINGS.leaseMs - 10_000
    const beat = (n: number) => JSON.stringify({ ...JSON.parse(OTHER_HOLDER), beat: n })
    server.rows.push({ name: OTHER, version, holder: beat(1) })
    // The next heartbeat lands on a replica whose clock gives it the same version.
    const { overrides } = deps({}, () => {
      server.rows.push({ name: OTHER, version, holder: beat(2) })
    })
    const error = await rejection(acquireMigrateLock(server.db, TARGET, quiet, overrides))
    expect(error.code).toBe('migrate_locked')
    expect(claimsOf(server, OTHER).at(-1)?.version).not.toBe(RELEASED)
  })

  test('--break-lock releases the claim it names and takes the lock', async () => {
    const server = fakeServer()
    otherClaim(server, 1_000)
    const lines: string[] = []
    const lock = await acquireMigrateLock(
      server.db,
      TARGET,
      { breakLock: 'other', log: (line) => lines.push(line) },
      deps().overrides,
    )
    expect(lines).toEqual([`Broke the migrate lock of ${OTHER_DESCRIBED}.`])
    expect(claimsOf(server, OTHER).at(-1)?.version).toBe(RELEASED)
    await lock.release()
  })

  test('--break-lock naming another claim leaves the holder alone', async () => {
    const server = fakeServer()
    otherClaim(server, 1_000)
    const lines: string[] = []
    const error = await rejection(
      acquireMigrateLock(server.db, TARGET, { breakLock: 'stale-one', log: (line) => lines.push(line) }, deps().overrides),
    )
    expect(lines).toEqual(['--break-lock: claim stale-one does not hold the migrate lock; taking the lock as usual.'])
    expect(error.code).toBe('migrate_locked')
    expect(claimsOf(server, OTHER).at(-1)?.version).not.toBe(RELEASED)
  })

  test('a run that cannot read its own claim back stops instead of taking the lock', async () => {
    const server = fakeServer()
    server.hidden.add(`${LOCK_ROW_PREFIX}run-1`)
    const error = await rejection(acquireMigrateLock(server.db, TARGET, quiet, deps().overrides))
    expect(error.code).toBe('migrate_lock_unverifiable')
    expect(error.message).toContain('CHKIT_MIGRATE_LOCK=off')
  })
})

describe('holding the migrate lock', () => {
  test('stops once no heartbeat was acknowledged for validMs', async () => {
    const server = fakeServer()
    const { overrides, local } = deps()
    const lock = await acquireMigrateLock(server.db, TARGET, quiet, overrides)
    local.now = LOCK_TIMINGS.validMs
    lock.assertHeld()
    local.now = LOCK_TIMINGS.validMs + 1
    expect(() => lock.assertHeld()).toThrow('lost the migrate lock')
    await lock.release()
  })

  test('a heartbeat renews the claim with a newer version and keeps the lock held', async () => {
    const server = fakeServer()
    const { overrides, local } = deps({ heartbeatMs: 1 })
    const lock = await acquireMigrateLock(server.db, TARGET, quiet, overrides)
    local.now = 50_000
    // A third row means the heartbeat that wrote the second one finished.
    await waitFor(() => claimsOf(server, `${LOCK_ROW_PREFIX}run-1`).length >= 3)
    const versions = claimsOf(server, `${LOCK_ROW_PREFIX}run-1`).map((row) => row.version)
    // The server clock stands still: each heartbeat still writes a newer version.
    expect(versions[1]).toBe((versions[0] as number) + 1)
    local.now = 50_000 + LOCK_TIMINGS.validMs
    lock.assertHeld()
    await lock.release()
  })

  test('a heartbeat whose row does not read back stops the run', async () => {
    const server = fakeServer()
    const name = `${LOCK_ROW_PREFIX}run-1`
    const lock = await acquireMigrateLock(server.db, TARGET, quiet, deps({ heartbeatMs: 1 }).overrides)
    server.dropped.add(name)
    await waitFor(() => isLost(lock))
    expect(() => lock.assertHeld()).toThrow('its heartbeat did not read back')
    server.dropped.clear()
    await lock.release()
  })

  test('a failed read of a heartbeat is tried again, and the heartbeat counts from its send time', async () => {
    const server = fakeServer()
    const name = `${LOCK_ROW_PREFIX}run-1`
    const { overrides, local, sleeps } = deps({ heartbeatMs: 1 })
    const lock = await acquireMigrateLock(server.db, TARGET, quiet, overrides)
    let failed = false
    server.failNextRead = () => {
      failed = true
      local.now = 20_000
    }
    local.now = 10_000
    await waitFor(() => failed && claimsOf(server, name).length >= 3)
    expect(sleeps).toContain(1_000)
    local.now = 20_000 + LOCK_TIMINGS.validMs
    lock.assertHeld()
    await lock.release()
  })

  test('a heartbeat whose request fails and that does not read back stops the run, as it may reach the server later', async () => {
    const server = fakeServer()
    const name = `${LOCK_ROW_PREFIX}run-1`
    // Beat 1 loses its connection; the server may still commit it later.
    server.onBeat = (beat) => (beat === 1 ? 'hold' : 'write')
    const lock = await acquireMigrateLock(server.db, TARGET, quiet, deps({ heartbeatMs: 1 }).overrides)
    await waitFor(() => isLost(lock))
    expect(() => lock.assertHeld()).toThrow('a heartbeat failed (connection lost) and may still reach the server')
    expect(server.held).toHaveLength(1)
    // No heartbeat after it.
    expect(claimsOf(server, name)).toHaveLength(1)
    server.onBeat = undefined
    await lock.release()
  })

  test('a heartbeat sent after the claim lapsed does not renew it', async () => {
    const server = fakeServer()
    const { overrides, local } = deps({ heartbeatMs: 20 })
    const lock = await acquireMigrateLock(server.db, TARGET, quiet, overrides)
    // The process was paused past the validity: another run may hold the lock now.
    local.now = LOCK_TIMINGS.validMs + 1
    await Bun.sleep(60)
    expect(claimsOf(server, `${LOCK_ROW_PREFIX}run-1`)).toHaveLength(1)
    expect(() => lock.assertHeld()).toThrow('no heartbeat was acknowledged for 60s')
    await lock.release()
  })

  test('a claim another run released (--break-lock) is lost at the next heartbeat', async () => {
    const server = fakeServer()
    const lock = await acquireMigrateLock(server.db, TARGET, quiet, deps({ heartbeatMs: 1 }).overrides)
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
    const columns =
      'INSERT INTO `app`._chkit_migrations (name, applied_at, checksum, chkit_version, migration_completed, operations) '
    expect(claimInsertSql(TARGET, `${LOCK_ROW_PREFIX}x`, '{"pid":1}', { released: false })).toBe(
      `${columns}SELECT '__chkit_migrate_lock__/x', now64(3), '{"pid":1}', '${CLI_VERSION}', false, []`,
    )
    expect(
      claimInsertSql(TARGET, `${LOCK_ROW_PREFIX}x`, '{"pid":1}', { released: false, after: '2026-11-11 08:00:00.000' }),
    ).toBe(
      `${columns}SELECT '__chkit_migrate_lock__/x', greatest(now64(3), toDateTime64('2026-11-11 08:00:00.000', 3, 'UTC') + toIntervalMillisecond(1)), '{"pid":1}', '${CLI_VERSION}', false, []`,
    )
    expect(claimInsertSql(TARGET, `${LOCK_ROW_PREFIX}x`, "it's", { released: true })).toBe(
      `${columns}SELECT '__chkit_migrate_lock__/x', toDateTime64('2299-12-31 23:59:59.000', 3, 'UTC'), 'it\\'s', '${CLI_VERSION}', false, []`,
    )
  })

  test('the read keeps the newest version of each claim, on every replica', () => {
    expect(claimsSelectSql({ ...TARGET, fanout: { cluster: 'default', replicas: 2 } }, `${LOCK_ROW_PREFIX}x`)).toBe(
      "SELECT name, latest.2 AS holder, latest.1 >= toDateTime64('2299-01-01 00:00:00', 3, 'UTC') AS released, toString(latest.1) AS version, " +
        'toString(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(latest.1)) AS age_ms ' +
        "FROM (SELECT name, argMax(tuple(applied_at, checksum), tuple(applied_at, JSONExtractInt(checksum, 'beat'))) AS latest FROM clusterAllReplicas('default', 'app', '_chkit_migrations') " +
        "WHERE startsWith(name, '__chkit_migrate_lock__/') GROUP BY name) " +
        "WHERE NOT released OR name = '__chkit_migrate_lock__/x' ORDER BY name SETTINGS skip_unavailable_shards = 0",
    )
  })
})

describe('guardExecutor', () => {
  for (const loseLock of [false, true]) {
    test(`a missing-database retry checks lock ownership again (lost: ${loseLock})`, async () => {
      const fallbackRequests: Array<{ sql: string; threads: string | null }> = []
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          fallbackRequests.push({ sql: (await request.text()).trim(), threads: new URL(request.url).searchParams.get('max_threads') })
          return new Response('')
        },
      })
      const config = { url: server.url.toString(), username: 'default', password: '', database: 'app', secure: false }
      const client = createStatelessClickHouseClient(config)
      let held = true
      const firstRequest = spyOn(client, 'command').mockImplementation(async () => {
        held = !loseLock
        throw Object.assign(new Error('Code: 81. UNKNOWN_DATABASE'), { code: '81' })
      })
      const executor = createExecutorWithClient(config, client)
      const guarded = guardExecutor(executor, () => {
        if (!held) throw new MigrateError('migrate_lock_lost', 'lost before retry')
      })
      const settings = { max_threads: 1 }
      try {
        const command = guarded.command('INSERT INTO app.events SELECT 1', settings)
        if (loseLock) await expect(command).rejects.toThrow('lost before retry')
        else await command
        expect(firstRequest).toHaveBeenCalledTimes(1)
        expect(fallbackRequests).toEqual(loseLock ? [] : [{ sql: 'INSERT INTO app.events SELECT 1', threads: '1' }])
      } finally {
        await executor.close()
        server.stop(true)
      }
    })
  }

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

function isLost(lock: { assertHeld(): void }): boolean {
  try {
    lock.assertHeld()
    return false
  } catch {
    return true
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5)
  expect(condition()).toBe(true)
}
