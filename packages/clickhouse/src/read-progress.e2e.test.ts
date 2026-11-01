import { describe, expect, test } from 'bun:test'

import {
  createLiveExecutor,
  createPrefix,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  type LiveEnv,
} from './e2e-testkit.js'
import { allReplicas, createClickHouseExecutor, resolveReplicaFanout, type ClickHouseExecutor } from './index.js'

const env = getLiveEnv()
// ObsessionDB users have no CREATE USER (or any access-management) grant
// (#403), so the read-only users exist in verify, against the local stack, only.
const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'

interface LoggedSettings {
  progress: string
  interval: string
}

// Reads send progress headers, which keep a long read's connection alive, unless
// the user is readonly = 1 and so cannot change any setting (#412).
describe('progress headers on reads (#412)', () => {
  test('reads of a user who may change settings send the progress settings', async () => {
    const executor = createLiveExecutor(env)
    try {
      expect(await readAndLogSettings(executor, executor)).toEqual({ progress: '1', interval: '30000' })
    } finally {
      await executor.close()
    }
  }, 120_000)

  // With the default 100 ms interval, Node and Bun reject the response with
  // HPE_HEADER_OVERFLOW once its progress headers pass ~16 KB, after about 10 s.
  test('a read that reports progress for 15 s completes', async () => {
    const executor = createLiveExecutor(env)
    try {
      const rows = await executor.query<{ slept: number }>(
        'SELECT sum(sleepEachRow(0.05)) AS slept FROM numbers(300) SETTINGS max_block_size = 1',
      )
      expect(rows).toEqual([{ slept: 0 }])
    } finally {
      await executor.close()
    }
  }, 120_000)

  for (const [readonly, expected] of [
    [1, { progress: '', interval: '' }],
    [2, { progress: '1', interval: '30000' }],
  ] as const) {
    test.skipIf(onObsessionDB)(
      `a readonly = ${readonly} user reads${readonly === 1 ? ' without' : ' with'} the progress settings`,
      async () => {
        const admin = createLiveExecutor(env)
        const user = { name: `${createPrefix(`progress_ro${readonly}`)}user`, password: crypto.randomUUID() }
        try {
          await admin.command(
            `CREATE USER ${quoteIdent(user.name)} IDENTIFIED BY '${user.password}' SETTINGS readonly = ${readonly}`,
          )
          await admin.command(`GRANT SELECT ON *.* TO ${quoteIdent(user.name)}`)
          const reader = createUserExecutor(env, user)
          try {
            expect(await readAndLogSettings(reader, admin)).toEqual(expected)
          } finally {
            await reader.close()
          }
        } finally {
          await admin.command(`DROP USER IF EXISTS ${quoteIdent(user.name)}`).catch(() => {})
          await admin.close()
        }
      },
      120_000,
    )
  }
})

function createUserExecutor(liveEnv: LiveEnv, user: { name: string; password: string }): ClickHouseExecutor {
  return createClickHouseExecutor({
    url: liveEnv.clickhouseUrl,
    username: user.name,
    password: user.password,
    database: liveEnv.clickhouseDatabase,
  })
}

// Runs a uniquely tagged read as `reader`, then returns the progress settings
// system.query_log recorded for it, read by `admin` on every replica.
async function readAndLogSettings(
  reader: ClickHouseExecutor,
  admin: ClickHouseExecutor,
): Promise<LoggedSettings | undefined> {
  const tag = createPrefix('read_progress')
  expect(await reader.query(`SELECT '${tag}' AS tag`)).toEqual([{ tag }])

  const fanout = await resolveReplicaFanout(admin)
  const queryLog = fanout ? allReplicas(fanout, 'system.query_log') : 'system.query_log'
  const rows = await pollUntil(
    () =>
      admin.query<LoggedSettings>(
        `SELECT Settings['send_progress_in_http_headers'] AS progress, Settings['http_headers_progress_interval_ms'] AS interval
FROM ${queryLog}
WHERE type = 'QueryFinish' AND position(query, '${tag}') > 0 AND position(query, 'query_log') = 0`,
      ),
    (found) => found.length > 0,
    { timeoutMs: 60_000 },
  )
  return rows[0]
}
