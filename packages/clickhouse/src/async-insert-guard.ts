import type { ClickHouseExecutor } from './index.js'
import { allReplicas, resolveReplicaFanout, stringLiteral } from './replicas.js'

/** How far back `system.query_log` is searched for fire-and-forget async inserts. */
const ASYNC_INSERT_WINDOW_MINUTES = 10

export interface QualifiedTable {
  database: string
  name: string
}

export interface AsyncInsertGuardOptions {
  /** `clickhouse.cluster`; without it the `default` cluster is probed (ObsessionDB). */
  cluster?: string
  log?: (line: string) => void
}

/**
 * Refuses to go on when an asynchronous INSERT with `wait_for_async_insert = 0`
 * wrote to one of `tables` in the last 10 minutes.
 *
 * ClickHouse binds the async insert buffer of a table to its uuid. When the
 * table is renamed or exchanged before a buffer is flushed, the flush fails
 * with TABLE_UUID_MISMATCH and the buffered rows are dropped. A writer that
 * waits for the flush (`wait_for_async_insert = 1`) receives that error and
 * can retry; a fire-and-forget writer already got its acknowledgement, so its
 * rows are lost without a trace. A cutover swaps the table while writers keep
 * inserting, so it must not run while such writers are active.
 *
 * `system.query_log` is read on every replica, because an INSERT is logged by
 * the replica that received it. Only queries that went through the async
 * queue count (`ProfileEvents['AsyncInsertQuery']`), and a setting absent from
 * `Settings` has its built-in default. A user who cannot read `query_log` gets
 * a warning instead of a refusal.
 */
export async function assertNoFireAndForgetAsyncInserts(
  executor: ClickHouseExecutor,
  tables: QualifiedTable[],
  options: AsyncInsertGuardOptions = {},
): Promise<void> {
  const names = tables.map((table) => `${table.database}.${table.name}`)
  const fanout = await resolveReplicaFanout(executor, options.cluster)
  const source = fanout ? allReplicas(fanout, 'system.query_log') : 'system.query_log'
  let rows: Array<{ table: string; inserts: number | string }>
  try {
    rows = await executor.query(fireAndForgetInsertsSql(source, names))
  } catch (error) {
    options.log?.(
      `  warning: could not read system.query_log to check for fire-and-forget async inserts into ${names.join(', ')} (${error instanceof Error ? error.message.split('\n')[0] : String(error)}). Make sure no writer uses async_insert = 1 with wait_for_async_insert = 0 on these tables.`,
    )
    return
  }
  const found = rows.filter((row) => Number(row.inserts) > 0)
  if (found.length === 0) return
  const counts = found.map((row) => `${row.inserts} into ${row.table}`).join(', ')
  throw new Error(
    `Fire-and-forget async inserts (async_insert = 1, wait_for_async_insert = 0) ran in the last ${ASYNC_INSERT_WINDOW_MINUTES} minutes: ${counts}. ` +
      'ClickHouse drops the buffered rows of such an insert when its table is exchanged or renamed (TABLE_UUID_MISMATCH at flush), and the writer is never told. ' +
      'Switch these writers to wait_for_async_insert = 1 (an insert in flight at the swap then fails with a retryable error) or pause them, ' +
      `wait ${ASYNC_INSERT_WINDOW_MINUTES} minutes, and run chkit migrate --apply again.`,
  )
}

export function fireAndForgetInsertsSql(source: string, names: string[]): string {
  const effective = (setting: string) =>
    `if(mapContains(Settings, ${stringLiteral(setting)}), Settings[${stringLiteral(setting)}], (SELECT default FROM system.settings WHERE name = ${stringLiteral(setting)}))`
  const list = `[${names.map(stringLiteral).join(', ')}]`
  return [
    `SELECT arrayJoin(arrayIntersect(tables, ${list})) AS table, count() AS inserts FROM ${source}`,
    `WHERE event_date >= yesterday() AND event_time >= now() - INTERVAL ${ASYNC_INSERT_WINDOW_MINUTES} MINUTE`,
    "AND type = 'QueryFinish' AND query_kind = 'Insert' AND ProfileEvents['AsyncInsertQuery'] > 0",
    `AND hasAny(tables, ${list})`,
    `AND ${effective('wait_for_async_insert')} IN ('0', 'false')`,
    'GROUP BY table ORDER BY table',
  ].join(' ')
}
