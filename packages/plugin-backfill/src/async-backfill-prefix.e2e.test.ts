import { afterAll, expect, test } from 'bun:test'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { createLiveExecutor, getLiveEnv } from '@chkit/clickhouse/e2e-testkit'
import { syncProgress } from './async-backfill.js'

const live = createLiveExecutor(getLiveEnv())

afterAll(async () => { await live.close() })

test.each([
  { planId: 'planABC123', nearMisses: ['planABC123x', 'planABC12'] },
  { planId: "quote'plan", nearMisses: ['quoteplan', "quote''plan"] },
  { planId: 'slash\\plan', nearMisses: ['slashplan', 'slash\\\\plan'] },
  { planId: 'per%cent', nearMisses: ['percent', 'perAnythingcent'] },
  { planId: 'under_score', nearMisses: ['underXscore', 'underscore'] },
  { planId: "mix\\'%_tail\\", nearMisses: ["mix'%_tail\\", "mix\\'XQtail\\", "mix\\'%_tail"] },
  { planId: 'escaped\\n\\t\\x41\\N\\0', nearMisses: ['escapedntx41N0', 'escaped\n\tA\0'] },
  { planId: "x\\' OR 1 = 1 -- %_", nearMisses: ['unrelated', "x' OR 1 = 1 -- %_"] },
])('reconciliation LIKE predicates match the literal prefix: $planId', async ({ planId, nearMisses }) => {
  const reads: string[] = []
  const executor: ClickHouseExecutor = {
    ...live,
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes('system.processes') || sql.includes('system.query_log')) reads.push(sql)
      return []
    },
  }
  await syncProgress(executor, planId, [{ id: 'c1' }], { c1: { status: 'pending' } })
  expect(reads).toHaveLength(2)

  const matches = [`backfill-${planId}-c1`, `backfill-${planId}-c2`, `backfill-${planId}-c1-more`]
  const candidates = [
    ...matches,
    ...nearMisses.map((id) => `backfill-${id}-c1`),
    `other-backfill-${planId}-c1`,
    `backfill-${planId}x-c1`,
  ]
  const values = candidates.map((id) => `unhex('${Buffer.from(id).toString('hex')}')`).join(', ')

  for (const sql of reads) {
    const pattern = sql.match(/query_id LIKE ('(?:[^'\\]|\\[\s\S]|'')*')/)?.[1]
    expect(pattern).toBeDefined()
    if (planId === 'planABC123') expect(pattern).toBe("'backfill-planABC123-%'")
    const rows = await live.query<{ query_id: string }>(
      `SELECT query_id FROM (SELECT arrayJoin([${values}]) AS query_id) WHERE query_id LIKE ${pattern}`,
    )
    expect(rows.map((row) => row.query_id).sort()).toEqual([...matches].sort())
  }
})
