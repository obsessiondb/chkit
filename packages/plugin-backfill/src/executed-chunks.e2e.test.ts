import { randomBytes } from 'node:crypto'

import { afterAll, describe, expect, test } from 'bun:test'

import {
  createLiveExecutor,
  createPrefix,
  createStatelessLiveExecutor,
  getLiveEnv,
  pollUntil,
} from '@chkit/clickhouse/e2e-testkit'

import { findExecutedChunks } from './executed-chunks.js'

const FINISHED = 'a'.repeat(16)
const FAILED = 'b'.repeat(16)
const RUNNING = 'c'.repeat(16)
const OTHER_PLAN_CHUNK = 'd'.repeat(16)

// `submit --plan-id` re-submits only the chunks of a plan that never finished on
// the server (#313). findExecutedChunks finds them by the header every chunk
// query starts with, whatever query id or job ran them.
describe('findExecutedChunks', () => {
  const liveEnv = getLiveEnv()
  const ddl = createLiveExecutor(liveEnv)
  const runner = createStatelessLiveExecutor(liveEnv)
  const table = `${liveEnv.clickhouseDatabase}.${createPrefix('executed_chunks')}t`

  afterAll(async () => {
    await ddl.command(`DROP TABLE IF EXISTS ${table} SYNC`)
    await Promise.all([ddl.close(), runner.close()])
  })

  test('reports the finished and running chunks of one plan only', async () => {
    const planId = randomBytes(8).toString('hex')
    const otherPlanId = randomBytes(8).toString('hex')
    const header = (plan: string, chunk: string) => `/* chkit backfill plan=${plan} chunk=${chunk} token= */`
    const since = new Date(Date.now() - 60_000).toISOString()
    const find = () => findExecutedChunks({ executor: ddl, planId, since })

    await ddl.command(`CREATE TABLE ${table} (id UInt64) ENGINE = MergeTree ORDER BY id`)
    await runner.command(`${header(planId, FINISHED)}\nINSERT INTO ${table} SELECT number FROM numbers(3)`)
    await expect(
      runner.command(`${header(planId, FAILED)}\nINSERT INTO ${table} SELECT throwIf(number = 0) FROM numbers(3)`),
    ).rejects.toThrow()
    await runner.command(`${header(otherPlanId, OTHER_PLAN_CHUNK)}\nINSERT INTO ${table} SELECT number FROM numbers(3)`)
    // Not awaited yet: the request only returns once the INSERT finished.
    const slowInsert = runner.command(
      `${header(planId, RUNNING)}\nINSERT INTO ${table} SELECT number FROM numbers(10) WHERE sleepEachRow(1) = 0 SETTINGS max_block_size = 1`,
    )

    const whileRunning = await pollUntil(
      find,
      (value) => value.finished.includes(FINISHED) && value.running.includes(RUNNING),
      { timeoutMs: 8_000 },
    )
    expect(whileRunning).toEqual({ finished: [FINISHED], running: [RUNNING] })

    await slowInsert
    const afterwards = await pollUntil(find, (value) => value.finished.includes(RUNNING), { timeoutMs: 30_000 })
    expect(afterwards).toEqual({ finished: [FINISHED, RUNNING], running: [] })
  }, 120_000)
})
