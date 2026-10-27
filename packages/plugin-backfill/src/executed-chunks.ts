import { allReplicas, observableSystemTable, resolveReplicaFanout, type ClickHouseExecutor } from '@chkit/clickhouse'

/** Chunk ids of a plan whose INSERT finished, or is still running, on the server. */
export interface ExecutedChunks {
  finished: string[]
  running: string[]
}

/**
 * Finds the chunks of a plan that any earlier run or managed job already wrote,
 * or is still writing. Every chunk query starts with the
 * `/* chkit backfill plan=<planId> chunk=<chunkId> … *\/` header, so this finds
 * them whatever query id ran them and whichever user the job backend used.
 * Writing a finished chunk again duplicates its rows whenever the insert block
 * differs (a copy of a table into itself reads its own earlier output), which
 * the idempotency token does not prevent.
 *
 * Reads every replica of a multi-replica target, and fails rather than skip a
 * replica. A chunk whose `system.query_log` entry has expired is not found.
 */
export async function findExecutedChunks(input: {
  executor: ClickHouseExecutor
  planId: string
  /** The plan's creation time: no chunk query of the plan is older. */
  since: string
  cluster?: string
}): Promise<ExecutedChunks> {
  const { executor, planId } = input
  if (!/^[a-f0-9]{16}$/.test(planId)) throw new Error(`Invalid backfill plan id: ${planId}`)
  const sinceDate = new Date(input.since)
  if (Number.isNaN(sinceDate.getTime())) throw new Error(`Invalid plan creation time: ${input.since}`)

  const fanout = await resolveReplicaFanout(executor, input.cluster)
  const from = (table: 'processes' | 'query_log') =>
    fanout ? allReplicas(fanout, `system.${table}`) : observableSystemTable(executor, table)
  const header = `startsWith(query, '/* chkit backfill plan=${planId} chunk=')`
  const chunkId = `extract(query, '^/\\\\* chkit backfill plan=[0-9a-f]+ chunk=([0-9a-f]+) ')`
  // The day before the plan's UTC date, so a server time zone cannot hide a query.
  const sinceDay = new Date(sinceDate.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10)

  // One after the other, and running queries first: a chunk that finishes between
  // the two reads then shows up in one of them. (A session-bound executor also
  // rejects concurrent queries.)
  const running = await executor.query<{ chunk_id: string }>(
    `SELECT DISTINCT ${chunkId} AS chunk_id FROM ${from('processes')}
WHERE ${header}
SETTINGS skip_unavailable_shards = 0`,
  )
  const finished = await executor.query<{ chunk_id: string }>(
    `SELECT DISTINCT ${chunkId} AS chunk_id FROM ${from('query_log')}
WHERE event_date >= toDate('${sinceDay}')
  AND type = 'QueryFinish'
  AND is_initial_query = 1
  AND ${header}
SETTINGS skip_unavailable_shards = 0`,
  )
  return { finished: chunkIds(finished), running: chunkIds(running) }
}

function chunkIds(rows: Array<{ chunk_id: string }>): string[] {
  return [...new Set(rows.map((row) => row.chunk_id).filter((id) => id.length > 0))].sort()
}
