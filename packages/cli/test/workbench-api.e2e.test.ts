import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { executeBackfill, type BackfillChunkState } from '../../plugin-backfill/src/async-backfill.js'
import { loadCredentials } from '../../plugin-obsessiondb/src/auth/credentials.js'
import { createRemoteExecutor } from '../../plugin-obsessiondb/src/query/remote-executor.js'
import { applyAsyncStatement, makeDeterministicQueryId } from '../src/commands/migrate/async-apply.js'
import type { JournalStore, MigrationRowState } from '../src/runtime/journal-store.js'
import { createPrefix, pollUntil, waitForTable } from '../src/test/e2e-testkit.js'

// Async migrate through the real ObsessionDB workbench API (#246). The API runs
// a query under its top-level `queryId` and on whichever replica it reaches, so
// this checks what the stand-in workbench of the default suite cannot: that a
// submission keeps chkit's id and that queryStatus sees it on every replica.
//
// Outside src/, excluded from default CI. Needs a `chkit obsessiondb login`
// session (~/.config/chkit/credentials.json) and the service slug:
//   CHKIT_E2E_OBSESSIONDB_SERVICE=<slug> bun run test:workbench-api
// Hard-fails (never skips) without them.

const SERVICE = process.env.CHKIT_E2E_OBSESSIONDB_SERVICE
const TIMEOUT_MS = 180_000
// About 20 s: one row per block, 1 s per row.
const SLOW_ROWS = 20
const MIGRATION_CHECKSUM = 'c1'

describe('async migrate through the real ObsessionDB workbench API', () => {
  test('a submission keeps its query id and reads as running on every replica until it finishes', async () => {
    const remote = await connect()
    const queryId = `chkit-e2e-${randomUUID()}`
    const bound = new Date((await readServerNowMs(remote)) - 2_000).toISOString()
    const query = remote
      .submit(`SELECT sum(sleepEachRow(1)) FROM numbers(${SLOW_ROWS}) SETTINGS max_block_size = 1`, queryId)
      .then(
        () => 'finished',
        (error: unknown) => String(error),
      )

    await pollUntil(
      () => remote.queryStatus(queryId, { everyReplica: true }),
      (status) => status.status === 'running',
      { intervalMs: 250, timeoutMs: 10_000 },
    )
    const statuses: string[] = []
    let localReadsThatSawIt = 0
    for (let read = 0; read < 6; read++) {
      statuses.push((await remote.queryStatus(queryId, { everyReplica: true })).status)
      // What queryStatus read before #246: the answering replica only.
      const [local] = await remote.query<{ n: string }>(
        `SELECT toString(count()) AS n FROM system.processes WHERE query_id = '${queryId}'`,
      )
      if (local?.n === '1') localReadsThatSawIt++
      await sleep(500)
    }
    console.log(`[workbench-api] single-replica system.processes reads saw the query ${localReadsThatSawIt}/6 times`)

    expect(statuses).toEqual(['running', 'running', 'running', 'running', 'running', 'running'])
    expect(await query).toBe('finished')
    const finished = await pollUntil(
      () => remote.queryStatus(queryId, { afterTime: bound }),
      (status) => status.status === 'finished',
      { timeoutMs: 60_000 },
    )
    expect(finished.durationMs).toBeGreaterThanOrEqual((SLOW_ROWS - 1) * 1_000)
  }, TIMEOUT_MS)

  test('a re-run attaches to the attempt a lost run left running', async () => {
    const remote = await connect()
    const [row] = await remote.query<{ db: string }>('SELECT currentDatabase() AS db')
    const database = row?.db ?? 'default'
    const tableName = `${createPrefix('workbench_api')}dst`
    const table = `\`${database}\`.\`${tableName}\``
    const operationKey = `table:${database}.${tableName}`
    const migrationName = `20990101000000_${tableName}.sql`
    const queryId = makeDeterministicQueryId(migrationName, 0)
    let attempt: Promise<string> | undefined
    try {
      await remote.command(`CREATE TABLE ${table} (n UInt64) ENGINE = MergeTree ORDER BY n`)
      await waitForTable(remote, database, tableName)
      // The attempt of a run that lost its connection while the statement ran.
      attempt = remote
        .submit(
          `INSERT INTO ${table} SELECT number + sleepEachRow(1) FROM numbers(${SLOW_ROWS}) SETTINGS max_block_size = 1`,
          queryId,
        )
        .then(
          () => 'finished',
          (error: unknown) => String(error),
        )
      await pollUntil(
        () => remote.queryStatus(queryId, { everyReplica: true }),
        (status) => status.status === 'running',
        { intervalMs: 250, timeoutMs: 10_000 },
      )

      const commands: string[] = []
      const submits: string[] = []
      const db: ClickHouseExecutor = {
        ...remote,
        command: async (sql) => {
          commands.push(sql)
          await remote.command(sql)
        },
        submit: async (sql, id) => {
          submits.push(sql)
          return remote.submit(sql, id)
        },
      }
      const journal = createMemoryJournal(startedState(migrationName, queryId, operationKey))
      const lines: string[] = []

      const result = await applyAsyncStatement({
        db,
        journalStore: journal.store,
        // Never submitted: chkit attaches to the running attempt.
        sql: 'SELECT 1',
        migrationName,
        migrationChecksum: MIGRATION_CHECKSUM,
        statementIndex: 0,
        operationType: 'load_table_data',
        operationKey,
        beforeRetry: `TRUNCATE TABLE ${table}`,
        log: (line) => lines.push(line),
        pollIntervalMs: 1_000,
      })

      expect(result.kind).toBe('completed')
      expect(lines.some((line) => line.includes('attaching to in-flight query'))).toBe(true)
      expect(commands).toEqual([])
      expect(submits).toEqual([])
      expect(journal.statuses()).toEqual(['completed'])
      expect(await attempt).toBe('finished')
      const rows = await pollUntil(
        async () => {
          const [count] = await remote.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`)
          return Number(count?.n)
        },
        (count) => count === SLOW_ROWS,
      )
      expect(rows).toBe(SLOW_ROWS)
    } finally {
      // A DROP waits for the running INSERT's table lock, so let it end first.
      await attempt
      await remote.command(`DROP TABLE IF EXISTS ${table}`)
    }
  }, TIMEOUT_MS)

  // #289: backfill's resume reads every replica through the remote executor
  // too (the SDK takes any executor), so a chunk that a lost run left running
  // is polled, not submitted again.
  test('a backfill resume finds the chunk a lost run left running', async () => {
    const remote = await connect()
    const planId = createPrefix('workbench_bf').slice(0, -1)
    const chunkId = 'c0'
    const queryId = `backfill-${planId}-${chunkId}`
    const chunkSql = `SELECT sum(sleepEachRow(1)) FROM numbers(${SLOW_ROWS}) SETTINGS max_block_size = 1`
    const attempt = remote.submit(chunkSql, queryId).then(
      () => 'finished',
      (error: unknown) => String(error),
    )
    await pollUntil(
      () => remote.queryStatus(queryId, { everyReplica: true }),
      (status) => status.status === 'running',
      { intervalMs: 250, timeoutMs: 10_000 },
    )

    const submits: string[] = []
    const snapshots: BackfillChunkState[] = []
    const result = await executeBackfill({
      executor: {
        ...remote,
        submit: async (sql, id) => {
          submits.push(id ?? sql)
          return remote.submit(sql, id)
        },
      },
      planId,
      chunks: [{ id: chunkId }],
      buildQuery: () => chunkSql,
      pollIntervalMs: 500,
      resumeFrom: { [chunkId]: { status: 'pending' } },
      onProgress: (progress) => {
        const state = progress[chunkId]
        if (state) snapshots.push(state)
      },
    })

    expect(snapshots[0]).toMatchObject({ status: 'running', queryId })
    expect(submits).toEqual([])
    expect(result.progress[chunkId]?.status).toBe('done')
    expect(await attempt).toBe('finished')
  }, TIMEOUT_MS)
})

async function connect(): Promise<ClickHouseExecutor> {
  expect(SERVICE, 'set CHKIT_E2E_OBSESSIONDB_SERVICE to the ObsessionDB service slug').toBeTruthy()
  const credentials = await loadCredentials()
  expect(credentials, 'run `chkit obsessiondb login` first').not.toBeNull()
  return createRemoteExecutor({
    credentials: credentials as NonNullable<typeof credentials>,
    serviceSlug: SERVICE as string,
  })
}

async function readServerNowMs(db: ClickHouseExecutor): Promise<number> {
  const [row] = await db.query<{ now_ms: string }>('SELECT toString(toUnixTimestamp64Milli(now64(3))) AS now_ms')
  return Number(row?.now_ms)
}

function createMemoryJournal(initial: MigrationRowState | null) {
  let state = initial
  const writes: MigrationRowState[] = []
  const store: JournalStore = {
    databaseMissing: false,
    async readJournal() {
      return { version: 1, applied: [] }
    },
    async readMigrationState() {
      return state
    },
    async writeMigrationState(next) {
      writes.push(next)
      state = next
    },
    async appendEntry() {},
  }
  return { store, statuses: () => writes.map((write) => write.operations[0]?.status) }
}

// What a run that lost its connection while the statement ran leaves behind.
function startedState(migrationName: string, queryId: string, operationKey: string): MigrationRowState {
  return {
    name: migrationName,
    appliedAt: '1970-01-01 00:00:00.000',
    checksum: MIGRATION_CHECKSUM,
    chkitVersion: '',
    migrationCompleted: false,
    operations: [
      {
        operationIndex: 0,
        operationKey,
        operationType: 'load_table_data',
        queryId,
        status: 'started',
        startedAt: '2026-10-02 00:00:00.000',
        finishedAt: null,
        lastError: '',
      },
    ],
  }
}
