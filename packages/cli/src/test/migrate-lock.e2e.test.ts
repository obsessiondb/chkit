import { describe, expect, test } from 'bun:test'

import { resolveReplicaFanout, type ClickHouseExecutor } from '@chkit/clickhouse'

import { acquireMigrateLock, LOCK_TIMINGS, type LockTarget, type MigrateLock } from '../commands/migrate/lock.js'
import { MigrateError } from '../commands/migrate/errors.js'
import { createLiveExecutor, createPrefix, getLiveEnv, quoteIdent, waitForTable } from './e2e-testkit.js'

// #716: the migrate lock against a live server, with a short lease. On a
// multi-replica target the claims land on whichever replica takes each
// request, so these runs check that every acknowledged claim is read back.

const TIMEOUT_MS = 180_000
const SHORT = { ...LOCK_TIMINGS, leaseMs: 12_000, validMs: 6_000, heartbeatMs: 1_000, observeMarginMs: 2_000, attempts: 1 }
const quiet = { log: () => {} }

async function withTarget(
  label: string,
  run: (db: ClickHouseExecutor, target: LockTarget, other: ClickHouseExecutor) => Promise<void>,
): Promise<void> {
  const db = createLiveExecutor(getLiveEnv())
  // Another run's connection: an executor takes one request at a time.
  const other = createLiveExecutor(getLiveEnv())
  const database = `${createPrefix(label)}db`
  const journalTable = '_chkit_migrations'
  await db.command(`CREATE DATABASE ${quoteIdent(database)}`)
  try {
    await db.command(
      `CREATE TABLE ${quoteIdent(database)}.${journalTable} (name String, applied_at DateTime64(3, 'UTC'), checksum String, ` +
        "chkit_version String, migration_completed Bool DEFAULT true, operations Array(Tuple(operation_index Int32, operation_key String, operation_type String, query_id String, status LowCardinality(String), started_at DateTime64(3, 'UTC'), finished_at Nullable(DateTime64(3, 'UTC')), last_error String)) DEFAULT []) " +
        'ENGINE = ReplacingMergeTree(applied_at) ORDER BY (name) SETTINGS index_granularity = 1',
    )
    await waitForTable(db, database, journalTable)
    await run(db, { database, journalTable, fanout: await resolveReplicaFanout(db) }, other)
  } finally {
    await db.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
    await db.close()
    await other.close()
  }
}

async function tryAcquire(db: ClickHouseExecutor, target: LockTarget): Promise<MigrateLock | MigrateError> {
  return await acquireMigrateLock(db, target, quiet, { timings: SHORT }).catch((error: unknown) => {
    if (error instanceof MigrateError) return error
    throw error
  })
}

describe('migrate lock on a live server (#716)', () => {
  test('a held lock stops another run until it is released', async () => {
    await withTarget('lock_held', async (db, target, other) => {
      const held = await acquireMigrateLock(db, target, quiet, { timings: SHORT })
      const refused = await tryAcquire(other, target)
      expect(refused).toBeInstanceOf(MigrateError)
      expect((refused as MigrateError).code).toBe('migrate_locked')
      expect((refused as MigrateError).message).toContain(`pid ${process.pid}`)
      // Heartbeats keep it held past the lease.
      await Bun.sleep(SHORT.leaseMs + 1_000)
      held.assertHeld()
      expect(((await tryAcquire(other, target)) as MigrateError).code).toBe('migrate_locked')
      await held.release()
      const next = await acquireMigrateLock(db, target, quiet, { timings: SHORT })
      await next.release()
    })
  }, TIMEOUT_MS)

  test('the claim of a run that stopped without releasing it expires after the lease', async () => {
    await withTarget('lock_expiry', async (db, target, other) => {
      // No heartbeat within the test: the run stopped.
      const crashed = await acquireMigrateLock(db, target, quiet, { timings: { ...SHORT, heartbeatMs: 600_000 } })
      expect(((await tryAcquire(other, target)) as MigrateError).code).toBe('migrate_locked')
      await Bun.sleep(SHORT.leaseMs + 500)
      expect(() => crashed.assertHeld()).toThrow('lost the migrate lock')
      const next = await acquireMigrateLock(db, target, quiet, { timings: SHORT })
      await next.release()
    })
  }, TIMEOUT_MS)

  test('of runs that claim at once, at most one takes the lock', async () => {
    await withTarget('lock_race', async (_db, target) => {
      const executors = Array.from({ length: 4 }, () => createLiveExecutor(getLiveEnv()))
      try {
        for (let round = 0; round < 10; round++) {
          const results = await Promise.all(executors.map((executor) => tryAcquire(executor, target)))
          const holders = results.filter((result): result is MigrateLock => !(result instanceof MigrateError))
          expect(holders.length).toBeLessThanOrEqual(1)
          for (const holder of holders) await holder.release()
        }
      } finally {
        await Promise.all(executors.map((executor) => executor.close()))
      }
    })
  }, TIMEOUT_MS)
})
